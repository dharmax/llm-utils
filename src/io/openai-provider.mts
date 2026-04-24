import { InteractionProvider, InteractionTurn, GenerationResult, ProviderConfig, ProviderId } from '../types.mjs';

export class OpenAIProvider implements InteractionProvider {
  id: ProviderId = 'openai';

  async generate(turn: InteractionTurn, config: ProviderConfig): Promise<GenerationResult> {
    const { modelId, prompt, system, format, signal } = turn;
    const baseUrl = config.baseUrl || 'https://api.openai.com/v1';

    try {
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
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
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `OpenAI error: ${response.status}`);
      }

      const data = await response.json();
      return {
        text: data.choices[0]?.message?.content || '',
        ok: true,
        model: { providerId: this.id, modelId: modelId! },
        usage: {
          promptTokens: data.usage?.prompt_tokens || 0,
          completionTokens: data.usage?.completion_tokens || 0,
          totalTokens: data.usage?.total_tokens || 0,
          available: true
        },
        raw: data
      };
    } catch (error: any) {
      return { text: '', ok: false, error: error.message, model: { providerId: this.id, modelId: modelId! } };
    }
  }
}
