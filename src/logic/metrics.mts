import { GenerationResult } from '../types.mjs';
import { LlmMetrics } from '../metrics/service.mjs';
import { InMemoryMetricsStore } from '../metrics/store.mjs';
import { MetricsStore } from '../metrics/types.mjs';

export class MetricsEngine {
  readonly store: MetricsStore;
  readonly metrics: LlmMetrics;

  constructor(store: MetricsStore = new InMemoryMetricsStore()) {
    this.store = store;
    this.metrics = new LlmMetrics(store);
  }

  record(result: GenerationResult, latencyMs: number) {
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
      error: result.error ?? null,
      costUsd: this.calculateCost(result)
    });
  }

  private calculateCost(result: GenerationResult): number {
    const { providerId, modelId } = result.model;
    const usage = result.usage!;

    if (providerId === 'ollama') return 0;
    if (modelId.includes('gpt-4o')) {
      return (usage.promptTokens * 0.005 / 1000) + (usage.completionTokens * 0.015 / 1000);
    }
    if (modelId.includes('claude-3-5')) {
      return (usage.promptTokens * 0.003 / 1000) + (usage.completionTokens * 0.015 / 1000);
    }
    return 0;
  }

  getReport(): any {
    const summary = this.metrics.totals();
    return {
      turnCount: summary.calls,
      totalPromptTokens: summary.promptTokens,
      totalCompletionTokens: summary.completionTokens,
      totalTokens: summary.totalTokens,
      totalLatencyMs: summary.totalLatencyMs,
      averageLatencyMs: summary.avgLatencyMs,
      estimatedCostUsd: summary.totalCostUsd
    };
  }
}
