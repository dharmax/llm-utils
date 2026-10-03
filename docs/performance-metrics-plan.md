# Performance Metrics — Implementation Plan

Design authority: docs/performance-metrics.md.

This is a llm-utils-owned development flow.

# LLMUTILS-PERFORMANCE-METRICS

Status: implementation present on master; verify typecheck/tests/build before consuming from AIWF.

## Start

1. use the package's normal dev flow;
2. create/reuse and claim LLMUTILS-PERFORMANCE-METRICS;
3. inspect current metrics/Asker/Actor/System-1 code surgically.

## Gate 1 — typed correlation + sink

Add the smallest MetricsContext and MetricsSink contracts.

Converge current LlmMetrics/InMemoryMetricsStore on them without creating a parallel hierarchy.

Acceptance:

- trace/task metadata round trips;
- no content fields required;
- sink failure is isolated from model execution;
- existing aggregate/query behavior remains correct.

## Gate 2 — automatic Asker instrumentation

Instrument actual provider calls inside Asker/Completion path.

Record:

- provider/model/task;
- tokens/cost when available;
- latency;
- success/failure;
- structured-output retry attempts;
- correlation context.

Prove that a structured JSON repair retry produces two provider-call records but one caller-visible ask.

## Gate 3 — System-1 instrumentation

After LLMUTILS-SYSTEM1 exists, record:

- backend/quality;
- latency;
- question count/types;
- unavailable/error;
- correlation context.

Do not persist raw state/questions/answers by default.

## Gate 4 — Actor instrumentation

Record one Actor run summary plus optional tool-call spans:

- step count;
- tool-call count/failures;
- missing-tool recoveries;
- halt reason;
- run latency;
- correlated child LLM usage.

Do not duplicate token accounting already emitted by Asker.

## Gate 5 — overhead/KISS gate

Run:

~~~bash
bun run typecheck
bun test
bun run build
~~~

Benchmark metrics on/off for repeated local no-op/fake-provider calls. Instrumentation overhead must be negligible relative to inference/tool work.

Method-by-method KISS audit.

Reject if this work introduces OpenTelemetry, persistent storage, dashboards, host-specific schemas, hidden global trace state, or content logging.