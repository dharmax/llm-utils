import { LlmMetricEvent, MetricsQuery, MetricsStore } from './types.mjs';

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

    if (typeof query.limit === 'number' && query.limit >= 0) {
      rows = rows.slice(0, query.limit);
    }

    return rows.map((event) => ({ ...event }));
  }
}
