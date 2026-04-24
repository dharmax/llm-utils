import { ModelCapabilities, ModelInfo, TaskType } from '../types.mjs';

/**
 * Gold Heuristics ported from core/services/model-fit.mjs
 */
export class RouterHeuristics {
  static inferCapabilities(modelId: string, sizeB: number | null, quality: 'low'|'medium'|'high'): ModelCapabilities {
    const lower = modelId.toLowerCase();
    const base = quality === 'high' ? 3.5 : quality === 'medium' ? 2.5 : 1.5;
    
    const result: ModelCapabilities = {
      logic: base,
      strategy: base,
      prose: base,
      visual: base,
      creative: base,
      data: base
    };

    const keywords = {
      logic: ['coder', 'code', 'math'],
      strategy: ['reason', 'reasoning', 'plan', 'planner', 'agent', 'analysis'],
      prose: ['llama', 'gemma', 'chat', 'assistant'],
      creative: ['hermes', 'stheno'],
      visual: ['vision', 'moondream'],
      data: ['extract', 'summary', 'json']
    };

    for (const [cap, keys] of Object.entries(keywords)) {
      if (keys.some(k => lower.includes(k))) {
        (result as any)[cap] += 1;
      }
    }

    if (lower.includes('gemma') || lower.includes('llama') || lower.includes('mistral')) {
      result.strategy += 0.5;
      result.prose += 0.5;
    }

    return result;
  }

  static scoreModel(model: ModelInfo, task: TaskType): { fitScore: number; reasons: string[] } {
    const caps = this.inferCapabilities(model.id, model.sizeB ?? null, model.quality ?? 'medium');
    const weights = task.weights;
    
    let sum = 0;
    let totalWeight = 0;
    for (const [cap, weight] of Object.entries(weights)) {
      const value = (caps as any)[cap] || 0;
      sum += (Math.max(0, Math.min(5, value)) / 5) * (weight as number);
      totalWeight += (weight as number);
    }
    
    const capabilityScore = (sum / (totalWeight || 1)) * 100;
    const qualityBonus = { low: 6, medium: 12, high: 18 }[model.quality ?? 'medium'];
    const fitScore = Math.max(0, Math.min(100, Math.round(capabilityScore + qualityBonus)));

    return {
      fitScore,
      reasons: [
        `capability fit ${capabilityScore.toFixed(1)}/100`,
        `quality ${model.quality ?? 'medium'}`
      ]
    };
  }
}
