import type { RepoConfig, Settings, SettingsIssue } from '../../../src/settings-schema.ts';
import type { Overview } from '../../../src/types.ts';
import { entryFor } from '../repos.ts';
import { timeAgo } from '../ui.tsx';
import { ContextBaseline } from './RepoContext.tsx';
import { Field, ListInput, NumberInput, Section, Segmented, Toggle, type Edit, type ErrorFor } from './SettingsControls.tsx';

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
// "owner/repo" or "owner/repo:folder", one per line. A pasted GitHub link is a repo.
const toSource = (line: string) => {
  if (/^https?:\/\//i.test(line)) return { repo: line, path: '' };
  const at = line.indexOf(':');
  return at < 0 ? { repo: line, path: '' } : { repo: line.slice(0, at).trim(), path: line.slice(at + 1).trim() };
};
const fromSource = (s: { repo: string; path: string }) => (s.path ? `${s.repo}:${s.path}` : s.repo);
const isPattern = (repo: string) => /[*?]/.test(repo);

// "Publish · Strict", as shown beside each repo in the list.
function summary(r: RepoConfig): string {
  if (!r.enabled) return 'Off';
  return [r.dryRun ? 'Dry run' : r.mode === 'draft' ? 'Draft' : 'Publish', r.profile === 'strict' ? 'Strict' : 'Standard'].join(' · ');
}

type Watching = Overview['github']['watching'];

// What the app sees on GitHub for an entry: the repo itself, or the repos a pattern covers.
function watched(r: RepoConfig, all: RepoConfig[], watching: Watching): Watching {
  return watching.filter((w) => entryFor(all, w.repo) === r);
}

function WatchLine({ w }: { w: Watching[number] }) {
  return (
    <li>
      <span className={w.ok ? 'ok-text' : 'error'}>{w.ok ? '✓' : '✗'}</span> <code>{w.repo}</code>{' '}
      <span className="muted">
        {w.ok ? `${w.openPrs} open PR${w.openPrs === 1 ? '' : 's'}, ${w.requestingYou} requesting you · checked ${timeAgo(w.checkedAt)}` : w.error}
      </span>
    </li>
  );
}

interface Props {
  draft: Settings;
  saved: Settings;
  edit: Edit;
  errorFor: ErrorFor;
  issues: SettingsIssue[];
  overview: Overview | null;
  // A repo entry as it starts out.
  newRepo: RepoConfig;
  selected: number;
  select: (i: number) => void;
}

export function RepoSettingsTab({ draft, saved, edit, errorFor, issues, overview, newRepo, selected, select }: Props) {
  const repos = draft.repos;
  const i = Math.min(selected, repos.length - 1);
  const repo = repos[i];
  const watching = overview?.github.watching ?? [];

  const add = () => {
    edit((d) => void d.repos.push({ ...structuredClone(newRepo), repo: '', context: { ...structuredClone(newRepo.context), id: newId() } }));
    select(repos.length);
  };

  return (
    <>
      <section className="repo-picker">
        <div className="row">
          <div>
            <h2>Repositories</h2>
            <p className="small muted section-desc">Only the repos listed here are ever reviewed. Each one has its own settings: pick a repo to change them.</p>
          </div>
          <button type="button" className="btn btn-small push" onClick={add}>
            Add repository
          </button>
        </div>
        {repos.length === 0 ? (
          <p className="empty">No repositories yet. Nothing is reviewed until you add one.</p>
        ) : (
          <div className="repo-list" role="tablist" aria-label="Repositories">
            {repos.map((r, n) => {
              const seen = watched(r, repos, watching);
              const requesting = seen.reduce((sum, w) => sum + w.requestingYou, 0);
              const broken = seen.filter((w) => !w.ok).length;
              const invalid = issues.some((x) => x.path === `repos.${n}` || x.path.startsWith(`repos.${n}.`));
              return (
                <button key={r.context.id} type="button" role="tab" aria-selected={n === i} className={`repo-row ${n === i ? 'active' : ''}`} onClick={() => select(n)}>
                  <span className="repo-name">{r.repo || 'New repository'}</span>
                  <span className="small muted">{summary(r)}</span>
                  <span className="small muted push">
                    {invalid ? (
                      <span className="error">Needs fixing</span>
                    ) : !r.enabled ? null : broken ? (
                      <span className="error">{isPattern(r.repo) ? `${broken} can't be read` : "Can't be read"}</span>
                    ) : seen.length ? (
                      `${isPattern(r.repo) ? `${seen.length} repo${seen.length === 1 ? '' : 's'} · ` : ''}${requesting} requesting you`
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {repo && <RepoForm key={repo.context.id} i={i} repo={repo} draft={draft} saved={saved} edit={edit} errorFor={errorFor} seen={watched(repo, repos, watching)} onRemoved={() => select(Math.max(0, i - 1))} />}
    </>
  );
}

interface FormProps {
  i: number;
  repo: RepoConfig;
  draft: Settings;
  saved: Settings;
  edit: Edit;
  errorFor: ErrorFor;
  seen: Watching;
  onRemoved: () => void;
}

function RepoForm({ i, repo, draft, saved, edit, errorFor, seen, onRemoved }: FormProps) {
  // Changes this repo's entry.
  const set = (fn: (r: RepoConfig) => void) => edit((d) => fn(d.repos[i]));
  const err = (path: string) => errorFor(`repos.${i}.${path}`);
  const others = draft.repos.filter((r, n) => n !== i && r.repo.trim());
  const strict = repo.profile === 'strict';
  const savedContext = saved.repos.find((r) => r.context.id === repo.context.id)?.context;
  const contextSaved = savedContext !== undefined && JSON.stringify(savedContext) === JSON.stringify(repo.context);
  const name = repo.repo.trim() || 'this repo';

  const copyFrom = (from: RepoConfig) =>
    set((r) => {
      const { dryRun, mode, profile, reviews, followUp, approval, merge, labels, skipAuthors, excludeGlobs, stalePrDays } = structuredClone(from);
      Object.assign(r, { dryRun, mode, profile, reviews, followUp, approval, merge, labels, skipAuthors, excludeGlobs, stalePrDays });
    });

  return (
    <div className="repo-form">
      <Section title="Repository" description="Everything from here down applies to this repo only.">
        <Field
          label="Repository"
          hint="owner/repo or a GitHub link. A pattern such as your-org/* covers every repo it matches that has no entry of its own."
          error={err('repo')}
        >
          <input value={repo.repo} placeholder="your-org/repo" autoFocus={!repo.repo} spellCheck={false} onChange={(e) => set((r) => void (r.repo = e.target.value))} />
        </Field>
        <Toggle
          checked={repo.enabled}
          onChange={(v) => set((r) => void (r.enabled = v))}
          label={<strong>Review pull requests here</strong>}
          hint="Off: nothing is reviewed, but these settings and the context are kept."
        />
        {repo.enabled && seen.length > 0 && (
          <Field label="On GitHub now">
            <ul className="watch-list small">
              {seen.map((w) => (
                <WatchLine key={w.repo} w={w} />
              ))}
            </ul>
          </Field>
        )}
        <div className="row wrap-row">
          {others.length > 0 && (
            <select
              value=""
              aria-label="Copy review settings from another repo"
              onChange={(e) => {
                const from = draft.repos.find((r) => r.context.id === e.target.value);
                if (from) copyFrom(from);
              }}
            >
              <option value="">Copy review settings from…</option>
              {others.map((r) => (
                <option key={r.context.id} value={r.context.id}>
                  {r.repo}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => {
              edit((d) => void d.repos.splice(i, 1));
              onRemoved();
            }}
          >
            Remove repository
          </button>
        </div>
        <div className="small muted">
          {others.length > 0 && 'Copying takes everything except the docs and the context. '}
          Removing a repo also removes its context baseline and uploaded files once you save.
        </div>
      </Section>

      <Section title="Posting to GitHub">
        <Toggle
          checked={repo.dryRun}
          onChange={(v) => set((r) => void (r.dryRun = v))}
          label={<strong>Dry run</strong>}
          hint="Reviews run and show up in the dashboard, but nothing is posted to GitHub and no labels change. Turn off when the reviews look right."
        />
        <Field
          label="How reviews are posted"
          hint={
            repo.mode === 'draft'
              ? 'A pending review only you can see. You edit it and submit it yourself.'
              : 'Posted straight away under your name. Approves when the rules allow it; rechecks request changes while blockers or majors remain.'
          }
        >
          <Segmented
            label="How reviews are posted"
            value={repo.mode}
            onChange={(v) => set((r) => void (r.mode = v))}
            options={[
              ['draft', 'Draft'],
              ['publish', 'Publish'],
            ]}
          />
        </Field>
        <Toggle
          checked={repo.approval.enabled}
          onChange={(v) => set((r) => void (r.approval.enabled = v))}
          label={<strong>Approve PRs that have no blockers</strong>}
          hint="Only published reviews approve. Never a draft (you decide when you submit it), a draft PR, your own PR, a PR with commits newer than the review, or one where you requested changes. An approval counts toward branch protection, so the PR may become mergeable."
        />
        {repo.approval.enabled && strict && (
          <p className="small muted">A Strict review approves only with high confidence, all required coverage and stages completed, and no open blockers or majors.</p>
        )}
        {repo.approval.enabled && !strict && (
          <Field
            label="Approve when confidence is at least"
            hint={
              repo.approval.minConfidence === 'high'
                ? 'High: no blockers or majors open, no open questions, requirements match, and every review is sure.'
                : 'Medium also approves with majors open, open questions, partly matching requirements, or a large change.'
            }
          >
            <Segmented
              label="Minimum confidence"
              value={repo.approval.minConfidence}
              onChange={(v) => set((r) => void (r.approval.minConfidence = v))}
              options={[
                ['high', 'High'],
                ['medium', 'Medium'],
              ]}
            />
          </Field>
        )}
      </Section>

      <Section title="Auto-merge" description="Merges PRs for you once they're approved. Off by default.">
        <Toggle
          checked={repo.merge.enabled}
          onChange={(v) => set((r) => void (r.merge.enabled = v))}
          label={<strong>Merge approved PRs</strong>}
          hint="Merges when your approval is on the PR's latest commit, nobody else has asked for changes, and GitHub says it can merge: required checks passed, branch rules met, no conflicts. Never during a dry run. Hold any PR from the Pull requests page."
        />
        {repo.merge.enabled && (
          <>
            {repo.mode === 'draft' && <p className="small muted">Reviews here are drafts, so a PR merges only after you submit your draft as an approval.</p>}
            {repo.mode === 'publish' && !repo.approval.enabled && <p className="small muted">Approving is off for this repo, so only PRs you approve yourself are merged.</p>}
            {repo.dryRun && <p className="small muted">Nothing merges until you turn off dry run.</p>}
            <Field label="Merge method" hint="The repo must allow it in its GitHub settings.">
              <Segmented
                label="Merge method"
                value={repo.merge.method}
                onChange={(v) => set((r) => void (r.merge.method = v))}
                options={[
                  ['squash', 'Squash'],
                  ['merge', 'Merge commit'],
                  ['rebase', 'Rebase'],
                ]}
              />
            </Field>
            <Field label="Wait after the approval" hint="Time to hold it from the Pull requests page before it merges. 0 merges as soon as GitHub allows." error={err('merge.delayMin')}>
              <NumberInput value={repo.merge.delayMin} min={0} max={1440} suffix="minutes" onChange={(v) => set((r) => void (r.merge.delayMin = v))} />
            </Field>
            <Toggle
              checked={repo.merge.deleteBranch}
              onChange={(v) => set((r) => void (r.merge.deleteBranch = v))}
              label="Delete the branch after merging"
              hint="Only branches in this repo, not forks."
            />
            <p className="small muted">The GitHub login needs write access to merge. For a fine-grained token, that's Contents: write.</p>
          </>
        )}
      </Section>

      <Section title="Reviews" description="How thoroughly each PR is reviewed, and what for. Each review is a separate model run, so fewer reviews use less of your subscription.">
        <Field
          label="Review profile"
          hint={
            strict
              ? 'Strict: both providers review, one independently of the other, and serious findings are verified. It needs complete coverage and high confidence before it approves, and uses many more model runs.'
              : 'Standard: one provider reviews, with an optional double-check of serious findings.'
          }
        >
          <Segmented
            label="Review profile"
            value={repo.profile}
            onChange={(v) => set((r) => void (r.profile = v))}
            options={[
              ['standard', 'Standard'],
              ['strict', 'Strict'],
            ]}
          />
        </Field>
        <div className="rows" role="group" aria-label="Reviews to run">
          <Toggle
            checked={repo.reviews.code}
            onChange={(v) => set((r) => void (r.reviews.code = v))}
            label={<strong>Code</strong>}
            hint="Bugs, edge cases, error handling, race conditions, missing tests, breaking changes."
          />
          <Toggle
            checked={repo.reviews.security}
            onChange={(v) => set((r) => void (r.reviews.security = v))}
            label={<strong>Security</strong>}
            hint="Injection, access control, secrets, unsafe defaults, dependency and CI changes."
          />
          <Toggle
            checked={repo.reviews.consistency}
            onChange={(v) => set((r) => void (r.reviews.consistency = v))}
            label={<strong>Consistency</strong>}
            hint="Whether the change agrees with its linked issue, its own description, the docs, and other open PRs touching the same code."
          />
        </div>
        {err('reviews') && <div className="small error">{err('reviews')}</div>}
        <div className="small muted">
          {strict
            ? 'In the Strict profile, code, security and the linked issue are always reviewed, whatever is ticked here. Consistency adds the docs and other open PRs.'
            : 'A PR is approved for you only when the code and security reviews both ran. Without the consistency review, confidence is medium at most.'}
        </div>
        {!strict && (
          <Field
            label="After the author pushes new commits"
            hint={
              repo.followUp === 'fixes'
                ? 'One run checks whether each earlier finding is fixed, and looks for blockers and majors in the new commits only. Usually a third of the cost of reviewing again. New commits over 400 changed lines, or over half the PR, or a rebase, get a full review of the whole PR instead.'
                : 'The reviews ticked above all run again on the new commits, and say which earlier findings are fixed.'
            }
          >
            <Segmented
              label="After the author pushes new commits"
              value={repo.followUp}
              onChange={(v) => set((r) => void (r.followUp = v))}
              options={[
                ['fixes', 'Check the fixes'],
                ['full', 'Review the new commits'],
              ]}
            />
          </Field>
        )}
      </Section>

      <Section
        title="Context"
        description={`Markdown that explains how ${name} is meant to work. It is read into a searchable graph once (the baseline) and every review looks its change up there. Baselining uses no model, and refreshes itself when a context repository changes.`}
      >
        <Field
          label="Context repositories"
          hint="One per line, readable with your GitHub token. Add :folder to use only part of one. The consistency review also looks here for docs the PR makes stale."
          error={err('context.sources')}
        >
          <ListInput
            value={repo.context.sources.map(fromSource)}
            onChange={(v) => set((r) => void (r.context.sources = v.map(toSource)))}
            rows={2}
            placeholder={'your-org/docs\nyour-org/handbook:architecture'}
          />
        </Field>
        <Field label="Anything every reviewer of this repo should know" error={err('context.notes')}>
          <textarea
            rows={2}
            value={repo.context.notes}
            placeholder="For example: amounts are stored in cents; the API is versioned by URL"
            onChange={(e) => set((r) => void (r.context.notes = e.target.value))}
          />
        </Field>
        {contextSaved ? (
          <ContextBaseline id={repo.context.id} />
        ) : (
          <div className="small muted">Save your changes to build the baseline or upload markdown.</div>
        )}
      </Section>

      <Section
        title="Docs and other PRs"
        description="For the consistency review. Other open PRs are only ever mentioned as alerts: they never block an approval or request changes."
      >
        <Field label="Docs inside the repo" hint="Folders or files, separated by commas. Left empty, the reviewer looks for docs in the repo itself." error={err('docs.paths')}>
          <input
            value={repo.docs.paths.join(', ')}
            placeholder="docs/, README.md"
            onChange={(e) => set((r) => void (r.docs.paths = e.target.value.split(',').map((p) => p.trim()).filter(Boolean)))}
          />
        </Field>
        <Field label="A separate docs repo" hint="Readable with your GitHub token. Context repositories above are already included." error={err('docs.docsRepo')}>
          <input value={repo.docs.docsRepo ?? ''} placeholder="your-org/docs" spellCheck={false} onChange={(e) => set((r) => void (r.docs.docsRepo = e.target.value.trim() || null))} />
        </Field>
        <Field label="Anything else about the docs" error={err('docs.notes')}>
          <textarea rows={2} value={repo.docs.notes} placeholder="For example: the API reference is generated, ignore docs/api" onChange={(e) => set((r) => void (r.docs.notes = e.target.value))} />
        </Field>
        <Field label="Another open PR is unmaintained after" hint="An overlap with an unmaintained PR is still mentioned, but always with low confidence." error={err('stalePrDays')}>
          <NumberInput value={repo.stalePrDays} min={1} max={3650} suffix="days without activity" onChange={(v) => set((r) => void (r.stalePrDays = v))} />
        </Field>
      </Section>

      <Section title="Files and authors">
        <div className="grid two">
          <Field label="Leave out of reviews" hint="File patterns, one per line: lockfiles, generated and vendored code." error={err('excludeGlobs')}>
            <ListInput value={repo.excludeGlobs} onChange={(v) => set((r) => void (r.excludeGlobs = v))} rows={6} />
          </Field>
          <Field label="Skip PRs by" hint="GitHub usernames, one per line. Applies to review requests, not PRs you add yourself." error={err('skipAuthors')}>
            <ListInput value={repo.skipAuthors} onChange={(v) => set((r) => void (r.skipAuthors = v))} rows={6} />
          </Field>
        </div>
      </Section>

      <Section title="Labels" description="A PR carries one of these at a time. Each is created in the repo the first time it's needed.">
        <Field label="While reviewing" hint="Stays on while your draft is unsubmitted." error={err('labels.reviewing')}>
          <input value={repo.labels.reviewing} onChange={(e) => set((r) => void (r.labels.reviewing = e.target.value))} />
        </Field>
        <Field label="Left feedback" hint="Reviewed without approving." error={err('labels.feedback')}>
          <input value={repo.labels.feedback} onChange={(e) => set((r) => void (r.labels.feedback = e.target.value))} />
        </Field>
        <Field label="Approved" hint="Approved for you, or you submitted your draft as an approval." error={err('labels.approved')}>
          <input value={repo.labels.approved} onChange={(e) => set((r) => void (r.labels.approved = e.target.value))} />
        </Field>
      </Section>
    </div>
  );
}
