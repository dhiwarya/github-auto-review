import { createHash } from 'node:crypto';
import { nowIso, type Db } from '../db.ts';
import type { RepoCache } from '../git/mirror.ts';
import type { RepoConfig } from '../settings-schema.ts';
import type { ContextHit, ContextResult, ContextStatus } from '../types.ts';
import { parseMarkdown } from './markdown.ts';

// A repo's context: markdown from context repositories and uploads, kept as a graph in the
// app's database. Every document and every heading section is a node; a section belongs to
// its parent, and a link in one section is an edge to the document or section it points at.
// Reviews query it by keyword (SQLite full-text search) and then follow the edges, so what
// they get is connected context rather than isolated snippets.
//
// Building it ("baselining") reads files and parses markdown: no model runs. Only files
// that changed since the last baseline are read again.

export type ContextEntry = Pick<RepoConfig['context'], 'id' | 'sources'>;

const TABLES = `
CREATE TABLE IF NOT EXISTS context_sets (
  set_id TEXT PRIMARY KEY,
  built_at TEXT,
  sources TEXT NOT NULL DEFAULT '{}', -- source key -> the commit it was read at
  error TEXT
);
CREATE TABLE IF NOT EXISTS context_docs (
  id INTEGER PRIMARY KEY,
  set_id TEXT NOT NULL,
  source TEXT NOT NULL, -- "owner/repo:folder" or "upload"
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  hash TEXT NOT NULL,
  chars INTEGER NOT NULL,
  UNIQUE (set_id, source, path)
);
CREATE TABLE IF NOT EXISTS context_nodes (
  id INTEGER PRIMARY KEY,
  set_id TEXT NOT NULL,
  doc_id INTEGER NOT NULL,
  parent_id INTEGER,
  level INTEGER NOT NULL, -- 0 for the document itself
  ord INTEGER NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  heading_path TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS context_nodes_doc ON context_nodes (doc_id);
CREATE INDEX IF NOT EXISTS context_nodes_parent ON context_nodes (parent_id);
CREATE TABLE IF NOT EXISTS context_links (
  set_id TEXT NOT NULL,
  doc_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  path TEXT,
  anchor TEXT,
  wiki TEXT
);
CREATE INDEX IF NOT EXISTS context_links_doc ON context_links (doc_id);
CREATE TABLE IF NOT EXISTS context_edges (
  set_id TEXT NOT NULL,
  from_node INTEGER NOT NULL,
  to_node INTEGER NOT NULL,
  PRIMARY KEY (from_node, to_node)
);
CREATE INDEX IF NOT EXISTS context_edges_to ON context_edges (to_node);
CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(title, heading_path, text, tokenize = 'porter unicode61');
`;

export const UPLOAD = 'upload';
const MARKDOWN = /\.(md|mdx|markdown)$/i;
// Tool settings and dependencies aren't documentation: .github, .kiro, node_modules and the like.
const HIDDEN = /(^|\/)(\.[^/]+|node_modules)\//;
const MAX_FILE_BYTES = 1_000_000;
const SEEDS = 8;
const PER_DOC = 3;
const NEIGHBOURS = 2;
const SEED_CHARS = 2400;
const NEIGHBOUR_CHARS = 1000;

interface NodeRow {
  id: number;
  doc_id: number;
  parent_id: number | null;
  level: number;
  title: string;
  heading_path: string;
  text: string;
}

const sourceKey = (s: { repo: string; path: string }) => `${s.repo}:${s.path.replace(/^\/+|\/+$/g, '')}`;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n…[cut]` : text);

export class ContextStore {
  private readonly db: Db;
  private readonly busy = new Map<string, Promise<unknown>>();

  constructor(db: Db) {
    this.db = db;
    db.sql.exec(TABLES);
  }

  // One build per set at a time.
  private async locked<T>(setId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.busy.get(setId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.busy.set(setId, run);
    try {
      return await run;
    } finally {
      if (this.busy.get(setId) === run) this.busy.delete(setId);
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.sql.exec('BEGIN');
    try {
      const out = fn();
      this.db.sql.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.sql.exec('ROLLBACK');
      throw err;
    }
  }

  private meta(setId: string): { built_at: string | null; sources: Record<string, string>; error: string | null } {
    const row = this.db.get<{ built_at: string | null; sources: string; error: string | null }>('SELECT * FROM context_sets WHERE set_id = ?', setId);
    return { built_at: row?.built_at ?? null, sources: row ? (JSON.parse(row.sources) as Record<string, string>) : {}, error: row?.error ?? null };
  }

  private saveMeta(setId: string, sources: Record<string, string>, error: string | null) {
    this.db.run(
      `INSERT INTO context_sets (set_id, built_at, sources, error) VALUES (?, ?, ?, ?)
       ON CONFLICT (set_id) DO UPDATE SET built_at = excluded.built_at, sources = excluded.sources, error = excluded.error`,
      setId, nowIso(), JSON.stringify(sources), error,
    );
  }

  // Brings the set up to date with its context repositories. Each is fetched (new commits
  // only), and when it hasn't moved since the last baseline nothing else happens. `force`
  // re-reads the file list even then.
  async refresh(entry: ContextEntry, cache: RepoCache, opts: { force?: boolean } = {}): Promise<ContextStatus> {
    return this.locked(entry.id, async () => {
      const before = this.meta(entry.id).sources;
      const after: Record<string, string> = {};
      const errors: string[] = [];
      let changed = false;

      for (const source of entry.sources) {
        const key = sourceKey(source);
        try {
          const sha = await cache.fetchDefault(source.repo);
          after[key] = sha;
          if (before[key] === sha && !opts.force) continue;
          const prefix = source.path.replace(/^\/+|\/+$/g, '');
          const files = (await cache.listTree(source.repo, sha)).filter(
            (f) => MARKDOWN.test(f.path) && !HIDDEN.test(f.path) && f.size <= MAX_FILE_BYTES && (!prefix || f.path === prefix || f.path.startsWith(`${prefix}/`)),
          );
          const known = new Map(this.db.all<{ path: string; hash: string }>('SELECT path, hash FROM context_docs WHERE set_id = ? AND source = ?', entry.id, key).map((d) => [d.path, d.hash]));
          // Git's own hash of each file says whether it changed, without reading it.
          const texts = new Map<string, string>();
          for (const f of files) {
            if (known.get(f.path) === f.hash) continue;
            const text = await cache.readFile(source.repo, sha, f.path);
            if (text !== null) texts.set(f.path, text);
          }
          const keep = new Set(files.map((f) => f.path));
          changed = this.writeDocs(entry.id, key, files.filter((f) => texts.has(f.path)).map((f) => ({ path: f.path, hash: f.hash, text: texts.get(f.path)! })), keep) || changed;
        } catch (err) {
          if (before[key]) after[key] = before[key];
          errors.push(`${source.repo}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
        }
      }

      // Sources taken out of Settings take their documents with them.
      const wanted = new Set([...entry.sources.map(sourceKey), UPLOAD]);
      for (const { source } of this.db.all<{ source: string }>('SELECT DISTINCT source FROM context_docs WHERE set_id = ?', entry.id)) {
        if (!wanted.has(source)) changed = this.writeDocs(entry.id, source, [], new Set()) || changed;
      }

      if (changed) this.rebuildEdges(entry.id);
      const last = this.meta(entry.id);
      if (changed || errors.length || last.error || !last.built_at || JSON.stringify(before) !== JSON.stringify(after)) {
        this.saveMeta(entry.id, after, errors.join('; ') || null);
      }
      return this.status(entry.id);
    });
  }

  // Adds or replaces uploaded documents. Paths are as they were in the folder you dropped.
  async upload(setId: string, files: { path: string; text: string }[], replace = false): Promise<ContextStatus> {
    return this.locked(setId, async () => {
      const incoming = files.map((f) => ({ path: f.path.replace(/\\/g, '/').replace(/^\/+/, ''), hash: sha256(f.text), text: f.text }));
      const known = new Map(this.db.all<{ path: string; hash: string }>('SELECT path, hash FROM context_docs WHERE set_id = ? AND source = ?', setId, UPLOAD).map((d) => [d.path, d.hash]));
      const keep = new Set([...(replace ? [] : known.keys()), ...incoming.map((f) => f.path)]);
      const changed = this.writeDocs(setId, UPLOAD, incoming.filter((f) => known.get(f.path) !== f.hash), keep);
      if (changed) this.rebuildEdges(setId);
      const meta = this.meta(setId);
      this.saveMeta(setId, meta.sources, meta.error);
      return this.status(setId);
    });
  }

  async clearUploads(setId: string): Promise<ContextStatus> {
    return this.upload(setId, [], true);
  }

  // Forgets sets that are no longer in Settings.
  prune(validIds: string[]) {
    const valid = new Set(validIds);
    const ids = new Set([
      ...this.db.all<{ set_id: string }>('SELECT set_id FROM context_sets').map((r) => r.set_id),
      ...this.db.all<{ set_id: string }>('SELECT DISTINCT set_id FROM context_docs').map((r) => r.set_id),
    ]);
    for (const id of ids) {
      if (valid.has(id)) continue;
      this.transaction(() => {
        this.db.run('DELETE FROM context_fts WHERE rowid IN (SELECT id FROM context_nodes WHERE set_id = ?)', id);
        for (const table of ['context_edges', 'context_links', 'context_nodes', 'context_docs', 'context_sets']) this.db.run(`DELETE FROM ${table} WHERE set_id = ?`, id);
      });
    }
  }

  // Replaces the given documents of one source, and drops those not in `keep`. Returns
  // whether anything changed.
  private writeDocs(setId: string, source: string, docs: { path: string; hash: string; text: string }[], keep: Set<string>): boolean {
    return this.transaction(() => {
      const existing = this.db.all<{ id: number; path: string }>('SELECT id, path FROM context_docs WHERE set_id = ? AND source = ?', setId, source);
      const replaced = new Set(docs.map((d) => d.path));
      const gone = existing.filter((d) => !keep.has(d.path) || replaced.has(d.path));
      for (const d of gone) {
        this.db.run('DELETE FROM context_fts WHERE rowid IN (SELECT id FROM context_nodes WHERE doc_id = ?)', d.id);
        this.db.run('DELETE FROM context_nodes WHERE doc_id = ?', d.id);
        this.db.run('DELETE FROM context_links WHERE doc_id = ?', d.id);
        this.db.run('DELETE FROM context_docs WHERE id = ?', d.id);
      }
      for (const d of docs) {
        const parsed = parseMarkdown(d.path, d.text);
        const docId = Number(this.db.run('INSERT INTO context_docs (set_id, source, path, title, hash, chars) VALUES (?, ?, ?, ?, ?, ?)', setId, source, d.path, parsed.title, d.hash, d.text.length).lastInsertRowid);
        const ids: number[] = [];
        const paths: string[] = [];
        for (const [i, s] of parsed.sections.entries()) {
          const headingPath = s.parent === null ? parsed.title : s.level === 1 && s.title === parsed.title ? parsed.title : `${paths[s.parent]} › ${s.title}`;
          paths.push(headingPath);
          const id = Number(
            this.db.run(
              'INSERT INTO context_nodes (set_id, doc_id, parent_id, level, ord, title, slug, heading_path, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              setId, docId, s.parent === null ? null : ids[s.parent], s.level, i, s.title, s.slug, headingPath, s.text,
            ).lastInsertRowid,
          );
          ids.push(id);
          this.db.run('INSERT INTO context_fts (rowid, title, heading_path, text) VALUES (?, ?, ?, ?)', id, s.title, headingPath, s.text);
          for (const l of s.links) this.db.run('INSERT INTO context_links (set_id, doc_id, node_id, path, anchor, wiki) VALUES (?, ?, ?, ?, ?, ?)', setId, docId, id, l.path, l.anchor, l.wiki);
        }
      }
      return gone.length > 0 || docs.length > 0;
    });
  }

  // Turns every stored link into an edge between two nodes, where its target exists.
  private rebuildEdges(setId: string) {
    this.transaction(() => {
      this.db.run('DELETE FROM context_edges WHERE set_id = ?', setId);
      const docs = this.db.all<{ id: number; source: string; path: string }>('SELECT id, source, path FROM context_docs WHERE set_id = ?', setId);
      const byPath = new Map(docs.map((d) => [`${d.source}\n${d.path.toLowerCase()}`, d.id]));
      const byName = new Map(docs.map((d) => [d.path.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase(), d.id]));
      const sourceOf = new Map(docs.map((d) => [d.id, d.source]));
      const nodes = this.db.all<{ id: number; doc_id: number; level: number; slug: string }>('SELECT id, doc_id, level, slug FROM context_nodes WHERE set_id = ?', setId);
      const docNode = new Map(nodes.filter((n) => n.level === 0).map((n) => [n.doc_id, n.id]));
      const bySlug = new Map(nodes.filter((n) => n.slug).map((n) => [`${n.doc_id}#${n.slug}`, n.id]));

      for (const l of this.db.all<{ doc_id: number; node_id: number; path: string | null; anchor: string | null; wiki: string | null }>('SELECT * FROM context_links WHERE set_id = ?', setId)) {
        let target: number | undefined = l.doc_id;
        if (l.wiki) target = byName.get(l.wiki);
        else if (l.path) {
          const at = (p: string) => byPath.get(`${sourceOf.get(l.doc_id)}\n${p.toLowerCase()}`);
          target = at(l.path) ?? at(`${l.path}.md`) ?? at(`${l.path}/README.md`) ?? at(`${l.path}/index.md`);
        }
        if (target === undefined) continue;
        const to = (l.anchor ? bySlug.get(`${target}#${l.anchor}`) : undefined) ?? docNode.get(target);
        if (to !== undefined && to !== l.node_id) this.db.run('INSERT OR IGNORE INTO context_edges (set_id, from_node, to_node) VALUES (?, ?, ?)', setId, l.node_id, to);
      }
    });
  }

  status(setId: string): ContextStatus {
    const meta = this.meta(setId);
    const n = (table: string, extra = '') => this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE set_id = ? ${extra}`, setId)?.n ?? 0;
    return {
      builtAt: meta.built_at,
      sources: Object.entries(meta.sources).map(([key, sha]) => ({ name: key.replace(/:$/, ''), sha })),
      docs: n('context_docs'),
      uploads: n('context_docs', `AND source = '${UPLOAD}'`),
      sections: n('context_nodes'),
      links: n('context_edges'),
      error: meta.error,
    };
  }

  // A section's text; a heading with little of its own brings its subsections along.
  private textOf(node: NodeRow, max: number): string {
    let text = node.text;
    if (text.length < 200) {
      for (const child of this.db.all<NodeRow>('SELECT * FROM context_nodes WHERE parent_id = ? ORDER BY ord', node.id)) {
        if (text.length >= max) break;
        text += `${text ? '\n\n' : ''}${'#'.repeat(Math.min(6, Math.max(2, child.level)))} ${child.title}\n${child.text}`;
      }
    }
    return clip(text.trim(), max);
  }

  // The sections that best match the terms, then the ones they link to or are linked from,
  // within a character budget.
  retrieve(setId: string, terms: string[], budget: number): ContextResult {
    const status = this.status(setId);
    const result: ContextResult = { setId, builtAt: status.builtAt, sources: status.sources, docs: status.docs, terms, map: this.map(setId), hits: [] };
    const words = terms.map((t) => t.replace(/[^\p{L}\p{N}_]/gu, '')).filter((t) => t.length >= 2);
    if (!words.length || !status.docs) return result;

    const ranked = this.db.all<NodeRow & { score: number }>(
      `SELECT n.*, bm25(context_fts, 8.0, 4.0, 1.0) AS score FROM context_fts JOIN context_nodes n ON n.id = context_fts.rowid
       WHERE context_fts MATCH ? AND n.set_id = ? ORDER BY score LIMIT 60`,
      words.map((w) => `"${w}"`).join(' OR '), setId,
    );
    const rank = new Map(ranked.map((n, i) => [n.id, i]));
    const docs = new Map(this.db.all<{ id: number; source: string; path: string }>('SELECT id, source, path FROM context_docs WHERE set_id = ?', setId).map((d) => [d.id, d]));
    const chosen = new Set<number>();
    const perDoc = new Map<number, number>();
    let used = 0;
    const add = (node: NodeRow, how: ContextHit['how'], via: string | null, max: number): boolean => {
      if (chosen.has(node.id) || used >= budget) return false;
      const text = this.textOf(node, Math.min(max, budget - used));
      if (text.length < 10) return false; // a bare heading
      const doc = docs.get(node.doc_id)!;
      chosen.add(node.id);
      used += text.length;
      result.hits.push({ source: doc.source === UPLOAD ? 'uploaded' : doc.source.replace(/:.*$/, ''), path: doc.path, heading: node.heading_path, how, via, text });
      return true;
    };

    const seeds: NodeRow[] = [];
    for (const node of ranked) {
      if (seeds.length >= SEEDS) break;
      if ((perDoc.get(node.doc_id) ?? 0) >= PER_DOC) continue;
      // A parent and its subsection would repeat each other.
      if (seeds.some((s) => s.id === node.parent_id || s.parent_id === node.id)) continue;
      if (add(node, 'matched', null, SEED_CHARS)) {
        seeds.push(node);
        perDoc.set(node.doc_id, (perDoc.get(node.doc_id) ?? 0) + 1);
      }
    }

    // One step along the graph from each match, best-matching neighbours first.
    for (const seed of seeds) {
      const neighbours = this.db
        .all<NodeRow>(
          `SELECT n.* FROM context_nodes n WHERE n.id IN (
             SELECT to_node FROM context_edges WHERE from_node = ? UNION SELECT from_node FROM context_edges WHERE to_node = ?)`,
          seed.id, seed.id,
        )
        .sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
      let taken = 0;
      for (const n of neighbours) {
        if (taken >= NEIGHBOURS) break;
        if (add(n, 'linked', seed.heading_path, NEIGHBOUR_CHARS)) taken++;
      }
    }
    return result;
  }

  // The most-referenced documents, so the reviewer knows what else exists.
  private map(setId: string, maxChars = 1200): string {
    const docs = this.db.all<{ path: string; title: string; refs: number }>(
      `SELECT d.path, d.title, (SELECT COUNT(*) FROM context_edges e JOIN context_nodes n ON n.id = e.to_node WHERE n.doc_id = d.id) AS refs
       FROM context_docs d WHERE d.set_id = ? ORDER BY refs DESC, d.path LIMIT 200`,
      setId,
    );
    const lines: string[] = [];
    let used = 0;
    for (const d of docs) {
      const line = `- ${d.path}${d.title && !d.path.toLowerCase().includes(d.title.toLowerCase()) ? `: ${d.title}` : ''}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    const total = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM context_docs WHERE set_id = ?', setId)?.n ?? 0;
    if (total > lines.length) lines.push(`(and ${total - lines.length} more documents)`);
    return lines.join('\n');
  }
}
