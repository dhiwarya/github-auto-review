import assert from 'node:assert/strict';
import type { SettingsStore } from '../src/settings.ts';

// Adds a repo to Settings, or changes its entry, and leaves everything else as it is.
export function setRepo(cfg: SettingsStore, repo: string, changes: Record<string, unknown> = {}) {
  const all = cfg.all;
  const i = all.repos.findIndex((r) => r.repo.toLowerCase() === repo.toLowerCase());
  const entry = { ...(i < 0 ? { repo } : all.repos[i]), ...changes };
  const res = cfg.update({ ...all, repos: i < 0 ? [...all.repos, entry] : all.repos.map((r, j) => (j === i ? entry : r)) });
  assert.ok(res.ok, res.ok ? '' : `settings were refused: ${res.issues.map((x) => `${x.path}: ${x.message}`).join('; ')}`);
  return cfg.forRepo(repo);
}
