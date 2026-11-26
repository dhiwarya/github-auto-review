import { z } from 'zod';

// JSON Schemas are written in the strict subset both CLIs accept: every property
// required, no extra properties, nullable via a type union.

const str = { type: 'string' } as const;
const enumOf = (values: string[]) => ({ type: 'string', enum: values });

const findingJson = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'severity', 'confidence', 'file', 'line', 'title', 'evidence', 'problem', 'suggestion'],
  properties: {
    category: enumOf(['bug', 'security', 'requirement', 'docs', 'design', 'test', 'performance']),
    severity: enumOf(['blocker', 'major', 'minor', 'nit']),
    confidence: enumOf(['high', 'medium', 'low']),
    file: str,
    line: { type: ['integer', 'null'] },
    title: str,
    evidence: str,
    problem: str,
    suggestion: str,
  },
};

// What the PR is for, and what was left out as outside it.
const scopeJson = {
  type: 'object',
  additionalProperties: false,
  required: ['job', 'left_out', 'out_of_scope_previous_ids'],
  properties: {
    job: str,
    left_out: { type: 'array', items: str },
    out_of_scope_previous_ids: { type: 'array', items: { type: 'integer' } },
  },
};

export const reviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'scope', 'spec_alignment', 'findings', 'questions_for_author', 'resolved_previous_ids', 'review_confidence'],
  properties: {
    summary: str,
    scope: scopeJson,
    spec_alignment: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'notes'],
      properties: {
        status: enumOf(['aligned', 'partial', 'misaligned', 'no_spec', 'not_checked']),
        notes: str,
      },
    },
    findings: { type: 'array', items: findingJson },
    questions_for_author: { type: 'array', items: str },
    resolved_previous_ids: { type: 'array', items: { type: 'integer' } },
    review_confidence: {
      type: 'object',
      additionalProperties: false,
      required: ['level', 'reason'],
      properties: {
        level: enumOf(['high', 'medium', 'low']),
        reason: str,
      },
    },
  },
};

// The consistency review also names other open PRs that matter to this one.
export const consistencySchema = {
  ...reviewSchema,
  required: [...reviewSchema.required, 'related_prs'],
  properties: {
    ...reviewSchema.properties,
    related_prs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['number', 'relation', 'note', 'confidence'],
        properties: {
          number: { type: 'integer' },
          relation: enumOf(['overlap', 'conflict', 'duplicate']),
          note: str,
          confidence: enumOf(['high', 'medium', 'low']),
        },
      },
    },
  },
};

export const verifySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'verdict', 'adjusted_severity', 'reason'],
        properties: {
          id: { type: 'integer' },
          verdict: enumOf(['confirmed', 'refuted', 'uncertain']),
          adjusted_severity: enumOf(['blocker', 'major', 'minor', 'nit']),
          reason: str,
        },
      },
    },
  },
};

export const recheckSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'verdicts', 'review_confidence'],
  properties: {
    summary: str,
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'reason'],
        properties: {
          id: { type: 'integer' },
          status: enumOf(['open', 'resolved', 'out_of_scope']),
          reason: str,
        },
      },
    },
    review_confidence: reviewSchema.properties.review_confidence,
  },
};

// A follow-up after new commits: a verdict for each earlier finding, plus serious problems
// the new commits add.
export const fixCheckSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'scope', 'verdicts', 'findings', 'review_confidence'],
  properties: {
    summary: str,
    scope: scopeJson,
    verdicts: recheckSchema.properties.verdicts,
    findings: { type: 'array', items: findingJson },
    review_confidence: reviewSchema.properties.review_confidence,
  },
};

// Runtime checks of what actually came back.

const severity = z.enum(['blocker', 'major', 'minor', 'nit']);

export const FindingOut = z.object({
  category: z.enum(['bug', 'security', 'requirement', 'docs', 'design', 'test', 'performance']),
  severity,
  confidence: z.enum(['high', 'medium', 'low']),
  file: z.string(),
  line: z.number().int().nullable(),
  title: z.string(),
  evidence: z.string(),
  problem: z.string(),
  suggestion: z.string(),
});
export type FindingOut = z.infer<typeof FindingOut>;

// Answers saved before scope existed have none.
export const ScopeOut = z.object({
  job: z.string().default(''),
  left_out: z.array(z.string()).default([]),
  out_of_scope_previous_ids: z.array(z.number().int()).default([]),
}).prefault({});
export type ScopeOut = z.infer<typeof ScopeOut>;

export const ReviewOut = z.object({
  summary: z.string(),
  scope: ScopeOut,
  spec_alignment: z.object({
    status: z.enum(['aligned', 'partial', 'misaligned', 'no_spec', 'not_checked']),
    notes: z.string(),
  }),
  findings: z.array(FindingOut),
  questions_for_author: z.array(z.string()),
  resolved_previous_ids: z.array(z.number().int()),
  review_confidence: z.object({
    level: z.enum(['high', 'medium', 'low']),
    reason: z.string(),
  }),
});
export type ReviewOut = z.infer<typeof ReviewOut>;

export const ConsistencyOut = ReviewOut.extend({
  related_prs: z.array(
    z.object({
      number: z.number().int(),
      relation: z.enum(['overlap', 'conflict', 'duplicate']),
      note: z.string(),
      confidence: z.enum(['high', 'medium', 'low']),
    }),
  ),
});
export type ConsistencyOut = z.infer<typeof ConsistencyOut>;

const coverageJson = {
  type: 'object', additionalProperties: false,
  required: ['section_id', 'status', 'dependencies', 'tests', 'configuration', 'notes'],
  properties: {
    section_id: str, status: enumOf(['examined', 'unverified']),
    dependencies: { type: 'array', items: str }, tests: { type: 'array', items: str },
    configuration: { type: 'array', items: str }, notes: str,
  },
};
const requirementJson = {
  type: 'object', additionalProperties: false, required: ['ref', 'criterion', 'status', 'promised', 'reason', 'scope_evidence'],
  properties: { ref: str, criterion: str, status: enumOf(['implemented', 'missing', 'deferred', 'out_of_scope', 'externally_unverifiable', 'not_checked']), promised: { type: 'boolean' }, reason: str, scope_evidence: str },
};
export const strictReviewSchema = {
  ...reviewSchema,
  required: [...reviewSchema.required, 'coverage', 'requirements'],
  properties: { ...reviewSchema.properties,
    coverage: { type: 'array', items: coverageJson },
    requirements: { type: 'array', items: requirementJson },
  },
};
export function strictSchemaForIssues(refs: string[]) {
  return { ...strictReviewSchema, properties: { ...strictReviewSchema.properties,
    requirements: { type: 'array', ...(!refs.length ? { maxItems: 0 } : {}), items: { ...requirementJson,
      properties: { ...requirementJson.properties, ref: refs.length ? enumOf(refs) : str },
    } },
  } };
}
export const StrictReviewOut = ReviewOut.extend({
  coverage: z.array(z.object({
    section_id: z.string(), status: z.enum(['examined', 'unverified']),
    dependencies: z.array(z.string()), tests: z.array(z.string()), configuration: z.array(z.string()), notes: z.string(),
  })),
  requirements: z.array(z.object({ ref: z.string(), criterion: z.string(), status: z.enum(['implemented', 'missing', 'deferred', 'out_of_scope', 'externally_unverifiable', 'not_checked']),
    // Answers saved before this field existed counted every criterion.
    promised: z.boolean().default(true), reason: z.string(), scope_evidence: z.string() })),
});
export type StrictReviewOut = z.infer<typeof StrictReviewOut>;

export const VerifyOut = z.object({
  verdicts: z.array(
    z.object({
      id: z.number().int(),
      verdict: z.enum(['confirmed', 'refuted', 'uncertain']),
      adjusted_severity: severity,
      reason: z.string(),
    }),
  ),
});
export type VerifyOut = z.infer<typeof VerifyOut>;

export const RecheckOut = z.object({
  summary: z.string(),
  verdicts: z.array(z.object({ id: z.number().int(), status: z.enum(['open', 'resolved', 'out_of_scope']), reason: z.string() })),
  review_confidence: ReviewOut.shape.review_confidence,
});
export type RecheckOut = z.infer<typeof RecheckOut>;

export const FixCheckOut = z.object({
  summary: z.string(),
  scope: ScopeOut,
  verdicts: RecheckOut.shape.verdicts,
  findings: z.array(FindingOut),
  review_confidence: ReviewOut.shape.review_confidence,
});
export type FixCheckOut = z.infer<typeof FixCheckOut>;
