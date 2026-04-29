import { PubSub } from '@dharmax/pubsub';
import {
  AggregateMetrics,
  LlmMetricEvent,
  MetricsBucket,
  MetricsEventsOptions,
  MetricsGroupBy,
  MetricsQuery,
  MetricsStore,
  MetricsTimeseriesPoint
} from './types.mjs';
import { InMemoryMetricsStore } from './store.mjs';

const EMPTY_AGGREGATE: AggregateMetrics = {
  calls: 0,
  successes: 0,
  failures: 0,
  successRate: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  totalLatencyMs: 0,
  avgLatencyMs: 0,
  avgPromptTokens: 0,
  avgCompletionTokens: 0,
  avgTotalTokens: 0,
  totalCostUsd: 0,
  avgCostUsd: 0
};

export class LlmMetrics {
  readonly store: MetricsStore;
  readonly bus: PubSub | null;
  readonly origin: string;

  constructor(
    store: MetricsStore = new InMemoryMetricsStore(),
    events: MetricsEventsOptions = {}
  ) {
    this.store = store;
    this.bus = events.bus ?? null;
    this.origin = events.origin ?? 'llm-metrics';
  }

  record(event: Omit<LlmMetricEvent, 'totalTokens'> & { totalTokens?: number }): LlmMetricEvent {
    const normalized = normalizeMetricEvent(event);
    this.store.append(normalized);
    this.bus?.trigger(this.origin, 'metrics:recorded', normalized);
    return normalized;
  }

  list(query: MetricsQuery = {}): LlmMetricEvent[] {
    return this.store.query(query);
  }

  latest(limit: number = 20, query: Omit<MetricsQuery, 'limit'> = {}): LlmMetricEvent[] {
    return this.list({ ...query, limit, order: 'desc' });
  }

  totals(query: MetricsQuery = {}): AggregateMetrics {
    return aggregateEvents(this.list(query));
  }

  byProvider(query: MetricsQuery = {}): Array<{ providerId: string; metrics: AggregateMetrics }> {
    return [...groupEvents(this.list(query), (event) => event.providerId).entries()]
      .map(([providerId, events]) => ({ providerId, metrics: aggregateEvents(events) }));
  }

  byModel(query: MetricsQuery = {}): Array<{ providerId: string; modelId: string; metrics: AggregateMetrics }> {
    return [...groupEvents(this.list(query), (event) => `${event.providerId}::${event.modelId}`).entries()]
      .map(([key, events]) => {
        const [providerId, modelId] = key.split('::');
        return { providerId, modelId, metrics: aggregateEvents(events) };
      });
  }

  timeseries(
    bucket: MetricsBucket,
    query: MetricsQuery = {},
    groupBy: MetricsGroupBy = 'total'
  ): MetricsTimeseriesPoint[] {
    const buckets = new Map<string, LlmMetricEvent[]>();
    for (const event of this.list({ ...query, order: 'asc' })) {
      const key = buildBucketKey(event.timestamp, bucket, groupBy, event);
      const slot = buckets.get(key) ?? [];
      slot.push(event);
      buckets.set(key, slot);
    }

    return [...buckets.entries()]
      .map(([key, events]) => {
        const first = events[0];
        const { bucketStart, bucketEnd } = resolveBucketRange(first.timestamp, bucket);
        const point: MetricsTimeseriesPoint = {
          bucketStart,
          bucketEnd,
          metrics: aggregateEvents(events)
        };
        if (groupBy === 'provider') point.providerId = first.providerId;
        if (groupBy === 'model') {
          point.providerId = first.providerId;
          point.modelId = first.modelId;
        }
        return { key, point };
      })
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(({ point }) => point);
  }
}

export function createMetricsPubSub(name: string = 'LLM Metrics'): PubSub {
  return new PubSub(name);
}

export function normalizeMetricEvent(event: Omit<LlmMetricEvent, 'totalTokens'> & { totalTokens?: number }): LlmMetricEvent {
  const promptTokens = Math.max(0, Number(event.promptTokens ?? 0));
  const completionTokens = Math.max(0, Number(event.completionTokens ?? 0));
  const totalTokens = Number.isFinite(event.totalTokens)
    ? Math.max(0, Number(event.totalTokens))
    : promptTokens + completionTokens;

  return {
    timestamp: event.timestamp,
    providerId: String(event.providerId),
    modelId: String(event.modelId),
    promptTokens,
    completionTokens,
    totalTokens,
    latencyMs: Math.max(0, Number(event.latencyMs ?? 0)),
    success: Boolean(event.success),
    error: event.error ?? null,
    taskClass: event.taskClass,
    capability: event.capability,
    costUsd: Number.isFinite(event.costUsd) ? Number(event.costUsd) : 0,
    metadata: event.metadata ? { ...event.metadata } : undefined
  };
}

export function aggregateEvents(events: LlmMetricEvent[]): AggregateMetrics {
  if (!events.length) return { ...EMPTY_AGGREGATE };

  const totals = events.reduce((acc, event) => {
    acc.calls += 1;
    acc.successes += event.success ? 1 : 0;
    acc.failures += event.success ? 0 : 1;
    acc.promptTokens += event.promptTokens;
    acc.completionTokens += event.completionTokens;
    acc.totalTokens += event.totalTokens ?? (event.promptTokens + event.completionTokens);
    acc.totalLatencyMs += event.latencyMs;
    acc.totalCostUsd += Number(event.costUsd ?? 0);
    return acc;
  }, { ...EMPTY_AGGREGATE });

  return {
    ...totals,
    successRate: roundPercent((totals.successes / totals.calls) * 100),
    avgLatencyMs: Math.round(totals.totalLatencyMs / totals.calls),
    avgPromptTokens: Math.round(totals.promptTokens / totals.calls),
    avgCompletionTokens: Math.round(totals.completionTokens / totals.calls),
    avgTotalTokens: Math.round(totals.totalTokens / totals.calls),
    avgCostUsd: roundCurrency(totals.totalCostUsd / totals.calls)
  };
}

function groupEvents(events: LlmMetricEvent[], makeKey: (event: LlmMetricEvent) => string): Map<string, LlmMetricEvent[]> {
  const groups = new Map<string, LlmMetricEvent[]>();
  for (const event of events) {
    const key = makeKey(event);
    const slot = groups.get(key) ?? [];
    slot.push(event);
    groups.set(key, slot);
  }
  return groups;
}

function buildBucketKey(timestamp: string, bucket: MetricsBucket, groupBy: MetricsGroupBy, event: LlmMetricEvent): string {
  const { bucketStart } = resolveBucketRange(timestamp, bucket);
  if (groupBy === 'provider') return `${bucketStart}::${event.providerId}`;
  if (groupBy === 'model') return `${bucketStart}::${event.providerId}::${event.modelId}`;
  return bucketStart;
}

function resolveBucketRange(timestamp: string, bucket: MetricsBucket): { bucketStart: string; bucketEnd: string } {
  const date = new Date(timestamp);
  const start = new Date(date);

  if (bucket === 'minute') {
    start.setUTCSeconds(0, 0);
  } else if (bucket === 'hour') {
    start.setUTCMinutes(0, 0, 0);
  } else if (bucket === 'day') {
    start.setUTCHours(0, 0, 0, 0);
  } else if (bucket === 'week') {
    start.setUTCHours(0, 0, 0, 0);
    const day = start.getUTCDay();
    const offset = (day + 6) % 7;
    start.setUTCDate(start.getUTCDate() - offset);
  } else if (bucket === 'month') {
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
  }

  const end = new Date(start);
  if (bucket === 'minute') end.setUTCMinutes(end.getUTCMinutes() + 1);
  if (bucket === 'hour') end.setUTCHours(end.getUTCHours() + 1);
  if (bucket === 'day') end.setUTCDate(end.getUTCDate() + 1);
  if (bucket === 'week') end.setUTCDate(end.getUTCDate() + 7);
  if (bucket === 'month') end.setUTCMonth(end.getUTCMonth() + 1);

  return {
    bucketStart: start.toISOString(),
    bucketEnd: end.toISOString()
  };
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundCurrency(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
