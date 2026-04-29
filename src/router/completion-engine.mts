import { ProviderConfig, ModelInfo, GenerationResult, ProviderAdapter, GenerateOptions } from '../types.mjs';
import { OllamaProvider } from '../io/ollama-adapter.mjs';
import { OpenAIAdapter } from '../io/openai-adapter.mjs';
import { GoogleAdapter } from '../io/google-adapter.mjs';
import { AnthropicAdapter } from '../io/anthropic-adapter.mjs';

export interface CompletionOptions {
  system?: string;
  temperature?: number;
  format?: 'text' | 'json';
  signal?: AbortSignal | null;
}

/**
 * CompletionEngine
 * generic orchestrator for LLM generation.
 * No hardcoded providers.
 */
export class CompletionEngine {
  private static adapters: Map<string, ProviderAdapter> = new Map([
    ['ollama', new OllamaProvider()],
    ['openai', new OpenAIAdapter()],
    ['google', new GoogleAdapter()],
    ['anthropic', new AnthropicAdapter()]
  ]);

  /**
   * Registers a custom provider adapter.
   */
  static registerAdapter(adapter: ProviderAdapter) {
    this.adapters.set(adapter.id, adapter);
  }

  /**
   * Lists all registered provider IDs.
   */
  static getRegisteredProviderIds(): string[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Executes a completion request against a specific provider.
   */
  static async generate(prompt: string, model: ModelInfo, config: ProviderConfig, options: CompletionOptions = {}): Promise<GenerationResult> {
    const adapter = this.adapters.get(model.providerId);
    
    if (!adapter) {
      return { 
        text: '', 
        ok: false, 
        error: `Unsupported provider for completion: ${model.providerId}`,
        model: { providerId: model.providerId, modelId: model.id }
      };
    }

    const generateOptions: GenerateOptions = {
      modelId: model.id,
      prompt,
      system: options.system,
      config,
      format: options.format,
      signal: options.signal
    };

    try {
      return await adapter.generate(generateOptions);
    } catch (error: any) {
      console.error(`[completion-engine] Fatal adapter error for ${model.providerId}:`, error.message);
      return {
        text: '',
        ok: false,
        error: `Fatal adapter error: ${error.message}`,
        model: { providerId: model.providerId, modelId: model.id }
      };
    }
  }
}
