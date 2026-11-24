import { useEffect, useState } from 'react';
import type { RepoConfig, Settings, SettingsIssue } from '../../../src/settings-schema.ts';
import type { Overview } from '../../../src/types.ts';
import { ApiError, getJson, sendJson } from '../api.ts';
import { AppSettingsTab } from './SettingsApp.tsx';
import { RepoSettingsTab } from './SettingsRepos.tsx';

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string };
export type SettingsTab = 'repos' | 'app';

// Settings come in two parts: what is decided per repo, and what the whole app shares.
// Both are edited as one draft and saved together.
export function SettingsPage({ overview, tab }: { overview: Overview | null; tab: SettingsTab }) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [newRepo, setNewRepo] = useState<RepoConfig | null>(null);
  const [selected, setSelected] = useState(0);
  const [issues, setIssues] = useState<SettingsIssue[]>([]);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (save.kind !== 'saved') return;
    const t = setTimeout(() => setSave((s) => (s.kind === 'saved' ? { kind: 'idle' } : s)), 3000);
    return () => clearTimeout(t);
  }, [save.kind]);

  useEffect(() => {
    getJson<{ settings: Settings; newRepo: RepoConfig }>('/api/settings')
      .then((res) => {
        setSaved(res.settings);
        setDraft(res.settings);
        setNewRepo(res.newRepo);
        // Start on a repo that is being reviewed, if there is one.
        setSelected(Math.max(0, res.settings.repos.findIndex((r) => r.enabled)));
      })
      .catch((e) => setLoadError(String(e.message ?? e)));
  }, []);

  if (loadError) return <p className="error">{loadError}</p>;
  if (!draft || !saved || !newRepo) return <p className="empty">Loading…</p>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const edit = (fn: (d: Settings) => void) => {
    setDraft((d) => {
      const next = structuredClone(d!);
      fn(next);
      return next;
    });
    if (save.kind !== 'saving') setSave({ kind: 'idle' });
  };

  // Messages for a field and anything under it, e.g. "repos.0.skipAuthors" covers
  // "repos.0.skipAuthors.2".
  const errorFor = (path: string) => {
    const found = issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`));
    if (!found.length) return undefined;
    return found
      .map((i) => {
        const index = i.path.slice(path.length + 1).split('.')[0];
        return /^\d+$/.test(index) ? `Line ${Number(index) + 1}: ${i.message}` : i.message;
      })
      .join(' · ');
  };

  const onSave = async () => {
    setSave({ kind: 'saving' });
    try {
      const res = await sendJson<{ settings: Settings }>('PUT', '/api/settings', draft);
      setSaved(res.settings);
      setDraft(res.settings);
      setIssues([]);
      setSave({ kind: 'saved' });
    } catch (err) {
      const found = (err instanceof ApiError ? (err.data as { issues?: SettingsIssue[] } | null) : null)?.issues ?? [];
      setIssues(found);
      // Take you to the first thing that needs fixing, whichever part it is in.
      const first = found[0]?.path.split('.');
      if (first?.[0] === 'repos' && /^\d+$/.test(first[1] ?? '')) {
        setSelected(Number(first[1]));
        if (tab !== 'repos') window.location.hash = '#/settings';
      } else if (first && !found.some((i) => i.path.startsWith('repos.')) && tab !== 'app') {
        window.location.hash = '#/settings/app';
      }
      setSave({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const onDiscard = () => {
    setDraft(saved);
    setIssues([]);
    setSave({ kind: 'idle' });
  };

  const repoIssues = issues.some((i) => i.path.startsWith('repos'));
  const appIssues = issues.some((i) => !i.path.startsWith('repos'));

  return (
    <div className="stack settings-page">
      <nav className="subtabs" aria-label="Settings">
        <a className={tab === 'repos' ? 'active' : ''} href="#/settings">
          Repositories{repoIssues && <span className="error"> · needs fixing</span>}
        </a>
        <a className={tab === 'app' ? 'active' : ''} href="#/settings/app">
          App{appIssues && <span className="error"> · needs fixing</span>}
        </a>
      </nav>

      {tab === 'repos' ? (
        <RepoSettingsTab draft={draft} saved={saved} edit={edit} errorFor={errorFor} issues={issues} overview={overview} newRepo={newRepo} selected={selected} select={setSelected} />
      ) : (
        <AppSettingsTab draft={draft} edit={edit} errorFor={errorFor} overview={overview} />
      )}

      {(dirty || save.kind !== 'idle') && (
        <div className={`save-bar ${save.kind === 'error' ? 'save-bar-error' : ''}`} role="status">
          <span className="small">
            {save.kind === 'saving' && 'Saving…'}
            {save.kind === 'saved' && !dirty && '✓ Saved. Applies straight away.'}
            {save.kind === 'error' && save.message}
            {save.kind === 'idle' && dirty && 'You have unsaved changes.'}
          </span>
          {dirty && (
            <div className="row">
              <button type="button" className="btn btn-ghost" onClick={onDiscard} disabled={save.kind === 'saving'}>
                Discard
              </button>
              <button type="button" className="btn" onClick={onSave} disabled={save.kind === 'saving'}>
                Save changes
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
