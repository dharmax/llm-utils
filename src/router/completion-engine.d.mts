import { ProviderConfig, ModelInfo, GenerationResult, ProviderAdapter } from '../types.mjs';
export interface CompletionOptions {
    system?: string;
    temperature?: number;
    format?: 'text' | 'json';
    signal?: AbortSignal | null;
}
export declare class CompletionEngine {
    private static adapters;
    /**
     * Registers a custom provider adapter.
     */
    static registerAdapter(adapter: ProviderAdapter): void;
    /**
     * Executes a completion request against a specific provider.
     */
    static generate(prompt: string, model: ModelInfo, config: ProviderConfig, options?: CompletionOptions): Promise<GenerationResult>;
}
