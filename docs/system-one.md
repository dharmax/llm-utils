# System-1 — Design

Status: target design for a shared fast semantic-assessment primitive.

## Purpose

`llm-utils` already owns generic model execution, routing, structured output, actors, sessions and metrics. Fast non-generative semantic assessment belongs at the same layer.

Hosts such as `ai-cli` and `ai-workflow` should not each wrap Laya independently.

System-1 answers **typed decisions**, not generated prose:

```text
compact state + typed questions
            ↓
      one fast assessment
            ↓
 choices / scores / yes-no probabilities
```

Typical uses:

- intent/routing classification;
- scope/complexity estimation;
- candidate relevance filtering;
- reasoning-depth / escalation decisions;
- failure-family classification;
- safety hints.

It is advisory. Host/domain code remains authoritative.

## Boundary

`llm-utils` owns:

- the tiny backend-neutral System-1 contract;
- typed question/result shapes;
- optional Laya adapter;
- quality/confidence metadata;
- latency metrics/failure fallback behavior.

Hosts own:

- the questions;
- domain thresholds/policy;
- what evidence enters the compact state;
- escalation;
- mutations and side effects.

System-1 never owns authorization, workflow state, graph persistence, or product semantics.

## Minimal contract

Keep it close to what real System-1 engines can answer efficiently:

```ts
type SystemOneQuestion =
  | {
      type: 'choice'
      instructions: string
      criteria: Record<string, string>
    }
  | {
      type: 'noul'
      instructions: string
    }
  | {
      type: 'score'
      instructions: string
      min?: number
      max?: number
    }

interface SystemOne {
  assess(
    state: Record<string, unknown>,
    questions: Record<string, SystemOneQuestion>,
  ): Promise<SystemOneAssessment | null>
}
```

The result preserves per-question probabilities/confidence rather than collapsing everything to booleans.

Do not add prompt templates, agents, retries, pipelines, registries, or host policies here.

## Laya adapter

The first adapter is Laya.

Requirements:

- support in-process Laya when installed;
- optionally support a remote System-1 endpoint through a small adapter/config seam;
- fail closed to `null`/unavailable rather than forcing host failure;
- expose raw calibrated answer probabilities;
- record latency;
- do not hide model quality.

`@receptron/laya` should be optional, not a mandatory heavy dependency for every llm-utils consumer. Prefer an optional peer/dynamic import unless implementation evidence shows another simpler packaging route.

## Quality

A System-1 backend/config has a quality grade:

```text
low | medium | high
```

Quality does not change the raw model result. Hosts use it when deciding confidence thresholds and escalation.

A low-quality engine can still be valuable for cheap routing/pruning, but should not silently make consequential decisions.

## Batching

The main performance win is one shared-state assessment containing several related questions.

Good:

```text
ticket summary + compact graph facts
→ work kind?
→ scope?
→ atomic vs split?
→ needs product context?
→ needs code context?
→ reasoning depth?
```

Bad:

```text
six separate System-1 calls
```

Likewise candidate filtering should batch a bounded shortlist when feasible.

## Candidate relevance

System-1 is especially useful between deterministic retrieval and expensive reasoning:

```text
cheap graph/lexical/exact search
          ↓
  bounded candidate set
          ↓
   System-1 relevance
          ↓
 very small evidence set
          ↓
 reasoning model
```

The host must provide candidate labels/descriptions, not entire files.

System-1 may shortlist candidates. It must not turn a relevance probability into canonical semantic truth.

## Failure semantics

Unavailable, timed-out, malformed, or low-confidence assessment is not an application error.

The caller receives unavailable/low-confidence evidence and follows its ordinary reasoning path.

System-1 is an optimization layer, never a correctness dependency.

## Existing ai-cli code

`ai-cli/src/laya.ts` currently proves the concept but owns generic machinery that should be shared.

After this primitive is implemented, ai-cli should consume it and retain only its domain-specific question set/policy.

Do not make ai-cli a dependency of llm-utils or AIWF.
