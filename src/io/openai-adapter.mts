import { ProviderAdapter, GenerateOptions, GenerationResult, ProviderId } from '../types.mjs';

export class OpenAIAdapter implements ProviderAdapter {
  id: ProviderId = 'openai';

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const { modelId, prompt, system, config, format, signal } = options;
    const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    const apiKey = config.apiKey;

    if (!apiKey) {
      return { text: '', ok: false, error: 'OpenAI API key missing.', model: { providerId: this.id, modelId: modelId } };
    }

    try {
      const messages = [];
      if (system) {
        messages.push({ role: 'system', content: system });
      }
      messages.push({ role: 'user', content: prompt });

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: modelId,
          messages,
          temperature: 0.1,
          response_format: format === 'json' ? { type: 'json_object' } : undefined
        }),
        signal: signal as any
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(`OpenAI error: ${response.status} ${errData.error?.message || response.statusText}`);
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content || '';

      return {
        text: text,
        ok: true,
        model: { providerId: this.id, modelId: modelId },
        usage: {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0,
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
