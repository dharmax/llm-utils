import { ProviderConfig, ModelInfo, TaskType } from '../types.mjs';
import { ProviderState } from '../types.mjs';
export interface RouterOptions {
    preferLocal?: boolean;
    allowWeak?: boolean;
}
export interface ScoringHeuristics {
    [capability: string]: {
        keywords: string[];
    };
}
export declare class ModelRouter {
    constructor(providerState: ProviderState);
    /**
     * Routes a task to the best available model.
     */
    route(taskType: TaskType, options?: {
        allowWeak?: boolean;
    }): ModelInfo | null;
    getProviderConfig(providerId: string): ProviderConfig;
    /**
     * Static logic ported from model-fit.mjs.
     */
    static scoreModels(providers: ProviderConfig[], taskType: TaskType, models: any[], heuristics?: ScoringHeuristics): ModelInfo[];
    /**
     * Routes a task to the best available candidate.
     */
    static route(candidates: ModelInfo[], options?: RouterOptions): ModelInfo | null;
    private providerState;
    private static inferCapabilities;
    private static scoreCapabilities;
    private static getTaskWeights;
}
