import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Db } from '../src/db.ts';
import type { GitHub } from '../src/github/client.ts';
import type { OpenPr } from '../src/github/watch.ts';
import { fetchPr, mergePlan, PrTracker, type PrRecord } from '../src/jobs/prs.ts';
import { SettingsStore } from '../src/settings.ts';
import { setRepo } from './helpers.ts';

const HEAD = 'a'.repeat(40);
const OLD = 'c'.repeat(40);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const record = (over: Partial<PrRecord> = {}): PrRecord => ({
  repo: 'acme/api', number: 1, title: 'Fix', url: 'u', author: 'author', state: 'open', draft: 0, head_sha: HEAD, head_ref: 'fix', head_repo: 'acme/api',
  base_ref: 'main', my_review: 'APPROVED', my_review_sha: HEAD, my_review_at: minutesAgo(30), my_pending: 0, changes_by: '[]', approved_by: '[]',
  mergeable_state: 'clean', gh_updated_at: 't1', checked_at: new Date().toISOString(), merged_at: null, merged_by: null, hold: 0, merge_note: null,
  merge_failed_sha: null, merge_failed_at: null, ...over,
});
const on = { enabled: true, dryRun: false, merge: { enabled: true, method: 'squash' as const, delayMin: 10, deleteBranch: false } };
const plan = (over: Partial<PrRecord> = {}, s = on) => mergePlan(record(over), s, 'me');

describe('when auto-merge merges', () => {
  it('merges an approved, mergeable PR once the wait is over', () => {
    assert.deepEqual(plan(), { status: 'waiting', note: 'Merging', at: null, go: true });
    const waiting = plan({ my_review_at: minutesAgo(3) });
    assert.equal(waiting.go, false);
    assert.equal(waiting.status, 'waiting');
    assert.ok(Date.parse(waiting.at!) > Date.now(), 'says when it will merge');
    assert.equal(plan({ mergeable_state: 'has_hooks' }).go, true);
  });

  it('never merges when it is off, a dry run, held, or not approved on the latest commit', () => {
    assert.equal(plan({}, { ...on, merge: { ...on.merge, enabled: false } }).status, 'off');
    assert.deepEqual(plan({}, { ...on, dryRun: true }), { status: 'off', note: 'Not during a dry run', at: null, go: false });
    assert.equal(plan({}, { ...on, enabled: false }).status, 'off');
    assert.equal(plan({ hold: 1 }).status, 'held');
    assert.equal(plan({ my_review: 'COMMENTED' }).note, 'Needs your approval');
    assert.equal(plan({ my_review: 'CHANGES_REQUESTED' }).status, 'none');
    assert.deepEqual(plan({ my_review_sha: OLD }), { status: 'blocked', note: 'New commits since your approval', at: null, go: false });
    assert.equal(plan({ draft: 1 }).note, 'The PR is a draft');
  });

  it('waits for GitHub, and says what is in the way', () => {
    assert.equal(plan({ changes_by: '["lead"]' }).note, '@lead requested changes');
    assert.equal(plan({ mergeable_state: 'dirty' }).note, 'Has merge conflicts');
    assert.equal(plan({ mergeable_state: 'behind' }).status, 'blocked');
    assert.deepEqual(plan({ mergeable_state: 'blocked' }), { status: 'waiting', note: 'Waiting for required checks or reviews', at: null, go: false });
    assert.equal(plan({ mergeable_state: 'unstable' }).go, false, 'a failing or running check is never merged over');
    assert.equal(plan({ mergeable_state: 'unknown' }).go, false);
    assert.equal(plan({ mergeable_state: null }).go, false);
  });

  it("doesn't retry a failed merge of the same commit for a while", () => {
    const failed = plan({ merge_failed_sha: HEAD, merge_failed_at: minutesAgo(5), merge_note: 'Merge failed: Merge method not allowed' });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.go, false);
    assert.equal(plan({ merge_failed_sha: HEAD, merge_failed_at: minutesAgo(31) }).go, true);
    assert.equal(plan({ merge_failed_sha: OLD, merge_failed_at: minutesAgo(1) }).go, true, 'new commits are tried straight away');
  });

  it('describes merged and closed PRs', () => {
    assert.equal(plan({ state: 'merged', merged_by: 'lead' }).note, 'Merged by @lead');
    assert.equal(plan({ state: 'merged', merged_by: 'me', merge_note: 'Merged by auto-merge (squash)' }).note, 'Merged by auto-merge (squash)');
    assert.equal(plan({ state: 'closed' }).note, 'Closed without merging');
  });
});

type Review = { user: { login: string }; state: string; commit_id: string; submitted_at: string };

// GitHub for one PR: its details, its reviews, and what was merged or deleted.
function fakeGitHub(pr: Record<string, unknown> = {}, reviews: Review[] = [], mergeFails?: { status: number; message: string }) {
  const calls = { get: 0, reviews: 0, merged: [] as unknown[], deleted: [] as string[] };
  const data = () => ({
    title: 'Fix', html_url: 'https://github.com/acme/api/pull/1', user: { login: 'author' }, draft: false, state: 'open', merged: false,
    head: { sha: HEAD, ref: 'fix', repo: { full_name: 'acme/api' } }, base: { ref: 'main', repo: { full_name: 'acme/api' } },
    mergeable_state: 'clean', updated_at: 't1', merged_at: null, merged_by: null, ...pr,
  });
  const gh = {
    me: 'me',
    octokit: {
      paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
      rest: {
        pulls: {
          get: async () => (calls.get++, { data: data() }),
          listReviews: async () => (calls.reviews++, { data: reviews }),
          merge: async (args: unknown) => {
            if (mergeFails) throw Object.assign(new Error(mergeFails.message), { status: mergeFails.status, response: { data: { message: mergeFails.message } } });
            calls.merged.push(args);
            Object.assign(pr, { state: 'closed', merged: true });
            return { data: { merged: true } };
          },
        },
        git: { deleteRef: async (a: { ref: string }) => void calls.deleted.push(a.ref) },
      },
    },
  } as unknown as GitHub;
  return { gh, calls };
}

const review = (login: string, state: string, commit = HEAD, minutes = 30): Review => ({ user: { login }, state, commit_id: commit, submitted_at: minutesAgo(minutes) });

describe('reading a PR from GitHub', () => {
  it('keeps the latest approval or change request, as GitHub does', async () => {
    const { gh } = fakeGitHub({}, [
      review('me', 'CHANGES_REQUESTED', OLD, 60),
      review('me', 'APPROVED', HEAD, 20),
      review('me', 'COMMENTED', HEAD, 10),
      review('lead', 'CHANGES_REQUESTED', HEAD, 15),
      review('other', 'APPROVED', HEAD, 15),
      review('other', 'DISMISSED', HEAD, 5),
    ]);
    const pr = await fetchPr(gh, 'acme/api', 1);
    assert.equal(pr.my_review, 'APPROVED', 'a later comment does not undo an approval');
    assert.equal(pr.my_review_sha, HEAD);
    assert.deepEqual(JSON.parse(pr.changes_by), ['lead']);
    assert.deepEqual(JSON.parse(pr.approved_by), [], 'a dismissed approval no longer counts');
  });

  it('tells a comment, a dismissal and an unsubmitted draft apart', async () => {
    assert.equal((await fetchPr(fakeGitHub({}, [review('me', 'COMMENTED')]).gh, 'acme/api', 1)).my_review, 'COMMENTED');
    assert.equal((await fetchPr(fakeGitHub({}, [review('me', 'APPROVED'), review('me', 'DISMISSED')]).gh, 'acme/api', 1)).my_review, null);
    const pending = await fetchPr(fakeGitHub({}, [review('me', 'PENDING')]).gh, 'acme/api', 1);
    assert.equal(pending.my_pending, 1);
    assert.equal(pending.my_review, null);
    assert.equal((await fetchPr(fakeGitHub({ state: 'closed', merged: true, merged_by: { login: 'lead' } }).gh, 'acme/api', 1)).state, 'merged');
  });
});

describe('keeping reviewed PRs up to date, and merging them', () => {
  let dir: string;
  let db: Db;
  let cfg: SettingsStore;
  let jobId: number;
  const open = (over: Partial<OpenPr> = {}) =>
    new Map([['acme/api', [{ repo: 'acme/api', number: 1, title: 'Fix', url: 'u', author: 'author', draft: false, headSha: HEAD, requestedReviewers: [], updatedAt: 't1', ...over }]]]);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-prs-'));
    db = new Db(dir);
    cfg = new SettingsStore(db);
    setRepo(cfg, 'acme/api', { dryRun: false, mode: 'publish', merge: { enabled: true, method: 'rebase', delayMin: 0, deleteBranch: true } });
    const job = db.insertJob({
      repo: 'acme/api', pr_number: 1, pr_title: 'Fix', pr_url: 'u', author: 'author', head_sha: HEAD, base_sha: 'b'.repeat(40),
      since_sha: null, mode: 'publish', source: 'request', dry_run: 0, state: 'queued', additions: 1, deletions: 0, changed_files: 1,
    });
    jobId = job.id;
    db.setState(jobId, 'done', { review_id: 9, review_state: 'APPROVED' });
  });

  afterEach(() => {
    db.sql.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('merges the approved commit with the repo\'s method, then deletes the branch', async () => {
    const { gh, calls } = fakeGitHub({}, [review('me', 'APPROVED')]);
    const tracker = new PrTracker(gh, cfg, db);
    await tracker.refresh(open());
    assert.deepEqual(calls.merged, [{ owner: 'acme', repo: 'api', pull_number: 1, sha: HEAD, merge_method: 'rebase' }], 'only the approved commit can be merged');
    assert.deepEqual(calls.deleted, ['heads/fix']);
    const [row] = tracker.rows();
    assert.equal(row.state, 'merged');
    assert.equal(row.merge.note, 'Merged by auto-merge (rebase)');
    assert.equal(row.review, 'approved');
    assert.ok(db.events(jobId).some((e) => e.message === 'Merged by auto-merge (rebase) into main'));
  });

  it('merges nothing while the repo is a dry run, or the PR is held', async () => {
    const { gh, calls } = fakeGitHub({}, [review('me', 'APPROVED')]);
    const tracker = new PrTracker(gh, cfg, db);
    setRepo(cfg, 'acme/api', { dryRun: true });
    await tracker.refresh(open());
    assert.equal(calls.merged.length, 0);
    assert.equal(tracker.rows()[0].merge.note, 'Not during a dry run');

    setRepo(cfg, 'acme/api', { dryRun: false });
    assert.equal(tracker.setHold('acme/api', 1, true), true);
    await tracker.refresh(open({ updatedAt: 't2' }));
    assert.equal(calls.merged.length, 0);
    assert.equal(tracker.rows()[0].merge.status, 'held');

    tracker.setHold('acme/api', 1, false);
    await tracker.refresh(open());
    assert.equal(calls.merged.length, 1, 'resuming lets it merge');
  });

  it('records a refused merge and waits before trying again', async () => {
    const { gh, calls } = fakeGitHub({}, [review('me', 'APPROVED')], { status: 405, message: 'Merge method not allowed.' });
    const tracker = new PrTracker(gh, cfg, db);
    await tracker.refresh(open());
    const [row] = tracker.rows();
    assert.equal(row.merge.status, 'failed');
    assert.equal(row.merge.note, 'Merge failed: Merge method not allowed');
    const gets = calls.get;
    await tracker.refresh(open());
    assert.equal(calls.get, gets, 'no second attempt, and no GitHub requests for an unchanged PR');
    assert.ok(db.events(jobId).some((e) => e.level === 'warn' && e.message.startsWith('Auto-merge failed')));
  });

  it('looks at a PR again only when it changed or left the open list', async () => {
    setRepo(cfg, 'acme/api', { merge: { enabled: false } });
    const { gh, calls } = fakeGitHub({}, [review('me', 'COMMENTED')]);
    const tracker = new PrTracker(gh, cfg, db);
    await tracker.refresh(open());
    assert.equal(calls.get, 1);
    assert.equal(tracker.rows()[0].review, 'commented', 'what GitHub shows now, over what was posted');
    await tracker.refresh(open());
    assert.equal(calls.get, 1, 'unchanged: no request');
    await tracker.refresh(open({ updatedAt: 't2' }));
    assert.equal(calls.get, 2);
    await tracker.refresh(new Map([['acme/api', []]]));
    assert.equal(calls.get, 3, 'gone from the open list: merged or closed');
    await tracker.refresh(new Map());
    assert.equal(calls.get, 3, 'a repo that was not checked says nothing');
  });

  it('looks up PRs in a repo that is no longer watched, once an hour', async () => {
    setRepo(cfg, 'acme/api', { enabled: false });
    const { gh, calls } = fakeGitHub({}, [review('me', 'COMMENTED')]);
    const tracker = new PrTracker(gh, cfg, db);
    await tracker.refresh(new Map());
    assert.equal(calls.get, 1);
    assert.equal(tracker.rows()[0].state, 'open');
    await tracker.refresh(new Map());
    assert.equal(calls.get, 1, 'not again within the hour');
    db.run(`UPDATE pull_requests SET checked_at = ?`, minutesAgo(61));
    await tracker.refresh(new Map());
    assert.equal(calls.get, 2);
  });

  it("doesn't retry a PR it can't read on every check", async () => {
    setRepo(cfg, 'acme/api', { enabled: false });
    const { gh } = fakeGitHub();
    let tries = 0;
    (gh.octokit.rest.pulls as unknown as { get: () => never }).get = () => {
      tries++;
      throw Object.assign(new Error('Not Found'), { status: 404 });
    };
    const tracker = new PrTracker(gh, cfg, db);
    await tracker.refresh(new Map());
    await tracker.refresh(new Map());
    assert.equal(tries, 1);
    assert.equal(tracker.rows()[0].state, 'unknown');
  });

  it('shows what was posted until the PR is checked on GitHub', () => {
    const { gh } = fakeGitHub();
    const [row] = new PrTracker(gh, cfg, db).rows();
    assert.equal(row.state, 'unknown');
    assert.equal(row.review, 'approved');
    assert.equal(row.job.id, jobId);
  });
});
