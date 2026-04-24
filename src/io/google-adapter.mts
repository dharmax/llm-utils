import { ProviderAdapter, GenerateOptions, GenerationResult, ProviderId } from '../types.mjs';

export class GoogleAdapter implements ProviderAdapter {
  id: ProviderId = 'google';

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const { modelId, prompt, system, config, format, signal } = options;
    const apiKey = config.apiKey;

    if (!apiKey) {
      return { text: '', ok: false, error: 'Google API key missing.', model: { providerId: this.id, modelId: modelId } };
    }

    try {
      const contents = [];
      contents.push({ role: 'user', parts: [{ text: prompt }] });

      const body: any = {
        contents,
        generationConfig: {
          temperature: 0.1,
          responseMimeType: format === 'json' ? 'application/json' : 'text/plain'
        }
      };

      if (system) {
        body.systemInstruction = { parts: [{ text: system }] };
      }

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal as any
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(`Google error: ${response.status} ${errData.error?.message || response.statusText}`);
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      return {
        text: text,
        ok: true,
        model: { providerId: this.id, modelId },
        usage: {
          promptTokens: data.usageMetadata?.promptTokenCount || 0,
          completionTokens: data.usageMetadata?.candidatesTokenCount || 0,
          totalTokens: data.usageMetadata?.totalTokenCount || 0,
          available: true
        },
        raw: data
      };
    } catch (error: any) {
      return {
        text: '',
        ok: false,
        error: error.message,
        model: { providerId: this.id, modelId }
      };
    }
  }
}
