// Keeps each reviewed PR's status current: open, merged or closed, your standing review,
// and whether GitHub would let it merge. With auto-merge on for its repo, merges it once
// you've approved its latest commit and GitHub allows it.
//
// A PR is looked at again only when GitHub's open-PR list (which the poller fetches anyway)
// shows it changed, or when it left that list. PRs waiting on checks are the exception:
// checks finishing don't change the PR, so those are looked at once a minute.

import { bus } from '../bus.ts';
import { nowIso, type Db } from '../db.ts';
import { errorText, httpStatus, rateLimited, splitRepo, type GitHub } from '../github/client.ts';
import type { OpenPr } from '../github/watch.ts';
import type { RepoSettings, SettingsStore } from '../settings.ts';
import type { Job, MergeStatus, MyReview, PrRow } from '../types.ts';

export interface PrRecord {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  state: 'open' | 'closed' | 'merged';
  draft: number;
  head_sha: string;
  head_ref: string;
  head_repo: string | null;
  base_ref: string;
  // Your standing review: APPROVED or CHANGES_REQUESTED (the latest of those counts, as on
  // GitHub), else COMMENTED if you commented, else null.
  my_review: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | null;
  my_review_sha: string | null;
  my_review_at: string | null;
  my_pending: number;
  changes_by: string; // JSON string[]: others whose standing review requests changes
  approved_by: string; // JSON string[]: others whose standing review approves
  mergeable_state: string | null;
  gh_updated_at: string | null;
  checked_at: string;
  merged_at: string | null;
  merged_by: string | null;
  hold: number;
  merge_note: string | null;
  merge_failed_sha: string | null;
  merge_failed_at: string | null;
}

// PRs reviewed in this many days are kept up to date.
const TRACK_DAYS = 90;
// GitHub requests are spent on at most this many PRs per check (two requests each).
const MAX_REFRESH = 5;
const WAITING_EVERY_MS = 60_000;
const RETRY_FAILED_MS = 30 * 60_000;
const MERGEABLE = new Set(['clean', 'has_hooks']);

const list = (json: string): string[] => {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const people = (logins: string[]) => logins.map((l) => `@${l}`).join(', ');

export interface MergePlan {
  status: MergeStatus;
  note: string;
  // When a wait ends: merging after the approval, or retrying after a failure.
  at: string | null;
  // Merge now.
  go: boolean;
}

// What auto-merge does with this PR right now. Pure, so it can be shown on the dashboard
// and tested; the PR is read fresh from GitHub before an actual merge.
export function mergePlan(r: PrRecord, s: Pick<RepoSettings, 'enabled' | 'dryRun' | 'merge'>, me: string, now = Date.now()): MergePlan {
  const plan = (status: MergeStatus, note: string, at: string | null = null, go = false): MergePlan => ({ status, note, at, go });
  if (r.state === 'merged') {
    const byApp = r.merge_note?.startsWith('Merged by auto-merge');
    return plan('merged', byApp ? r.merge_note! : r.merged_by ? `Merged by @${r.merged_by}` : 'Merged');
  }
  if (r.state === 'closed') return plan('none', 'Closed without merging');
  if (!s.merge.enabled) return plan('off', '');
  if (!s.enabled) return plan('off', 'Reviews are switched off for this repo');
  if (s.dryRun) return plan('off', 'Not during a dry run');
  if (r.hold) return plan('held', 'Held from the dashboard');
  if (r.my_review === 'CHANGES_REQUESTED') return plan('none', '');
  if (r.my_review !== 'APPROVED') return plan('none', 'Needs your approval');
  if (r.my_review_sha !== r.head_sha) return plan('blocked', 'New commits since your approval');
  if (r.draft) return plan('blocked', 'The PR is a draft');
  const changes = list(r.changes_by).filter((l) => l.toLowerCase() !== me.toLowerCase());
  if (changes.length) return plan('blocked', `${people(changes)} requested changes`);
  switch (r.mergeable_state) {
    case 'dirty': return plan('blocked', 'Has merge conflicts');
    case 'behind': return plan('blocked', 'Branch is behind the base branch');
    case 'draft': return plan('blocked', 'The PR is a draft');
    case 'blocked': return plan('waiting', 'Waiting for required checks or reviews');
    case 'unstable': return plan('waiting', 'Some checks are failing or still running');
  }
  if (!MERGEABLE.has(r.mergeable_state ?? '')) return plan('waiting', 'Waiting for GitHub to say it can merge');
  if (r.merge_failed_sha === r.head_sha && r.merge_failed_at) {
    const retry = Date.parse(r.merge_failed_at) + RETRY_FAILED_MS;
    if (now < retry) return plan('failed', r.merge_note ?? 'Merge failed', new Date(retry).toISOString());
  }
  const due = Date.parse(r.my_review_at ?? '') + s.merge.delayMin * 60_000;
  if (Number.isFinite(due) && now < due) return plan('waiting', 'Merges after the wait', new Date(due).toISOString());
  return plan('waiting', 'Merging', null, true);
}

// The PR and its reviews as GitHub has them now.
export async function fetchPr(gh: GitHub, repo: string, number: number): Promise<Omit<PrRecord, 'hold' | 'merge_note' | 'merge_failed_sha' | 'merge_failed_at'>> {
  const { data: p } = await gh.octokit.rest.pulls.get({ ...splitRepo(repo), pull_number: number });
  const reviews = await gh.octokit.paginate(gh.octokit.rest.pulls.listReviews, { ...splitRepo(repo), pull_number: number, per_page: 100 });
  const me = gh.me.toLowerCase();
  let mine: { state: 'APPROVED' | 'CHANGES_REQUESTED'; sha: string | null; at: string | null } | null = null;
  let commented = false;
  let pending = false;
  const others = new Map<string, string>();
  // Oldest first, so later reviews replace earlier ones as they do on GitHub.
  for (const r of reviews) {
    const login = r.user?.login;
    if (!login) continue;
    if (login.toLowerCase() === me) {
      if (r.state === 'PENDING') pending = true;
      else if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') mine = { state: r.state, sha: r.commit_id ?? null, at: r.submitted_at ?? null };
      else if (r.state === 'DISMISSED') mine = null;
      else if (r.state === 'COMMENTED') commented = true;
    } else if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED') {
      others.set(login, r.state);
    }
  }
  const by = (state: string) => JSON.stringify([...others].filter(([, s]) => s === state).map(([l]) => l));
  return {
    repo: p.base.repo.full_name,
    number,
    title: p.title,
    url: p.html_url,
    author: p.user?.login ?? 'unknown',
    state: p.merged ? 'merged' : p.state === 'closed' ? 'closed' : 'open',
    draft: p.draft ? 1 : 0,
    head_sha: p.head.sha,
    head_ref: p.head.ref,
    head_repo: p.head.repo?.full_name ?? null,
    base_ref: p.base.ref,
    my_review: mine?.state ?? (commented ? 'COMMENTED' : null),
    my_review_sha: mine?.sha ?? null,
    my_review_at: mine?.at ?? null,
    my_pending: pending ? 1 : 0,
    changes_by: by('CHANGES_REQUESTED'),
    approved_by: by('APPROVED'),
    mergeable_state: p.mergeable_state ?? null,
    gh_updated_at: p.updated_at,
    checked_at: nowIso(),
    merged_at: p.merged_at ?? null,
    merged_by: p.merged_by?.login ?? null,
  };
}

// Why GitHub refused a merge, in words.
function mergeError(err: unknown): string {
  const status = httpStatus(err);
  const message = (err as { response?: { data?: { message?: string } } }).response?.data?.message ?? errorText(err);
  if (status === 403 || status === 404) return "the GitHub login can't merge here (it needs write access; for a fine-grained token, Contents: write)";
  if (status === 409) return 'the PR got new commits just now';
  return message.replace(/\.$/, '');
}

export class PrTracker {
  private readonly gh: GitHub;
  private readonly cfg: SettingsStore;
  private readonly db: Db;

  constructor(gh: GitHub, cfg: SettingsStore, db: Db) {
    this.gh = gh;
    this.cfg = cfg;
    this.db = db;
  }

  record(repo: string, number: number): PrRecord | undefined {
    return this.db.get<PrRecord>('SELECT * FROM pull_requests WHERE repo = ? AND number = ?', repo, number);
  }

  // PRs with a finished review in the last TRACK_DAYS days.
  private tracked(): { repo: string; number: number }[] {
    const since = new Date(Date.now() - TRACK_DAYS * 86400_000).toISOString();
    return this.db.all<{ repo: string; number: number }>(
      `SELECT repo, pr_number AS number FROM jobs WHERE state = 'done' AND finished_at >= ?
         GROUP BY repo COLLATE NOCASE, pr_number ORDER BY MAX(id) DESC`,
      since,
    );
  }

  // `open`: each repo checked successfully just now (lower-case name) and its open PRs.
  async refresh(open: Map<string, OpenPr[]>): Promise<void> {
    let changed = false;
    const now = Date.now();
    const due: { repo: string; number: number }[] = [];
    for (const t of this.tracked()) {
      const prs = open.get(t.repo.toLowerCase());
      if (!prs) continue; // not watched now, or the check failed: nothing new to go on
      const row = this.record(t.repo, t.number);
      const pr = prs.find((p) => p.number === t.number);
      if (!pr) {
        if (!row || row.state === 'open') due.push(t); // it was merged or closed
      } else if (!row || row.state !== 'open' || row.gh_updated_at !== pr.updatedAt || row.head_sha !== pr.headSha) {
        due.push(t);
      } else if (this.plan(row).status === 'waiting' && now - Date.parse(row.checked_at) >= WAITING_EVERY_MS) {
        due.push(t);
      }
    }

    for (const t of due.slice(0, MAX_REFRESH)) {
      try {
        this.save(await fetchPr(this.gh, t.repo, t.number));
        changed = true;
      } catch (err) {
        if (rateLimited(err)) throw err;
        console.error(`[prs] ${t.repo}#${t.number}: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Merge what's ready, including PRs whose wait just ended.
    for (const row of this.db.all<PrRecord>(`SELECT * FROM pull_requests WHERE state = 'open'`)) {
      if (!this.plan(row).go || !open.has(row.repo.toLowerCase())) continue;
      await this.merge(row);
      changed = true;
    }
    if (changed) bus.prsChanged();
  }

  private plan(row: PrRecord) {
    return mergePlan(row, this.cfg.forRepo(row.repo), this.gh.me);
  }

  private save(r: Omit<PrRecord, 'hold' | 'merge_note' | 'merge_failed_sha' | 'merge_failed_at'>) {
    const cols = Object.keys(r) as (keyof typeof r)[];
    const updates = cols.filter((c) => c !== 'repo' && c !== 'number').map((c) => `${c} = excluded.${c}`).join(', ');
    this.db.run(
      `INSERT INTO pull_requests (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
       ON CONFLICT (repo, number) DO UPDATE SET ${updates}`,
      ...cols.map((c) => r[c]),
    );
  }

  private note(row: PrRecord, message: string, level: 'info' | 'warn' = 'info') {
    const job = this.db.jobsForPr(row.repo, row.number)[0];
    if (job) this.db.event(job.id, message, level);
    else console.log(`[prs] ${row.repo}#${row.number}: ${message}`);
  }

  // Reads the PR fresh, checks again, and merges only the commit that was approved.
  private async merge(stale: PrRecord) {
    const settings = this.cfg.forRepo(stale.repo);
    this.save(await fetchPr(this.gh, stale.repo, stale.number));
    const row = this.record(stale.repo, stale.number)!;
    if (!this.plan(row).go) return;
    const method = settings.merge.method;
    try {
      await this.gh.octokit.rest.pulls.merge({ ...splitRepo(row.repo), pull_number: row.number, sha: row.head_sha, merge_method: method });
    } catch (err) {
      if (rateLimited(err)) throw err;
      const why = mergeError(err);
      this.db.run(
        `UPDATE pull_requests SET merge_note = ?, merge_failed_sha = ?, merge_failed_at = ? WHERE repo = ? AND number = ?`,
        `Merge failed: ${why}`, row.head_sha, nowIso(), row.repo, row.number,
      );
      this.note(row, `Auto-merge failed: ${why}. Trying again in 30 minutes, or when the PR changes.`, 'warn');
      return;
    }
    const note = `Merged by auto-merge (${method})`;
    this.db.run(
      `UPDATE pull_requests SET state = 'merged', merged_at = ?, merged_by = ?, merge_note = ?, merge_failed_sha = NULL, merge_failed_at = NULL WHERE repo = ? AND number = ?`,
      nowIso(), this.gh.me, note, row.repo, row.number,
    );
    this.note(row, `${note} into ${row.base_ref}`);
    if (settings.merge.deleteBranch && row.head_repo?.toLowerCase() === row.repo.toLowerCase()) {
      try {
        await this.gh.octokit.rest.git.deleteRef({ ...splitRepo(row.repo), ref: `heads/${row.head_ref}` });
        this.note(row, `Deleted the branch ${row.head_ref}`);
      } catch (err) {
        if (rateLimited(err)) throw err;
        this.note(row, `Couldn't delete the branch ${row.head_ref}: ${errorText(err)}`, 'warn');
      }
    }
  }

  // Hold stops auto-merge for this PR until you resume it. Resuming also retries a failed merge.
  setHold(repo: string, number: number, hold: boolean): boolean {
    const res = this.db.run(
      `UPDATE pull_requests SET hold = ?, merge_failed_sha = CASE WHEN ? THEN merge_failed_sha END, merge_failed_at = CASE WHEN ? THEN merge_failed_at END
       WHERE repo = ? AND number = ?`,
      hold ? 1 : 0, hold ? 1 : 0, hold ? 1 : 0, repo, number,
    );
    if (!res.changes) return false;
    const row = this.record(repo, number)!;
    this.note(row, hold ? 'Auto-merge held from the dashboard' : 'Auto-merge resumed from the dashboard');
    bus.prsChanged();
    return true;
  }

  // Every reviewed PR with its latest finished review, newest first.
  rows(limit = 500): PrRow[] {
    const jobs = this.db.all<Job>(
      `SELECT * FROM jobs j WHERE state = 'done'
         AND id = (SELECT MAX(id) FROM jobs k WHERE k.repo = j.repo COLLATE NOCASE AND k.pr_number = j.pr_number AND k.state = 'done')
       ORDER BY finished_at DESC LIMIT ?`,
      limit,
    );
    return jobs.map((j) => {
      const r = this.record(j.repo, j.pr_number);
      const review = myReview(j, r);
      const plan = r ? this.plan(r) : { status: 'none' as const, note: '', at: null };
      return {
        repo: r?.repo ?? j.repo,
        number: j.pr_number,
        title: r?.title || j.pr_title,
        url: r?.url || j.pr_url,
        author: r?.author || j.author,
        state: r?.state ?? 'unknown',
        draft: r?.draft === 1,
        review,
        reviewOutdated: !!r && (review === 'approved' || review === 'changes_requested') && !!r.my_review_sha && r.my_review_sha !== r.head_sha,
        pendingDraft: r?.my_pending === 1 && review !== 'draft',
        changesBy: r ? list(r.changes_by) : [],
        approvedBy: r ? list(r.approved_by) : [],
        mergeable: r?.mergeable_state ?? null,
        merge: { status: plan.status, note: plan.note, at: plan.at },
        hold: r?.hold === 1,
        mergedAt: r?.merged_at ?? null,
        mergedBy: r?.merged_by ?? null,
        checkedAt: r?.checked_at ?? null,
        job: { id: j.id, kind: j.kind, finishedAt: j.finished_at, counts: this.db.withCounts(j).counts! },
      };
    });
  }
}

// Your review as GitHub shows it, falling back to what the app posted until the PR has
// been checked.
function myReview(job: Job, r: PrRecord | undefined): MyReview {
  if (r?.my_review === 'APPROVED') return 'approved';
  if (r?.my_review === 'CHANGES_REQUESTED') return 'changes_requested';
  if (r?.my_review === 'COMMENTED') return 'commented';
  if (r?.my_pending) return 'draft';
  if (job.dry_run || job.review_state === 'DRY_RUN') return 'dry_run';
  if (r) return 'not_posted';
  switch (job.review_state) {
    case 'APPROVED': return 'approved';
    case 'CHANGES_REQUESTED': return 'changes_requested';
    case 'COMMENTED': return 'commented';
    case 'PENDING': return 'draft';
    default: return 'not_posted';
  }
}
