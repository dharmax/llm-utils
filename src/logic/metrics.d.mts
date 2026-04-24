import { GenerationResult } from '../types.mjs';
/**
 * Superb Engine for tracking and analyzing LLM usage.
 */
export declare class MetricsEngine {
    private metrics;
    /**
     * Records a single generation turn.
     */
    record(result: GenerationResult, latencyMs: number): void;
    private calculateCost;
    getReport(): any;
}
