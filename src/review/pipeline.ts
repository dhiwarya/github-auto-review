import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SettingsStore } from '../settings.ts';
import type { Db } from '../db.ts';
import { contextSection } from '../context/prompt.ts';
import { queryTerms } from '../context/query.ts';
import type { ContextStore } from '../context/store.ts';
import type { Checkout, RepoCache } from '../git/mirror.ts';
import { parsePatch } from '../github/diff.ts';
import type { GitHub } from '../github/client.ts';
import { removeLabel, showLabel } from '../github/labels.ts';
import { getLinkedRefs, getPr, listDiscussion, listPrFiles, type PrInfo } from '../github/prs.ts';
import { insertBeforeMarker, myVerdict, PendingReviewExists, isOwnComment, postReview, type InlineComment, type ReviewEvent } from '../github/publish.ts';
import { NoProviderAvailable, type Router } from '../llm/router.ts';
import { containsSecret, ownSecrets } from '../secrets.ts';
import { PASS_OF, REVIEW_TYPES, reviewsOf, type Confidence, type Evidence, type Finding, type Job, type PostPreview, type Provider, type ReviewMode, type ReviewType } from '../types.ts';
import { assess, atLeast, openBlockers } from './confidence.ts';
import { buildContext, docsSection, fence, recheckPrompt, refsEvidence, type ReviewContext } from './context.ts';
import { countsLine, inlineBody, recheckBody, summaryBody } from './format.ts';
import { consistencyInstructions, mainInstructions, recheckInstructions, securityInstructions, verifyInstructions } from './prompts.ts';
import { relatedAlerts, relatedCandidates, relatedSection, type RelatedCandidate } from './related.ts';
import { ConsistencyOut, consistencySchema, RecheckOut, recheckSchema, ReviewOut, reviewSchema, VerifyOut, verifySchema } from './schema.ts';
import { addedTextOf, lowerSeverity, minSeverity, placeFindings, scrubText, type Candidate } from './validate.ts';
import { POLICY_VERSION, hasStrictCoverage, readPolicy, readReport, strictApprovalBlocks } from './policy.ts';
import { runStrictReview, StrictReviewWaiting, StrictReviewIncomplete } from './strict.ts';
import { materializeSources } from './sources.ts';

// The job no longer needs doing: PR closed, or new commits replaced it.
export class JobObsolete extends Error {}

// Posting a dry-run review isn't possible right now; the message says why.
export class PostRefused extends Error {}

// Where a separate docs repository is checked out, inside the PR checkout.
const EXTERNAL_DOCS_DIR = '.external-docs';

// The review contains one of the app's own credentials. Never retried.
export class UnsafeToPost extends Error {}

export class ReviewPipeline {
  private readonly gh: GitHub;
  private readonly cfg: SettingsStore;
  private readonly db: Db;
  private readonly router: Router;
  private readonly cache: RepoCache;
  private readonly context: ContextStore | null;

  constructor(gh: GitHub, cfg: SettingsStore, db: Db, router: Router, cache: RepoCache, context: ContextStore | null = null) {
    this.context = context;
    this.gh = gh;
    this.cfg = cfg;
    this.db = db;
    this.router = router;
    this.cache = cache;
  }

  private step(job: Job, step: string, progress: number) {
    this.db.updateJob(job.id, { step, progress });
    this.db.event(job.id, step);
  }

  async run(job: Job, signal: AbortSignal): Promise<void> {
    if (!this.cfg.isRepoAllowed(job.repo)) throw new JobObsolete('repo is no longer in your repos list');
    const pr = await getPr(this.gh, job.repo, job.pr_number);
    if (pr.state !== 'open') throw new JobObsolete('PR is no longer open');
    if (pr.headSha !== job.head_sha) throw new JobObsolete(`superseded by new commits (${pr.headSha.slice(0, 7)})`);
    this.db.updateJob(job.id, { pr_title: pr.title, additions: pr.additions, deletions: pr.deletions, changed_files: pr.changedFiles });
    if (!job.review_policy) job = this.db.updateJob(job.id, { review_policy: JSON.stringify({ version: POLICY_VERSION, settings: this.cfg.all }) });
    let policy = readPolicy(job);
    if (!policy) throw new Error('Unknown review policy; this job cannot be resumed safely');
    if (policy.settings.reviewProfile === 'strict' && policy.version < POLICY_VERSION && !job.review_id) {
      const upgraded = structuredClone(policy.settings);
      if (upgraded.strict.maxBatches === 8) upgraded.strict.maxBatches = 16;
      if (upgraded.strict.maxRuns === 32) upgraded.strict.maxRuns = 64;
      job = this.db.updateJob(job.id, { review_policy: JSON.stringify({ version: POLICY_VERSION, settings: upgraded, previousPolicy: policy }), since_sha: null, review_body: null, review_report: null });
      this.db.event(job.id, 'Upgraded Strict completion policy; restarting with full PR coverage');
      policy = readPolicy(job)!;
    }
    const frozen = structuredClone(policy.settings);
    const strict = frozen.reviewProfile === 'strict';
    if (strict) {
      frozen.limits.passTimeoutSec = frozen.strict.passTimeoutSec;
      frozen.limits.maxDiffChars = frozen.strict.maxDiffChars;
      frozen.limits.claudeMaxTurns = frozen.strict.claudeMaxTurns;
      frozen.models.claudeEffort = frozen.strict.claudeEffort;
    }
    const cfg = this.cfg.snapshot(frozen);
    let recovery = readReport(job)?.recovery;
    if (strict && !recovery && (job.since_sha || job.kind === 'recheck')) {
      const baseline = this.db.jobsForPr(job.repo, job.pr_number).find((j) => j.id !== job.id && j.state === 'done' && j.dry_run === job.dry_run && j.head_sha === (job.kind === 'recheck' ? job.head_sha : job.since_sha));
      const priorUncertainty = baseline && hasStrictCoverage(baseline) && readReport(baseline)?.approvalBlocks.some((reason) => reason === 'Unresolved questions affect review confidence' || reason === 'A required pass reported less than high confidence');
      if (!hasStrictCoverage(baseline) || priorUncertainty) {
        recovery = `Automatically expanded to the full current PR: ${priorUncertainty ? `job ${baseline!.id} has earlier questions or code uncertainty that must be reassessed` : baseline ? `job ${baseline.id} lacks complete current-policy Strict coverage` : 'no complete Strict baseline exists'}`;
        job = this.db.updateJob(job.id, { since_sha: null, review_body: null });
        this.db.event(job.id, recovery);
      }
    }

    // A retry after "pending review exists" only needs to post what was already prepared.
    if (job.review_body && !job.review_id && !job.dry_run && (!strict || readReport(job)?.complete)) {
      await this.publish(job, this.db.findings(job.id));
      return;
    }
    if (strict) this.db.run('UPDATE findings SET resolved_by_job = NULL WHERE resolved_by_job = ?', job.id);

    await this.labelStart(job, pr);
    if (job.kind === 'recheck' && !strict) return this.recheck(job, pr, signal, cfg);

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `auto-reviewer-work-${job.id}-`));
    let checkout: Checkout | null = null;
    let docs: { repos: { repo: string; dir: string }[]; cleanup(): Promise<void> } | null = null;
    try {
      checkout = await this.checkout(job, pr, signal, cfg);

      this.step(job, 'Reading the PR, linked issues and guidelines', 18);
      const previous = this.previousFindings(job);
      const priorJob = strict ? this.db.jobsForPr(job.repo, job.pr_number).find((j) => j.id !== job.id && j.state === 'done' && j.dry_run === job.dry_run) : null;
      const ctx = await buildContext(this.gh, cfg, pr, job.since_sha, previous, this.cache, {
        snapshot: strict ? this.db.contextSnapshot(job.id) : null,
        recheckOnly: strict && job.kind === 'recheck',
        priorReview: priorJob?.review_body && priorJob.confidence !== 'high' ? { id: priorJob.id, text: `${priorJob.confidence_notes ?? ''}\n\n${priorJob.review_body}` } : undefined,
      });
      ctx.recovery = recovery;
      ctx.recheckOnly = strict && job.kind === 'recheck';
      if (ctx.sourceSnapshot) {
        this.db.saveContextSnapshot(job.id, ctx.sourceSnapshot);
        await materializeSources(ctx.sourceSnapshot, checkout.dir);
      }
      await this.projectContext(job, ctx, cfg);
      this.db.setEvidence(job.id, ctx.evidence);
      this.db.event(
        job.id,
        `${ctx.incremental ? 'Follow-up review of new commits' : 'Full review'}: ${ctx.reviewFiles.length} files, ` +
          `${ctx.changedLines} changed lines, ${ctx.issues.length} linked issue(s)${ctx.large ? strict ? ', Strict batch review' : ', large-PR mode' : ''}`,
      );

      const task = { cwd: checkout.dir, workDir, timeoutMs: cfg.limits.passTimeoutSec * 1000, signal };
      const placeOpts = { checkoutDir: checkout.dir, prFiles: ctx.prFiles, previous, maxNits: cfg.limits.maxNits, strict, requirementText: ctx.issues.map((i) => `${i.title}\n${i.body}\n${i.comments.map((c) => c.body).join('\n')}`).join('\n') };

      // Strict always reviews code, security and requirements itself, with both providers.
      // Of the consistency review it adds what Strict doesn't cover: the docs and other open PRs.
      const chosen = reviewsOf(job);
      const reviews: ReviewType[] = strict ? REVIEW_TYPES.filter((r) => r !== 'consistency' || (chosen.includes(r) && !ctx.recheckOnly)) : chosen;
      // The consistency review also gets the docs and the other open PRs touching the same files.
      let related: RelatedCandidate[] = [];
      let consistencyPrompt = ctx.prompt;
      if (reviews.includes('consistency')) {
        docs = await this.externalDocs(job, checkout.dir, cfg);
        try {
          const changed = ctx.prFiles.map((f) => f.filename).filter((f) => !cfg.isExcludedFile(f));
          related = await relatedCandidates(this.gh, this.cache, pr, changed, cfg.consistency.stalePrDays);
        } catch (err) {
          if (signal.aborted) throw err;
          this.db.event(job.id, `Couldn't compare with the other open PRs (${err instanceof Error ? err.message : err}); reviewing without them`, 'warn');
        }
        const others = related.length
          ? `## Other open pull requests that change the same files\n${fence('other-open-prs', relatedSection(related))}`
          : 'No other open pull request changes the same files, so related_prs is empty.';
        const docsCfg = cfg.docsFor(job.repo);
        consistencyPrompt = `${ctx.prompt}\n\n${docsSection(docsCfg, docs?.repos ?? [])}\n\n${others}`;
        this.db.setEvidence(job.id, {
          ...ctx.evidence,
          docs: { paths: docsCfg?.paths ?? [], repo: docs?.repos.map((r) => r.repo).join(', ') || null },
          otherPrs: related.map((r) => ({ number: r.pr.number, title: r.pr.title, url: r.pr.url, files: r.files.length, staleDays: r.staleDays })),
          promptChars: consistencyPrompt.length,
        });
      }

      const brief: Record<ReviewType, { instructions: string; prompt: string; schema: object }> = {
        code: { instructions: mainInstructions(ctx.me, cfg.limits.maxNits), prompt: ctx.prompt, schema: reviewSchema },
        security: { instructions: securityInstructions(ctx.me), prompt: ctx.prompt, schema: reviewSchema },
        consistency: { instructions: consistencyInstructions(ctx.me, { requirements: !strict }), prompt: consistencyPrompt, schema: consistencySchema },
      };
      this.step(job, strict ? `Strict review: code, security and an independent review${reviews.includes('consistency') ? ', then docs and other PRs' : ''}` : `Reviewing: ${reviews.join(', ')}`, 25);
      const strictResult = strict ? await runStrictReview({ job, ctx, cfg, db: this.db, router: this.router, task, placeOpts }) : null;
      // In Strict the engine above did code and security; only the consistency extras are left.
      const separate = strict ? reviews.filter((r) => r === 'consistency') : reviews;
      let done = 0;
      const progress = () => this.db.updateJob(job.id, { progress: (strict ? 68 : 25) + Math.round((++done * (strict ? 2 : 44)) / separate.length) });
      const ran = await Promise.all(
        separate.map(async (type) => {
          // Strict keeps every run on its assigned provider: no falling back to the other one.
          const res = await this.router.run(job.id, PASS_OF[type], { ...task, ...brief[type] }, strict ? { config: cfg, providers: [cfg.models.provider] } : { config: cfg }).finally(progress);
          return { type, res, out: parseReview(res.output, type) };
        }),
      );
      const strictOut = strictResult ? parseReview(strictResult.mainOut, 'strict') : null;
      const outs: ReviewOut[] = [...(strictOut ? [strictOut] : []), ...ran.map((r) => r.out)];
      const picks = ConsistencyOut.safeParse(ran.find((r) => r.type === 'consistency')?.res.output);
      const spec = strictOut?.spec_alignment ?? ran.find((r) => r.type === 'consistency')?.out.spec_alignment ?? { status: 'not_checked' as const, notes: '' };
      const ranLine = ran.map((r) => `${r.type} review (${r.res.provider} ${r.res.model ?? '(default model)'}): ${r.out.findings.length} finding(s)`).join('. ');
      this.db.event(
        job.id,
        [
          strictResult ? `Strict review: ${strictResult.report.stages.length} stages, ${strictResult.candidates.length} proposed finding(s), ${strictResult.report.complete ? 'coverage complete' : 'incomplete'}` : '',
          ranLine.replace(/^./, (c) => c.toUpperCase()),
        ].filter(Boolean).join('. ') + '.',
      );

      let candidates: Candidate[] = [...(strictResult?.candidates ?? []), ...ran.flatMap((r) => r.out.findings.map((f) => toCandidate(f, r.type, r.res.provider, r.res.model)))];

      if (!strict && cfg.models.doubleCheck && candidates.some((c) => c.severity === 'blocker' || c.severity === 'major')) {
        this.step(job, 'Double-checking blockers and majors', 72);
        candidates = await this.verify(job, ctx, candidates, placeOpts, task, cfg);
      }

      this.step(job, 'Checking findings against the code', 88);
      const placed = placeFindings(candidates, placeOpts);
      if (strict) {
        // Retried Strict stages are checkpointed. Replace their local materialization so
        // a resumed job never accumulates duplicate findings.
        this.db.run('DELETE FROM findings WHERE job_id = ?', job.id);
        for (const p of placed) if (p.status !== 'dropped' && (p.original_severity === 'blocker' || p.original_severity === 'major') && p.verification !== 'confirmed') p.status = 'summary';
      }
      const inserted = placed.map((p) =>
        this.db.insertFinding({
          job_id: job.id,
          pass: p.pass,
          model: p.model,
          model_id: p.model_id,
          category: p.category,
          severity: p.severity,
          original_severity: p.original_severity,
          confidence: p.confidence,
          file: p.file,
          line: p.line,
          title: p.title,
          evidence: p.evidence,
          problem: p.problem,
          suggestion: p.suggestion,
          verification: p.verification,
          verified_by: p.verified_by,
          verify_reason: p.verify_reason,
          status: p.status,
          drop_reason: p.drop_reason,
          comment_id: null,
          outcome: null,
        }),
      );
      const dropped = inserted.filter((f) => f.status === 'dropped');
      if (dropped.length) this.db.event(job.id, `Discarded ${dropped.length} finding(s): ${[...new Set(dropped.map((f) => f.drop_reason?.split(':')[0]))].join('; ')}`);
      if (placed.some((p) => p.drop_reason?.includes('exfiltration'))) {
        this.db.event(job.id, 'A model tried to output a credential that is not in the PR. That finding was discarded; check the PR for prompt injection.', 'warn');
      }

      const resolvedIds = new Set(outs.flatMap((o) => o.resolved_previous_ids));
      const resolved = previous.filter((f) => resolvedIds.has(f.id));
      for (const f of resolved) this.db.updateFinding(f.id, { resolved_by_job: job.id });

      const posted = inserted.filter((f) => f.status !== 'dropped');
      // Free text is posted as written, so it gets the same secret check as the findings.
      const addedText = addedTextOf(ctx.prFiles);
      let smuggled = strictResult?.injection ?? false;
      const clean = (text: string) => {
        const scrubbed = scrubText(text, addedText);
        smuggled ||= scrubbed.smuggled;
        return scrubbed.text;
      };
      const summaries = outs.map((o) => clean(o.summary));
      const allQuestions = outs.flatMap((o) => o.questions_for_author);
      const questions = (strict ? allQuestions : allQuestions.slice(0, 4)).map(clean);
      const passes = outs.map((o) => ({ level: o.review_confidence.level, reason: clean(o.review_confidence.reason) }));
      const specNotes = clean(spec.notes);
      // Alerts about other open PRs: shown to the reader, with no say in confidence or approval.
      const alerts = picks.success ? relatedAlerts(related, picks.data.related_prs.map((p) => ({ ...p, note: clean(p.note) }))) : [];
      if (alerts.length) this.db.event(job.id, `Related open PRs: ${alerts.map((a) => `#${a.number} (${a.relation}, ${a.confidence} confidence)`).join(', ')}`);
      if (smuggled) {
        this.db.event(job.id, 'A model put a credential that is not in the PR into its summary or questions. It was redacted; check the PR for prompt injection.', 'warn');
      }
      const body = ctx.recheckOnly ? `${strictResult!.report.complete ? '**Review complete.**' : '**Review incomplete.**'}\n\n${recheckBody({ headSha: job.head_sha, summary: summaries.filter(Boolean).join('\n\n'), open: previous.filter((f) => !resolvedIds.has(f.id)).map((finding) => ({ finding, reason: '' })), resolved: resolved.map((finding) => ({ finding, reason: '' })), jobId: job.id })}` : summaryBody({
        repo: job.repo,
        headSha: job.head_sha,
        summaries,
        specStatus: spec.status,
        specNotes,
        related: alerts,
        reviews: strict ? REVIEW_TYPES : reviews,
        issues: ctx.issues,
        findings: posted,
        questions,
        resolved,
        large: !strict && ctx.large,
        excluded: ctx.excluded,
        inlineFailed: false,
        jobId: job.id,
        complete: strictResult?.report.complete,
      });
      const assessment = assess({
        findings: posted,
        openEarlier: previous.filter((f) => !resolvedIds.has(f.id)),
        // Strict assesses the linked issue itself, so nothing that affects confidence is skipped.
        notRun: strict ? [] : REVIEW_TYPES.filter((r) => !reviews.includes(r)),
        specStatus: spec.status,
        questions: questions.length,
        large: !strict && ctx.large,
        truncated: !strict && ctx.truncated,
        coverageIncomplete: strict && !strictResult!.report.complete,
        injection: smuggled || placed.some((p) => p.drop_reason?.includes('exfiltration')),
        passes,
      });
      this.db.event(job.id, `Confidence ${assessment.level}${assessment.reasons.length ? `: ${assessment.reasons.join('; ')}` : ''}`);
      job = this.db.updateJob(job.id, {
        review_body: strictResult ? `${body}\n\n${strictResult.report.gaps.length ? `**Coverage gaps**\n${strictResult.report.gaps.map((g) => `- ${g}`).join('\n')}` : ''}` : body,
        related_prs: alerts.length ? JSON.stringify(alerts) : null,
        spec_status: spec.status,
        confidence: assessment.level,
        confidence_notes: assessment.reasons.join('\n') || null,
      });

      if (strictResult) {
        const blocks = strictApprovalBlocks(job, [...posted, ...previous.filter((f) => !resolvedIds.has(f.id))], true);
        job = this.db.updateJob(job.id, { review_report: JSON.stringify(strictResult.report), approve_note: blocks.join('; ') || null });
        if (strictResult.retryAt) throw new StrictReviewWaiting(strictResult.retryAt);
        if (strictResult.report.stages.some((s) => s.error)) throw new Error('A required Strict stage failed; completed stages are saved for retry. See the coverage report for details.');
        if (ctx.contextGaps?.length) throw new Error(`Strict context retrieval is incomplete: ${ctx.contextGaps.join('; ')}`);
        if (!strictResult.report.complete) throw new StrictReviewIncomplete(`Strict review did not complete within its recovery budget. Nothing was posted. ${strictResult.report.gaps.join('; ')}. Use Full PR review with suitable budgets or explicitly post a partial review.`);
      }

      if (signal.aborted) throw signal.reason;
      await this.publish(job, inserted);
    } finally {
      await docs?.cleanup().catch(() => {});
      await checkout?.cleanup();
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  // Checks out the repo's separate docs repository, if Settings names one, inside the PR
  // checkout so the consistency review can read it. Without it the review still runs.
  private async externalDocs(job: Job, checkoutDir: string, cfg = this.cfg): Promise<{ repos: { repo: string; dir: string }[]; cleanup(): Promise<void> } | null> {
    // The repo's docs repository, and the repositories its context is built from.
    const wanted = [...new Set([cfg.docsFor(job.repo)?.docsRepo, ...(cfg.contextFor(job.repo)?.sources.map((s) => s.repo) ?? [])].filter((r): r is string => Boolean(r)))];
    if (!wanted.length) return null;
    const repos: { repo: string; dir: string }[] = [];
    const cleanups: (() => Promise<void>)[] = [];
    for (const docsRepo of wanted) {
      const dir = `${EXTERNAL_DOCS_DIR}/${docsRepo.split('/')[1]}`;
      try {
        this.step(job, `Fetching the docs repository ${docsRepo}`, 20);
        const sha = await this.cache.fetchDefault(docsRepo);
        await fs.mkdir(path.join(checkoutDir, EXTERNAL_DOCS_DIR), { recursive: true });
        const worktree = await this.cache.worktreeAt(docsRepo, sha, path.join(checkoutDir, dir));
        repos.push({ repo: docsRepo, dir });
        cleanups.push(worktree.cleanup);
      } catch (err) {
        const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
        this.db.event(job.id, `Couldn't read the docs repository ${docsRepo} (${why}); reviewing without it`, 'warn');
      }
    }
    return repos.length ? { repos, cleanup: async () => void (await Promise.all(cleanups.map((c) => c().catch(() => {})))) } : null;
  }

  // Looks the change up in the repo's context graph and adds what it finds to the prompt of
  // every review. The baseline is brought up to date first, which costs a fetch and no model
  // run. What was found is kept with the job, so a retry reviews against the same context.
  private async projectContext(job: Job, ctx: ReviewContext, cfg: SettingsStore) {
    const entry = cfg.contextFor(job.repo);
    if (!this.context || !entry) return;
    const key = `job-context:${job.id}`;
    try {
      let saved = JSON.parse(this.db.getKv(key) ?? 'null') as { section: string; evidence: NonNullable<Evidence['context']> } | null;
      if (!saved) {
        this.step(job, 'Looking up the project context', 22);
        const status = await this.context.refresh(entry, this.cache);
        if (status.error) this.db.event(job.id, `Part of the project context couldn't be refreshed (${status.error}); using the last baseline`, 'warn');
        const terms = queryTerms({
          title: ctx.pr.title,
          issues: ctx.issues.map((i) => i.title),
          files: ctx.reviewFiles.map((f) => f.filename),
          addedLines: ctx.reviewFiles.flatMap((f) => [...parsePatch(f.patch).addedLines.values()]),
        });
        const result = this.context.retrieve(entry.id, terms, cfg.limits.contextChars);
        saved = {
          section: result.hits.length || entry.notes ? contextSection(result, entry.notes) : '',
          evidence: {
            builtAt: result.builtAt,
            sources: result.sources,
            docs: result.docs,
            terms,
            hits: result.hits.map((h) => ({ source: h.source, path: h.path, heading: h.heading, how: h.how, chars: h.text.length })),
          },
        };
        this.db.setKv(key, JSON.stringify(saved));
        this.db.event(job.id, `Project context: ${result.hits.length} section(s) from ${new Set(result.hits.map((h) => h.path)).size} document(s), out of ${result.docs} in the baseline`);
      }
      if (saved.section) {
        ctx.prompt += `\n\n${saved.section}`;
        if (ctx.contextPrompt) ctx.contextPrompt += `\n\n${saved.section}`;
      }
      ctx.evidence = { ...ctx.evidence, context: saved.evidence, promptChars: ctx.prompt.length };
    } catch (err) {
      this.db.event(job.id, `Couldn't look up the project context (${err instanceof Error ? err.message.split('\n')[0] : err}); reviewing without it`, 'warn');
    }
  }

  private async checkout(job: Job, pr: PrInfo, signal: AbortSignal, cfg = this.cfg): Promise<Checkout> {
    const firstTime = !(await this.cache.exists(job.repo));
    this.step(job, firstTime ? 'Downloading a local copy of the repo (first review only)' : 'Fetching new commits', 6);
    await this.cache.fetchPr(job.repo, job.pr_number, job.head_sha, pr.baseRef, pr.baseSha);
    if (signal.aborted) throw signal.reason;
    this.step(job, 'Checking out the PR', 12);
    const checkout = await this.cache.worktree(job.repo, job.head_sha, cfg.keepCheckouts);
    if (signal.aborted) {
      await checkout.cleanup();
      throw signal.reason;
    }
    return checkout;
  }

  // The review was requested again with no new commits. Nothing new is raised on code that
  // was already reviewed: each finding still open from earlier reviews is checked again
  // against the code and what was said on the PR since, and stays open or is resolved.
  private async recheck(job: Job, pr: PrInfo, signal: AbortSignal, cfg = this.cfg) {
    const open = this.previousFindings(job);
    const jobs = this.db.jobsForPr(job.repo, job.pr_number);
    const last = jobs.find((j) => j.id !== job.id && j.state === 'done' && j.head_sha === job.head_sha && j.dry_run === job.dry_run);

    const verdicts = new Map<number, { status: 'open' | 'resolved'; reason: string }>();
    let summary = '';
    let pass: { level: Confidence; reason: string } | null = null;
    let smuggled = false;
    if (open.length) {
      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `auto-reviewer-work-${job.id}-`));
      let checkout: Checkout | null = null;
      try {
        checkout = await this.checkout(job, pr, signal, cfg);
        this.step(job, 'Reading what was said on the PR since the last review', 18);
        const owners = new Set(open.map((f) => f.job_id));
        const since = jobs.filter((j) => owners.has(j.id)).map((j) => j.created_at).sort()[0] ?? job.created_at;
        const [discussion, { issues, prs }, prFiles] = await Promise.all([
          listDiscussion(this.gh, job.repo, job.pr_number, since),
          getLinkedRefs(this.gh, pr),
          listPrFiles(this.gh, job.repo, job.pr_number),
        ]);
        const prompt = recheckPrompt(pr, open, discussion, issues);
        const threads = new Set(open.map((f) => f.comment_id).filter((id) => id !== null));
        const people = discussion.filter((c) => !isOwnComment(c.body));
        this.db.setEvidence(job.id, {
          diff: null,
          ...refsEvidence(issues, prs),
          guidelines: [],
          history: [],
          previousFindings: open.length,
          discussion: {
            threadReplies: people.filter((c) => c.inReplyTo !== null && threads.has(c.inReplyTo)).length,
            conversation: people.filter((c) => c.inReplyTo === null).length,
          },
          promptChars: prompt.length,
        });

        this.step(job, `Re-checking ${open.length} open finding(s) from earlier reviews`, 30);
        const res = await this.router.run(job.id, 'recheck', {
          cwd: checkout.dir,
          workDir,
          timeoutMs: cfg.limits.passTimeoutSec * 1000,
          signal,
          instructions: recheckInstructions(this.gh.me),
          prompt,
          schema: recheckSchema,
        }, { config: cfg });
        const parsed = RecheckOut.safeParse(res.output);
        if (!parsed.success) throw new Error(`the re-check returned an unexpected shape: ${parsed.error.issues[0]?.message ?? ''}`);

        // Reasons and the summary are posted as written, so they get the same secret check as findings.
        const addedText = addedTextOf(prFiles);
        const clean = (text: string) => {
          const scrubbed = scrubText(text, addedText);
          smuggled ||= scrubbed.smuggled;
          return scrubbed.text;
        };
        for (const v of parsed.data.verdicts) verdicts.set(v.id, { status: v.status, reason: clean(v.reason) });
        summary = clean(parsed.data.summary);
        pass = { level: parsed.data.review_confidence.level, reason: clean(parsed.data.review_confidence.reason) };
      } finally {
        await checkout?.cleanup();
        await fs.rm(workDir, { recursive: true, force: true });
      }
    }
    if (smuggled) {
      this.db.event(job.id, 'The re-check put a credential that is not in the PR into its text. It was redacted; check the PR for prompt injection.', 'warn');
    }

    // A finding without a verdict stays open: only an explicit "resolved" closes one.
    const resolved = open.filter((f) => verdicts.get(f.id)?.status === 'resolved');
    const stillOpen = open.filter((f) => verdicts.get(f.id)?.status !== 'resolved');
    for (const f of resolved) this.db.updateFinding(f.id, { resolved_by_job: job.id });
    const reasonOf = (f: Finding) => ({ finding: f, reason: verdicts.get(f.id)?.reason ?? '' });
    this.db.event(job.id, open.length ? `Re-check: ${stillOpen.length} still open, ${resolved.length} resolved` : 'No findings from earlier reviews are open, so there was nothing to re-check');

    // With nothing re-read, the last review's rating of this same code still stands.
    const assessment = pass
      ? assess({
          findings: [],
          openEarlier: stillOpen,
          notRun: [],
          specStatus: last?.spec_status ?? 'not_checked',
          questions: 0,
          large: false,
          truncated: false,
          injection: smuggled,
          passes: [pass],
        })
      : null;
    if (assessment) this.db.event(job.id, `Confidence ${assessment.level}${assessment.reasons.length ? `: ${assessment.reasons.join('; ')}` : ''}`);
    job = this.db.updateJob(job.id, {
      review_body: recheckBody({ headSha: job.head_sha, summary, open: stillOpen.map(reasonOf), resolved: resolved.map(reasonOf), jobId: job.id }),
      spec_status: last?.spec_status ?? null,
      confidence: assessment ? assessment.level : (last?.confidence ?? null),
      confidence_notes: assessment ? assessment.reasons.join('\n') || null : (last?.confidence_notes ?? null),
    });

    if (signal.aborted) throw signal.reason;
    await this.publish(job, []);
  }

  // What stops a re-check from approving: any finding from earlier reviews still open. With a
  // blocker or major among them it requests changes; otherwise it comments. null when nothing
  // is open, or for a normal review.
  private recheckHold(job: Job): { note: string; requestChanges: boolean } | null {
    if (job.kind !== 'recheck') return null;
    const open = this.previousFindings(job, true);
    if (!open.length) return null;
    return {
      note: `${countsLine(open)} still open from earlier reviews`,
      requestChanges: open.some((f) => f.severity === 'blocker' || f.severity === 'major'),
    };
  }

  // Findings raised in earlier reviews of this PR that haven't been marked fixed.
  private previousFindings(job: Job, includePublished = false): Finding[] {
    return this.db.all<Finding>(
      `SELECT f.* FROM findings f JOIN jobs j ON j.id = f.job_id
       WHERE j.repo = ? AND j.pr_number = ? AND j.id != ? AND j.state = 'done' AND (j.dry_run = ? OR (? = 1 AND j.dry_run = 0))
         AND f.status != 'dropped'
         AND (f.resolved_by_job IS NULL OR (f.resolved_by_job != ? AND NOT EXISTS (SELECT 1 FROM jobs resolved WHERE resolved.id = f.resolved_by_job AND resolved.state = 'done')))
         AND COALESCE(f.outcome, '') != 'deleted'`,
      job.repo, job.pr_number, job.id, job.dry_run, includePublished ? 1 : 0, job.id,
    );
  }

  private async verify(
    job: Job,
    ctx: ReviewContext,
    candidates: Candidate[],
    placeOpts: Parameters<typeof placeFindings>[1],
    task: { cwd: string; workDir: string; timeoutMs: number; signal: AbortSignal },
    cfg = this.cfg,
  ): Promise<Candidate[]> {
    // Only findings that survive the cheap checks are worth a second model's time.
    const pre = placeFindings(candidates, placeOpts);
    const toVerify = candidates
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => pre[i].status !== 'dropped' && (c.severity === 'blocker' || c.severity === 'major'));
    if (!toVerify.length) return candidates;

    // A separate run with fresh context, on the same provider order as the review itself.
    const out = candidates.map((c) => ({ ...c }));
    const list = toVerify
      .map(({ c, i }) =>
        [`### Finding id ${i}`, `${c.severity} · ${c.category} · ${c.file}${c.line ? `:${c.line}` : ''}`, `Title: ${c.title}`, `Problem: ${c.problem}`, `Evidence:\n${c.evidence}`].join('\n'),
      )
      .join('\n\n');
    try {
      const res = await this.router.run(job.id, 'verify', {
        ...task,
        instructions: verifyInstructions(),
        prompt: `${ctx.prompt}\n\n## Findings to check\n\n${list}`,
        schema: verifySchema,
      }, { config: cfg });
      const parsed = VerifyOut.safeParse(res.output);
      if (!parsed.success) throw new Error('the double-check returned an unexpected shape');
      const byId = new Map(parsed.data.verdicts.map((v) => [v.id, v]));
      for (const { i } of toVerify) {
        const v = byId.get(i);
        const c = out[i];
        c.verified_by = res.provider;
        if (!v) {
          c.verification = 'skipped';
          continue;
        }
        c.verify_reason = v.reason;
        c.verification = v.verdict;
        if (v.verdict === 'confirmed') c.severity = minSeverity(c.severity, v.adjusted_severity);
        if (v.verdict === 'uncertain') {
          c.severity = lowerSeverity(c.severity);
          c.confidence = 'low';
        }
      }
      const refuted = toVerify.filter(({ i }) => out[i].verification === 'refuted').length;
      this.db.event(job.id, `${res.provider} ${res.model ?? ''} double-checked ${toVerify.length} finding(s): ${refuted} refuted`);
    } catch (err) {
      if (task.signal.aborted) throw err;
      for (const { i } of toVerify) out[i].verification = 'skipped';
      const why = err instanceof NoProviderAvailable ? 'no model available' : err instanceof Error ? err.message : String(err);
      this.db.event(job.id, `Couldn't double-check the findings (${why}); posting them unverified`, 'warn');
    }
    return out;
  }

  private async publish(job: Job, findings: Finding[]) {
    if (readPolicy(job)?.settings.reviewProfile === 'strict' && (!readReport(job)?.complete || readReport(job)?.version !== POLICY_VERSION)) throw new StrictReviewIncomplete('Strict coverage is incomplete; automatic posting is disabled');
    if (job.dry_run) {
      const inline = findings.filter((f) => f.status === 'inline' && f.line !== null).length;
      this.step(job, `Dry run: not posted. Ready to post a ${job.mode} review with ${inline} inline comment(s)`, 100);
      this.db.setState(job.id, 'done', { review_state: 'DRY_RUN', progress: 100 });
      return;
    }

    // Last check before speaking for you: don't post on a commit that's already outdated.
    const pr = await getPr(this.gh, job.repo, job.pr_number);
    if (pr.state !== 'open') throw new JobObsolete('PR is no longer open');
    if (!this.cfg.isRepoAllowed(job.repo)) throw new JobObsolete('repo is no longer in your repos list');
    if (pr.headSha !== job.head_sha) throw new JobObsolete(`superseded by new commits (${pr.headSha.slice(0, 7)})`);
    await this.post(job, findings, job.mode, pr);
  }

  // Why this review shouldn't approve the PR, or null when it should. Checked again right
  // before posting, against the PR as it is then.
  private async whyNotApprove(job: Job, pr: PrInfo, posted: Finding[]): Promise<string | null> {
    const { enabled, minConfidence } = this.cfg.approval;
    const frozen = readPolicy(job)?.settings.approval;
    const reasons: string[] = [];
    if (!enabled || frozen?.enabled === false) reasons.push('Approving is turned off in Settings');
    const findings = [...posted, ...this.previousFindings(job, true)];
    const blockers = openBlockers(findings);
    if (blockers) reasons.push(`${blockers} blocker${blockers === 1 ? '' : 's'} still open`);
    if (!job.confidence) reasons.push('This review has no confidence level (it was made before approvals existed)');
    else if (!atLeast(job.confidence, minConfidence) || (frozen && !atLeast(job.confidence, frozen.minConfidence))) reasons.push(`Confidence is ${job.confidence}; approving needs ${minConfidence === 'high' || frozen?.minConfidence === 'high' ? 'high' : 'medium'}`);
    reasons.push(...strictApprovalBlocks(job, findings, this.cfg.reviewProfile === 'strict'));
    if (pr.draft) reasons.push('The PR is still a draft');
    if (pr.author.toLowerCase() === this.gh.me.toLowerCase()) reasons.push("GitHub doesn't let you approve your own PR");
    if (pr.headSha !== job.head_sha) reasons.push('The PR has new commits since this review');
    // A change request the app published (from a re-check) is superseded by approving; yours isn't.
    const verdict = await myVerdict(this.gh, job.repo, job.pr_number);
    if (verdict?.state === 'CHANGES_REQUESTED' && !this.publishedByApp(verdict.reviewId)) reasons.push('You requested changes on this PR yourself');
    return [...new Set(reasons)].join('; ') || null;
  }

  private async decision(job: Job, pr: PrInfo, findings: Finding[]) {
    const hold = this.recheckHold(job);
    const reasons = await this.whyNotApprove(job, pr, findings);
    const strict = this.cfg.reviewProfile === 'strict' || readPolicy(job)?.settings.reviewProfile === 'strict';
    return {
      approveNote: strict ? [hold?.note, reasons].filter(Boolean).join('; ') || null : hold?.note ?? reasons,
      requestChanges: hold?.requestChanges === true,
    };
  }

  // Reviews you submitted from a draft are yours, even if the app wrote them.
  private publishedByApp(reviewId: number | undefined): boolean {
    return typeof reviewId === 'number' && Boolean(this.db.get(`SELECT id FROM jobs WHERE review_id = ? AND mode = 'publish'`, reviewId));
  }

  // Sends a prepared review to GitHub on the reviewed commit and sets the label. Drafts are
  // pending reviews only you can see; published reviews approve the PR when nothing stands
  // in the way, request changes when a re-check finds blockers or majors still open, and
  // comment otherwise.
  private async post(job: Job, findings: Finding[], mode: ReviewMode, pr: PrInfo, allowPartial = false) {
    const strict = readPolicy(job)?.settings.reviewProfile === 'strict';
    const partial = strict && (!readReport(job)?.complete || readReport(job)?.version !== POLICY_VERSION);
    if (partial && !allowPartial) throw new PostRefused('This Strict review is incomplete. Explicitly choose to post a partial review, or finish a full review first.');
    const posted = findings.filter((f) => f.status !== 'dropped');
    const inline: InlineComment[] = posted
      .filter((f) => f.status === 'inline' && f.line !== null)
      .map((f) => ({ findingId: f.id, path: f.file, line: f.line!, body: inlineBody(f) }));
    // The last check before anything leaves: none of the app's own credentials, in any form.
    if (containsSecret([job.review_body ?? '', ...inline.map((c) => c.body)], ownSecrets([this.gh.token]))) {
      throw new UnsafeToPost("The review contains one of the app's own credentials, so nothing was posted. Check the PR for prompt injection.");
    }
    const decision = await this.decision(job, pr, posted);
    const approveNote = decision.approveNote;
    const requestChanges = !partial && mode === 'publish' && decision.requestChanges;
    const approve = !partial && mode === 'publish' && approveNote === null;
    const event: ReviewEvent = mode === 'draft' ? null : requestChanges ? 'REQUEST_CHANGES' : approve ? 'APPROVE' : 'COMMENT';

    const doing = mode === 'draft' ? 'Posting draft review (only you can see it)' : requestChanges ? 'Requesting changes' : approve ? 'Approving the PR' : 'Posting review comment';
    this.step(job, doing, 95);
    let body = job.review_body ?? '';
    if (strict) {
      if (partial) body = body.replace(/\*\*No issues found\.\*\*/g, '**No new findings in the reviewed sections.**').replace('this result is retained locally until recovery completes.', 'posted explicitly as a partial review; unchecked areas remain.');
      const verdict = approveNote ? `**Approval withheld:** ${approveNote}` : '**Approval checks passed.**';
      body = insertBeforeMarker(body, verdict);
    }
    if (containsSecret([body, ...inline.map((c) => c.body)], ownSecrets([this.gh.token]))) throw new UnsafeToPost("The final review contains one of the app's own credentials, so nothing was posted.");
    const res = await postReview(this.gh, job.repo, job.pr_number, job.head_sha, event, body, inline);
    if (res.droppedInline) {
      this.db.event(job.id, 'GitHub rejected an inline comment position, so every finding went into the review body instead', 'warn');
      for (const f of inline) this.db.updateFinding(f.findingId, { status: 'summary' });
    } else {
      for (const c of inline) this.db.updateFinding(c.findingId, { posted_body: c.body });
    }
    for (const [findingId, commentId] of res.commentIds) this.db.updateFinding(findingId, { comment_id: commentId });
    for (const f of posted) this.db.updateFinding(f.id, { outcome: mode === 'draft' ? 'pending' : 'published' });

    const label = mode === 'draft' ? 'reviewing' : approve ? 'approved' : 'feedback';
    const labelOk = await showLabel(this.gh, job.repo, job.pr_number, this.cfg.labels, label, pr.labels);
    this.db.setState(job.id, 'done', {
      mode,
      dry_run: 0, // from here on it's a real review: follow-ups build on it and kept comments are tracked
      review_id: res.id,
      review_url: res.url,
      review_state: res.state,
      review_body: body,
      approve_note: approveNote,
      label_ok: labelOk ? 1 : 0,
      progress: 100,
      step: mode === 'draft' ? 'Draft review ready for you on GitHub' : requestChanges ? 'Changes requested' : approve ? 'Approved' : 'Review posted',
    });
    this.db.event(job.id, `Review ${res.state.toLowerCase()} with ${res.commentIds.size} inline comment(s): ${res.url}`);
    if (requestChanges) this.db.event(job.id, `Requested changes for you: ${approveNote}`);
    else if (approve) this.db.event(job.id, `Approved the PR for you (confidence ${job.confidence})`);
    else if (mode === 'publish') this.db.event(job.id, `Not approved: ${approveNote}`);
    else if (decision.requestChanges) this.db.event(job.id, `${approveNote}: submit the draft as "Request changes" if you agree`);
    else if (approveNote === null) this.db.event(job.id, 'No blockers and confidence is high enough: submit the draft as an approval if you agree');
  }

  // ---- posting a dry-run review from the dashboard

  private readonly posting = new Set<number>();

  private postable(id: number): Job {
    const job = this.db.job(id);
    if (!job) throw new PostRefused('Review not found');
    if (job.review_id) throw new PostRefused('This review is already on GitHub');
    const partial = readPolicy(job)?.settings.reviewProfile === 'strict' && !readReport(job)?.complete && job.review_body && ['failed', 'cancelled'].includes(job.state);
    if (!partial && (!job.dry_run || job.state !== 'done' || job.review_state !== 'DRY_RUN')) throw new PostRefused('Only finished dry runs or stopped incomplete Strict reviews can be posted');
    if (!this.cfg.isRepoAllowed(job.repo)) throw new PostRefused('This repo is no longer in your repos list');
    if (this.posting.has(id)) throw new PostRefused('Already posting this review');
    return job;
  }

  // What posting would do, checked against the PR as it is now.
  async previewPost(id: number): Promise<PostPreview> {
    const job = this.postable(id);
    const pr = await getPr(this.gh, job.repo, job.pr_number);
    if (pr.state !== 'open') throw new PostRefused('This PR is no longer open');
    const findings = this.db.findings(id).filter((f) => f.status !== 'dropped');
    const { approveNote, requestChanges } = await this.decision(job, pr, findings);
    const partial = readPolicy(job)?.settings.reviewProfile === 'strict' && (!readReport(job)?.complete || readReport(job)?.version !== POLICY_VERSION);
    return {
      inline: findings.filter((f) => f.status === 'inline' && f.line !== null).length,
      inSummary: findings.filter((f) => f.status === 'summary' || (f.status === 'inline' && f.line === null)).length,
      reviewedSha: job.head_sha,
      currentSha: pr.headSha,
      defaultMode: this.cfg.modeFor(job.repo),
      approveNote,
      requestChanges: !partial && requestChanges,
      partial,
      labels: { draft: this.cfg.labels.reviewing, publish: approveNote === null ? this.cfg.labels.approved : this.cfg.labels.feedback },
    };
  }

  async postDryRun(id: number, mode: ReviewMode, allowPartial = false): Promise<Job> {
    const job = this.postable(id);
    this.posting.add(id);
    try {
      const pr = await getPr(this.gh, job.repo, job.pr_number);
      if (pr.state !== 'open') throw new PostRefused('This PR is no longer open');
      this.db.event(id, `Posting to GitHub from the dashboard as a ${mode === 'draft' ? 'draft' : 'published review'}`);
      if (pr.headSha !== job.head_sha) {
        this.db.event(
          id,
          `The PR moved on to ${pr.headSha.slice(0, 7)}; comments go on the reviewed commit ${job.head_sha.slice(0, 7)} and may show as outdated`,
          'warn',
        );
      }
      await this.post(job, this.db.findings(id), mode, pr, allowPartial);
      return this.db.job(id)!;
    } catch (err) {
      // Put the review back as it was, ready to try again.
      this.db.updateJob(id, { step: job.step, progress: job.progress });
      if (err instanceof PendingReviewExists) {
        throw new PostRefused('You already have an unsubmitted review on this PR. Submit or discard it on GitHub, then try again.');
      }
      if (err instanceof UnsafeToPost) {
        this.db.event(id, err.message, 'error');
        throw new PostRefused(err.message);
      }
      if (!(err instanceof PostRefused)) this.db.event(id, `Posting failed: ${err instanceof Error ? err.message : err}`, 'error');
      throw err;
    } finally {
      this.posting.delete(id);
    }
  }

  private async labelStart(job: Job, pr: PrInfo) {
    if (job.dry_run) return;
    const ok = await showLabel(this.gh, job.repo, job.pr_number, this.cfg.labels, 'reviewing', pr.labels);
    if (!ok) this.db.event(job.id, 'Can\'t set labels on this repo (needs triage access); the review body carries a marker instead', 'warn');
  }

  // A review that stops early takes its "on review" label with it.
  async labelFailed(job: Job) {
    if (job.dry_run) return;
    await removeLabel(this.gh, job.repo, job.pr_number, this.cfg.labels.reviewing);
  }

  async labelCancelled(job: Job) {
    await this.labelFailed(job);
  }
}

function parseReview(output: unknown, pass: string): ReviewOut {
  const parsed = ReviewOut.safeParse(output);
  if (!parsed.success) throw new Error(`${pass} pass returned an unexpected shape: ${parsed.error.issues[0]?.message ?? ''}`);
  return parsed.data;
}

// Each review owns its categories, whatever the model picked.
function toCandidate(f: ReviewOut['findings'][number], type: ReviewType, model: Provider, modelId: string | null): Candidate {
  const category = type === 'security' ? 'security' : type === 'consistency' ? (f.category === 'docs' ? 'docs' : 'requirement') : f.category;
  return {
    ...f,
    category,
    pass: PASS_OF[type],
    model,
    model_id: modelId,
    original_severity: f.severity,
    verification: 'not_needed',
    verified_by: null,
    verify_reason: null,
  };
}
