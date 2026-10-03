# Performance Metrics — Design

Status: implemented shared model/System-1/actor correlation and telemetry substrate; hosts own workflow summaries/persistence.

## 1. Purpose

llm-utils already has LlmMetrics, but today it is mostly a standalone recorder. Performance metrics should become automatic, correlated, and host-composable without turning llm-utils into an analytics platform.

llm-utils owns generic cognition/execution telemetry.

Hosts own workflow/domain metrics and persistence/reporting policy.

## 2. What llm-utils measures

### LLM call

- provider/model;
- task class;
- success/failure;
- prompt/completion/total tokens when provider reports them;
- estimated cost when pricing is available;
- latency;
- retry/structured-output repair count;
- optional local/remote marker.

### System-1 assessment

- backend ID/type/quality;
- latency;
- question count/types;
- success/unavailable/error;
- optional usage supplied by backend;
- confidence/distribution summaries only when the host chooses to attach them.

### Actor run

- total latency;
- steps;
- tool calls;
- tool failures;
- missing-tool recoveries;
- halt reason;
- total child LLM usage correlated to the run.

### Tool execution

Optionally emit generic tool-call timing/success records from LLMActor.

Never record tool parameters/results by default.

## 3. Correlation

Add a tiny explicit metrics context:

~~~
interface MetricsContext {
  traceId: string
  spanId?: string
  parentSpanId?: string
  taskClass?: string
  tags?: Record<string, string | number | boolean>
}
~~~

Do not use hidden AsyncLocalStorage as the first implementation. Explicit propagation is easier to reason about and test.

AskOptions, ActorRunOptions and System-1 assessment options may carry MetricsContext.

Child calls inherit traceId and add their own span/parent relationship.

## 4. Event/sink boundary

Generalize the current store behind a tiny append/query-capable interface where needed, or at minimum an append sink for host persistence.

~~~
interface MetricsSink {
  append(event: MetricEvent): void | Promise<void>
}
~~~

Existing InMemoryMetricsStore remains useful and may implement the contract.

llm-utils must not own AIWF persistence format, Semantika, files, dashboards, or retention policy.

## 5. Automatic instrumentation

Asker should record every actual provider call automatically, including bounded structured-output retries.

SystemOne adapters should record assessment latency/outcome automatically.

LLMActor should record aggregate run metrics and optional tool spans automatically.

Hosts should not need to manually re-count tokens/latency already known by llm-utils.

## 6. Privacy and volume

Metrics contain identifiers, numbers, outcome categories and bounded tags.

Do not persist prompts, model outputs, tool arguments, tool results, source text or secrets by default.

Keep detailed per-call events cheap; hosts may aggregate/persist only run summaries.

## 7. Existing API

Preserve the useful current LlmMetrics aggregate/query API where possible.

The redesign should converge rather than add MetricsEngine2 or a parallel telemetry hierarchy.

Current metadata remains an escape hatch, but trace/task fields that need interoperability should become typed rather than convention-only.

## 8. Non-goals

Do not build OpenTelemetry compatibility, dashboards, experiment management, pricing services, persistent databases, or AIWF-specific metric names in llm-utils.

## 9. Invariants

1. Metrics are automatic where llm-utils owns the event.
2. One trace can correlate System-1, LLM and Actor work.
3. Hosts can persist/aggregate without llm-utils depending on them.
4. No prompt/source content is recorded by default.
5. Metrics must not materially slow the measured operation.
6. Failure to record metrics must never fail the underlying AI operation.