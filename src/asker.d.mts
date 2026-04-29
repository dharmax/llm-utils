import { AskerOptions, ProviderConfig, TaskType, GenerationResult, ModelInfo, InteractionTurn, SystemStatus } from './types.mjs';
import { PromptEngine } from './prompts/prompt-engine.mjs';
import { ContextManager } from './context/context-manager.mjs';
export declare class Asker {
    private providerConfigs;
    private taskTypes;
    private modelFitMatrix;
    private contextManager?;
    private promptEngine;
    private router?;
    constructor(options: AskerOptions);
    constructor(providers: ProviderConfig[], taskTypes: TaskType[], contextManager: ContextManager, promptEngine: PromptEngine);
    getPromptEngine(): PromptEngine;
    /**
     * Retrieves the current system status (e.g. lean-ctx installation).
     */
    getSystemStatus(): Promise<SystemStatus>;
    /**
     * Refreshes model-to-task mappings using scored candidates.
     */
    refreshMapping(availableModels?: ModelInfo[]): Promise<void>;
    prompt(turn: InteractionTurn): Promise<GenerationResult>;
    prompt(templateName: string, toolkit: any, data: any): Promise<GenerationResult>;
    /**
     * Simple turn execution.
     */
    ask(prompt: string, taskTypeId: string, options?: Partial<InteractionTurn>): Promise<GenerationResult>;
    private getWeightsForTask;
}
