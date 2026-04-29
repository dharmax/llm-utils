import { PubSub } from '@dharmax/pubsub';

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
