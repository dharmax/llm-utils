import { AnthropicAdapter, GoogleAdapter, OllamaProvider, OpenAIAdapter } from './adapters.mjs';
import { GenerateOptions, GenerationResult, ModelInfo, ProviderAdapter, ProviderConfig } from './types.mjs';

export interface CompletionOptions {
  system?: string;
  temperature?: number;
  format?: 'text' | 'json';
  signal?: AbortSignal | null;
}

export class CompletionEngine {
  private static adapters: Map<string, ProviderAdapter> = new Map([
    ['ollama', new OllamaProvider()],
    ['openai', new OpenAIAdapter()],
    ['google', new GoogleAdapter()],
    ['anthropic', new AnthropicAdapter()]
  ]);

  static registerAdapter(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  static getRegisteredProviderIds(): string[] {
    return Array.from(this.adapters.keys());
  }

  static async generate(
    prompt: string,
    model: ModelInfo,
    config: ProviderConfig,
    options: CompletionOptions = {}
  ): Promise<GenerationResult> {
    const adapter = this.adapters.get(model.providerId);
    if (!adapter) {
      return {
        text: '',
        ok: false,
        error: `Unsupported provider for completion: ${model.providerId}`,
        err: `Unsupported provider for completion: ${model.providerId}`,
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
      const message = error?.message ?? String(error);
      return {
        text: '',
        ok: false,
        error: `Fatal adapter error: ${message}`,
        err: `Fatal adapter error: ${message}`,
        model: { providerId: model.providerId, modelId: model.id }
      };
    }
  }
}
