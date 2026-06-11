import { GenerateOptions, GenerationResult, ProviderAdapter, ProviderId } from './types.mjs';

export class OpenAIAdapter implements ProviderAdapter {
  id: ProviderId = 'openai';

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const { modelId, prompt, system, config, format, signal } = options;
    const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    const apiKey = config.apiKey;
    if (!apiKey) return adapterError(this.id, modelId, 'OpenAI API key missing.');

    try {
      const messages = [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt }
      ];
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: modelId,
          messages,
          temperature: 0.1,
          response_format: format === 'json' ? { type: 'json_object' } : undefined
        }),
        signal: signal as any
      });

      if (!response.ok) throw new Error(`OpenAI error: ${response.status} ${await responseText(response)}`);
      const data = await response.json();
      return {
        text: data.choices?.[0]?.message?.content ?? '',
        ok: true,
        model: { providerId: this.id, modelId },
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0,
          totalTokens: data.usage?.total_tokens ?? 0,
          available: true
        },
        raw: data
      };
    } catch (error: any) {
      return adapterError(this.id, modelId, error?.message ?? String(error));
    }
  }
}

export class AnthropicAdapter implements ProviderAdapter {
  id: ProviderId = 'anthropic';

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const { modelId, prompt, system, config, signal } = options;
    const baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1';
    const apiKey = config.apiKey;
    if (!apiKey) return adapterError(this.id, modelId, 'Anthropic API key missing.');

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

      if (!response.ok) throw new Error(`Anthropic error: ${response.status} ${await responseText(response)}`);
      const data = await response.json();
      return {
        text: data.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n') ?? '',
        ok: true,
        model: { providerId: this.id, modelId },
        usage: {
          promptTokens: data.usage?.input_tokens ?? 0,
          completionTokens: data.usage?.output_tokens ?? 0,
          totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
          available: true
        },
        raw: data
      };
    } catch (error: any) {
      return adapterError(this.id, modelId, error?.message ?? String(error));
    }
  }
}

export class GoogleAdapter implements ProviderAdapter {
  id: ProviderId = 'google';

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const { modelId, prompt, system, config, format, signal } = options;
    const apiKey = config.apiKey;
    if (!apiKey) return adapterError(this.id, modelId, 'Google API key missing.');

    try {
      const body: any = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: format === 'json' ? 'application/json' : 'text/plain'
        }
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal as any
      });

      if (!response.ok) throw new Error(`Google error: ${response.status} ${await responseText(response)}`);
      const data = await response.json();
      return {
        text: data.candidates?.[0]?.content?.parts?.[0]?.text ?? '',
        ok: true,
        model: { providerId: this.id, modelId },
        usage: {
          promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
          completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
          totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
          available: true
        },
        raw: data
      };
    } catch (error: any) {
      return adapterError(this.id, modelId, error?.message ?? String(error));
    }
  }
}

export class OllamaProvider implements ProviderAdapter {
  id: ProviderId = 'ollama';

  async generate(options: GenerateOptions): Promise<GenerationResult> {
    const { modelId, prompt, system, config, format, signal } = options;
    const host = config.host ?? 'localhost';
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
          options: { temperature: 0.1 }
        }),
        signal: signal as any
      });

      if (!response.ok) throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
      const data = await response.json();
      return {
        text: data.response ?? '',
        ok: true,
        model: { providerId: this.id, modelId },
        usage: {
          promptTokens: data.prompt_eval_count ?? 0,
          completionTokens: data.eval_count ?? 0,
          totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
          available: true
        },
        raw: data
      };
    } catch (error: any) {
      return adapterError(this.id, modelId, error?.message ?? String(error));
    }
  }
}

async function responseText(response: Response): Promise<string> {
  const data = await response.json().catch(() => null);
  return data?.error?.message ?? data?.error ?? data?.message ?? response.statusText;
}

function adapterError(providerId: ProviderId, modelId: string, message: string): GenerationResult {
  return {
    text: '',
    ok: false,
    error: message,
    err: message,
    model: { providerId, modelId }
  };
}
