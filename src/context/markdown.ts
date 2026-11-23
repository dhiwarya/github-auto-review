import path from 'node:path';

// Turns a markdown document into the pieces of a context graph: one section per heading,
// each with its own text and the links it contains. No model is involved.

export interface ParsedSection {
  level: number; // 0 for the document itself (the text before its first heading)
  title: string;
  slug: string; // the anchor GitHub gives the heading
  text: string; // the section's own text, without its subsections
  parent: number | null; // index into sections; null for the document
  links: ParsedLink[];
}

export interface ParsedLink {
  path: string | null; // a document, relative to the source's root; null for a link within this one
  anchor: string | null;
  wiki: string | null; // a [[Page]] link, matched by file name
}

export interface ParsedDoc {
  title: string;
  sections: ParsedSection[]; // sections[0] is the document itself
}

const MAX_SECTION_CHARS = 20_000;

// The anchor GitHub generates for a heading.
export const slugify = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');

const plain = (heading: string) =>
  heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim();

function linksIn(text: string, docPath: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  for (const m of text.matchAll(/(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
    if (m[1]) continue; // an image
    const target = m[2];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue; // another site
    const [file, anchor] = target.split('#', 2);
    if (!file) {
      if (anchor) links.push({ path: null, anchor: anchor.toLowerCase(), wiki: null });
      continue;
    }
    let decoded = file;
    try {
      decoded = decodeURIComponent(file);
    } catch {
      // keep it as written
    }
    const resolved = decoded.startsWith('/') ? path.posix.normalize(decoded.slice(1)) : path.posix.normalize(path.posix.join(path.posix.dirname(docPath), decoded));
    if (resolved.startsWith('..')) continue; // outside the source
    links.push({ path: resolved.replace(/\/$/, ''), anchor: anchor ? anchor.toLowerCase() : null, wiki: null });
  }
  for (const m of text.matchAll(/\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]/g)) {
    links.push({ path: null, anchor: m[2] ? slugify(m[2]) : null, wiki: m[1].trim().toLowerCase() });
  }
  return links;
}

export function parseMarkdown(docPath: string, source: string): ParsedDoc {
  let text = source.replace(/\r\n?/g, '\n');
  let title = '';
  // Front matter: only its title is kept.
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (front) {
    title = /^title:\s*["']?(.+?)["']?\s*$/m.exec(front[1])?.[1] ?? '';
    text = text.slice(front[0].length);
  }

  const sections: { level: number; title: string; lines: string[]; parent: number | null }[] = [{ level: 0, title: '', lines: [], parent: null }];
  const open: number[] = [0]; // the section each heading level is currently inside
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const mark = /^\s{0,3}(```+|~~~+)/.exec(line)?.[1];
    if (mark) {
      if (!fence) fence = mark[0];
      else if (mark[0] === fence) fence = null;
    }
    const heading = fence || mark ? null : /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) {
      sections[open.at(-1)!].lines.push(line);
      continue;
    }
    const level = heading[1].length;
    while (open.length > 1 && sections[open.at(-1)!].level >= level) open.pop();
    sections.push({ level, title: plain(heading[2]), lines: [], parent: open.at(-1)! });
    open.push(sections.length - 1);
  }

  const firstH1 = sections.find((s) => s.level === 1)?.title;
  title ||= firstH1 || path.posix.basename(docPath).replace(/\.[^.]+$/, '');
  sections[0].title = title;

  const seen = new Map<string, number>();
  return {
    title,
    sections: sections.map((s) => {
      const body = s.lines.join('\n').trim();
      // GitHub numbers repeated headings: setup, setup-1, setup-2.
      const base = s.level === 0 ? '' : slugify(s.title);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return {
        level: s.level,
        title: s.title,
        slug: n && base ? `${base}-${n}` : base,
        text: body.length > MAX_SECTION_CHARS ? `${body.slice(0, MAX_SECTION_CHARS)}\n…[cut]` : body,
        parent: s.parent,
        links: linksIn(body, docPath),
      };
    }),
  };
}
