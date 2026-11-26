import { findingMarker } from '../github/publish.ts';
import type { LinkedIssue } from '../github/prs.ts';
import type { Finding, RelatedPr, ReviewMode, ReviewType, Severity, SpecStatus } from '../types.ts';

// What the PR author reads: a one-line verdict, a short summary, then only the sections
// that have something in them. Plain markdown, no emoji, no model details. Hidden markers
// tie the comments back to the review and its findings.

const SEVERITY_LABEL: Record<Severity, string> = { blocker: 'Blocker', major: 'Major', minor: 'Minor', nit: 'Nit' };
const SEVERITIES: Severity[] = ['blocker', 'major', 'minor', 'nit'];
const MAX_QUESTIONS = 3;
const MAX_REASONS = 2;

const oneLine = (text: string) => text.replace(/\s*\n+\s*/g, ' ').trim();
const sentence = (text: string) => {
  const t = oneLine(text);
  return !t ? '' : `${t[0].toUpperCase()}${t.slice(1)}${/[.!?:)`"]$/.test(t) ? '' : '.'}`;
};
const short = (text: string, max = 120) => {
  const t = oneLine(text);
  return t.length <= max ? t : `${t.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const andList = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

const unverified = (f: Finding) => f.confidence === 'low' && (f.verification === 'uncertain' || f.verification === 'skipped');
const label = (f: Finding) => `**${SEVERITY_LABEL[f.severity]}${unverified(f) ? ' (not verified)' : ''}:**`;
const where = (f: Finding, withLine = true) => (f.file ? ` (\`${f.file}${withLine && f.line ? `:${f.line}` : ''}\`)` : '');
const serious = (f: Finding) => f.severity === 'blocker' || f.severity === 'major';

export function inlineBody(f: Finding): string {
  return [`${label(f)} ${f.title}`, '', f.problem, '', `**Suggestion:** ${f.suggestion}`, findingMarker(f.id)].join('\n');
}

// "2 blockers, 1 major, 3 minor"
export function countsLine(findings: Finding[]): string {
  return SEVERITIES.map((sev) => ({ sev, n: findings.filter((f) => f.severity === sev).length }))
    .filter((c) => c.n > 0)
    .map(({ sev, n }) => `${n} ${sev}${n > 1 && (sev === 'blocker' || sev === 'nit') ? 's' : ''}`)
    .join(', ');
}

// Questions often come back twice in different words, once from each review. They are
// compared by the question itself, not the explanation after it.
const words = (text: string) => new Set(text.split(/(?<=\?)\s/)[0].toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []);
export function distinctQuestions(questions: string[], max = MAX_QUESTIONS): string[] {
  const kept: { text: string; words: Set<string> }[] = [];
  for (const raw of questions) {
    const text = oneLine(raw);
    if (!text) continue;
    const w = words(text);
    const same = kept.find((k) => {
      const shared = [...w].filter((x) => k.words.has(x)).length;
      return shared / Math.min(w.size, k.words.size || 1) >= 0.7 || shared / new Set([...w, ...k.words]).size >= 0.5;
    });
    if (!same) kept.push({ text, words: w });
    // Keep the more specific question.
    else if (w.size > same.words.size) Object.assign(same, { text, words: w });
  }
  return kept.slice(0, max).map((k) => k.text);
}

// How the review was decided: posted as a draft, published, or only prepared (a dry run).
// `notes` are the reasons it can't approve, worded for you; the author sees a translation.
export interface Decision {
  mode: ReviewMode | 'preview';
  approve: boolean;
  requestChanges: boolean;
  notes: string[];
}

interface AuthorView {
  findings: Finding[];
  questions: string[];
  doubts: string[];
  specStatus?: SpecStatus;
  large?: boolean;
}

// The reasons not to approve that mean something to the author, in their terms. Internal
// ones (approving switched off, review bookkeeping, your own PR) stay on the dashboard, and
// ones the verdict already says (open blockers) aren't repeated.
export function authorReasons(notes: string[], v: AuthorView): { reasons: string[]; questions: boolean } {
  const reasons: string[] = [];
  let questions = false;
  let unsure = false;
  for (const note of notes) {
    let m: RegExpExecArray | null;
    if ((m = /^(\d+) blockers? still open$/.exec(note))) {
      const earlier = Number(m[1]) - v.findings.filter((f) => f.severity === 'blocker').length;
      if (earlier > 0) reasons.push(earlier === 1 ? 'A blocker from my earlier review is still open.' : `${earlier} blockers from my earlier reviews are still open.`);
    } else if (/^Confidence is |^Strict approval requires high confidence$|^A required pass reported less than high confidence$/.test(note)) {
      unsure = true;
    } else if (note === 'Unresolved questions affect review confidence') {
      questions = true;
    } else if ((m = /^Requirement (\S+): ([\s\S]+) is missing$/.exec(note))) {
      reasons.push(`It doesn't cover "${short(m[2])}" from ${m[1]} yet.`);
    } else if ((m = /^Requirement (\S+): ([\s\S]+) is externally unverifiable$/.exec(note))) {
      reasons.push(`"${short(m[2])}" (${m[1]}) can't be confirmed from the code. A note on how it was checked would help.`);
    } else if ((m = /^Requirement (\S+): ([\s\S]+) cannot be excluded/.exec(note))) {
      reasons.push(`"${short(m[2])}" (${m[1]}) is left for later, and I couldn't confirm that was agreed.`);
    } else if (note === 'A serious finding has not been confirmed' || /^Finding \d+ has unresolved serious verification$/.test(note)) {
      reasons.push("I couldn't confirm one of the serious findings. Tell me if it doesn't hold.");
    } else if (note === 'The PR is still a draft') {
      reasons.push('The PR is still marked as a draft.');
    } else if (note === 'You requested changes on this PR yourself') {
      reasons.push('My earlier request for changes still stands.');
    }
  }
  if (unsure) {
    if (v.questions.length) questions = true;
    const doubt = v.doubts.map(sentence).find(Boolean);
    if (doubt) reasons.push(doubt);
    // Nothing else on the page explains the doubt: say what kind it is.
    else if (!questions && !reasons.length && !v.findings.some(serious) && v.specStatus !== 'partial' && v.specStatus !== 'misaligned' && !v.large) {
      reasons.push("Part of this change depends on code or services I couldn't check from this repo.");
    }
  }
  return { reasons: [...new Set(reasons)].slice(0, MAX_REASONS), questions: questions && v.questions.length > 0 };
}

function verdictLine(findings: Finding[], d: Decision, held: boolean, partial: boolean): string {
  const counts = countsLine(findings);
  if (partial) return counts ? `**Partial review.** ${counts} in the parts I checked; some parts weren't checked.` : "**Partial review.** No issues in the parts I checked, but some parts weren't checked.";
  if (findings.some(serious)) return `**Needs changes.** ${counts}.${findings.some((f) => f.status === 'inline' && f.line !== null) ? ' Details are in the comments on the code.' : ''}`;
  const approved = d.approve && d.mode === 'publish';
  const small = findings.length ? `${plural(findings.length, 'small suggestion')}, nothing blocking.` : null;
  if (approved) return `**Approved.** ${small ?? 'Nothing blocking.'}`;
  if (held) return `**Looks good, but I'm not approving yet.** ${findings.length ? `${plural(findings.length, 'small suggestion')}.` : 'No issues found.'}`;
  return `**Looks good.** ${small ?? (d.approve ? 'Nothing blocking.' : 'No issues found.')}`;
}

function issueSentence(status: SpecStatus, notes: string, issues: LinkedIssue[], repo: string): string {
  if (status !== 'partial' && status !== 'misaligned') return '';
  const refs = andList(issues.map((i) => (i.repo.toLowerCase() === repo.toLowerCase() ? `#${i.number}` : `${i.repo}#${i.number}`)));
  if (!refs) return '';
  const lead = status === 'partial' ? `It only partly matches ${refs}` : `It doesn't match ${refs}`;
  const first = /^(.+?[.!?])(?:\s+(?=[A-Z])|$)/.exec(oneLine(notes))?.[1] ?? oneLine(notes);
  return first ? `${lead}: ${short(first, 300).replace(/^./, (c) => c.toLowerCase())}${/[.!?…]$/.test(first) ? '' : '.'}` : `${lead}.`;
}

function fixedSentence(resolved: Finding[]): string {
  if (!resolved.length) return '';
  if (resolved.length > 3) return `${plural(resolved.length, 'finding')} from my last review ${resolved.length === 1 ? 'is' : 'are'} fixed.`;
  return `Fixed since my last review: ${andList(resolved.map((f) => `"${oneLine(f.title)}"`))}.`;
}

function notApproving(reasons: string[], questions: string[]): string[] {
  const items = [...reasons, ...questions];
  return [`**Not approving yet.** ${items.length === 1 ? 'One thing is still open:' : `${plural(items.length, 'thing')} are still open:`}`, '', ...items.map((t) => `- ${t}`), ''];
}

const RELATION_SURE: Record<RelatedPr['confidence'], string> = { high: 'likely', medium: 'possible', low: 'unsure' };
function headsUp(related: RelatedPr[]): string[] {
  if (!related.length) return [];
  return ['**Heads up**', '', ...related.map((r) => {
    const how = r.staleDays !== null ? `${r.relation}; no activity for ${r.staleDays} days` : `${RELATION_SURE[r.confidence]} ${r.relation}`;
    return `- #${r.number} (${how}): ${sentence(r.note)}`;
  }), ''];
}

// Earlier findings a later look found to be outside the PR's job: no longer counted.
function outsideSentence(n: number): string {
  if (!n) return '';
  return n === 1
    ? "One finding from my last review is outside this PR's job, so I've stopped counting it."
    : `${n} findings from my last review are outside this PR's job, so I've stopped counting them.`;
}

function outsideSection(items: { finding: Finding; reason: string }[]): string[] {
  if (!items.length) return [];
  return ['**Outside this PR**', '', ...items.map(({ finding: f, reason }) => `- ${oneLine(f.title)}${where(f, false)}${reason.trim() ? `: ${sentence(reason)}` : ''}`), ''];
}

function footer(marker: string, parts: string[]): string[] {
  return [marker, '', `<sub>${parts.filter(Boolean).join(' · ')}</sub>`];
}

export interface SummaryInput {
  repo: string;
  headSha: string;
  jobId: number;
  profile: 'standard' | 'strict';
  summary: string; // one short summary for the whole review
  specStatus: SpecStatus;
  specNotes: string;
  issues: LinkedIssue[];
  findings: Finding[]; // posted ones (inline + summary)
  questions: string[];
  doubts: string[]; // what the reviews couldn't check, in their words
  related: RelatedPr[]; // other open PRs worth a look: alerts, not findings
  reviews: ReviewType[]; // the reviews that ran
  resolved: Finding[];
  outOfScope?: Finding[]; // from earlier reviews, outside the PR's job
  large: boolean;
  excluded: string[];
  complete?: boolean; // Strict: false when some parts weren't checked
}

export function summaryBody(s: SummaryInput, d: Decision): string {
  const findings = s.findings.filter((f) => f.status !== 'dropped');
  const questions = distinctQuestions(s.questions);
  const why = d.approve ? { reasons: [], questions: false } : authorReasons(d.notes, { findings, questions, doubts: s.doubts, specStatus: s.specStatus, large: s.large });
  const held = why.reasons.length > 0 || why.questions;
  const partial = s.complete === false;
  const out = [verdictLine(findings, d, held, partial), ''];

  const extra = [issueSentence(s.specStatus, s.specNotes, s.issues, s.repo), fixedSentence(s.resolved), outsideSentence(s.outOfScope?.length ?? 0)].filter(Boolean).join(' ');
  const summary = s.summary.trim();
  if (summary || extra) out.push(summary.includes('\n') || !summary ? [summary, extra].filter(Boolean).join('\n\n') : [summary, extra].filter(Boolean).join(' '), '');

  // Findings on a changed line are inline comments; the rest are listed here.
  const general = findings.filter((f) => f.status === 'summary' || (f.status === 'inline' && f.line === null));
  if (general.length) {
    out.push(general.some(serious) ? '**Needs fixing**' : '**Suggestions**', '');
    for (const f of general) {
      out.push(`- ${label(f)} ${oneLine(f.title)}${where(f)}`);
      out.push(`  ${[sentence(f.problem), sentence(f.suggestion)].filter(Boolean).join(' ')}`);
      out.push(`  ${findingMarker(f.id)}`);
    }
    out.push('');
  }

  if (held) out.push(...notApproving(why.reasons, why.questions ? questions : []));
  if (questions.length && !why.questions) out.push('**Questions**', '', ...questions.map((q) => `- ${q}`), '');
  out.push(...headsUp(s.related));

  const ran = andList(s.reviews.map((r) => r));
  const notes = [
    `${s.profile === 'strict' ? `Strict ${ran}` : ran.replace(/^./, (c) => c.toUpperCase())} review of \`${s.headSha.slice(0, 7)}\``,
    partial ? "Some parts weren't checked" : '',
    s.large ? 'Large change: only the highest risks were checked' : '',
    s.excluded.length ? `Skipped ${plural(s.excluded.length, 'generated or lock file')}` : '',
  ];
  out.push(...footer(`<!-- ai-review sha=${s.headSha} job=${s.jobId} -->`, notes));
  return out.join('\n');
}

export interface RecheckInput {
  headSha: string;
  summary: string;
  open: { finding: Finding; reason: string }[];
  resolved: { finding: Finding; reason: string }[];
  outOfScope?: { finding: Finding; reason: string }[];
  jobId: number;
  complete?: boolean;
}

// A re-check after the review was requested again without new commits: which earlier
// findings are still open, and which turned out not to hold.
export function recheckBody(r: RecheckInput, d: Decision): string {
  const lead = '**No new commits since my last review.**';
  const n = r.open.length;
  const outside = r.outOfScope ?? [];
  const status = n
    ? `${plural(n, 'finding')} ${n === 1 ? 'is' : 'are'} still open: ${countsLine(r.open.map((o) => o.finding))}.`
    : r.resolved.length ? 'Everything from my last review is resolved.' : outside.length ? 'Nothing from my last review is still open.' : 'Nothing from earlier reviews is open.';
  const out = [[lead, status, outsideSentence(outside.length)].filter(Boolean).join(' '), ''];
  if (r.summary.trim()) out.push(r.summary.trim(), '');

  if (n) {
    out.push('**Still open**', '');
    for (const { finding: f, reason } of r.open) {
      out.push(`- ${label(f)} ${oneLine(f.title)}${where(f)}`);
      if (reason.trim()) out.push(`  ${sentence(reason)}`);
    }
    out.push('');
  }
  if (r.resolved.length) {
    out.push('**Resolved**', '', ...r.resolved.map(({ finding: f, reason }) => `- ${oneLine(f.title)}${where(f, false)}${reason.trim() ? `: ${sentence(reason)}` : ''}`), '');
  }
  out.push(...outsideSection(outside));
  const why = d.approve ? { reasons: [] } : authorReasons(d.notes, { findings: [], questions: [], doubts: [] });
  if (why.reasons.length) out.push(...notApproving(why.reasons, []));

  out.push(...footer(`<!-- ai-review sha=${r.headSha} job=${r.jobId} recheck -->`, [`Re-check of \`${r.headSha.slice(0, 7)}\``, r.complete === false ? "Some parts weren't checked" : '']));
  return out.join('\n');
}

export interface FixCheckInput {
  headSha: string;
  sinceSha: string; // the commit the last review was of
  jobId: number;
  summary: string;
  findings: Finding[]; // new problems in the new commits (posted ones)
  open: { finding: Finding; reason: string }[]; // from earlier reviews, still open
  resolved: { finding: Finding; reason: string }[]; // from earlier reviews, fixed now
  outOfScope?: { finding: Finding; reason: string }[]; // from earlier reviews, outside the PR's job
  excluded: string[];
}

// A follow-up after the author pushed new commits: which earlier findings are fixed, which
// are still open, and anything serious the new commits add.
export function fixCheckBody(r: FixCheckInput, d: Decision): string {
  const fresh = r.findings.filter((f) => f.status !== 'dropped');
  const stillOpen = r.open.map((o) => o.finding);
  const all = [...stillOpen, ...fresh];
  // Open findings are listed below, so the reasons don't repeat them.
  const why = d.approve ? { reasons: [] } : authorReasons(d.notes, { findings: all, questions: [], doubts: [] });
  const lead = all.some(serious)
    ? '**Needs changes.**'
    : d.approve && d.mode === 'publish'
      ? '**Approved.**'
      : why.reasons.length
        ? "**Looks good, but I'm not approving yet.**"
        : '**Looks good.**';

  const total = r.open.length + r.resolved.length;
  const n = r.open.length;
  const outside = r.outOfScope ?? [];
  const fixes = !total
    ? outside.length ? '' : 'Nothing from my last review was open.'
    : !n
      ? total === 1 ? 'The finding from my last review is fixed.' : `All ${total} findings from my last review are fixed.`
      : r.resolved.length
        ? `${r.resolved.length} of ${total} findings from my last review ${r.resolved.length === 1 ? 'is' : 'are'} fixed; ${n} ${n === 1 ? 'is' : 'are'} still open: ${countsLine(stillOpen)}.`
        : total === 1 ? `The finding from my last review is still open: ${countsLine(stillOpen)}.` : `All ${total} findings from my last review are still open: ${countsLine(stillOpen)}.`;
  const inline = fresh.some((f) => f.status === 'inline' && f.line !== null);
  const added = fresh.length ? ` The new commits add ${countsLine(fresh)}.${inline ? ' Details are in the comments on the code.' : ''}` : '';
  const out = [`${[lead, fixes, outsideSentence(outside.length)].filter(Boolean).join(' ')}${added}`, ''];
  if (r.summary.trim()) out.push(r.summary.trim(), '');

  if (n) {
    out.push('**Still open**', '');
    for (const { finding: f, reason } of r.open) {
      out.push(`- ${label(f)} ${oneLine(f.title)}${where(f)}`);
      if (reason.trim()) out.push(`  ${sentence(reason)}`);
    }
    out.push('');
  }
  const general = fresh.filter((f) => f.status === 'summary' || (f.status === 'inline' && f.line === null));
  if (general.length) {
    out.push('**New in these commits**', '');
    for (const f of general) {
      out.push(`- ${label(f)} ${oneLine(f.title)}${where(f)}`);
      out.push(`  ${[sentence(f.problem), sentence(f.suggestion)].filter(Boolean).join(' ')}`);
      out.push(`  ${findingMarker(f.id)}`);
    }
    out.push('');
  }
  if (r.resolved.length) {
    out.push('**Fixed**', '', ...r.resolved.map(({ finding: f, reason }) => `- ${oneLine(f.title)}${where(f, false)}${reason.trim() ? `: ${sentence(reason)}` : ''}`), '');
  }
  out.push(...outsideSection(outside));
  if (why.reasons.length) out.push(...notApproving(why.reasons, []));

  out.push(...footer(`<!-- ai-review sha=${r.headSha} job=${r.jobId} -->`, [
    `Follow-up check of \`${r.headSha.slice(0, 7)}\`: the changes since \`${r.sinceSha.slice(0, 7)}\``,
    r.excluded.length ? `Skipped ${plural(r.excluded.length, 'generated or lock file')}` : '',
  ]));
  return out.join('\n');
}

// Everything the comment is built from, kept with the job so it can be written again
// with the decision made right before posting.
export type ReviewParts = ({ kind: 'review' } & SummaryInput) | ({ kind: 'recheck' } & RecheckInput) | ({ kind: 'fixcheck' } & FixCheckInput);

export function renderReview(parts: ReviewParts, d: Decision): string {
  return parts.kind === 'recheck' ? recheckBody(parts, d) : parts.kind === 'fixcheck' ? fixCheckBody(parts, d) : summaryBody(parts, d);
}
