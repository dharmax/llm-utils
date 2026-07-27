import { PubSub } from '@dharmax/pubsub';
import type { GenerationResult } from './types.mts';

export type MetricsBucket = 'minute' | 'hour' | 'day' | 'week' | 'month';
export type MetricsGroupBy = 'total' | 'provider' | 'model';

export interface LlmMetricEvent {
  timestamp: string;
  providerId: string;
  modelId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
  latencyMs: number;
  success: boolean;
  error?: string | null;
  err?: string | null;
  taskClass?: string;
  capability?: string;
  costUsd?: number | null;
  metadata?: Record<string, unknown>;
}

export interface MetricsQuery {
  from?: string;
  to?: string;
  providerId?: string;
  modelId?: string;
  taskClass?: string;
  success?: boolean;
  limit?: number | null;
  order?: 'asc' | 'desc';
}

export interface MetricsStore {
  append(event: LlmMetricEvent): void;
  query(query?: MetricsQuery): LlmMetricEvent[];
}

export interface AggregateMetrics {
  calls: number;
  successes: number;
  failures: number;
  successRate: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalLatencyMs: number;
  avgLatencyMs: number;
  avgPromptTokens: number;
  avgCompletionTokens: number;
  avgTotalTokens: number;
  totalCostUsd: number;
  avgCostUsd: number;
}

export interface MetricsTimeseriesPoint {
  bucketStart: string;
  bucketEnd: string;
  metrics: AggregateMetrics;
  providerId?: string;
  modelId?: string;
}

export interface MetricsEventsOptions {
  bus?: PubSub | null;
  origin?: string;
}

export interface UsagePricing {
  inputCostPerMillionTokensUsd?: number;
  outputCostPerMillionTokensUsd?: number;
}

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

export class InMemoryMetricsStore implements MetricsStore {
  private events: LlmMetricEvent[];
  private maxEvents: number | null;

  constructor(options: { initialEvents?: LlmMetricEvent[]; maxEvents?: number | null } = {}) {
    this.events = [...(options.initialEvents ?? [])];
    this.maxEvents = options.maxEvents ?? null;
  }

  append(event: LlmMetricEvent): void {
    this.events.push({ ...event });
    if (this.maxEvents && this.maxEvents > 0 && this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }

  query(query: MetricsQuery = {}): LlmMetricEvent[] {
    const fromMs = query.from ? Date.parse(query.from) : null;
    const toMs = query.to ? Date.parse(query.to) : null;
    const order = query.order ?? 'desc';
    let rows = this.events.filter((event) => {
      const eventMs = Date.parse(event.timestamp);
      if (fromMs !== null && eventMs < fromMs) return false;
      if (toMs !== null && eventMs > toMs) return false;
      if (query.providerId && event.providerId !== query.providerId) return false;
      if (query.modelId && event.modelId !== query.modelId) return false;
      if (query.taskClass && event.taskClass !== query.taskClass) return false;
      if (typeof query.success === 'boolean' && event.success !== query.success) return false;
      return true;
    });

    rows = rows.sort((left, right) => {
      const delta = Date.parse(left.timestamp) - Date.parse(right.timestamp);
      return order === 'asc' ? delta : -delta;
    });

    if (typeof query.limit === 'number' && query.limit >= 0) rows = rows.slice(0, query.limit);
    return rows.map((event) => ({ ...event }));
  }
}

/** Stores and aggregates normalized request metrics without assuming pricing. */
export class LlmMetrics {
  readonly store: MetricsStore;
  readonly bus: PubSub | null;
  readonly origin: string;

  constructor(store: MetricsStore = new InMemoryMetricsStore(), events: MetricsEventsOptions = {}) {
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
        return {
          providerId: providerId ?? '',
          modelId: modelId ?? '',
          metrics: aggregateEvents(events)
        };
      });
  }

  timeseries(bucket: MetricsBucket, query: MetricsQuery = {}, groupBy: MetricsGroupBy = 'total'): MetricsTimeseriesPoint[] {
    const buckets = new Map<string, LlmMetricEvent[]>();
    for (const event of this.list({ ...query, order: 'asc' })) {
      const key = buildBucketKey(event.timestamp, bucket, groupBy, event);
      buckets.set(key, [...(buckets.get(key) ?? []), event]);
    }

    return [...buckets.entries()]
      .map(([key, events]) => {
        const first = events[0];
        if (!first) return null;
        const point: MetricsTimeseriesPoint = {
          ...resolveBucketRange(first.timestamp, bucket),
          metrics: aggregateEvents(events)
        };
        if (groupBy === 'provider') point.providerId = first.providerId;
        if (groupBy === 'model') {
          point.providerId = first.providerId;
          point.modelId = first.modelId;
        }
        return { key, point };
      })
      .filter((entry): entry is { key: string; point: MetricsTimeseriesPoint } => entry !== null)
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(({ point }) => point);
  }
}

/** Compatibility façade that records successful generation usage. */
export class MetricsEngine {
  readonly store: MetricsStore;
  readonly metrics: LlmMetrics;

  constructor(store: MetricsStore = new InMemoryMetricsStore()) {
    this.store = store;
    this.metrics = new LlmMetrics(store);
  }

  record(result: GenerationResult, latencyMs: number, pricing?: UsagePricing): void {
    if (!result.ok || !result.usage) return;
    this.metrics.record({
      timestamp: new Date().toISOString(),
      providerId: result.model.providerId,
      modelId: result.model.modelId,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      totalTokens: result.usage.totalTokens,
      latencyMs,
      success: result.ok,
      error: result.error ?? result.err ?? null,
      costUsd: calculateUsageCost(result.usage, pricing)
    });
  }

  getReport(): Record<string, number> {
    const totals = this.metrics.totals();
    return {
      turnCount: totals.calls,
      totalPromptTokens: totals.promptTokens,
      totalCompletionTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
      totalLatencyMs: totals.totalLatencyMs,
      averageLatencyMs: totals.avgLatencyMs,
      estimatedCostUsd: totals.totalCostUsd
    };
  }
}

export function createMetricsPubSub(name: string = 'LLM Metrics'): PubSub {
  return new PubSub(name);
}

export function normalizeMetricEvent(event: Omit<LlmMetricEvent, 'totalTokens'> & { totalTokens?: number }): LlmMetricEvent {
  const promptTokens = Math.max(0, Number(event.promptTokens ?? 0));
  const completionTokens = Math.max(0, Number(event.completionTokens ?? 0));
  return {
    timestamp: event.timestamp,
    providerId: String(event.providerId),
    modelId: String(event.modelId),
    promptTokens,
    completionTokens,
    totalTokens: Number.isFinite(event.totalTokens) ? Math.max(0, Number(event.totalTokens)) : promptTokens + completionTokens,
    latencyMs: Math.max(0, Number(event.latencyMs ?? 0)),
    success: Boolean(event.success),
    error: event.error ?? event.err ?? null,
    ...(event.taskClass === undefined ? {} : { taskClass: event.taskClass }),
    ...(event.capability === undefined ? {} : { capability: event.capability }),
    costUsd: Number.isFinite(event.costUsd) ? Number(event.costUsd) : 0,
    ...(event.metadata ? { metadata: { ...event.metadata } } : {})
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
    acc.totalTokens += event.totalTokens ?? event.promptTokens + event.completionTokens;
    acc.totalLatencyMs += event.latencyMs;
    acc.totalCostUsd += Number(event.costUsd ?? 0);
    return acc;
  }, { ...EMPTY_AGGREGATE });

  return {
    ...totals,
    successRate: round(totals.successes / totals.calls * 100, 2),
    avgLatencyMs: Math.round(totals.totalLatencyMs / totals.calls),
    avgPromptTokens: Math.round(totals.promptTokens / totals.calls),
    avgCompletionTokens: Math.round(totals.completionTokens / totals.calls),
    avgTotalTokens: Math.round(totals.totalTokens / totals.calls),
    avgCostUsd: round(totals.totalCostUsd / totals.calls, 6)
  };
}

function groupEvents(events: LlmMetricEvent[], makeKey: (event: LlmMetricEvent) => string): Map<string, LlmMetricEvent[]> {
  const groups = new Map<string, LlmMetricEvent[]>();
  for (const event of events) groups.set(makeKey(event), [...(groups.get(makeKey(event)) ?? []), event]);
  return groups;
}

function buildBucketKey(timestamp: string, bucket: MetricsBucket, groupBy: MetricsGroupBy, event: LlmMetricEvent): string {
  const { bucketStart } = resolveBucketRange(timestamp, bucket);
  if (groupBy === 'provider') return `${bucketStart}::${event.providerId}`;
  if (groupBy === 'model') return `${bucketStart}::${event.providerId}::${event.modelId}`;
  return bucketStart;
}

function resolveBucketRange(timestamp: string, bucket: MetricsBucket): { bucketStart: string; bucketEnd: string } {
  const start = new Date(timestamp);
  if (bucket === 'minute') start.setUTCSeconds(0, 0);
  if (bucket === 'hour') start.setUTCMinutes(0, 0, 0);
  if (bucket === 'day') start.setUTCHours(0, 0, 0, 0);
  if (bucket === 'week') {
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  }
  if (bucket === 'month') {
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
  }

  const end = new Date(start);
  if (bucket === 'minute') end.setUTCMinutes(end.getUTCMinutes() + 1);
  if (bucket === 'hour') end.setUTCHours(end.getUTCHours() + 1);
  if (bucket === 'day') end.setUTCDate(end.getUTCDate() + 1);
  if (bucket === 'week') end.setUTCDate(end.getUTCDate() + 7);
  if (bucket === 'month') end.setUTCMonth(end.getUTCMonth() + 1);

  return { bucketStart: start.toISOString(), bucketEnd: end.toISOString() };
}

/**
 * Prices provider-reported usage with caller-supplied rates. Unknown pricing is
 * deliberately zero instead of relying on stale hard-coded model prices.
 */
export function calculateUsageCost(
  usage: GenerationResult['usage'],
  pricing?: UsagePricing,
): number {
  if (!usage || !pricing) return 0;
  return usage.promptTokens / 1_000_000 * (pricing.inputCostPerMillionTokensUsd ?? 0)
    + usage.completionTokens / 1_000_000 * (pricing.outputCostPerMillionTokensUsd ?? 0);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
