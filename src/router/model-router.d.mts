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
export declare class ModelRouter {
    /**
     * Scores models against a specific task type using heuristics.
     * Logic ported from model-fit.mjs.
     */
    static scoreModels(providers: ProviderConfig[], taskType: TaskType, models: any[], heuristics?: ScoringHeuristics): ModelInfo[];
    /**
     * Routes a task to the best available candidate.
     */
    static route(candidates: ModelInfo[], options?: RouterOptions): ModelInfo | null;
    private static inferCapabilities;
    private static scoreCapabilities;
    private static getTaskWeights;
}
