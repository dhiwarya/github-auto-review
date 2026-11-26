import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { bus } from '../bus.ts';
import { SettingsStore } from '../settings.ts';
import { RepoSchema } from '../settings-schema.ts';
import { queryTerms } from '../context/query.ts';
import type { ContextStore } from '../context/store.ts';
import type { Db } from '../db.ts';
import type { RepoCache } from '../git/mirror.ts';
import type { GitHub } from '../github/client.ts';
import { getPr } from '../github/prs.ts';
import type { Poller } from '../jobs/poller.ts';
import type { PrTracker } from '../jobs/prs.ts';
import type { Worker } from '../jobs/worker.ts';
import type { Router } from '../llm/router.ts';
import { PostRefused, type ReviewPipeline } from '../review/pipeline.ts';
import { REVIEW_TYPES, type HistoryPage, type Job, type JobDetail, type JobState, type LeaderboardKind, type Overview, type StreamMessage } from '../types.ts';
import { leaderboard } from './leaderboard.ts';

interface Deps {
  cfg: SettingsStore;
  host: string;
  // Host names besides this machine's own that may open the dashboard, such as its
  // Tailscale name when Tailscale Serve proxies it.
  allowedHosts: string[];
  port: number;
  db: Db;
  gh: GitHub;
  router: Router;
  worker: Worker;
  poller: Poller;
  pipeline: ReviewPipeline;
  context: ContextStore;
  cache: RepoCache;
  prs: PrTracker;
}

// Uploaded context: markdown and plain text, up to 20 MB and 3,000 files at a time.
const UPLOAD_BYTES = 20 * 1024 * 1024;
const UPLOAD_FILES = 3000;
const UPLOADABLE = /\.(md|mdx|markdown|txt)$/i;

const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

export function overview({ cfg, db, gh, router, worker, poller }: Deps): Overview {
  const counts = { queued: 0, running: 0, waiting: 0, done: 0, failed: 0, cancelled: 0, skipped: 0 } as Record<JobState, number>;
  for (const r of db.all<{ state: JobState; n: number }>('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state')) counts[r.state] = r.n;
  return {
    me: gh.me,
    github_auth: gh.authSource,
    settings: { provider: cfg.models.provider, fallbackToOther: cfg.models.fallbackToOther, doubleCheck: cfg.models.doubleCheck },
    repos: cfg.repos.map((r) => ({ repo: r.repo, enabled: r.enabled, dryRun: r.dryRun, mode: r.mode, profile: r.profile, reviews: REVIEW_TYPES.filter((t) => r.reviews[t]) })),
    needs_setup: cfg.needsSetup,
    counts,
    last_poll_at: db.getKv('last_poll_at'),
    next_poll_at: db.getKv('next_poll_at'),
    last_poll_error: db.getKv('last_poll_error'),
    providers: router.status(),
    paused_reason: worker.pausedReason(),
    github: {
      limits: ['core', 'graphql', 'search'].flatMap((r) => (gh.rateLimits.has(r) ? [gh.rateLimits.get(r)!] : [])),
      watching: poller.watcher.watchStatus(),
      paused_until: poller.status().pausedUntil,
      pause_reason: poller.status().pauseReason,
      last_cycle: JSON.parse(db.getKv('last_poll_stats') ?? 'null'),
    },
  };
}

// "https://github.com/owner/repo/pull/12" or "owner/repo#12"
function parsePrRef(input: string): { repo: string; number: number } | null {
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(input);
  if (url) return { repo: url[1], number: Number(url[2]) };
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(input.trim());
  return short ? { repo: short[1], number: Number(short[2]) } : null;
}

export async function startServer(deps: Deps) {
  const { cfg, db, gh, worker, poller } = deps;
  // The dashboard holds a live-updates connection open; closing must not wait for it.
  const app = Fastify({ logger: false, forceCloseConnections: true });
  const allowed = new Set(['127.0.0.1', 'localhost', '[::1]', ...deps.allowedHosts.map((h) => h.toLowerCase())]);

  // The dashboard is for this machine (plus any ALLOWED_HOSTS) only. Checking Host blocks DNS-rebinding pages (on any
  // port, since Docker can publish it on another one), and requiring a custom header on
  // writes blocks other websites from posting to the API.
  app.addHook('onRequest', async (req, reply) => {
    const hostname = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (!allowed.has(hostname)) return reply.code(403).send({ error: 'forbidden host' });
    if (req.method !== 'GET' && req.headers['x-auto-reviewer'] !== '1') return reply.code(403).send({ error: 'missing header' });
  });

  app.get('/api/overview', async () => overview(deps));

  // Lists leave out the long text (the review, its policy and report); a job's page loads it.
  const light = (j: Job): Job => {
    const { review_body: _body, review_policy: _policy, review_report: _report, ...rest } = db.withCounts(j);
    return { ...rest, review_body: null };
  };
  const ACTIVE_SQL = `state IN ('queued', 'running', 'waiting')`;

  // ?active=1: only queued, running and waiting jobs.
  app.get<{ Querystring: { limit?: string; active?: string } }>('/api/jobs', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    return db.all<Job>(`SELECT * FROM jobs ${req.query.active === '1' ? `WHERE ${ACTIVE_SQL}` : ''} ORDER BY id DESC LIMIT ?`, limit).map(light);
  });

  // Finished jobs, newest first, one page at a time.
  app.get<{ Querystring: { page?: string; size?: string } }>('/api/history', async (req) => {
    const size = Math.min(Math.max(Number(req.query.size) || 25, 1), 200);
    const total = db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs WHERE NOT ${ACTIVE_SQL}`)!.n;
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(Math.max(Math.floor(Number(req.query.page) || 1), 1), pages);
    const jobs = db.all<Job>(`SELECT * FROM jobs WHERE NOT ${ACTIVE_SQL} ORDER BY id DESC LIMIT ? OFFSET ?`, size, (page - 1) * size).map(light);
    return { jobs, total, page, size } satisfies HistoryPage;
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = db.job(Number(req.params.id));
    if (!job) return reply.code(404).send({ error: 'not found' });
    return {
      job: db.withCounts(job),
      findings: db.findings(job.id),
      events: db.events(job.id),
      runs: db.runs(job.id),
      evidence: db.evidence(job.id),
      steps: db.steps(job.id),
    } satisfies JobDetail;
  });

  // Every reviewed PR: your review as it stands on GitHub, the PR's state, and auto-merge.
  app.get('/api/prs', async () => deps.prs.rows());

  // Hold or resume auto-merge for one PR. Resuming also retries a failed merge.
  app.post<{ Body: { repo?: unknown; number?: unknown; hold?: unknown } }>('/api/prs/hold', async (req, reply) => {
    const { repo, number, hold } = req.body ?? {};
    if (typeof repo !== 'string' || typeof number !== 'number' || typeof hold !== 'boolean') return reply.code(400).send({ error: 'Send repo, number and hold' });
    if (!deps.prs.setHold(repo, number, hold)) return reply.code(404).send({ error: "That PR hasn't been checked on GitHub yet" });
    return { ok: true };
  });

  // A step's full text (command output, a tool's result), loaded when you open it.
  app.get<{ Params: { id: string } }>('/api/steps/:id', async (req) => ({ detail: db.stepDetail(Number(req.params.id)) }));

  app.post<{ Body: { pr?: string; reviews?: unknown } }>('/api/jobs', async (req, reply) => {
    const ref = parsePrRef(req.body?.pr ?? '');
    if (!ref) return reply.code(400).send({ error: 'Use a PR link or owner/repo#123' });
    // Optional: the reviews to run on this PR, instead of the repo's usual set.
    const asked = req.body?.reviews;
    const reviews = Array.isArray(asked) ? REVIEW_TYPES.filter((r) => asked.includes(r)) : undefined;
    if (reviews && !reviews.length) return reply.code(400).send({ error: 'Pick at least one review' });
    if (!cfg.isRepoAllowed(ref.repo)) return reply.code(400).send({ error: cfg.entryFor(ref.repo) ? `Reviews are switched off for ${ref.repo} in Settings` : `${ref.repo} isn't in your repos list (add it in Settings)` });
    try {
      const pr = await getPr(gh, ref.repo, ref.number);
      if (pr.state !== 'open') return reply.code(400).send({ error: 'That PR is not open' });
      return poller.enqueue(pr, 'manual', reviews);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (req) => {
    worker.retry(Number(req.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/recheck', async (req, reply) => {
    try {
      return await poller.recheckFromDashboard(Number(req.params.id));
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/full-review', async (req, reply) => {
    try { return await poller.fullReviewFromDashboard(Number(req.params.id)); }
    catch (err) { return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) }); }
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req) => {
    worker.cancel(Number(req.params.id), 'cancelled from the dashboard');
    return { ok: true };
  });

  // Posting a dry-run review: first what it would do, then doing it.
  app.get<{ Params: { id: string } }>('/api/jobs/:id/post', async (req, reply) => {
    try {
      return await deps.pipeline.previewPost(Number(req.params.id));
    } catch (err) {
      return reply.code(err instanceof PostRefused ? 409 : 500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: { mode?: string; allowPartial?: boolean } }>('/api/jobs/:id/post', async (req, reply) => {
    const mode = req.body?.mode;
    if (mode !== 'draft' && mode !== 'publish') return reply.code(400).send({ error: 'mode must be draft or publish' });
    try {
      return await deps.pipeline.postDryRun(Number(req.params.id), mode, req.body?.allowPartial === true);
    } catch (err) {
      return reply.code(err instanceof PostRefused ? 409 : 500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/poll', async () => {
    void poller.pollOnce();
    return { ok: true };
  });

  app.post<{ Params: { provider: string } }>('/api/providers/:provider/reset', async (req, reply) => {
    const p = req.params.provider;
    if (p !== 'claude' && p !== 'codex') return reply.code(400).send({ error: 'unknown provider' });
    deps.router.clear(p);
    return { ok: true };
  });

  // All settings, edited from the dashboard. A save is validated as a whole, stored in the
  // database, and applies to the running app straight away.
  // `newRepo` is a repo entry as it starts out, for the dashboard's "Add repository".
  app.get('/api/settings', async () => ({ settings: cfg.all, defaults: SettingsStore.defaults(), newRepo: RepoSchema.parse({ repo: 'owner/repo' }) }));

  app.put<{ Body: unknown }>('/api/settings', async (req, reply) => {
    const result = cfg.update(req.body);
    if (!result.ok) return reply.code(400).send({ error: 'Some settings need fixing', issues: result.issues });
    console.log('[settings] saved');
    deps.context.prune(cfg.contextSets.map((c) => c.id));
    return { settings: result.settings };
  });

  // Repo context: the markdown baseline each review looks things up in.
  const contextEntry = (id: string) => cfg.contextSets.find((c) => c.id === id);
  const failed = (err: unknown) => ({ error: err instanceof Error ? err.message.split('\n')[0] : String(err) });

  app.get('/api/context', async () => ({ sets: cfg.contextSets.map((c) => ({ id: c.id, repo: c.repo, status: deps.context.status(c.id) })) }));

  // Builds the baseline now: fetches the context repositories and re-reads what changed.
  app.post<{ Params: { id: string } }>('/api/context/:id/baseline', async (req, reply) => {
    const entry = contextEntry(req.params.id);
    if (!entry) return reply.code(404).send({ error: 'Save your settings first, then build the baseline' });
    try {
      return { status: await deps.context.refresh(entry, deps.cache, { force: true }) };
    } catch (err) {
      return reply.code(500).send(failed(err));
    }
  });

  app.post<{ Params: { id: string }; Body: { files?: unknown; replace?: unknown } }>('/api/context/:id/upload', { bodyLimit: UPLOAD_BYTES + 4 * 1024 * 1024 }, async (req, reply) => {
    if (!contextEntry(req.params.id)) return reply.code(404).send({ error: 'Save your settings first, then upload' });
    const raw = Array.isArray(req.body?.files) ? req.body.files : [];
    const files = raw.filter((f): f is { path: string; text: string } => typeof f?.path === 'string' && typeof f?.text === 'string' && UPLOADABLE.test(f.path) && !f.path.split(/[\\/]/).includes('..'));
    if (!files.length) return reply.code(400).send({ error: 'No markdown or text files in that upload (.md, .mdx, .markdown, .txt)' });
    if (files.length > UPLOAD_FILES) return reply.code(400).send({ error: `That is ${files.length} files; the most at once is ${UPLOAD_FILES}` });
    if (files.reduce((n, f) => n + f.text.length, 0) > UPLOAD_BYTES) return reply.code(400).send({ error: 'That upload is over 20 MB' });
    try {
      return { status: await deps.context.upload(req.params.id, files, req.body?.replace === true), skipped: raw.length - files.length };
    } catch (err) {
      return reply.code(500).send(failed(err));
    }
  });

  app.post<{ Params: { id: string } }>('/api/context/:id/uploads/clear', async (req, reply) => {
    if (!contextEntry(req.params.id)) return reply.code(404).send({ error: 'Unknown context' });
    return { status: await deps.context.clearUploads(req.params.id) };
  });

  // What a review would be given for these words: a way to try the baseline out.
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/context/:id/search', async (req, reply) => {
    if (!contextEntry(req.params.id)) return reply.code(404).send({ error: 'Unknown context' });
    const terms = queryTerms({ title: req.query.q ?? '', issues: [], files: [], addedLines: [] });
    return deps.context.retrieve(req.params.id, terms, cfg.limits.contextChars);
  });

  app.get<{ Params: { kind: string } }>('/api/leaderboard/:kind', async (req, reply) => {
    const kind = req.params.kind as LeaderboardKind;
    if (!['models', 'repos', 'authors'].includes(kind)) return reply.code(404).send({ error: 'unknown leaderboard' });
    return leaderboard(db, kind);
  });

  // Live updates: job changes as they happen, overview at most a few times a second.
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (msg: StreamMessage) => reply.raw.write(`data: ${JSON.stringify(msg)}\n\n`);
    let pending: NodeJS.Timeout | null = null;
    const onJob = (msg: StreamMessage) => {
      send(msg);
      if (msg.type === 'job') onOverview(); // a model's steps or a PR's status don't change the overview
    };
    const onOverview = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        send({ type: 'overview', overview: overview(deps) });
      }, 300);
    };
    bus.on('message', onJob);
    bus.on('overview', onOverview);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    send({ type: 'overview', overview: overview(deps) });
    req.raw.on('close', () => {
      bus.off('message', onJob);
      bus.off('overview', onOverview);
      clearInterval(heartbeat);
      if (pending) clearTimeout(pending);
    });
  });

  if (fs.existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/plain').send('Dashboard not built yet. Run `npm run build`, then restart.'));
  }

  // Loopback only, as the dashboard controls what gets posted to GitHub as you. In Docker it
  // listens on all of the container's interfaces and the port is published on the host's
  // loopback only.
  await app.listen({ host: deps.host, port: deps.port });
  return app;
}
