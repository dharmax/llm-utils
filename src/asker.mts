import { ProviderId, ProviderConfig, TaskType, GenerationResult, ModelInfo, InteractionTurn, SystemStatus } from './types.mjs';
import { PromptEngine } from './prompts/prompt-engine.mjs';
import { ContextManager } from './context/context-manager.mjs';
import { CompletionEngine } from './router/completion-engine.mjs';
import { RouterHeuristics } from './logic/heuristics.mjs';
import { ModelRouter } from './router/model-router.mjs';
import { SystemProbe } from './io/system.mjs';

export class Asker {
  private providerConfigs: Map<ProviderId, ProviderConfig>;
  private taskTypes: Map<string, TaskType>;
  private modelFitMatrix: Map<string, ModelInfo[]> = new Map();

  constructor(
    providers: ProviderConfig[],
    taskTypes: TaskType[],
    private contextManager: ContextManager,
    private promptEngine: PromptEngine
  ) {
    this.providerConfigs = new Map(providers.map(p => [p.id, p]));
    this.taskTypes = new Map(taskTypes.map(t => [t.id, t]));
  }

  getPromptEngine(): PromptEngine {
    return this.promptEngine;
  }

  /**
   * Retrieves the current system status (e.g. lean-ctx installation).
   */
  async getSystemStatus(): Promise<SystemStatus> {
    return SystemProbe.getStatus();
  }

  /**
   * Refreshes model-to-task mappings using Gold heuristics.
   */
  async refreshMapping(availableModels: ModelInfo[]): Promise<void> {
    const availableProviders = new Set(
      Array.from(this.providerConfigs.values())
        .filter(p => p.enabled !== false && (p.id === 'ollama' || !!p.apiKey))
        .map(p => p.id)
    );

    for (const task of this.taskTypes.values()) {
      const candidates = ModelRouter.scoreModels(
        Array.from(this.providerConfigs.values()),
        task,
        availableModels.filter(m => availableProviders.has(m.providerId))
      );
      this.modelFitMatrix.set(task.id, candidates);
    }
  }

  /**
   * High-level templated prompt execution.
   */
  async prompt(templateName: string, toolkit: any, data: any): Promise<GenerationResult> {
    const { content, manifest } = await this.promptEngine.load(templateName);
    
    // Resolve context grounding from manifest
    const variables = { ...data, ...toolkit };
    if (manifest.inject) {
      for (const item of manifest.inject) {
        if (item.type === 'context_blocks') {
          const blocks = await this.contextManager.getRelevantBlocks(data.inputText || '', item.categories);
          variables[item.key] = blocks.map(b => `### ${b.title}\n${b.body}`).join('\n\n');
        }
      }
    }

    const finalPrompt = this.promptEngine.render(content, variables);
    const taskType = data.taskType || manifest.taskType || 'default';

    return this.ask(finalPrompt, taskType, { system: manifest.system });
  }

  /**
   * Simple turn execution.
   */
  async ask(prompt: string, taskTypeId: string, options: Partial<InteractionTurn> = {}): Promise<GenerationResult> {
    const candidates = this.modelFitMatrix.get(taskTypeId) || [];
    const model = ModelRouter.route(candidates);

    if (!model) {
      throw new Error(`No model routed for task: ${taskTypeId}`);
    }

    const config = this.providerConfigs.get(model.providerId);
    if (!config) throw new Error(`Config missing for provider: ${model.providerId}`);

    const turn: InteractionTurn = {
      ...options,
      prompt,
      modelId: model.id,
      providerId: model.providerId
    };

    return CompletionEngine.generate(prompt, model, config, { 
      system: options.system,
      format: options.format,
      signal: options.signal
    });
  }
}
