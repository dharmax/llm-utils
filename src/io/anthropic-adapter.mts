import { ProviderAdapter, GenerateOptions, GenerationResult, ProviderId } from '../types.mjs';

export class AnthropicAdapter implements ProviderAdapter {
  id: ProviderId = 'anthropic';

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const { modelId, prompt, system, config, format, signal } = options;
    const baseUrl = config.baseUrl || 'https://api.anthropic.com/v1';
    const apiKey = config.apiKey;

    if (!apiKey) {
      return { text: '', ok: false, error: 'Anthropic API key missing.', model: { providerId: this.id, modelId: modelId } };
    }

    try {
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: prompt }],
          system: system || undefined,
          max_tokens: 4096,
          temperature: 0.1
        }),
        signal: signal as any
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(`Anthropic error: ${response.status} ${errData.error?.message || response.statusText}`);
      }

      const data = await response.json();
      const text = data.content?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') || '';

      return {
        text: text,
        ok: true,
        model: { providerId: this.id, modelId: modelId },
        usage: {
          promptTokens: data.usage?.input_tokens || 0,
          completionTokens: data.usage?.output_tokens || 0,
          totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
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
