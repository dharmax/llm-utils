import { ModelCapabilities, ModelInfo, TaskType } from '../types.mjs';
/**
 * Gold Heuristics ported from core/services/model-fit.mjs
 */
export declare class RouterHeuristics {
    static inferCapabilities(modelId: string, sizeB: number | null, quality: 'low' | 'medium' | 'high'): ModelCapabilities;
    static scoreModel(model: ModelInfo, task: TaskType): {
        fitScore: number;
        reasons: string[];
    };
}
