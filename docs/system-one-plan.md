# System-1 — Implementation Plan

Design authority: `docs/system-one.md`.

This is a **llm-utils-owned development flow**.

## Ticket — LLMUTILS-SYSTEM1

### Start

1. Run the project's normal sync/workflow step if present.
2. Create/reuse and claim `LLMUTILS-SYSTEM1`.
3. Use repository context surgically; do not preload a fixed file list.

### Step 1 — contract only

Add the smallest backend-neutral types and `SystemOne` assessment interface.

Required question shapes:

- choice with named criteria;
- noul;
- score with an ordered criteria rubric.

Preserve calibrated probabilities/confidence in results.

No host policy and no agent/pipeline abstraction.

Gate with focused tests/typecheck.

### Step 2 — Laya adapter

Implement the smallest Laya adapter.

Requirements:

- in-process adapter via dynamic/optional dependency and lazy model load;
- one tiny remote adapter/protocol that can replace duplicated ai-cli HTTP glue;
- no eager model load during package import or ordinary non-System-1 use;
- unavailable/timeouts return a non-fatal unavailable result;
- quality grade exposed;
- answer probabilities/distributions and usage preserved;
- latency recorded.

Do not duplicate ai-cli routing/safety questions in llm-utils.

### Step 3 — prove batching, Bun compatibility and fallback

Tests must prove:

- multiple questions use one backend assessment;
- choice probabilities preserved;
- noul probability preserved;
- score expected level/distribution preserved;
- unavailable backend cleanly falls back;
- malformed backend result does not fabricate an answer;
- timeout is bounded;
- no autoregressive LLM call is involved.

Run one real in-process Laya smoke test under Bun when the model is available. If @receptron/laya/onnxruntime-node is not reliably usable under Bun, keep the shared remote adapter as the supported path and stop rather than adding runtime shims or ONNX machinery to llm-utils.

Run:

```bash
bun run typecheck
bun test
bun run build
```

Then method-by-method KISS audit.

### Step 4 — migrate proven consumer

Migrate ai-cli to the shared primitive while keeping its question set, answer interpretation and safety policy host-owned. Preserve local/remote fallback behavior and keep `@receptron/laya` installed only in hosts that actually want local Laya.

AIWF and other consumers may use the shared primitive after this gate is green. Do not force System-1 into packages that merely depend on llm-utils; adopt it only at genuine cheap-classification/ranking boundaries.

## Rejection criteria

Reject if this work creates:

- a generic cognitive framework;
- host/domain policy in llm-utils;
- agent/workflow orchestration;
- persistence;
- a registry;
- mandatory Laya installation for consumers that do not use it;
- loss of raw probabilities;
- an API shaped around AIWF-specific ticket concepts.
