import { ProviderConfig, TaskType, GenerationResult, ModelInfo, InteractionTurn, SystemStatus } from './types.mjs';
import { PromptEngine } from './prompts/prompt-engine.mjs';
import { ContextManager } from './context/context-manager.mjs';
export declare class Asker {
    private contextManager;
    private promptEngine;
    private providerConfigs;
    private taskTypes;
    private modelFitMatrix;
    constructor(providers: ProviderConfig[], taskTypes: TaskType[], contextManager: ContextManager, promptEngine: PromptEngine);
    getPromptEngine(): PromptEngine;
    /**
     * Retrieves the current system status (e.g. lean-ctx installation).
     */
    getSystemStatus(): Promise<SystemStatus>;
    /**
     * Refreshes model-to-task mappings using Gold heuristics.
     */
    refreshMapping(availableModels: ModelInfo[]): Promise<void>;
    /**
     * High-level templated prompt execution.
     */
    prompt(templateName: string, toolkit: any, data: any): Promise<GenerationResult>;
    /**
     * Simple turn execution.
     */
    ask(prompt: string, taskTypeId: string, options?: Partial<InteractionTurn>): Promise<GenerationResult>;
}
