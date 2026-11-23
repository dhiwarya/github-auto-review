import type { RepoCache } from '../git/mirror.ts';
import type { GitHub } from '../github/client.ts';
import { listOpenPrs, type OpenPrSummary, type PrInfo } from '../github/prs.ts';
import type { Confidence, RelatedPr } from '../types.ts';

// Other open PRs that change the same files as the one under review. Found from the local
// repo copy, so it costs one GitHub request however many PRs are open. The consistency
// review decides which of them matter; what comes out is an alert for the reader, never a
// finding, so it can't lower confidence, block an approval or request changes.

const MAX_COMPARED = 40; // the most recently active PRs are compared
const MAX_SHOWN = 8; // the ones sharing the most files go to the model
const PATCH_CHARS = 2500; // of each candidate's changes to the shared files

export interface RelatedCandidate {
  pr: OpenPrSummary;
  staleDays: number | null; // days without activity, when over the limit
  files: string[];
  patch: string;
}

export const daysSince = (iso: string, now = Date.now()) => Math.max(0, Math.floor((now - Date.parse(iso)) / 86_400_000));

export async function relatedCandidates(
  gh: GitHub,
  cache: RepoCache,
  pr: PrInfo,
  changedFiles: string[],
  staleAfterDays: number,
  now = Date.now(),
): Promise<RelatedCandidate[]> {
  const mine = new Set(changedFiles);
  if (!mine.size) return [];
  const others = (await listOpenPrs(gh, pr.repo)).filter((o) => o.number !== pr.number).slice(0, MAX_COMPARED);
  const heads = await cache.fetchPrHeads(pr.repo, others.map((o) => o.number));

  const found: RelatedCandidate[] = [];
  for (const other of others) {
    const head = heads.get(other.number);
    if (!head) continue;
    try {
      const base = await cache.mergeBase(pr.repo, pr.baseSha, head);
      const shared = (await cache.diffFiles(pr.repo, base, head)).filter((f) => mine.has(f.filename));
      if (!shared.length) continue;
      const days = daysSince(other.updatedAt, now);
      const patch = shared.map((f) => `--- ${f.filename}\n${f.patch ?? '(no text diff)'}`).join('\n');
      found.push({
        pr: other,
        staleDays: days > staleAfterDays ? days : null,
        files: shared.map((f) => f.filename),
        patch: patch.length > PATCH_CHARS ? `${patch.slice(0, PATCH_CHARS)}\n…[cut]` : patch,
      });
    } catch {
      // No common history with this PR's base: nothing to compare.
    }
  }
  return found.sort((a, b) => b.files.length - a.files.length).slice(0, MAX_SHOWN);
}

export function relatedSection(candidates: RelatedCandidate[], now = Date.now()): string {
  return candidates
    .map((c) => {
      const flags = [
        `@${c.pr.author}`,
        `last activity ${daysSince(c.pr.updatedAt, now)} day(s) ago`,
        c.pr.draft ? 'draft' : '',
        c.staleDays !== null ? 'UNMAINTAINED' : '',
      ].filter(Boolean);
      return `### #${c.pr.number}: ${c.pr.title} (${flags.join(', ')})\nShared files: ${c.files.join(', ')}\n${c.patch}`;
    })
    .join('\n\n');
}

// Turns the model's picks into alerts. Only PRs it was shown count, and an unmaintained PR
// is always low confidence, whatever the model said.
export function relatedAlerts(
  candidates: RelatedCandidate[],
  picks: { number: number; relation: RelatedPr['relation']; note: string; confidence: Confidence }[],
): RelatedPr[] {
  const byNumber = new Map(candidates.map((c) => [c.pr.number, c]));
  const seen = new Set<number>();
  const alerts: RelatedPr[] = [];
  for (const pick of picks) {
    const c = byNumber.get(pick.number);
    if (!c || seen.has(pick.number)) continue;
    seen.add(pick.number);
    alerts.push({
      number: c.pr.number,
      title: c.pr.title,
      url: c.pr.url,
      author: c.pr.author,
      relation: pick.relation,
      note: pick.note,
      confidence: c.staleDays !== null ? 'low' : pick.confidence,
      staleDays: c.staleDays,
      files: c.files,
    });
  }
  return alerts;
}
