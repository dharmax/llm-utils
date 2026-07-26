import type {
  ModelCapabilities,
  ModelInfo,
  ProviderConfig,
  ProviderState,
  TaskType
} from './types.mjs';

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
  constructor(private providerState: ProviderState) {}

  route(taskType: TaskType, options: RouterOptions = {}): ModelInfo | null {
    const providers = Object.values(this.providerState.providers);
    const models = providers.flatMap((provider) =>
      provider.available && provider.models
        ? provider.models.map((model) => ({ ...model, providerId: model.providerId ?? provider.id }))
        : []
    );
    return ModelRouter.routeCandidates(
      ModelRouter.scoreModels(providers, taskType, models, this.providerState.knowledge?.heuristics ?? {}),
      options
    );
  }

  getProviderConfig(providerId: string): ProviderConfig | undefined {
    return this.providerState.providers[providerId];
  }

  static scoreModels(
    _providers: ProviderConfig[],
    taskType: TaskType,
    models: ModelInfo[],
    heuristics: ScoringHeuristics = {}
  ): ModelInfo[] {
    const weights = taskType.weights && Object.keys(taskType.weights).length
      ? taskType.weights
      : this.getTaskWeights(taskType.id);

    return models
      .map((model) => {
        const capabilities = model.capabilities ?? RouterHeuristics.inferCapabilities(model.id, model.sizeB ?? null, model.quality ?? 'medium', heuristics);
        const capabilityScore = scoreCapabilities(capabilities, weights);
        const qualityBonus = { low: 6, medium: 12, high: 18 }[model.quality ?? 'medium'];
        const fitScore = Math.max(0, Math.min(100, Math.round(capabilityScore + qualityBonus)));
        return {
          ...model,
          fitScore,
          fitReasons: [`capability fit ${capabilityScore.toFixed(1)}/100`, `quality ${model.quality ?? 'medium'}`]
        };
      })
      .sort((left, right) => (right.fitScore ?? 0) - (left.fitScore ?? 0));
  }

  static route(candidates: ModelInfo[], options: RouterOptions = {}): ModelInfo | null {
    return this.routeCandidates(candidates, options);
  }

  private static routeCandidates(candidates: ModelInfo[], options: RouterOptions): ModelInfo | null {
    const available = candidates.filter((candidate) => (candidate.fitScore ?? 0) > 0);
    if (!available.length) return null;

    if (options.preferLocal) {
      const local = available.filter((candidate) => candidate.local || candidate.providerId === 'ollama');
      if (local.length) return local[0] ?? null;
      if (!options.allowWeak) return null;
    }

    return available[0] ?? null;
  }

  private static getTaskWeights(taskClass: string): Partial<ModelCapabilities> {
    if (taskClass === 'code-generation') return { logic: 0.45, strategy: 0.3, prose: 0.15, data: 0.1 };
    if (taskClass === 'summarization') return { data: 0.45, prose: 0.35, strategy: 0.15, logic: 0.05 };
    if (taskClass === 'architecture') return { strategy: 0.45, logic: 0.25, prose: 0.2, data: 0.1 };
    return { strategy: 0.3, logic: 0.3, prose: 0.2, data: 0.2 };
  }
}

export class RouterHeuristics {
  static inferCapabilities(
    modelId: string,
    _sizeB: number | null,
    quality: 'low' | 'medium' | 'high',
    heuristics: ScoringHeuristics = {}
  ): ModelCapabilities {
    const lower = modelId.toLowerCase();
    const base = quality === 'high' ? 0.75 : quality === 'medium' ? 0.55 : 0.35;
    const capabilities: ModelCapabilities = {
      logic: base,
      strategy: base,
      prose: base,
      visual: base,
      creative: base,
      data: base
    };
    const keywordMap: Record<keyof ModelCapabilities, string[]> = {
      logic: ['coder', 'code', 'math'],
      strategy: ['reason', 'reasoning', 'plan', 'planner', 'agent', 'analysis'],
      prose: ['llama', 'gemma', 'chat', 'assistant'],
      creative: ['hermes', 'stheno'],
      visual: ['vision', 'moondream'],
      data: ['extract', 'summary', 'json']
    };

    for (const [capability, defaults] of Object.entries(keywordMap) as Array<[keyof ModelCapabilities, string[]]>) {
      const keywords = heuristics[capability]?.keywords ?? defaults;
      if (keywords.some((keyword) => lower.includes(keyword))) {
        capabilities[capability] = Math.min(1, capabilities[capability] + 0.2);
      }
    }

    return capabilities;
  }

  static scoreModel(model: ModelInfo, task: TaskType): { fitScore: number; reasons: string[] } {
    const scored = ModelRouter.scoreModels([], task, [model])[0];
    if (!scored) return { fitScore: 0, reasons: [] };
    return {
      fitScore: scored.fitScore ?? 0,
      reasons: scored.fitReasons ?? []
    };
  }
}

function scoreCapabilities(
  capabilities: Partial<ModelCapabilities>,
  weights: Partial<ModelCapabilities>
): number {
  let score = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(weights)) {
    const weighted = Number(weight ?? 0);
    score += Number(capabilities[key as keyof ModelCapabilities] ?? 0) * weighted;
    totalWeight += weighted;
  }
  return totalWeight ? (score / totalWeight) * 100 : 0;
}
