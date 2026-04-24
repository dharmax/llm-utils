import { ProviderAdapter, GenerateOptions, GenerationResult, ProviderId } from '../types.mjs';

export class OllamaProvider implements ProviderAdapter {
  id: ProviderId = 'ollama';

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const { modelId, prompt, system, config, format, signal } = options;
    const host = config.host || 'localhost';
    const baseUrl = host.startsWith('http') ? host : `http://${host}:11434`;
    
    try {
      const response = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          prompt,
          system,
          stream: false,
          format: format === 'json' ? 'json' : undefined,
          options: {
            temperature: 0.1
          }
        }),
        signal: signal as any
      });

      if (!response.ok) {
        throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      return {
        text: data.response,
        ok: true,
        model: { providerId: this.id, modelId: modelId },
        usage: {
          promptTokens: data.prompt_eval_count || 0,
          completionTokens: data.eval_count || 0,
          totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
          available: true
        },
        raw: data
      };
    } catch (error: any) {
      return {
        text: '',
        ok: false,
        error: error.message,
        model: { providerId: this.id, modelId: modelId }
      };
    }
  }
}
