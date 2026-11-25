import { useEffect, useState } from 'react';
import type { MyReview, PrRow } from '../../../src/types.ts';
import { getJson, postJson, useStream, useTick } from '../api.ts';
import { Segmented } from './SettingsControls.tsx';
import { clockTime, SeverityCounts, timeAgo } from '../ui.tsx';

const REVIEW_LABEL: Record<MyReview, string> = {
  approved: 'Approved',
  changes_requested: 'Changes requested',
  commented: 'Commented',
  draft: 'Draft, not submitted',
  dry_run: 'Dry run, not posted',
  not_posted: 'Not on GitHub',
};

type Filter = 'all' | 'open' | 'approved' | 'changes_requested' | 'commented' | 'merged' | 'closed';
const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['open', 'Open'],
  ['approved', 'Approved'],
  ['changes_requested', 'Changes requested'],
  ['commented', 'Commented'],
  ['merged', 'Merged'],
  ['closed', 'Closed'],
];
const matches = (p: PrRow, f: Filter) => f === 'all' || f === p.state || f === p.review || (f === 'open' && p.state === 'unknown');

function usePrs() {
  const [prs, setPrs] = useState<PrRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    getJson<PrRow[]>('/api/prs')
      .then((rows) => {
        setPrs(rows);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoaded(true));
  useEffect(() => void load(), []);
  // A PR changed on GitHub, or a review finished.
  useStream((m) => {
    if (m.type === 'prs' || (m.type === 'job' && m.job.state === 'done')) void load();
  });
  return { prs, loaded, error, reload: load };
}

function Review({ p }: { p: PrRow }) {
  return (
    <>
      <span className={`verdict verdict-${p.review}`}>{REVIEW_LABEL[p.review]}</span>
      {p.reviewOutdated && <div className="small muted">on an older commit</div>}
      {p.pendingDraft && <div className="small muted">plus a draft not submitted</div>}
    </>
  );
}

function PrState({ p }: { p: PrRow }) {
  const label = p.state === 'unknown' ? 'Checking…' : p.draft && p.state === 'open' ? 'Draft' : p.state[0].toUpperCase() + p.state.slice(1);
  const others = [
    p.changesBy.length ? `${p.changesBy.map((l) => `@${l}`).join(', ')} requested changes` : '',
    p.approvedBy.length ? `approved by ${p.approvedBy.map((l) => `@${l}`).join(', ')}` : '',
  ].filter(Boolean);
  return (
    <>
      <span className={`prstate prstate-${p.state}`}>{label}</span>
      {p.state === 'merged' && p.mergedAt && <div className="small muted nowrap">{timeAgo(p.mergedAt)}</div>}
      {others.map((o) => (
        <div key={o} className="small muted">
          {o}
        </div>
      ))}
    </>
  );
}

function AutoMerge({ p, onChange }: { p: PrRow; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { status, note, at } = p.merge;
  const toggle = async (hold: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await postJson('/api/prs/hold', { repo: p.repo, number: p.number, hold });
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (status === 'off') return <span className="muted small">{note || 'Off'}</span>;
  if (status === 'merged') return <span className="small">{note}</span>;
  const text = at && status === 'waiting' ? `Merges at ${clockTime(at)}` : at && status === 'failed' ? `${note}. Retrying at ${clockTime(at)}` : note;
  const canHold = p.state === 'open' && (status === 'waiting' || status === 'blocked' || status === 'failed');
  return (
    <div className="automerge" onClick={(e) => e.stopPropagation()}>
      {text && <span className={`small ${status === 'failed' ? 'error' : status === 'waiting' ? '' : 'muted'}`}>{text}</span>}
      {status === 'held' && (
        <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => toggle(false)}>
          Resume
        </button>
      )}
      {status === 'failed' && (
        <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => toggle(false)}>
          Retry now
        </button>
      )}
      {canHold && (
        <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => toggle(true)} title="Don't merge this PR until you resume it">
          Hold
        </button>
      )}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

export function PrsPage() {
  useTick();
  const { prs, loaded, error, reload } = usePrs();
  const [filter, setFilter] = useState<Filter>('all');
  const open = prs.filter((p) => p.state === 'open' || p.state === 'unknown');
  const shown = prs.filter((p) => matches(p, filter));
  const anyMerge = prs.some((p) => p.merge.status !== 'off');

  return (
    <div className="stack">
      <section className="stats">
        {(
          [
            ['Open', open.length],
            ['Approved', prs.filter((p) => p.review === 'approved').length],
            ['Changes requested', prs.filter((p) => p.review === 'changes_requested').length],
            ['Commented', prs.filter((p) => p.review === 'commented').length],
            ['Merged', prs.filter((p) => p.state === 'merged').length],
          ] as const
        ).map(([label, n]) => (
          <div key={label} className="stat">
            <div className="stat-n">{loaded ? n : '–'}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </section>

      <section>
        <div className="row wrap-row prs-head">
          <h2>
            Reviewed pull requests {prs.length > 0 && <span className="count">{prs.length}</span>}
          </h2>
          <Segmented label="Show" value={filter} onChange={setFilter} options={FILTERS} />
        </div>
        <p className="small muted">Your review as it stands on GitHub now, including reviews you submitted or changed yourself.</p>
        {error && <p className="error">{error}</p>}
        {shown.length ? (
          <div className="table-wrap">
            <table className="table clickable">
              <thead>
                <tr>
                  <th>Pull request</th>
                  <th>Author</th>
                  <th>Your review</th>
                  <th>PR</th>
                  {anyMerge && <th>Auto-merge</th>}
                  <th>Findings</th>
                  <th>Reviewed</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={`${p.repo}#${p.number}`} onClick={() => (window.location.hash = `#/jobs/${p.job.id}`)}>
                    <td>
                      <a href={p.url} className="repo" target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="Open on GitHub">
                        {p.repo}#{p.number}
                      </a>
                      <div className="truncate" title={p.title}>
                        {p.title}
                      </div>
                    </td>
                    <td>@{p.author}</td>
                    <td>
                      <Review p={p} />
                    </td>
                    <td>
                      <PrState p={p} />
                    </td>
                    {anyMerge && (
                      <td>
                        <AutoMerge p={p} onChange={reload} />
                      </td>
                    )}
                    <td>
                      <SeverityCounts counts={p.job.counts} />
                    </td>
                    <td className="muted nowrap">
                      <a href={`#/jobs/${p.job.id}`} onClick={(e) => e.stopPropagation()}>
                        {timeAgo(p.job.finishedAt)}
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">{!loaded ? 'Loading…' : prs.length ? 'No pull requests match.' : 'PRs show up here once they have a finished review.'}</p>
        )}
      </section>
    </div>
  );
}
