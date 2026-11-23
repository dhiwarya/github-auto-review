import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ContextStore } from '../src/context/store.ts';
import { Db } from '../src/db.ts';
import { RepoCache } from '../src/git/mirror.ts';
import type { GitHub } from '../src/github/client.ts';
import { isOwnComment } from '../src/github/publish.ts';
import type { Router, RouterTask } from '../src/llm/router.ts';
import { ReviewPipeline } from '../src/review/pipeline.ts';
import { consistencyInstructions, mainInstructions, strictInstructions } from '../src/review/prompts.ts';
import { relatedAlerts, type RelatedCandidate } from '../src/review/related.ts';
import { SettingsStore } from '../src/settings.ts';
import type { Evidence, RelatedPr } from '../src/types.ts';

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const exec = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=Tester', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

// Two local repositories standing in for GitHub. The code repo has PR 7 (under review),
// PR 8 and PR 9 (both also change app.js) and PR 10 (changes something else). The docs
// repo has one page.
function makeRemotes(root: string) {
  const work = path.join(root, 'work');
  const remote = path.join(root, 'api.git');
  fs.mkdirSync(work);
  const git = (...args: string[]) => exec(work, ...args);
  git('init', '-q');
  fs.writeFileSync(path.join(work, 'app.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(work, 'other.js'), 'export const y = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'Add app');
  const base = git('rev-parse', 'HEAD');
  const branch = (name: string, file: string, line: string) => {
    git('checkout', '-q', '-b', name, 'main');
    fs.appendFileSync(path.join(work, file), line);
    git('commit', '-qam', name);
    return git('rev-parse', 'HEAD');
  };
  const head = branch('pr7', 'app.js', 'export const mul = (a, b) => a * b;\n');
  branch('pr8', 'app.js', 'export const div = (a, b) => a / b;\n');
  branch('pr9', 'app.js', 'export const pow = (a, b) => a ** b;\n');
  branch('pr10', 'other.js', 'export const z = 2;\n');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git('push', '-q', remote, 'main:refs/heads/main', 'pr7:refs/pull/7/head', 'pr8:refs/pull/8/head', 'pr9:refs/pull/9/head', 'pr10:refs/pull/10/head');

  const docsWork = path.join(root, 'docs-work');
  const docsRemote = path.join(root, 'handbook.git');
  fs.mkdirSync(docsWork);
  exec(docsWork, 'init', '-q');
  fs.writeFileSync(path.join(docsWork, 'guide.md'), 'The app can add numbers.\n');
  fs.writeFileSync(path.join(docsWork, 'multiply.md'), '# Multiplying\nThe mul export multiplies two numbers. See the [guide](guide.md).\n');
  exec(docsWork, 'add', '.');
  exec(docsWork, 'commit', '-qm', 'Guide');
  execFileSync('git', ['init', '-q', '--bare', docsRemote]);
  exec(docsWork, 'push', '-q', docsRemote, 'main:refs/heads/main');
  execFileSync('git', ['--git-dir', docsRemote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  return { remote, docsRemote, base, head };
}

function fakeGitHub(base: string, head: string) {
  const pr = (number: number, title: string, updated: string) => ({ number, title, html_url: `https://github.com/acme/api/pull/${number}`, user: { login: 'someone' }, draft: false, updated_at: updated });
  return {
    me: 'me',
    token: 't',
    rateLimits: new Map(),
    octokit: {
      paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
      graphql: async () => {
        throw new Error('no graphql here');
      },
      rest: {
        pulls: {
          get: async () => ({
            data: {
              title: 'Add mul', body: '', html_url: 'https://github.com/acme/api/pull/7', user: { login: 'author' }, draft: false, state: 'open',
              head: { sha: head, ref: 'pr7' }, base: { sha: base, ref: 'main', repo: { full_name: 'acme/api' } },
              additions: 1, deletions: 0, changed_files: 1, labels: [], requested_reviewers: [{ login: 'me' }],
            },
          }),
          listFiles: async () => ({ data: [{ filename: 'app.js', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n export const add = (a, b) => a + b;\n+export const mul = (a, b) => a * b;' }] }),
          list: async () => ({ data: [pr(7, 'Add mul', daysAgo(0)), pr(8, 'Add div', daysAgo(2.5)), pr(9, 'Add pow', daysAgo(90.5)), pr(10, 'Other', daysAgo(1.5))] }),
        },
      },
    },
  } as unknown as GitHub;
}

const review = (over: Record<string, unknown> = {}) => ({
  summary: 'Fine.',
  spec_alignment: { status: 'not_checked', notes: '' },
  findings: [],
  questions_for_author: [],
  resolved_previous_ids: [],
  review_confidence: { level: 'high', reason: 'Read it all.' },
  ...over,
});

describe('choosing the reviews', { skip: process.platform === 'win32' && 'uses POSIX paths in the stand-in remotes' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-reviews-'));
  const { remote, docsRemote, base, head } = makeRemotes(root);
  // A fresh database for each test; the repo copies are shared.
  const dbs: Db[] = [];
  const fresh = (name: string) => {
    fs.mkdirSync(path.join(root, name));
    const db = new Db(path.join(root, name));
    dbs.push(db);
    const cfg = new SettingsStore(db);
    cfg.update({
      ...cfg.all,
      repos: { allow: ['acme/api'], deny: [] },
      consistency: { stalePrDays: 30, docs: [{ repo: 'acme/*', paths: ['docs/'], docsRepo: 'acme/handbook', notes: 'The guide is hand-written.' }] },
    });
    return { db, cfg };
  };
  const cache = new RepoCache(path.join(root, 'cache'), null, (repo) => (repo === 'acme/handbook' ? docsRemote : remote));
  after(() => {
    for (const db of dbs) db.sql.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const job = (db: Db, reviews: string) =>
    db.insertJob({
      repo: 'acme/api', pr_number: 7, pr_title: 'Add mul', pr_url: 'https://github.com/acme/api/pull/7', author: 'author', head_sha: head,
      base_sha: base, since_sha: null, reviews, mode: 'publish', source: 'manual', dry_run: 1, state: 'queued', additions: 1, deletions: 0, changed_files: 1,
    });

  // A router that records each run and answers from a table.
  function fakeRouter(answers: Record<string, unknown>) {
    const runs: { purpose: string; prompt: string; instructions: string; sawDocs: boolean }[] = [];
    const router = {
      run: async (_jobId: number, purpose: string, task: RouterTask) => {
        runs.push({ purpose, prompt: task.prompt, instructions: task.instructions, sawDocs: fs.existsSync(path.join(task.cwd, '.external-docs/handbook/guide.md')) });
        return { provider: 'codex' as const, model: 'gpt-6.1-sol', output: answers[purpose] };
      },
    } as unknown as Router;
    return { router, runs };
  }

  it('runs only the chosen reviews, with the docs repo and other PRs for consistency', async () => {
    const { db, cfg } = fresh('one');
    const { router, runs } = fakeRouter({
      security: review(),
      consistency: review({
        summary: 'Matches, but the guide is stale.',
        spec_alignment: { status: 'no_spec', notes: '' },
        findings: [{ category: 'design', severity: 'minor', confidence: 'high', file: '.external-docs/handbook/guide.md', line: 1, title: 'Guide omits multiplying', evidence: 'The app can add numbers.', problem: 'The guide lists only adding.', suggestion: 'Mention multiplying.' }],
        related_prs: [
          { number: 8, relation: 'overlap', note: 'Both add an export to app.js.', confidence: 'high' },
          { number: 9, relation: 'conflict', note: 'Also adds an export.', confidence: 'high' },
          { number: 10, relation: 'duplicate', note: 'Made up.', confidence: 'high' },
        ],
      }),
    });
    const j = job(db, 'security,consistency');
    await new ReviewPipeline(fakeGitHub(base, head), cfg, db, router, cache).run(j, new AbortController().signal);

    assert.deepEqual(runs.map((r) => r.purpose).sort(), ['consistency', 'security'], 'no code review, no double-check');
    const consistency = runs.find((r) => r.purpose === 'consistency')!;
    assert.ok(consistency.sawDocs, 'the docs repo was checked out inside the PR checkout');
    assert.match(consistency.prompt, /In this repository: `docs\/`\./);
    assert.match(consistency.prompt, /docs repository acme\/handbook is checked out read-only at `\.external-docs\/handbook\/`/);
    assert.match(consistency.prompt, /The guide is hand-written\./);
    assert.match(consistency.prompt, /### #8: Add div/);
    assert.match(consistency.prompt, /### #9: Add pow \(@someone, last activity 90 day\(s\) ago, UNMAINTAINED\)/);
    assert.doesNotMatch(consistency.prompt, /#10/, 'a PR that shares no file is not shown');
    assert.doesNotMatch(runs.find((r) => r.purpose === 'security')!.prompt, /Where the docs are|Other open pull requests/);

    const done = db.job(j.id)!;
    assert.equal(done.state, 'done');
    assert.equal(done.spec_status, 'no_spec');
    assert.equal(done.confidence, 'low');
    assert.match(done.confidence_notes ?? '', /No code review ran/);
    const related = JSON.parse(done.related_prs ?? '[]') as RelatedPr[];
    assert.deepEqual(related.map((r) => [r.number, r.relation, r.confidence, r.staleDays]), [[8, 'overlap', 'high', null], [9, 'conflict', 'low', 90]], 'unmaintained means low; unknown PRs are dropped');

    const [finding] = db.findings(j.id);
    assert.equal(finding.category, 'requirement', 'consistency findings are requirement or docs');
    assert.equal(finding.status, 'summary', 'a page outside the PR can only go in the summary');
    assert.match(done.review_body ?? '', /\*\*Related open PRs\*\* \(for awareness, not a request to change anything\)\n\n- #8 \(overlap, high confidence\): Both add an export to app\.js\.\n- #9 \(conflict, low confidence: no activity for 90 days\): Also adds an export\./);
    assert.match(done.review_body ?? '', /Covers security and consistency only; no code review was run\./);
    assert.doesNotMatch(done.review_body ?? '', /Auto Reviewer/);

    const evidence = db.evidence(j.id) as Evidence;
    assert.deepEqual(evidence.docs, { paths: ['docs/'], repo: 'acme/handbook' });
    assert.deepEqual(evidence.otherPrs?.map((p) => p.number), [8, 9]);
    assert.equal(fs.readdirSync(path.join(os.tmpdir(), 'auto-reviewer')).some((d) => d.startsWith(`acme-api-${head.slice(0, 7)}`)), false, 'the checkout is gone');
  });

  it('keeps related PRs out of the code and security reviews, and out of confidence', async () => {
    const { db, cfg } = fresh('two');
    const { router, runs } = fakeRouter({ main: review(), security: review() });
    const j = job(db, 'code,security');
    await new ReviewPipeline(fakeGitHub(base, head), cfg, db, router, cache).run(j, new AbortController().signal);
    assert.deepEqual(runs.map((r) => r.purpose).sort(), ['main', 'security']);
    assert.ok(!runs.some((r) => r.sawDocs), 'the docs repo is only fetched for the consistency review');
    const done = db.job(j.id)!;
    assert.equal(done.confidence, 'medium');
    assert.match(done.confidence_notes ?? '', /No consistency review ran/);
    assert.equal(done.related_prs, null);
    assert.match(runs.find((r) => r.purpose === 'main')!.instructions, /never use the categories "requirement" or "docs"/);
  });

  it('looks the change up in the repo context and gives it to every review', async () => {
    const { db, cfg } = fresh('ctx');
    cfg.update({ ...cfg.all, context: [{ id: 'ctx00001', repo: 'acme/*', sources: [{ repo: 'acme/handbook', path: '' }], notes: 'Amounts are in cents.' }] });
    const { router, runs } = fakeRouter({ main: review(), security: review() });
    const j = job(db, 'code,security');
    const context = new ContextStore(db);
    await new ReviewPipeline(fakeGitHub(base, head), cfg, db, router, cache, context).run(j, new AbortController().signal);

    assert.equal(runs.length, 2);
    for (const run of runs) {
      assert.match(run.prompt, /## Project context/);
      assert.match(run.prompt, /2 documents, from acme\/handbook@[0-9a-f]{7}/);
      assert.match(run.prompt, /From the repository's reviewer: Amounts are in cents\./);
      assert.match(run.prompt, /#### acme\/handbook: multiply\.md — Multiplying\nThe mul export multiplies two numbers\./);
      assert.match(run.prompt, /#### acme\/handbook: guide\.md — guide \(linked with "Multiplying"\)\nThe app can add numbers\./);
    }
    const evidence = db.evidence(j.id) as Evidence;
    assert.equal(evidence.context?.docs, 2);
    assert.deepEqual(evidence.context?.hits.map((h) => [h.path, h.how]), [['multiply.md', 'matched'], ['guide.md', 'linked']]);
    assert.ok(evidence.context?.terms.includes('mul'));
    assert.ok(db.events(j.id).some((e) => /Project context: 2 section\(s\) from 2 document\(s\), out of 2 in the baseline/.test(e.message)));
    assert.deepEqual(context.status('ctx00001').sources.map((s) => s.name), ['acme/handbook']);
  });

  it('reviews without the context when its repository cannot be read', async () => {
    const { db, cfg } = fresh('ctxbroken');
    cfg.update({ ...cfg.all, context: [{ id: 'ctx00002', repo: 'acme/*', sources: [{ repo: 'acme/missing', path: '' }], notes: '' }] });
    const broken = new RepoCache(path.join(root, 'cache-broken'), null, (repo) => (repo === 'acme/missing' ? path.join(root, 'nope.git') : remote));
    const { router, runs } = fakeRouter({ main: review(), security: review() });
    const j = job(db, 'code,security');
    await new ReviewPipeline(fakeGitHub(base, head), cfg, db, router, broken, new ContextStore(db)).run(j, new AbortController().signal);
    assert.equal(db.job(j.id)!.state, 'done');
    assert.doesNotMatch(runs[0].prompt, /## Project context/);
    assert.ok(db.events(j.id).some((e) => e.level === 'warn' && /project context couldn't be refreshed/.test(e.message)));
  });

  it('treats a job from before the choice existed as code and security', async () => {
    const { db, cfg } = fresh('three');
    const { router, runs } = fakeRouter({ main: review(), security: review() });
    const j = db.updateJob(job(db, 'x').id, { reviews: null });
    await new ReviewPipeline(fakeGitHub(base, head), cfg, db, router, cache).run(j, new AbortController().signal);
    assert.deepEqual(runs.map((r) => r.purpose).sort(), ['main', 'security']);
  });
});

describe('review instructions', () => {
  it('give requirements to the consistency review, except in Strict, whose own passes keep them', () => {
    assert.doesNotMatch(mainInstructions('me', 5), /Requirement alignment/);
    assert.match(mainInstructions('me', 5, { requirements: true }), /Requirement alignment against the linked issues/);
    assert.match(strictInstructions('main', 'me', 5), /Requirement alignment against the linked issues/);
    assert.match(consistencyInstructions('me'), /The linked issues\. Report these with category "requirement"/);
    const extras = consistencyInstructions('me', { requirements: false });
    assert.doesNotMatch(extras, /Report these with category "requirement"/);
    assert.match(extras, /category "docs"/);
    assert.match(extras, /related_prs/);
  });
});

describe('related PR alerts', () => {
  const candidate = (number: number, staleDays: number | null): RelatedCandidate => ({
    pr: { number, title: `PR ${number}`, url: `u${number}`, author: 'a', draft: false, updatedAt: daysAgo(staleDays ?? 1) },
    staleDays,
    files: ['a.js'],
    patch: '',
  });

  it('lowers an unmaintained PR to low confidence, and ignores repeats and PRs it was never shown', () => {
    const alerts = relatedAlerts(
      [candidate(1, null), candidate(2, 45)],
      [
        { number: 2, relation: 'conflict', note: 'n', confidence: 'high' },
        { number: 1, relation: 'overlap', note: 'n', confidence: 'medium' },
        { number: 1, relation: 'duplicate', note: 'again', confidence: 'high' },
        { number: 99, relation: 'duplicate', note: 'invented', confidence: 'high' },
      ],
    );
    assert.deepEqual(alerts.map((a) => [a.number, a.relation, a.confidence]), [[2, 'conflict', 'low'], [1, 'overlap', 'medium']]);
  });
});

describe('the app’s own comments', () => {
  it('are recognised by their hidden markers, and by the old signature', () => {
    assert.ok(isOwnComment('**Minor (bug):** x\n<!-- ai-finding:12 -->'));
    assert.ok(isOwnComment('**No issues found.**\n<!-- ai-review sha=abc job=3 -->'));
    assert.ok(isOwnComment('Old comment\n\n<sub>Auto Reviewer</sub>'));
    assert.ok(!isOwnComment('Fixed in the last commit, thanks.'));
  });
});
