// What can be configured, with defaults. Edited from the dashboard's Settings page and
// stored in the app's database. Only zod is imported so the dashboard can share the types.
import { z } from 'zod';

const provider = z.enum(['claude', 'codex']);
const mode = z.enum(['draft', 'publish']);
// A pasted GitHub link becomes owner/repo.
const repoPattern = z
  .string()
  .trim()
  .transform((v) => {
    const link = /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(v);
    return link ? `${link[1]}/${link[2].replace(/\.git$/, '')}` : v;
  })
  .pipe(z.string().regex(/^[\w.*?-]+\/[\w.*?-]+$/, 'Use owner/repo, or a pattern such as owner/*'));
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');
const int = (min: number, max: number) => z.number().int().min(min).max(max);
// An exact repository, not a pattern. A pasted GitHub link becomes owner/repo.
const repoName = repoPattern.pipe(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'Use one repository: owner/repo'));
// Which reviews run. Each is a separate model run, so fewer means less usage.
const reviewTypes = {
  code: z.boolean().default(true),
  security: z.boolean().default(true),
  consistency: z.boolean().default(true),
};
const atLeastOne = (r: { code: boolean; security: boolean; consistency: boolean }) => r.code || r.security || r.consistency;
const labelName = z.string().trim().min(1, 'Give the label a name').max(50, 'GitHub allows up to 50 characters');
const LABEL_KINDS = ['reviewing', 'feedback', 'approved'] as const;

// A provider's models, tried in order. null = the CLI's own default model.
const providerModels = z.object({
  model: z.string().trim().min(1).nullable().default(null),
  fallbackModels: z.array(z.string().trim().min(1)).default([]),
});

// A context set's id names its baseline in the database. One is made up when a repo is added.
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

// Everything that is decided per repo. A repo is only reviewed when it has an entry here.
export const RepoSchema = z.object({
  // One repository, or a pattern such as owner/* for every repo it matches that has no
  // entry of its own.
  repo: repoPattern,
  // Off: the entry and its context are kept, but its pull requests aren't reviewed.
  enabled: z.boolean().default(true),
  // While true, reviews run but nothing is posted to GitHub and no labels change.
  dryRun: z.boolean().default(true),
  mode: mode.default('draft'),
  profile: z.enum(['standard', 'strict']).default('standard'),
  // The reviews every PR gets.
  reviews: z.object(reviewTypes).refine(atLeastOne, 'Turn on at least one review').prefault({}),
  // Approve the PR for you when a published review finds no open blockers and is
  // confident enough. Drafts are never approved: you decide when you submit them.
  approval: z
    .object({
      enabled: z.boolean().default(true),
      minConfidence: z.enum(['high', 'medium']).default('high'),
    })
    .prefault({}),
  // Merge the PR for you once you've approved its latest commit, nobody else asked for
  // changes, and GitHub says it can be merged (required checks passed, branch rules met,
  // no conflicts). Never during a dry run.
  merge: z
    .object({
      enabled: z.boolean().default(false),
      method: z.enum(['squash', 'merge', 'rebase']).default('squash'),
      // How long to wait after the approval, so there is time to hold it from the dashboard.
      delayMin: int(0, 1440).default(10),
      // Delete the PR's branch after merging, when it's in the same repo.
      deleteBranch: z.boolean().default(false),
    })
    .prefault({}),
  // A PR carries one of these at a time. "reviewing" stays while your draft is unsubmitted.
  labels: z
    .object({
      reviewing: labelName.default('dh: on review'),
      feedback: labelName.default('dh: feedback'),
      approved: labelName.default('dh: approved'),
    })
    .superRefine((labels, ctx) => {
      // GitHub label names ignore case.
      const seen = new Map<string, string>();
      for (const kind of LABEL_KINDS) {
        const key = labels[kind].toLowerCase();
        const other = seen.get(key);
        if (other) ctx.addIssue({ code: 'custom', path: [kind], message: `Same name as the ${other} label` });
        else seen.set(key, kind);
      }
    })
    .prefault({}),
  skipAuthors: z.array(z.string().trim().min(1)).default(['dependabot[bot]', 'renovate[bot]', 'github-actions[bot]']),
  excludeGlobs: z
    .array(z.string().trim().min(1))
    .default([
      '**/package-lock.json',
      '**/pnpm-lock.yaml',
      '**/yarn.lock',
      '**/*.lock',
      '**/go.sum',
      '**/vendor/**',
      '**/dist/**',
      '**/*.min.js',
      '**/*.snap',
      '**/*.generated.*',
    ]),
  // Another open PR with no activity for this long is treated as unmaintained: an
  // overlap with it is still mentioned, but with low confidence.
  stalePrDays: int(1, 3650).default(30),
  // Where the docs live, for the consistency review. Left empty, the reviewer looks for
  // docs in the repo itself.
  docs: z
    .object({
      // Folders or files in the reviewed repo, e.g. docs/ or README.md.
      paths: z.array(z.string().trim().min(1)).default([]),
      // Another repository that holds the docs, checked out read-only next to the PR.
      docsRepo: repoName.nullable().default(null),
      // Anything else the reviewer should know about the docs, in your words.
      notes: z.string().trim().max(2000, 'Up to 2,000 characters').default(''),
    })
    .prefault({}),
  // Markdown that describes the repo, kept as a searchable graph ("baseline") and looked up
  // for every review. It comes from context repositories and from files you upload.
  context: z
    .object({
      id: z.string().regex(/^[a-z0-9]{6,20}$/).default(newId),
      // Repositories whose markdown is the context, optionally one folder of each.
      sources: z.array(z.object({ repo: repoName, path: z.string().trim().max(200).default('') })).default([]),
      // Anything else every reviewer of this repo should know, in your words.
      notes: z.string().trim().max(2000, 'Up to 2,000 characters').default(''),
    })
    .prefault({}),
});

// What the whole app shares: the reviewer's models and how much work it may do.
const appShape = {
  strict: z.object({
    passTimeoutSec: int(60, 3600).default(1800),
    maxDiffChars: int(10_000, 1_000_000).default(500_000),
    claudeMaxTurns: int(5, 200).default(120),
    claudeEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
    maxBatches: int(1, 40).default(16),
    maxRuns: int(3, 200).default(64),
    maxContinuations: int(0, 4).default(2),
    verificationReserve: int(1, 40).default(8),
  }).prefault({}),
  models: z
    .object({
      // The one provider that does a whole review.
      provider: provider.default('codex'),
      // When every model of that provider is unavailable (usage limit, signed out), use the other one.
      fallbackToOther: z.boolean().default(true),
      // Re-check blockers and majors in a second, separate run before posting them.
      doubleCheck: z.boolean().default(true),
      codex: providerModels.prefault({ model: 'gpt-6.1-sol', fallbackModels: ['gpt-6-sol'] }),
      claude: providerModels.prefault({ model: 'claude-opus-5-5', fallbackModels: ['claude-opus-4-8'] }),
      claudeEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
    })
    .prefault({}),
  schedule: z
    .object({
      // GitHub allows 30 search requests a minute; each check uses one.
      pollIntervalSec: int(5, 3600).default(5),
      // How often to check which comments you kept in submitted drafts.
      syncIntervalSec: int(30, 3600).default(60),
      maxReviewsPerHour: int(1, 100).default(6),
      concurrency: int(1, 4).default(1),
      // Optional daily window (local time) where no reviews start, to keep your quota for yourself.
      pauseBetween: z.object({ start: clock, end: clock }).nullable().default(null),
      // How long to rest a model after it reports a usage limit.
      quotaBackoffMin: int(1, 1440).default(30),
    })
    .prefault({}),
  limits: z
    .object({
      // Above this many changed lines (after exclusions) the review covers top risks only.
      largePrLines: int(100, 100_000).default(1500),
      maxDiffChars: int(10_000, 1_000_000).default(200_000),
      maxNits: int(0, 20).default(5),
      // How much of a repo's context a review may be given, in characters.
      contextChars: int(1000, 60_000).default(12_000),
      passTimeoutSec: int(60, 3600).default(900),
      claudeMaxTurns: int(5, 200).default(60),
      maxAttempts: int(1, 10).default(3),
    })
    .prefault({}),
  // Keep each PR checkout after its review, for debugging.
  keepCheckouts: z.boolean().default(false),
};

export const SettingsSchema = z.object({
  // Nothing outside this list is ever reviewed. Empty until you add repos in Settings.
  repos: z
    .array(RepoSchema)
    .superRefine((repos, ctx) => {
      const names = new Set<string>();
      const ids = new Set<string>();
      for (const [i, r] of repos.entries()) {
        if (names.has(r.repo.toLowerCase())) ctx.addIssue({ code: 'custom', path: [i, 'repo'], message: 'This repo is listed twice' });
        names.add(r.repo.toLowerCase());
        if (ids.has(r.context.id)) ctx.addIssue({ code: 'custom', path: [i, 'context', 'id'], message: 'Two repos share a context id' });
        ids.add(r.context.id);
      }
    })
    .default([]),
  ...appShape,
});

// One repo's settings together with the app's: what a review of that repo runs with. A
// job keeps a copy from when it started, so a later change doesn't alter it halfway.
export const RepoSettingsSchema = z.object({ ...RepoSchema.shape, ...appShape });

export type Settings = z.infer<typeof SettingsSchema>;
export type RepoConfig = z.infer<typeof RepoSchema>;
export type RepoSettingsData = z.infer<typeof RepoSettingsSchema>;

export interface SettingsIssue {
  path: string; // e.g. "repos.0.labels.reviewing"
  message: string;
}
