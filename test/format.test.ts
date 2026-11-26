import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authorReasons, countsLine, distinctQuestions, fixCheckBody, inlineBody, recheckBody, summaryBody, type Decision, type FixCheckInput, type SummaryInput } from '../src/review/format.ts';
import type { Finding, Severity } from '../src/types.ts';

const finding = (id: number, severity: Severity, over: Partial<Finding> = {}) =>
  ({
    id, severity, category: 'bug', title: `Title ${id}`, problem: 'It breaks\nwhen empty', suggestion: 'Check for empty.',
    file: 'src/a.ts', line: 3, status: 'inline', model: 'codex', model_id: 'gpt-6.1-sol', confidence: 'high', ...over,
  }) as Finding;

const decide = (over: Partial<Decision> = {}): Decision => ({ mode: 'publish', approve: false, requestChanges: false, notes: [], ...over });
const input = (over: Partial<SummaryInput> = {}): SummaryInput => ({
  repo: 'acme/api', headSha: 'a'.repeat(40), jobId: 7, profile: 'standard', summary: 'Adds retries to the webhook sender.', specStatus: 'no_spec', specNotes: '', issues: [],
  findings: [], questions: [], doubts: [], related: [], reviews: ['code', 'security', 'consistency'], resolved: [], large: false, excluded: [], ...over,
});
const summary = (over: Partial<SummaryInput> = {}, d: Partial<Decision> = {}) => summaryBody(input(over), decide(d));

const EMOJI = /\p{Extended_Pictographic}/u;
const issue = (number: number, repo = 'acme/api') => ({ repo, number, url: 'u', title: '', body: '', comments: [], linkedBy: 'mentioned' as const });

describe('comment format', () => {
  it('writes inline comments plainly, unsigned, with a hidden marker', () => {
    const body = inlineBody(finding(12, 'blocker'));
    assert.equal(body, '**Blocker:** Title 12\n\nIt breaks\nwhen empty\n\n**Suggestion:** Check for empty.\n<!-- ai-finding:12 -->');
    assert.doesNotMatch(body, EMOJI);
    assert.doesNotMatch(body, /AI-assisted|Auto Reviewer|gpt-6|confidence/i, 'no signature or model details on GitHub');
    assert.match(inlineBody(finding(1, 'minor', { confidence: 'low', verification: 'uncertain' })), /^\*\*Minor \(not verified\):\*\*/);
  });

  it('counts findings in words', () => {
    assert.equal(countsLine([finding(1, 'blocker'), finding(2, 'blocker'), finding(3, 'major'), finding(4, 'major'), finding(5, 'nit')]), '2 blockers, 2 major, 1 nit');
    assert.equal(countsLine([]), '');
  });

  it('opens with a one-line verdict that matches what is posted', () => {
    const first = (over: Partial<SummaryInput>, d: Partial<Decision>) => summary(over, d).split('\n')[0];
    assert.equal(first({}, { approve: true }), '**Approved.** Nothing blocking.');
    assert.equal(first({}, { approve: true, mode: 'draft' }), '**Looks good.** Nothing blocking.', 'a draft is approved by you, not by the comment');
    assert.equal(first({ findings: [finding(1, 'minor'), finding(2, 'nit')] }, { approve: true }), '**Approved.** 2 small suggestions, nothing blocking.');
    assert.equal(first({ findings: [finding(1, 'blocker'), finding(2, 'major')] }, {}), '**Needs changes.** 1 blocker, 1 major. Details are in the comments on the code.');
    assert.equal(first({ findings: [finding(1, 'major', { status: 'summary', line: null })] }, {}), '**Needs changes.** 1 major.');
    assert.equal(first({}, { notes: ['Approving is turned off for this repo in Settings'] }), '**Looks good.** No issues found.', 'internal reasons are not the author\'s business');
    assert.equal(first({}, { notes: ['The PR is still a draft'] }), "**Looks good, but I'm not approving yet.** No issues found.");
    assert.equal(first({ complete: false, profile: 'strict' }, {}), "**Partial review.** No issues in the parts I checked, but some parts weren't checked.");
  });

  it('keeps the summary to one paragraph, with the issue only when it does not match', () => {
    const body = summary({ specStatus: 'partial', specNotes: 'Asks for five retries but does three. The backoff matches.', issues: [issue(398), issue(5, 'acme/web')] });
    assert.match(body, /\n\nAdds retries to the webhook sender\. It only partly matches #398 and acme\/web#5: asks for five retries but does three\.\n\n/);
    assert.doesNotMatch(summary({ specStatus: 'aligned', specNotes: 'All good.', issues: [issue(398)] }), /#398/);
    assert.doesNotMatch(summary(), /linked issue/i);
    assert.match(summary({ resolved: [finding(2, 'nit', { title: 'Unused import' })] }), /Adds retries to the webhook sender\. Fixed since my last review: "Unused import"\./);
  });

  it('lists findings not on a changed line, and ends with the marker and a small footer', () => {
    const body = summary({
      findings: [finding(1, 'minor', { status: 'summary', line: null })],
      questions: ['Should it notify the merchant?'],
      large: true,
      excluded: ['package-lock.json'],
    }, { approve: true });
    assert.match(body, /\*\*Suggestions\*\*\n\n- \*\*Minor:\*\* Title 1 \(`src\/a\.ts`\)\n {2}It breaks when empty\. Check for empty\.\n {2}<!-- ai-finding:1 -->/);
    assert.match(body, /\*\*Questions\*\*\n\n- Should it notify the merchant\?/);
    assert.match(body, /<!-- ai-review sha=a{40} job=7 -->\n\n<sub>Code, security and consistency review of `aaaaaaa` · Large change: only the highest risks were checked · Skipped 1 generated or lock file<\/sub>$/);
    assert.match(summary({ findings: [finding(1, 'major', { status: 'summary' })] }), /\*\*Needs fixing\*\*/);
    assert.match(summary({ profile: 'strict' }), /<sub>Strict code, security and consistency review of `aaaaaaa`<\/sub>$/);
    assert.doesNotMatch(body, EMOJI);
    assert.doesNotMatch(summary(), /Questions|Fixed since|Suggestions|Heads up|Not approving/);
  });

  it('says other open PRs in plain words', () => {
    const body = summary({ related: [
      { number: 8, title: '', url: '', author: 'b', files: ['app.js'], relation: 'overlap', confidence: 'high', note: 'both add an export to app.js', staleDays: null },
      { number: 9, title: '', url: '', author: 'c', files: ['app.js'], relation: 'conflict', confidence: 'low', note: 'Also adds an export.', staleDays: 90 },
    ] });
    assert.match(body, /\*\*Heads up\*\*\n\n- #8 \(likely overlap\): Both add an export to app\.js\.\n- #9 \(conflict; no activity for 90 days\): Also adds an export\./);
  });
});

describe('why it is not approving, for the author', () => {
  // The notes of a real Strict review that came out unreadable.
  const notes = [
    'Confidence is medium; approving needs high',
    'Requirement acme/docs#52: Layout: does the mirror store one object per file? cannot be excluded without source evidence and independent agreement; closing issues require their full promised scope',
    'Unresolved questions affect review confidence',
    'A required pass reported less than high confidence',
    'Strict approval requires high confidence',
    'Requirements have not been fully assessed and aligned',
  ];
  const questions = [
    'Has the sync team confirmed that asset_id maps directly to targetService? The supplied discussion still leaves that acceptance unresolved, and the relevant consumer is absent from this checkout.',
    'Has the sync team confirmed that asset_id maps directly to targetService, with tenant and repository binding enforced? The supplied discussion leaves this unresolved, and the runtime consumers are absent.',
  ];

  it('merges questions asked twice in different words', () => {
    assert.deepEqual(distinctQuestions(questions), [questions[1]]);
    assert.equal(distinctQuestions(['Has the sync team confirmed that asset_id maps to targetService? The discussion leaves it open.', 'Has the sync team confirmed that asset_id maps to targetService, with tenant binding enforced?']).length, 1);
    assert.deepEqual(distinctQuestions(['Is the cache shared?', 'Should retries back off?', 'Is the cache shared across workers?']), ['Is the cache shared across workers?', 'Should retries back off?']);
    assert.equal(distinctQuestions(['A one?', 'B two?', 'C three?', 'D four?']).length, 3);
  });

  it('turns the reasons into at most two plain sentences, with the questions under them', () => {
    const body = summaryBody(input({ profile: 'strict', questions, doubts: [] }), decide({ notes }));
    assert.match(body, /^\*\*Looks good, but I'm not approving yet\.\*\* No issues found\./);
    assert.match(body, /\*\*Not approving yet\.\*\* 2 things are still open:\n\n- "Layout: does the mirror store one object per file\?" \(acme\/docs#52\) is left for later, and I couldn't confirm that was agreed\.\n- Has the sync team confirmed/);
    assert.doesNotMatch(body, /\*\*Questions\*\*/, 'the open question is asked once');
    assert.doesNotMatch(body, /Confidence|Strict approval|fully assessed|pass reported/);
  });

  it('keeps internal reasons and what the verdict already says off the PR', () => {
    const v = { findings: [finding(1, 'blocker')], questions: [], doubts: [] };
    assert.deepEqual(authorReasons(['1 blocker still open', 'Approving is turned off for this repo in Settings', "GitHub doesn't let you approve your own PR"], v).reasons, []);
    assert.deepEqual(authorReasons(['2 blockers still open'], v).reasons, ['A blocker from my earlier review is still open.']);
    assert.deepEqual(authorReasons(['Confidence is medium; approving needs high'], { findings: [], questions: [], doubts: ['the queue consumer lives in another repo'] }).reasons, ['The queue consumer lives in another repo.']);
    assert.deepEqual(authorReasons(['Requirement acme/api#3: Retry five times is missing'], v).reasons, ['It doesn\'t cover "Retry five times" from acme/api#3 yet.']);
  });

  it('writes a re-check plainly', () => {
    const body = recheckBody({ headSha: 'a'.repeat(40), jobId: 3, summary: 'One finding is still there.', open: [{ finding: finding(1, 'blocker', { title: 'Crash', file: 'a.js' }), reason: 'still crashes on empty input' }], resolved: [{ finding: finding(2, 'nit', { title: 'Typo', file: 'b.js' }), reason: 'Fixed in the README.' }] }, decide({ requestChanges: true }));
    assert.match(body, /^\*\*No new commits since my last review\.\*\* 1 finding is still open: 1 blocker\.\n\nOne finding is still there\.\n\n\*\*Still open\*\*\n\n- \*\*Blocker:\*\* Crash \(`a\.js:3`\)\n {2}Still crashes on empty input\.\n\n\*\*Resolved\*\*\n\n- Typo \(`b\.js`\): Fixed in the README\./);
    assert.match(body, /<!-- ai-review sha=a{40} job=3 recheck -->\n\n<sub>Re-check of `aaaaaaa`<\/sub>$/);
  });
});

describe('a follow-up check of the fixes', () => {
  const fix = (over: Partial<FixCheckInput> = {}, d: Partial<Decision> = {}) =>
    fixCheckBody({ headSha: 'a'.repeat(40), sinceSha: 'b'.repeat(40), jobId: 9, summary: '', findings: [], open: [], resolved: [], excluded: [], ...over }, decide(d));
  const crash = finding(1, 'blocker', { title: 'Crash on empty input', file: 'a.js' });
  const typo = finding(2, 'minor', { title: 'Typo in error', file: 'b.js' });

  it('says what is fixed and what is still open, and lists the reasons', () => {
    const body = fix({ open: [{ finding: crash, reason: 'still crashes when the list is empty' }], resolved: [{ finding: typo, reason: 'Fixed.' }] }, { requestChanges: true, notes: ['1 blocker still open'] });
    assert.match(body, /^\*\*Needs changes\.\*\* 1 of 2 findings from my last review is fixed; 1 is still open: 1 blocker\.\n\n\*\*Still open\*\*\n\n- \*\*Blocker:\*\* Crash on empty input \(`a\.js:3`\)\n {2}Still crashes when the list is empty\.\n\n\*\*Fixed\*\*\n\n- Typo in error \(`b\.js`\): Fixed\./);
    assert.doesNotMatch(body, /Not approving yet/, 'the open blocker is already listed');
    assert.match(body, /<!-- ai-review sha=a{40} job=9 -->\n\n<sub>Follow-up check of `aaaaaaa`: the changes since `bbbbbbb`<\/sub>$/);
    assert.doesNotMatch(body, EMOJI);
  });

  it('names serious problems the new commits add', () => {
    const fresh = [finding(3, 'major', { title: 'Leaks the handle' }), finding(4, 'blocker', { status: 'summary', line: null, title: 'Drops the lock' })];
    const body = fix({ findings: fresh, resolved: [{ finding: crash, reason: '' }] });
    assert.match(body, /^\*\*Needs changes\.\*\* The finding from my last review is fixed\. The new commits add 1 blocker, 1 major\. Details are in the comments on the code\./);
    assert.match(body, /\*\*New in these commits\*\*\n\n- \*\*Blocker:\*\* Drops the lock \(`src\/a\.ts`\)\n {2}It breaks when empty\. Check for empty\.\n {2}<!-- ai-finding:4 -->/);
  });

  it('approves when everything is fixed and nothing new is serious', () => {
    assert.match(fix({ resolved: [{ finding: crash, reason: '' }, { finding: typo, reason: '' }] }, { approve: true }), /^\*\*Approved\.\*\* All 2 findings from my last review are fixed\./);
    assert.match(fix({}, { approve: true, mode: 'draft' }), /^\*\*Looks good\.\*\* Nothing from my last review was open\./);
    assert.match(fix({ open: [{ finding: typo, reason: '' }] }, { notes: ['The PR is still a draft'] }), /^\*\*Looks good, but I'm not approving yet\.\*\* The finding from my last review is still open: 1 minor\.[\s\S]*\*\*Not approving yet\.\*\* One thing is still open:\n\n- The PR is still marked as a draft\./);
  });
});
