import { ProviderConfig, ModelInfo, TaskType, ProviderState } from '../types.mjs';

export interface RouterOptions {
  preferLocal?: boolean;
  allowWeak?: boolean;
}

export interface ScoringHeuristics {
  [capability: string]: {
    keywords: string[];
  }
}

/**
 * ModelRouter
 * Instance-based router that scores and selects models.
 */
export class ModelRouter {
  constructor(private providerState: ProviderState) {}

  /**
   * Routes a task to the best available model.
   */
  route(taskType: TaskType, options: { allowWeak?: boolean } = {}): ModelInfo | null {
    const providers = Object.values(this.providerState.providers);
    const availableModels: any[] = [];

    for (const p of providers) {
      if (p.available && p.models) {
        for (const m of p.models) {
          availableModels.push({ ...m, providerId: p.id || (p as any).providerId });
        }
      }
    }

    const scored = ModelRouter.scoreModels(
      providers,
      taskType,
      availableModels,
      this.providerState.knowledge?.heuristics || {}
    );

    return scored[0] || null;
  }

  getProviderConfig(providerId: string): ProviderConfig {
    return this.providerState.providers[providerId];
  }

  /**
   * Static logic ported from model-fit.mjs.
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
        local: model.local
      });
    }

    scoredModels.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));
    return scoredModels;
  }

  /**
   * Routes a task to the best available candidate.
   */
  static route(candidates: ModelInfo[], options: RouterOptions = {}): ModelInfo | null {
    const available = candidates.filter(c => (c.fitScore || 0) > 0);
    if (!available.length) return null;

    let filtered = available;
    if (options.preferLocal) {
      const local = available.filter(c => c.providerId === 'ollama' || c.local);
      if (local.length) {
        filtered = local;
      } else if (!options.allowWeak) {
        return null;
      }
    }

    return filtered[0] || null;
  }

  private static scoreCapabilities(capabilities: any, weights: any): number {
    let score = 0;
    for (const [key, weight] of Object.entries(weights)) {
      score += (capabilities[key] || 0) * (weight as number);
    }
    return score * 100;
  }

  private static inferCapabilities(model: any, heuristics: ScoringHeuristics): any {
    return model.capabilities || { logic: 0.5, strategy: 0.5 };
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
