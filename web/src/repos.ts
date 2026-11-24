import type { RepoSummary } from '../../src/types.ts';

const isPattern = (repo: string) => /[*?]/.test(repo);

// Whether a Settings entry such as "owner/*" covers a repo. The app decides for real; this
// is only for showing which entry applies.
export function matchesRepo(pattern: string, repo: string): boolean {
  const source = pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`).test(repo.toLowerCase());
}

// The entry that decides for a repo: its own, otherwise the first pattern that matches.
export function entryFor<T extends { repo: string }>(repos: T[], repo: string): T | undefined {
  const name = repo.toLowerCase();
  return repos.find((r) => r.repo.toLowerCase() === name) ?? repos.find((r) => isPattern(r.repo) && matchesRepo(r.repo, repo));
}

export const reviewedRepos = (repos: RepoSummary[] | undefined) => (repos ?? []).filter((r) => r.enabled);
