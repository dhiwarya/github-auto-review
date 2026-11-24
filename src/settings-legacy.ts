// Settings used to be one flat list of app-wide values, with a repos list and per-repo
// exceptions beside it. These turn that shape into today's, where every repo has its own
// entry, so stored settings and the copies kept with earlier reviews keep working.
import picomatch from 'picomatch';

type Old = Record<string, any>;

const LEGACY_KEYS = ['dryRun', 'defaultMode', 'reviewProfile', 'repoModes', 'reviews', 'repoReviews', 'consistency', 'context', 'skipAuthors', 'excludeGlobs', 'approval', 'labels'];

export function isLegacySettings(raw: unknown): raw is Old {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const old = raw as Old;
  if (Array.isArray(old.repos)) return false;
  return (old.repos !== undefined && typeof old.repos === 'object') || LEGACY_KEYS.some((k) => k in old);
}

const glob = (pattern: string, repo: string) => picomatch.isMatch(repo.toLowerCase(), pattern.toLowerCase());
const appPart = (old: Old) => ({ strict: old.strict, models: old.models, schedule: old.schedule, limits: old.limits, keepCheckouts: old.keepCheckouts });

// One repo's part of the old settings. `matches` says whether an old exception written for
// that pattern applied to it; the first one that did won.
function repoPart(old: Old, repo: string, matches: (pattern: string) => boolean) {
  const first = (list: unknown): Old | undefined =>
    Array.isArray(list) ? list.find((o) => o && typeof o.repo === 'string' && matches(o.repo)) : undefined;
  const reviews = first(old.repoReviews) ?? old.reviews;
  const docs = first(old.consistency?.docs);
  const context = first(old.context);
  return {
    repo,
    enabled: true,
    dryRun: old.dryRun,
    mode: first(old.repoModes)?.mode ?? old.defaultMode,
    profile: old.reviewProfile,
    reviews: reviews && { code: reviews.code, security: reviews.security, consistency: reviews.consistency },
    approval: old.approval,
    labels: old.labels,
    skipAuthors: old.skipAuthors,
    excludeGlobs: old.excludeGlobs,
    stalePrDays: old.consistency?.stalePrDays,
    docs: docs && { paths: docs.paths, docsRepo: docs.docsRepo, notes: docs.notes },
    context: context && { id: context.id, sources: context.sources, notes: context.notes },
  };
}

// The whole of the old settings: one entry per repo that was listed. Repos that were on the
// "never review" list become entries that are switched off, placed first so they still win
// over a pattern.
export function fromLegacySettings(old: Old): unknown {
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : []);
  const allow = strings(old.repos?.allow);
  const deny = strings(old.repos?.deny);
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const ids = new Set<string>();
  const repos = allow.map((name) => {
    const entry = repoPart(old, name, (pattern) => same(pattern, name) || glob(pattern, name));
    if (deny.some((d) => same(d, name) || glob(d, name))) entry.enabled = false;
    // A context set belongs to one entry; a second repo that shared it starts its own.
    if (entry.context?.id && ids.has(entry.context.id)) entry.context = { ...entry.context, id: undefined };
    if (entry.context?.id) ids.add(entry.context.id);
    return entry;
  });
  const off = deny.filter((d) => !allow.some((a) => same(a, d))).map((name) => ({ ...repoPart(old, name, (pattern) => same(pattern, name) || glob(pattern, name)), context: undefined, enabled: false }));
  // An exception written for one repo that a pattern covered becomes that repo's own entry.
  const listed = new Set([...allow, ...deny].map((r) => r.toLowerCase()));
  const own: unknown[] = [];
  for (const o of [old.repoModes, old.repoReviews, old.consistency?.docs, old.context].flatMap((l) => (Array.isArray(l) ? l : []))) {
    const name = typeof o?.repo === 'string' ? o.repo.trim() : '';
    if (!name || /[*?]/.test(name) || listed.has(name.toLowerCase()) || !allow.some((a) => glob(a, name))) continue;
    listed.add(name.toLowerCase());
    const entry = repoPart(old, name, (pattern) => glob(pattern, name));
    if (deny.some((d) => glob(d, name))) entry.enabled = false;
    if (entry.context?.id && ids.has(entry.context.id)) entry.context = { ...entry.context, id: undefined };
    if (entry.context?.id) ids.add(entry.context.id);
    own.push(entry);
  }
  return { repos: [...off, ...repos, ...own], ...appPart(old) };
}

// The old settings as they applied to one repo.
export function fromLegacyRepoSettings(old: Old, repo: string): unknown {
  return { ...repoPart(old, repo, (pattern) => glob(pattern, repo)), ...appPart(old) };
}
