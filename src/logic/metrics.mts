import { GenerationResult } from '../types.mjs';

/**
 * Superb Engine for tracking and analyzing LLM usage.
 */
export class MetricsEngine {
  private metrics: any = {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    turnCount: 0,
    averageLatencyMs: 0,
    estimatedCostUsd: 0
  };

  /**
   * Records a single generation turn.
   */
  record(result: GenerationResult, latencyMs: number) {
    if (!result.ok || !result.usage) return;

    this.metrics.turnCount++;
    this.metrics.totalPromptTokens += result.usage.promptTokens;
    this.metrics.totalCompletionTokens += result.usage.completionTokens;
    this.metrics.totalTokens += result.usage.totalTokens;
    this.metrics.totalLatencyMs += latencyMs;
    this.metrics.averageLatencyMs = Math.round(this.metrics.totalLatencyMs / this.metrics.turnCount);
    
    // Cost estimation (Gold logic from providers.mjs)
    this.metrics.estimatedCostUsd += this.calculateCost(result);
  }

  private calculateCost(result: GenerationResult): number {
    const { providerId, modelId } = result.model;
    const usage = result.usage!;

    // Simple heuristic pricing for common models
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
    return { ...this.metrics };
  }
}
