import { useEffect, useRef, useState } from 'react';
import type { ContextResult, ContextStatus } from '../../../src/types.ts';
import { getJson, postJson } from '../api.ts';
import { shortSha, timeAgo } from '../ui.tsx';

const UPLOADABLE = /\.(md|mdx|markdown|txt)$/i;

// The baseline of one saved context entry: where it stands, building it, adding markdown
// by upload, and trying a search to see what a review would be given.
export function ContextBaseline({ id }: { id: string }) {
  const [status, setStatus] = useState<ContextStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<ContextResult | null>(null);
  const folder = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getJson<{ sets: { id: string; status: ContextStatus }[] }>('/api/context')
      .then((r) => setStatus(r.sets.find((s) => s.id === id)?.status ?? null))
      .catch(() => {});
  }, [id]);

  const act = async (label: string, fn: () => Promise<{ status: ContextStatus; skipped?: number }>, done: (r: { status: ContextStatus; skipped?: number }) => string) => {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      const res = await fn();
      setStatus(res.status);
      setMessage(done(res));
      setFound(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const upload = async (list: FileList | null) => {
    const picked = [...(list ?? [])];
    const usable = picked.filter((f) => UPLOADABLE.test(f.name));
    if (!usable.length) {
      setError(picked.length ? 'None of those are markdown or text files (.md, .mdx, .markdown, .txt).' : null);
      return;
    }
    await act(
      'Uploading…',
      async () => postJson('/api/context/' + id + '/upload', { files: await Promise.all(usable.map(async (f) => ({ path: f.webkitRelativePath || f.name, text: await f.text() }))) }),
      (r) => `Added ${usable.length} file${usable.length === 1 ? '' : 's'}${picked.length > usable.length ? `, skipped ${picked.length - usable.length} that aren't markdown or text` : ''}. ${r.status.docs} documents in the baseline now.`,
    );
    if (folder.current) folder.current.value = '';
    if (files.current) files.current.value = '';
  };

  const search = async () => {
    if (!query.trim()) return;
    setError(null);
    try {
      setFound(await getJson<ContextResult>(`/api/context/${id}/search?q=${encodeURIComponent(query)}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const built = status?.builtAt;
  return (
    <div className="context-baseline small">
      <div>
        {!status ? (
          <span className="muted">Loading…</span>
        ) : built ? (
          <>
            <strong>Baseline:</strong> {status.docs.toLocaleString()} document{status.docs === 1 ? '' : 's'} · {status.sections.toLocaleString()} sections · {status.links.toLocaleString()} links
            <span className="muted">
              {' '}
              · built {timeAgo(built)}
              {status.sources.map((s) => ` · ${s.name}@${shortSha(s.sha)}`).join('')}
              {status.uploads > 0 && ` · ${status.uploads} uploaded`}
            </span>
          </>
        ) : (
          <span className="muted">No baseline yet. Build it now, or it is built before the first review.</span>
        )}
      </div>
      {status?.error && <div className="error">Couldn't refresh: {status.error}. The last baseline is still in use.</div>}
      <div className="row wrap-row">
        <button type="button" className="btn btn-small" disabled={busy !== null} onClick={() => act('Building…', () => postJson(`/api/context/${id}/baseline`), (r) => `Baseline is up to date: ${r.status.docs} documents.`)}>
          {busy === 'Building…' ? busy : built ? 'Refresh baseline' : 'Build baseline'}
        </button>
        <button type="button" className="btn btn-ghost btn-small" disabled={busy !== null} onClick={() => folder.current?.click()}>
          {busy === 'Uploading…' ? busy : 'Upload a folder'}
        </button>
        <button type="button" className="btn btn-ghost btn-small" disabled={busy !== null} onClick={() => files.current?.click()}>
          Upload files
        </button>
        {status && status.uploads > 0 && (
          <button type="button" className="btn btn-ghost btn-small" disabled={busy !== null} onClick={() => act('Clearing…', () => postJson(`/api/context/${id}/uploads/clear`), () => 'Uploaded files removed.')}>
            Remove uploads
          </button>
        )}
        <input ref={folder} type="file" hidden multiple {...{ webkitdirectory: '' }} onChange={(e) => upload(e.target.files)} />
        <input ref={files} type="file" hidden multiple accept=".md,.mdx,.markdown,.txt" onChange={(e) => upload(e.target.files)} />
      </div>
      {message && <div>{message}</div>}
      {error && <div className="error">{error}</div>}

      {built && status.docs > 0 && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Try a search: what would a review about these words be given?" aria-label="Try a search" />
          <button className="btn btn-ghost btn-small" disabled={!query.trim()}>
            Search
          </button>
        </form>
      )}
      {found && (
        <div>
          {found.hits.length ? (
            <ul className="plain-list">
              {found.hits.map((h, i) => (
                <li key={i}>
                  <strong>{h.heading}</strong>{' '}
                  <span className="muted">
                    · {h.source}: {h.path} · {h.how === 'matched' ? 'matched' : `linked with “${h.via}”`} · {h.text.length.toLocaleString()} characters
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="muted">Nothing in the baseline matches those words.</span>
          )}
        </div>
      )}
    </div>
  );
}
