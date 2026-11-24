import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Db } from '../src/db.ts';
import { readPolicy } from '../src/review/policy.ts';
import { SettingsStore } from '../src/settings.ts';
import type { Job } from '../src/types.ts';
import { setRepo } from './helpers.ts';

describe('SettingsStore', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-settings-'));
    db = new Db(dir);
  });

  afterEach(() => {
    db.sql.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts safe: no repos, nothing reviewed, and a new repo starts as a dry run', () => {
    const cfg = new SettingsStore(db);
    assert.equal(cfg.needsSetup, true);
    assert.equal(cfg.isRepoAllowed('any/repo'), false);
    assert.equal(cfg.forRepo('any/repo').enabled, false, 'a repo that is not listed is off');
    const added = setRepo(cfg, 'acme/api');
    assert.equal(cfg.needsSetup, false);
    assert.equal(added.dryRun, true);
    assert.equal(added.mode, 'draft');
    assert.equal(added.profile, 'standard');
    assert.deepEqual(added.reviews, ['code', 'security', 'consistency']);
  });

  it('keeps separate settings for each repo', () => {
    const cfg = new SettingsStore(db);
    setRepo(cfg, 'acme/api', { dryRun: false, mode: 'publish', profile: 'strict', labels: { reviewing: 'bot: reviewing', feedback: 'bot: feedback', approved: 'bot: ok' } });
    setRepo(cfg, 'acme/web', { reviews: { code: true, security: false, consistency: false }, approval: { enabled: false, minConfidence: 'medium' }, skipAuthors: ['someone'], excludeGlobs: ['**/*.gen.ts'] });

    const api = cfg.forRepo('ACME/API');
    assert.deepEqual([api.dryRun, api.mode, api.profile, api.labels.approved], [false, 'publish', 'strict', 'bot: ok']);
    assert.equal(api.approval.enabled, true);
    assert.equal(api.isExcludedFile('src/a.gen.ts'), false);
    assert.equal(api.isExcludedFile('package-lock.json'), true);

    const web = cfg.forRepo('acme/web');
    assert.deepEqual([web.dryRun, web.mode, web.profile, web.labels.approved], [true, 'draft', 'standard', 'dh: approved']);
    assert.deepEqual(web.reviews, ['code']);
    assert.equal(web.approval.enabled, false);
    assert.deepEqual(web.skipAuthors, ['someone']);
    assert.equal(web.isExcludedFile('src/a.gen.ts'), true);
    assert.equal(web.isExcludedFile('package-lock.json'), false);

    // What the whole app shares reaches every repo.
    cfg.update({ ...cfg.all, limits: { ...cfg.limits, maxNits: 2 } });
    assert.equal(cfg.forRepo('acme/api').limits.maxNits, 2);
    assert.equal(cfg.forRepo('acme/web').limits.maxNits, 2);
    assert.deepEqual(new SettingsStore(db).repos.map((r) => r.repo), ['acme/api', 'acme/web'], 'persists across restarts');
  });

  it('lets a repo’s own entry win over a pattern, and switches repos off', () => {
    const cfg = new SettingsStore(db);
    setRepo(cfg, 'acme/*', { mode: 'publish' });
    setRepo(cfg, 'acme/web', { mode: 'draft' });
    setRepo(cfg, 'acme/secret', { enabled: false });
    assert.equal(cfg.forRepo('acme/api').mode, 'publish');
    assert.equal(cfg.forRepo('acme/api').repo, 'acme/*');
    assert.equal(cfg.forRepo('Acme/Web').mode, 'draft');
    assert.equal(cfg.isRepoAllowed('acme/api'), true);
    assert.equal(cfg.isRepoAllowed('acme/secret'), false);
    assert.equal(cfg.isRepoAllowed('other/api'), false);
    setRepo(cfg, 'acme/*', { enabled: false });
    assert.equal(cfg.isRepoAllowed('acme/api'), false);
    assert.equal(cfg.isRepoAllowed('acme/web'), true, 'its own entry is still on');
  });

  it('rejects invalid settings with the field that is wrong, and keeps the old ones', () => {
    const cfg = new SettingsStore(db);
    setRepo(cfg, 'acme/api');
    const res = cfg.update({ ...cfg.all, repos: [...cfg.all.repos, { repo: 'not a repo' }, { repo: 'Acme/API' }], schedule: { ...cfg.schedule, pollIntervalSec: 1 } });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.deepEqual(res.issues.map((i) => i.path).sort(), ['repos.1.repo', 'repos.2.repo', 'schedule.pollIntervalSec']);
    assert.match(res.issues.find((i) => i.path === 'repos.2.repo')!.message, /listed twice/);
    assert.deepEqual(cfg.repos.map((r) => r.repo), ['acme/api']);
  });

  it('needs three different label names, ignoring case as GitHub does', () => {
    const cfg = new SettingsStore(db);
    const res = cfg.update({ ...cfg.all, repos: [{ repo: 'acme/api', labels: { reviewing: 'dh: on review', feedback: 'DH: On Review', approved: ' ' } }] });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.deepEqual(res.issues.map((i) => i.path).sort(), ['repos.0.labels.approved', 'repos.0.labels.feedback']);
    assert.equal(cfg.needsSetup, true, 'nothing was saved');
  });

  it('insists on at least one review per repo', () => {
    const cfg = new SettingsStore(db);
    const none = cfg.update({ ...cfg.all, repos: [{ repo: 'acme/api', reviews: { code: false, security: false, consistency: false } }] });
    assert.equal(none.ok, false);
    if (!none.ok) assert.deepEqual(none.issues.map((i) => i.path), ['repos.0.reviews']);
  });

  it('knows where a repo’s docs are, and takes one exact docs repo', () => {
    const cfg = new SettingsStore(db);
    assert.equal(setRepo(cfg, 'acme/api').docs, null, 'nothing said: the reviewer looks in the repo');
    const api = setRepo(cfg, 'acme/api', { stalePrDays: 14, docs: { paths: ['docs/'], docsRepo: 'https://github.com/acme/handbook', notes: '' } });
    assert.deepEqual(api.docs, { paths: ['docs/'], docsRepo: 'acme/handbook', notes: '' });
    assert.equal(api.stalePrDays, 14);
    const bad = cfg.update({ ...cfg.all, repos: [{ repo: 'acme/api', docs: { paths: [], docsRepo: 'acme/*', notes: '' } }] });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.deepEqual(bad.issues.map((i) => i.path), ['repos.0.docs.docsRepo']);
  });

  it('gives each repo its own context set', () => {
    const cfg = new SettingsStore(db);
    setRepo(cfg, 'acme/api', { context: { sources: [{ repo: 'acme/handbook', path: 'docs' }], notes: 'Amounts are in cents.' } });
    setRepo(cfg, 'acme/web');
    const [api, web] = cfg.contextSets;
    assert.match(api.id, /^[a-z0-9]{10}$/, 'an id is made up when none is given');
    assert.notEqual(api.id, web.id);
    assert.deepEqual([api.repo, api.sources, api.notes], ['acme/api', [{ repo: 'acme/handbook', path: 'docs' }], 'Amounts are in cents.']);
    assert.equal(new SettingsStore(db).forRepo('acme/api').context.id, api.id, 'and kept');
    const shared = cfg.update({ ...cfg.all, repos: cfg.all.repos.map((r) => ({ ...r, context: { ...r.context, id: api.id } })) });
    assert.equal(shared.ok, false);
    if (!shared.ok) assert.deepEqual(shared.issues.map((i) => i.path), ['repos.1.context.id']);
  });

  it('turns a pasted GitHub link into owner/repo', () => {
    const cfg = new SettingsStore(db);
    const res = cfg.update({ ...cfg.all, repos: [{ repo: 'https://github.com/acme/api/pull/12' }, { repo: 'github.com/acme/web.git' }] });
    assert.ok(res.ok);
    assert.deepEqual(cfg.repos.map((r) => r.repo), ['acme/api', 'acme/web']);
  });

  // What the app stored before each repo had its own entry.
  const legacy = {
    reviewProfile: 'strict',
    repos: { allow: ['acme/api', 'acme/*', 'solo/tool'], deny: ['acme/secret'] },
    dryRun: false,
    defaultMode: 'draft',
    repoModes: [{ repo: 'acme/api', mode: 'publish' }, { repo: 'acme/web', mode: 'publish' }, { repo: 'elsewhere/x', mode: 'publish' }],
    reviews: { code: true, security: true, consistency: false },
    repoReviews: [{ repo: 'solo/*', code: true, security: false, consistency: false }],
    consistency: { stalePrDays: 14, docs: [{ repo: 'acme/*', paths: ['docs/'], docsRepo: 'acme/handbook', notes: 'Hand-written.' }] },
    context: [{ id: 'ctx00001', repo: 'acme/*', sources: [{ repo: 'acme/handbook', path: '' }], notes: 'Cents.' }],
    skipAuthors: ['a-bot'],
    excludeGlobs: ['**/*.lock'],
    approval: { enabled: true, minConfidence: 'medium' },
    labels: { reviewing: 'r', feedback: 'f', approved: 'a' },
    models: { provider: 'claude' },
    schedule: { maxReviewsPerHour: 20 },
    limits: { maxNits: 3 },
    strict: { maxRuns: 50, maxContinuations: 2 },
    keepCheckouts: true,
  };

  it('turns the earlier app-wide settings into one entry per repo, once', () => {
    db.setKv('settings', JSON.stringify(legacy));
    const cfg = new SettingsStore(db);
    // acme/web was covered by acme/* but had an exception of its own, so it gets its own entry.
    assert.deepEqual(cfg.repos.map((r) => [r.repo, r.enabled]), [['acme/secret', false], ['acme/api', true], ['acme/*', true], ['solo/tool', true], ['acme/web', true]]);
    assert.deepEqual([cfg.forRepo('acme/web').mode, cfg.forRepo('acme/web').docs?.docsRepo], ['publish', 'acme/handbook']);

    const api = cfg.forRepo('acme/api');
    assert.deepEqual([api.profile, api.dryRun, api.mode, api.stalePrDays], ['strict', false, 'publish', 14]);
    assert.deepEqual(api.reviews, ['code', 'security']);
    assert.deepEqual(api.docs, { paths: ['docs/'], docsRepo: 'acme/handbook', notes: 'Hand-written.' });
    assert.deepEqual(api.context, { id: 'ctx00001', sources: [{ repo: 'acme/handbook', path: '' }], notes: 'Cents.' });
    assert.deepEqual([api.labels.approved, api.skipAuthors, api.approval.minConfidence], ['a', ['a-bot'], 'medium']);
    assert.equal(api.isExcludedFile('yarn.lock'), true);

    const rest = cfg.forRepo('acme/other');
    assert.deepEqual([rest.repo, rest.mode, rest.context.sources.length], ['acme/*', 'draft', 1]);
    assert.notEqual(rest.context.id, 'ctx00001', 'a context set belongs to one entry');
    assert.deepEqual(cfg.forRepo('solo/tool').reviews, ['code']);
    assert.equal(cfg.isRepoAllowed('acme/secret'), false);

    // The rest of the app's settings carry over unchanged.
    assert.deepEqual([cfg.models.provider, cfg.schedule.maxReviewsPerHour, cfg.limits.maxNits, cfg.strict.maxRuns, cfg.keepCheckouts], ['claude', 20, 3, 50, true]);

    // Stored in the new shape straight away, with the old one kept beside it.
    assert.ok(Array.isArray(JSON.parse(db.getKv('settings')!).repos));
    assert.deepEqual(JSON.parse(db.getKv('settings:before-repos')!).repos.allow, legacy.repos.allow);
    assert.equal(new SettingsStore(db).forRepo('acme/other').context.id, rest.context.id);
  });

  it('reads the settings an earlier review kept, as they applied to its repo', () => {
    const policy = readPolicy({ repo: 'acme/web', review_policy: JSON.stringify({ version: 2, settings: legacy }) } as Job)!;
    assert.deepEqual([policy.settings.repo, policy.settings.profile, policy.settings.mode, policy.settings.approval.minConfidence], ['acme/web', 'strict', 'publish', 'medium']);
    assert.deepEqual(policy.settings.reviews, { code: true, security: true, consistency: false });
    assert.equal(policy.settings.docs.docsRepo, 'acme/handbook');
    assert.equal(policy.settings.strict.maxRuns, 50);
    assert.equal(readPolicy({ repo: 'acme/other', review_policy: JSON.stringify({ version: 2, settings: legacy }) } as Job)!.settings.mode, 'draft');
  });

  it('drops settings that no longer exist, such as the old label prefix', () => {
    db.setKv('settings', JSON.stringify({ repos: { allow: ['acme/api'] }, labels: { prefix: 'ai-review', blockerLabelInDraft: true } }));
    const cfg = new SettingsStore(db);
    assert.deepEqual(cfg.forRepo('acme/api').labels, { reviewing: 'dh: on review', feedback: 'dh: feedback', approved: 'dh: approved' });
    assert.deepEqual(cfg.repos.map((r) => r.repo), ['acme/api']);
  });

  it('imports an old reviewer.config.json once, then renames it', () => {
    const file = path.join(dir, 'reviewer.config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        repos: { allow: ['acme/api', 'acme/web'] },
        dryRun: true,
        repoModes: { 'acme/web': 'publish' },
        models: { provider: 'claude', main: { provider: 'claude' }, crossVerify: false },
        server: { host: '127.0.0.1', port: 4477 },
        dataDir: './data',
      }),
    );
    const cfg = new SettingsStore(db);
    const message = cfg.importLegacyFile(file);
    assert.match(message ?? '', /Imported/);
    assert.deepEqual(cfg.repos.map((r) => r.repo), ['acme/api', 'acme/web']);
    assert.equal(cfg.models.provider, 'claude');
    assert.equal(cfg.forRepo('acme/web').mode, 'publish');
    assert.equal(cfg.forRepo('acme/api').mode, 'draft');
    assert.ok(!fs.existsSync(file));
    assert.ok(fs.existsSync(path.join(dir, 'reviewer.config.imported.json')));
    // Once settings are stored, an old file is never read again.
    fs.writeFileSync(file, JSON.stringify({ repos: { allow: ['other/repo'] } }));
    assert.equal(new SettingsStore(db).importLegacyFile(file), null);
  });
});
