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

- choice;
- noul;
- score.

Preserve calibrated probabilities/confidence in results.

No host policy and no agent/pipeline abstraction.

Gate with focused tests/typecheck.

### Step 2 — Laya adapter

Implement the smallest Laya adapter.

Requirements:

- in-process adapter via dynamic/optional dependency;
- remote adapter only if it stays tiny and directly replaces duplicated ai-cli behavior;
- unavailable/timeouts return a non-fatal unavailable result;
- quality grade exposed;
- latency recorded.

Do not duplicate ai-cli routing/safety questions in llm-utils.

### Step 3 — prove batching and fallback

Tests must prove:

- multiple questions use one backend assessment;
- choice probabilities preserved;
- noul probability preserved;
- score preserved;
- unavailable backend cleanly falls back;
- malformed backend result does not fabricate an answer;
- timeout is bounded;
- no autoregressive LLM call is involved.

Run:

```bash
bun run typecheck
bun test
bun run build
```

Then method-by-method KISS audit.

### Step 4 — ai-cli migration is separate

Do **not** mutate ai-cli in this ticket.

After llm-utils publishes the primitive, ai-cli gets its own small migration ticket to replace generic wrapper/config types while keeping its question set and safety policy.

AIWF may consume the shared primitive after this gate is green.

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
