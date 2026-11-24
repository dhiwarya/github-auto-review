import type { Settings } from '../../../src/settings-schema.ts';
import type { Overview, Provider, ProviderStatus } from '../../../src/types.ts';
import { postJson } from '../api.ts';
import { clockTime } from '../ui.tsx';
import { Field, ListInput, NumberInput, Section, Segmented, Toggle, type Edit, type ErrorFor } from './SettingsControls.tsx';

const NAME: Record<Provider, string> = { codex: 'Codex', claude: 'Claude' };
const other = (p: Provider): Provider => (p === 'codex' ? 'claude' : 'codex');
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// A provider's models as they are right now, from the live overview.
function ModelStatus({ p, role }: { p: ProviderStatus; role: string }) {
  return (
    <div className="model-status">
      <div className="card-top">
        <strong>{NAME[p.provider]}</strong>
        <span className="muted small">{role}</span>
        <span className={`pill push ${p.blocked_until ? 'pill-warn' : 'pill-ok'}`}>
          <span className="dot" />
          {p.blocked_until ? `paused until ${clockTime(p.blocked_until)}` : 'ready'}
        </span>
      </div>
      <ol className="model-chain small">
        {p.models.map((m, i) => (
          <li key={`${m.model}-${i}`}>
            <code>{m.model ?? '(CLI default)'}</code>
            {m.blocked_until ? (
              <span className="warn-text" title={m.last_error ?? undefined}>
                {' '}
                · paused until {clockTime(m.blocked_until)}
              </span>
            ) : (
              p.active_model === m.model && <span className="ok-text"> · in use</span>
            )}
          </li>
        ))}
      </ol>
      {p.last_error && <p className="small error">{p.last_error}</p>}
      {p.blocked_until && (
        <button type="button" className="btn btn-small btn-ghost" onClick={() => postJson(`/api/providers/${p.provider}/reset`)}>
          Try again now
        </button>
      )}
    </div>
  );
}

// What every repo shares: who reviews, how often, and how much work a review may be.
export function AppSettingsTab({ draft, edit, errorFor, overview }: { draft: Settings; edit: Edit; errorFor: ErrorFor; overview: Overview | null }) {
  const m = draft.models;
  const backup = other(m.provider);
  const byProvider = new Map(overview?.providers.map((p) => [p.provider, p]));
  // Strict is chosen per repo; its parts show up here once a repo uses it.
  const strictRepos = draft.repos.filter((r) => r.profile === 'strict').map((r) => r.repo);
  const anyStrict = strictRepos.length > 0;
  const backupRole = anyStrict ? (m.fallbackToOther ? 'backup, and independent review in Strict' : 'independent review in Strict') : m.fallbackToOther ? 'backup' : 'not used';

  return (
    <>
      <Section title="Reviewer" description="Your Codex and Claude Code logins do the reviewing, for every repo. One provider does a whole review; a repo on the Strict profile also uses the other one for an independent review.">
        <Field label="Who reviews">
          <Segmented
            label="Review provider"
            value={m.provider}
            onChange={(v) => edit((d) => void (d.models.provider = v))}
            options={[
              ['codex', 'Codex'],
              ['claude', 'Claude'],
            ]}
          />
        </Field>
        <Toggle
          checked={m.fallbackToOther}
          onChange={(v) => edit((d) => void (d.models.fallbackToOther = v))}
          label={`If ${NAME[m.provider]} runs out, use ${NAME[backup]} instead`}
          hint={`When every ${NAME[m.provider]} model hits its usage limit or you're signed out. Off: reviews wait until ${NAME[m.provider]} is available again. Applies to Standard reviews.`}
        />
        <Toggle
          checked={m.doubleCheck}
          onChange={(v) => edit((d) => void (d.models.doubleCheck = v))}
          label="Double-check blockers and majors before posting"
          hint="A fresh run re-reads serious findings. Refuted findings are dropped; uncertain ones are downgraded. Applies to Standard reviews; Strict always verifies them."
        />
        <div className="grid two">
          {([m.provider, backup] as Provider[]).map((p, i) => (
            <div key={p} className="model-card">
              <Field label={`${NAME[p]} models${i === 0 ? '' : ` (${backupRole})`}`} error={errorFor(`models.${p}`)}>
                <input value={draft.models[p].model ?? ''} placeholder="CLI default" onChange={(e) => edit((d) => void (d.models[p].model = e.target.value.trim() || null))} />
                <div className="small muted">First choice. Then, in order:</div>
                <ListInput value={draft.models[p].fallbackModels} onChange={(v) => edit((d) => void (d.models[p].fallbackModels = v))} rows={2} />
              </Field>
              {byProvider.get(p) && <ModelStatus p={byProvider.get(p)!} role={i === 0 ? 'reviews' : backupRole} />}
            </div>
          ))}
        </div>
        <Field label="Claude effort" hint="How hard Claude thinks. Default leaves it to Claude Code.">
          <select value={m.claudeEffort ?? ''} onChange={(e) => edit((d) => void (d.models.claudeEffort = (e.target.value || null) as Settings['models']['claudeEffort']))}>
            <option value="">Default</option>
            {EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      <Section title="Schedule">
        <div className="grid two">
          <Field label="Check GitHub every" hint="One request per watched repo, free when nothing changed. Many repos stretch the cycle to at most one request a second." error={errorFor('schedule.pollIntervalSec')}>
            <NumberInput value={draft.schedule.pollIntervalSec} min={5} max={3600} suffix="seconds" onChange={(v) => edit((d) => void (d.schedule.pollIntervalSec = v))} />
          </Field>
          <Field label="Most reviews per hour" hint="Across all repos. Protects your subscription limits." error={errorFor('schedule.maxReviewsPerHour')}>
            <NumberInput value={draft.schedule.maxReviewsPerHour} min={1} max={100} onChange={(v) => edit((d) => void (d.schedule.maxReviewsPerHour = v))} />
          </Field>
          <Field label="Reviews at the same time" error={errorFor('schedule.concurrency')}>
            <NumberInput value={draft.schedule.concurrency} min={1} max={4} onChange={(v) => edit((d) => void (d.schedule.concurrency = v))} />
          </Field>
          <Field label="Rest a model after a usage limit for" error={errorFor('schedule.quotaBackoffMin')}>
            <NumberInput value={draft.schedule.quotaBackoffMin} min={1} max={1440} suffix="minutes" onChange={(v) => edit((d) => void (d.schedule.quotaBackoffMin = v))} />
          </Field>
          <Field label="Check which draft comments you kept every" error={errorFor('schedule.syncIntervalSec')}>
            <NumberInput value={draft.schedule.syncIntervalSec} min={30} max={3600} suffix="seconds" onChange={(v) => edit((d) => void (d.schedule.syncIntervalSec = v))} />
          </Field>
        </div>
        <Toggle
          checked={draft.schedule.pauseBetween !== null}
          onChange={(v) => edit((d) => void (d.schedule.pauseBetween = v ? { start: '09:00', end: '18:00' } : null))}
          label="Pause reviews during part of the day"
          hint="To keep your subscription for your own work. Queued reviews start when the window ends."
        />
        {draft.schedule.pauseBetween && (
          <Field label="Paused between" error={errorFor('schedule.pauseBetween')}>
            <div className="row number-row">
              <input type="time" value={draft.schedule.pauseBetween.start} onChange={(e) => edit((d) => void (d.schedule.pauseBetween!.start = e.target.value))} />
              <span className="muted small">and</span>
              <input type="time" value={draft.schedule.pauseBetween.end} onChange={(e) => edit((d) => void (d.schedule.pauseBetween!.end = e.target.value))} />
            </div>
          </Field>
        )}
      </Section>

      <Section title="Review limits" description="How much one review may take on. Strict reviews use their own run budgets, below, but the nit cap and the retry limit still apply to them.">
        <div className="grid two">
          <Field label="Large PR above" hint="Then only blockers and majors are reported." error={errorFor('limits.largePrLines')}>
            <NumberInput value={draft.limits.largePrLines} min={100} suffix="changed lines" onChange={(v) => edit((d) => void (d.limits.largePrLines = v))} />
          </Field>
          <Field label="Project context per review" hint="How much of a repo's context baseline a review may be given." error={errorFor('limits.contextChars')}>
            <NumberInput value={draft.limits.contextChars} min={1000} max={60000} suffix="characters" onChange={(v) => edit((d) => void (d.limits.contextChars = v))} />
          </Field>
          <Field label="Most nits per review" error={errorFor('limits.maxNits')}>
            <NumberInput value={draft.limits.maxNits} min={0} max={20} onChange={(v) => edit((d) => void (d.limits.maxNits = v))} />
          </Field>
          <Field label="Time limit per model run" error={errorFor('limits.passTimeoutSec')}>
            <NumberInput value={draft.limits.passTimeoutSec} min={60} max={3600} suffix="seconds" onChange={(v) => edit((d) => void (d.limits.passTimeoutSec = v))} />
          </Field>
          <Field label="Attempts before giving up" error={errorFor('limits.maxAttempts')}>
            <NumberInput value={draft.limits.maxAttempts} min={1} max={10} onChange={(v) => edit((d) => void (d.limits.maxAttempts = v))} />
          </Field>
          <Field label="Diff size sent to the model" error={errorFor('limits.maxDiffChars')}>
            <NumberInput value={draft.limits.maxDiffChars} min={10000} max={1000000} suffix="characters" onChange={(v) => edit((d) => void (d.limits.maxDiffChars = v))} />
          </Field>
          <Field label="Claude turns per run" error={errorFor('limits.claudeMaxTurns')}>
            <NumberInput value={draft.limits.claudeMaxTurns} min={5} max={200} onChange={(v) => edit((d) => void (d.limits.claudeMaxTurns = v))} />
          </Field>
        </div>
      </Section>

      <Section
        title="Strict review budgets"
        description={
          <>
            {anyStrict ? `Used by ${strictRepos.filter(Boolean).join(', ') || 'the repos on the Strict profile'}.` : 'No repo uses the Strict profile yet; choose it under a repo’s Reviews.'} Large PRs are split into batches, then checked for
            interactions. Exhausted budgets leave explicit coverage gaps and prevent approval. Successful stages are reused on retry.
          </>
        }
      >
        <div className="grid two">
          <Field label="Time limit per Strict run" error={errorFor('strict.passTimeoutSec')}>
            <NumberInput value={draft.strict.passTimeoutSec} min={60} max={3600} suffix="seconds" onChange={(v) => edit((d) => void (d.strict.passTimeoutSec = v))} />
          </Field>
          <Field label="Characters per Strict run" error={errorFor('strict.maxDiffChars')}>
            <NumberInput value={draft.strict.maxDiffChars} min={10000} max={1000000} onChange={(v) => edit((d) => void (d.strict.maxDiffChars = v))} />
          </Field>
          <Field label="Maximum review batches" error={errorFor('strict.maxBatches')}>
            <NumberInput value={draft.strict.maxBatches} min={1} max={40} onChange={(v) => edit((d) => void (d.strict.maxBatches = v))} />
          </Field>
          <Field label="Maximum model attempts per job" hint="Includes fallback model attempts and verification." error={errorFor('strict.maxRuns')}>
            <NumberInput value={draft.strict.maxRuns} min={3} max={200} onChange={(v) => edit((d) => void (d.strict.maxRuns = v))} />
          </Field>
          <Field label="Continuations per stage" hint="Complete missing source/code sections without repeating completed coverage." error={errorFor('strict.maxContinuations')}>
            <NumberInput value={draft.strict.maxContinuations} min={0} max={4} onChange={(v) => edit((d) => void (d.strict.maxContinuations = v))} />
          </Field>
          <Field label="Attempts reserved for verification" error={errorFor('strict.verificationReserve')}>
            <NumberInput value={draft.strict.verificationReserve} min={1} max={40} onChange={(v) => edit((d) => void (d.strict.verificationReserve = v))} />
          </Field>
          <Field label="Claude turns per Strict run" error={errorFor('strict.claudeMaxTurns')}>
            <NumberInput value={draft.strict.claudeMaxTurns} min={5} max={200} onChange={(v) => edit((d) => void (d.strict.claudeMaxTurns = v))} />
          </Field>
          <Field label="Claude effort in Strict">
            <select value={draft.strict.claudeEffort} onChange={(e) => edit((d) => void (d.strict.claudeEffort = e.target.value as Settings['strict']['claudeEffort']))}>
              {EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Section>

      {overview && (
        <Section
          title="GitHub usage"
          description="The app checks each repo's open pull requests with conditional requests. When nothing changed GitHub answers “not modified”, which doesn't count against your limits."
        >
          {overview.github.paused_until && (
            <div className="small error">
              Paused: {overview.github.pause_reason}. Checking again at {clockTime(overview.github.paused_until)}.
            </div>
          )}
          {overview.github.last_cycle && (
            <div className="small">
              Last check: {overview.github.last_cycle.requests} request{overview.github.last_cycle.requests === 1 ? '' : 's'}, {overview.github.last_cycle.notModified} of them free.
            </div>
          )}
          <div className="limits">
            {overview.github.limits.map((l) => (
              <div key={l.resource} className="limit">
                <div className="small">
                  <strong>{l.resource}</strong>{' '}
                  <span className={l.remaining / l.limit < 0.1 ? 'warn-text' : 'muted'}>
                    {l.remaining.toLocaleString()} of {l.limit.toLocaleString()} left · resets {clockTime(l.reset)}
                  </span>
                </div>
                <div className="progress">
                  <div style={{ width: `${Math.max(2, (l.remaining / l.limit) * 100)}%` }} />
                </div>
              </div>
            ))}
            {overview.github.limits.length === 0 && <div className="small muted">Shows up after the first request.</div>}
          </div>
        </Section>
      )}

      <Section title="Advanced">
        <Toggle
          checked={draft.keepCheckouts}
          onChange={(v) => edit((d) => void (d.keepCheckouts = v))}
          label="Keep PR checkouts after each review"
          hint="For debugging. They're kept in your system's temp folder and removed when the app restarts."
        />
      </Section>
    </>
  );
}
