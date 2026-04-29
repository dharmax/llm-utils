import {
  AskerOptions,
  ProviderId,
  ProviderConfig,
  TaskType,
  GenerationResult,
  ModelInfo,
  InteractionTurn,
  SystemStatus
} from './types.mjs';
import { PromptEngine } from './prompts/prompt-engine.mjs';
import { ContextManager } from './context/context-manager.mjs';
import { CompletionEngine } from './router/completion-engine.mjs';
import { ModelRouter } from './router/model-router.mjs';
import { SystemProbe } from './io/system.mjs';

/**
 * Asker
 * High-level interface for LLM requests.
 */
export class Asker {
  private providerConfigs: Map<ProviderId, ProviderConfig> = new Map();
  private taskTypes: Map<string, TaskType> = new Map();
  private modelFitMatrix: Map<string, ModelInfo[]> = new Map();
  private contextManager?: ContextManager;
  private promptEngine: PromptEngine;
  private router?: ModelRouter;

  constructor(options: AskerOptions);
  constructor(
    providers: ProviderConfig[],
    taskTypes: TaskType[],
    contextManager: ContextManager,
    promptEngine: PromptEngine
  );
  constructor(
    providersOrOptions: AskerOptions | ProviderConfig[],
    taskTypes: TaskType[] = [],
    contextManager?: ContextManager,
    promptEngine?: PromptEngine
  ) {
    if (Array.isArray(providersOrOptions)) {
      this.providerConfigs = new Map(providersOrOptions.map(p => [p.id, p]));
      this.taskTypes = new Map(taskTypes.map(t => [t.id, t]));
      this.contextManager = contextManager;
      this.promptEngine = promptEngine || new PromptEngine();
      return;
    }

    const options = providersOrOptions;
    this.router = new ModelRouter(options.providerState);
    this.promptEngine = options.promptEngine || new PromptEngine();
    this.providerConfigs = new Map(
      Object.values(options.providerState.providers || {}).map(p => [p.id, p])
    );
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
   * Refreshes model-to-task mappings using scored candidates.
   */
  async refreshMapping(availableModels: ModelInfo[] = []): Promise<void> {
    if (this.router) return;

    const providers = Array.from(this.providerConfigs.values());
    const availableProviders = new Set(
      providers
        .filter(p => p.enabled !== false && (p.id === 'ollama' || !!p.apiKey || p.available))
        .map(p => p.id)
    );

    for (const task of this.taskTypes.values()) {
      const candidates = ModelRouter.scoreModels(
        providers,
        task,
        availableModels.filter(m => availableProviders.has(m.providerId))
      );
      this.modelFitMatrix.set(task.id, candidates);
    }
  }

  async prompt(turn: InteractionTurn): Promise<GenerationResult>;
  async prompt(templateName: string, toolkit: any, data: any): Promise<GenerationResult>;
  async prompt(
    turnOrTemplateName: InteractionTurn | string,
    toolkit: any = {},
    data: any = {}
  ): Promise<GenerationResult> {
    if (typeof turnOrTemplateName !== 'string') {
      return this.ask(turnOrTemplateName.prompt, 'default', turnOrTemplateName);
    }

    const { content, manifest } = await this.promptEngine.load(turnOrTemplateName);

    const variables = { ...data, ...toolkit };
    if (manifest.inject && this.contextManager) {
      for (const item of manifest.inject) {
        if (item.type === 'context_blocks') {
          const blocks = await this.contextManager.getRelevantBlocks(
            data.inputText || '',
            item.categories || []
          );
          variables[item.key] = blocks.map(b => `### ${b.title}\n${b.body}`).join('\n\n');
        }
      }
    }

    const finalPrompt = this.promptEngine.render(content, variables);
    const taskType = data.taskType || manifest.taskType || 'default';
    return this.ask(finalPrompt, taskType, { system: manifest.system });
  }

  async ask(
    prompt: string,
    taskTypeId: string,
    options: Partial<InteractionTurn> = {}
  ): Promise<GenerationResult> {
    let model: ModelInfo | null = null;

    if (this.router) {
      const taskType: TaskType = {
        id: taskTypeId,
        shortName: taskTypeId,
        description: 'Generic task',
        weights: this.getWeightsForTask(taskTypeId)
      };

      model = this.router.route(taskType, {
        allowWeak: options.providerId === 'ollama' || options.modelId?.includes('mock')
      });
    } else {
      const candidates = this.modelFitMatrix.get(taskTypeId) || [];
      model = ModelRouter.route(candidates);
    }

    if (!model && options.providerId && options.modelId) {
      model = { id: options.modelId, providerId: options.providerId };
    }

    if (!model) {
      return {
        text: '',
        ok: false,
        error: `No model routed for task: ${taskTypeId}`,
        model: { providerId: 'unknown', modelId: 'none' }
      };
    }

    const config = this.router
      ? this.router.getProviderConfig(model.providerId) || { id: model.providerId }
      : this.providerConfigs.get(model.providerId) || { id: model.providerId };

    const result = await CompletionEngine.generate(prompt, model, config, {
      system: options.system,
      format: options.format,
      signal: options.signal
    });

    result.response = result.text;
    return result;
  }

  private getWeightsForTask(id: string) {
    const task = this.taskTypes.get(id);
    if (task) return task.weights;

    switch (id) {
      case 'code-generation':
        return { logic: 0.7, strategy: 0.3 };
      default:
        return { logic: 0.5, strategy: 0.5 };
    }
  }
}
