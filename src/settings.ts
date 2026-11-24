import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { bus } from './bus.ts';
import type { Db } from './db.ts';
import { fromLegacySettings, isLegacySettings } from './settings-legacy.ts';
import { RepoSchema, SettingsSchema, type RepoConfig, type RepoSettingsData, type Settings, type SettingsIssue } from './settings-schema.ts';
import { REVIEW_TYPES, type Provider, type ReviewType } from './types.ts';

export { SettingsSchema, type RepoConfig, type RepoSettingsData, type Settings, type SettingsIssue };

const KEY = 'settings';
type Matcher = (s: string) => boolean;
const never: Matcher = () => false;
const compile = (patterns: string[], opts?: picomatch.PicomatchOptions): Matcher =>
  patterns.length ? picomatch(patterns, opts) : never;
const isPattern = (repo: string) => /[*?]/.test(repo);

type Models = Settings['models'];
const modelChain = (models: Models, p: Provider): (string | null)[] => [...new Set([models[p].model, ...models[p].fallbackModels])];
// The chosen provider first, then the other one if falling back is on.
const providerOrder = (models: Models): Provider[] => {
  const other: Provider = models.provider === 'claude' ? 'codex' : 'claude';
  return models.fallbackToOther ? [models.provider, other] : [models.provider];
};

// One repo's settings, with the app's alongside: everything a review of that repo needs.
// Read live through SettingsStore.forRepo, or rebuilt from the copy a job keeps.
export class RepoSettings {
  readonly data: RepoSettingsData;
  private readonly excluded: Matcher;

  constructor(data: RepoSettingsData) {
    this.data = data;
    this.excluded = compile(data.excludeGlobs, { dot: true });
  }

  get repo() { return this.data.repo; }
  get enabled() { return this.data.enabled; }
  get dryRun() { return this.data.dryRun; }
  get mode() { return this.data.mode; }
  get profile() { return this.data.profile; }
  get approval() { return this.data.approval; }
  get labels() { return this.data.labels; }
  get skipAuthors() { return this.data.skipAuthors; }
  get stalePrDays() { return this.data.stalePrDays; }
  get context() { return this.data.context; }
  get strict() { return this.data.strict; }
  get models() { return this.data.models; }
  get schedule() { return this.data.schedule; }
  get limits() { return this.data.limits; }
  get keepCheckouts() { return this.data.keepCheckouts; }

  // The reviews a PR in this repo gets, in a fixed order.
  get reviews(): ReviewType[] {
    return REVIEW_TYPES.filter((r) => this.data.reviews[r]);
  }

  // Where this repo's docs live, if you said.
  get docs(): RepoConfig['docs'] | null {
    const d = this.data.docs;
    return d.paths.length || d.docsRepo || d.notes ? d : null;
  }

  isExcludedFile(file: string): boolean {
    return this.excluded(file);
  }

  modelChain(p: Provider) { return modelChain(this.data.models, p); }
  providerOrder() { return providerOrder(this.data.models); }
}

// The app's settings, stored in its database and edited from the dashboard. Every part of
// the app reads them through this object at the moment it needs them, so a saved change
// applies right away without a restart.
export class SettingsStore {
  private readonly db: Db;
  private data: Settings;
  // The matching entry for each repo asked about, until the settings change.
  private readonly resolved = new Map<string, RepoSettings>();

  constructor(db: Db, snapshot?: Settings) {
    this.db = db;
    this.data = SettingsStore.defaults();
    const raw = snapshot ? JSON.stringify(snapshot) : db.getKv(KEY);
    if (raw) {
      let input = JSON.parse(raw);
      // Settings from before each repo had its own entry.
      const legacy = isLegacySettings(input);
      if (legacy) input = fromLegacySettings(input);
      const upgrade = !snapshot && (legacy || (input.strict && input.strict.maxContinuations === undefined));
      if (input.strict && input.strict.maxContinuations === undefined) {
        if (input.strict.maxBatches === 8) input.strict.maxBatches = 16;
        if (input.strict.maxRuns === 32) input.strict.maxRuns = 64;
      }
      const parsed = SettingsSchema.safeParse(input);
      if (parsed.success) {
        this.data = parsed.data;
        // The old shape is kept beside it, in case you go back to an earlier version.
        if (legacy && !snapshot) db.setKv(`${KEY}:before-repos`, raw);
        if (upgrade) db.setKv(KEY, JSON.stringify(this.data));
      }
      else console.error('[settings] stored settings are invalid; using defaults until they are saved again', parsed.error.issues);
    }
  }

  static defaults(): Settings {
    return SettingsSchema.parse({});
  }

  get all(): Settings {
    return structuredClone(this.data);
  }

  snapshot(data = this.all): SettingsStore {
    return new SettingsStore(this.db, data);
  }

  get stored(): boolean {
    return this.db.getKv(KEY) !== null;
  }

  update(input: unknown): { ok: true; settings: Settings } | { ok: false; issues: SettingsIssue[] } {
    const parsed = SettingsSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
    }
    this.data = parsed.data;
    this.db.setKv(KEY, JSON.stringify(this.data));
    this.resolved.clear();
    bus.emit('settings');
    bus.overviewChanged();
    return { ok: true, settings: this.all };
  }

  // One-time import from the config file used before settings moved into the dashboard.
  // The file is renamed afterwards so it's clear it no longer does anything.
  importLegacyFile(file: string): string | null {
    if (this.stored || !fs.existsSync(file)) return null;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return `Couldn't read ${file} to import it: ${err instanceof Error ? err.message : err}`;
    }
    delete raw.server;
    delete raw.dataDir;
    if (raw.repoModes && !Array.isArray(raw.repoModes)) {
      raw.repoModes = Object.entries(raw.repoModes as Record<string, string>).map(([repo, mode]) => ({ repo, mode }));
    }
    const result = this.update(isLegacySettings(raw) ? fromLegacySettings(raw) : raw);
    if (!result.ok) {
      return `Didn't import ${file}: ${result.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}. Set things up in the dashboard instead.`;
    }
    const backup = path.join(path.dirname(file), 'reviewer.config.imported.json');
    fs.renameSync(file, backup);
    return `Imported settings from ${path.basename(file)} (renamed to ${path.basename(backup)}; you can delete it). Settings now live in the dashboard.`;
  }

  // ---- sections, read live

  get repos() { return this.data.repos; }
  get strict() { return this.data.strict; }
  get models() { return this.data.models; }
  get schedule() { return this.data.schedule; }
  get limits() { return this.data.limits; }
  get keepCheckouts() { return this.data.keepCheckouts; }

  // ---- helpers

  // Nothing is reviewed until a repo is listed and switched on.
  get needsSetup(): boolean {
    return !this.data.repos.some((r) => r.enabled);
  }

  // The entry that decides for this repo: its own if it has one, otherwise the first
  // pattern that matches it.
  entryFor(repo: string): RepoConfig | null {
    const name = repo.toLowerCase();
    return (
      this.data.repos.find((r) => r.repo.toLowerCase() === name) ??
      this.data.repos.find((r) => isPattern(r.repo) && picomatch.isMatch(name, r.repo.toLowerCase())) ??
      null
    );
  }

  isRepoAllowed(repo: string): boolean {
    return this.entryFor(repo)?.enabled === true;
  }

  // This repo's settings as they are now. A repo that isn't listed gets the defaults,
  // switched off.
  forRepo(repo: string): RepoSettings {
    const key = repo.toLowerCase();
    let hit = this.resolved.get(key);
    if (!hit) {
      const entry = this.entryFor(repo) ?? RepoSchema.parse({ repo, enabled: false });
      const { repos: _repos, ...app } = this.all;
      hit = new RepoSettings({ ...structuredClone(entry), ...app });
      this.resolved.set(key, hit);
    }
    return hit;
  }

  // Every repo's context set, for the baseline store.
  get contextSets(): (RepoConfig['context'] & { repo: string })[] {
    return this.data.repos.map((r) => ({ ...r.context, repo: r.repo }));
  }

  modelChain(p: Provider) { return modelChain(this.data.models, p); }
  providerOrder() { return providerOrder(this.data.models); }
}
