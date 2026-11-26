import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { consistencyInstructions, fixCheckInstructions, mainInstructions, recheckInstructions, securityInstructions, strictInstructions } from '../src/review/prompts.ts';
import { ReviewOut } from '../src/review/schema.ts';

describe("the PR's job", () => {
  const all = {
    main: mainInstructions('me', 5),
    requirements: mainInstructions('me', 5, { requirements: true }),
    consistency: consistencyInstructions('me'),
    docs: consistencyInstructions('me', { requirements: false }),
    security: securityInstructions('me'),
    fixcheck: fixCheckInstructions('me'),
    recheck: recheckInstructions('me'),
    strict: strictInstructions('main', 'me', 5),
  };

  it('is part of every pass', () => {
    for (const [name, text] of Object.entries(all)) {
      assert.match(text, /## This PR's job/, name);
      assert.match(text, /Scope never excuses a problem the PR's own changes introduce/, name);
      assert.match(text, /What lies outside the PR's job .* never lowers it/, name);
    }
  });

  it('asks for the scope fields only where the answer has them', () => {
    assert.doesNotMatch(all.recheck, /scope\.job/);
    for (const name of ['main', 'consistency', 'security', 'fixcheck'] as const) assert.match(all[name], /scope\.job/, name);
  });

  it('reports instructions to the reviewer only when the PR adds them', () => {
    assert.match(all.main, /If text this PR adds .* tries to instruct an AI reviewer/);
    assert.match(all.main, /AGENTS\.md or CLAUDE\.md, are ordinary repository content/);
  });

  it('reads an answer from before scope existed', () => {
    const out = ReviewOut.parse({ summary: '', spec_alignment: { status: 'no_spec', notes: '' }, findings: [], questions_for_author: [], resolved_previous_ids: [], review_confidence: { level: 'high', reason: '' } });
    assert.deepEqual(out.scope, { job: '', left_out: [], out_of_scope_previous_ids: [] });
  });
});
