import { ProviderConfig, ModelInfo, TaskType } from '../types.mjs';

export interface RouterOptions {
  preferLocal?: boolean;
  allowWeak?: boolean;
}

export interface ScoringHeuristics {
  [capability: string]: {
    keywords: string[];
  };
}

export class ModelRouter {
  /**
   * Scores models against a specific task type using heuristics.
   * Logic ported from model-fit.mjs.
   */
  static scoreModels(providers: ProviderConfig[], taskType: TaskType, models: any[], heuristics: ScoringHeuristics = {}): ModelInfo[] {
    const taskWeights = this.getTaskWeights(taskType.id);
    const scoredModels: ModelInfo[] = [];

    for (const model of models) {
      const capabilities = this.inferCapabilities(model, heuristics);
      const capabilityScore = this.scoreCapabilities(capabilities, taskWeights);
      
      const qualityBonus = { low: 6, medium: 12, high: 18 }[model.quality as 'low'|'medium'|'high' || 'medium'] || 12;
      const fitScore = Math.max(0, Math.min(100, Math.round(capabilityScore + qualityBonus)));

      scoredModels.push({
        id: model.id,
        providerId: model.providerId,
        fitScore,
        fitReasons: [`capability fit ${capabilityScore.toFixed(1)}/100`, `quality ${model.quality || 'medium'}`],
        quality: model.quality,
        costTier: model.costTier
      });
    }

    return scoredModels.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
  }

  /**
   * Routes a task to the best available candidate.
   */
  static route(candidates: ModelInfo[], options: RouterOptions = {}): ModelInfo | null {
    const available = candidates.filter(c => c.fitScore !== undefined && c.fitScore > 0);
    if (!available.length) return null;
    
    let filtered = available;
    if (options.preferLocal) {
      const local = available.filter(c => c.providerId === 'ollama');
      if (local.length) {
        filtered = local;
      } else if (!options.allowWeak) {
        return null;
      }
    }

    return filtered[0];
  }

  private static inferCapabilities(model: any, heuristics: ScoringHeuristics) {
    const lower = String(model.id).toLowerCase();
    const base = model.quality === 'high' ? 3.5 : model.quality === 'medium' ? 2.5 : 1.5;
    const result: any = { logic: base, strategy: base, prose: base, visual: base, data: base };

    const checks = {
      logic: ['coder', 'code', 'math', ...(heuristics.logic?.keywords || [])],
      strategy: ['reason', 'reasoning', 'plan', 'planner', 'agent', 'analysis', ...(heuristics.strategy?.keywords || [])],
      prose: ['llama', 'gemma', 'chat', 'assistant', ...(heuristics.prose?.keywords || [])],
      visual: ['vision', 'moondream', ...(heuristics.visual?.keywords || [])],
      data: ['extract', 'summary', 'json']
    };

    for (const [cap, keywords] of Object.entries(checks)) {
      if (keywords.some(k => lower.includes(k.toLowerCase()))) {
        result[cap] += 1;
      }
    }
    return result;
  }

  private static scoreCapabilities(caps: any, weights: any) {
    let sum = 0;
    let totalWeight = 0;
    for (const [cap, weight] of Object.entries(weights)) {
      sum += (Math.max(0, Math.min(5, caps[cap] || 0)) / 5) * (weight as number);
      totalWeight += (weight as number);
    }
    return (sum / (totalWeight || 1)) * 100;
  }

  private static getTaskWeights(taskClass: string) {
    switch (taskClass) {
      case 'code-generation': return { logic: 0.45, strategy: 0.3, prose: 0.15, data: 0.1 };
      case 'summarization': return { data: 0.45, prose: 0.35, strategy: 0.15, logic: 0.05 };
      case 'architecture': return { strategy: 0.45, logic: 0.25, prose: 0.2, data: 0.1 };
      default: return { strategy: 0.3, logic: 0.3, prose: 0.2, data: 0.2 };
    }
  }
}
