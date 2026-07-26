import type {
    GenerateOptions,
    GenerationResult,
    LlmFailure,
    ProviderAdapter,
    ProviderId,
} from './types.mjs'

type JsonRecord = Record<string, unknown>

export class OpenAIAdapter implements ProviderAdapter {
    readonly id = 'openai'

    async generate(options: GenerateOptions): Promise<GenerationResult> {
        const {modelId, prompt, system, config, format, signal} = options
        if (!config.apiKey)
            return adapterFailure(this.id, modelId, {
                kind: 'configuration',
                message: 'OpenAI API key missing.',
                retryable: false,
                fatal: true,
            })

        return requestJson({
            providerId: this.id,
            modelId,
            url: `${config.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`,
            headers: {Authorization: `Bearer ${config.apiKey}`},
            body: {
                model: modelId,
                messages: [
                    ...(system ? [{role: 'system', content: system}] : []),
                    {role: 'user', content: prompt},
                ],
                temperature: options.temperature ?? 0.1,
                response_format: format === 'json' ? {type: 'json_object'} : undefined,
            },
            signal,
            read: data => ({
                text: stringAt(data, 'choices', 0, 'message', 'content'),
                usage: usage(
                    numberAt(data, 'usage', 'prompt_tokens'),
                    numberAt(data, 'usage', 'completion_tokens'),
                    numberAt(data, 'usage', 'total_tokens'),
                ),
            }),
        })
    }
}

export class AnthropicAdapter implements ProviderAdapter {
    readonly id = 'anthropic'

    async generate(options: GenerateOptions): Promise<GenerationResult> {
        const {modelId, prompt, system, config, signal} = options
        if (!config.apiKey)
            return adapterFailure(this.id, modelId, {
                kind: 'configuration',
                message: 'Anthropic API key missing.',
                retryable: false,
                fatal: true,
            })

        return requestJson({
            providerId: this.id,
            modelId,
            url: `${config.baseUrl ?? 'https://api.anthropic.com/v1'}/messages`,
            headers: {
                'x-api-key': config.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: {
                model: modelId,
                messages: [{role: 'user', content: prompt}],
                system: system || undefined,
                max_tokens: 4096,
                temperature: options.temperature ?? 0.1,
            },
            signal,
            read: data => {
                const content = arrayAt(data, 'content')
                    .filter(part => recordAt(part)?.type === 'text')
                    .map(part => String(recordAt(part)?.text ?? ''))
                    .join('\n')
                const promptTokens = numberAt(data, 'usage', 'input_tokens')
                const completionTokens = numberAt(data, 'usage', 'output_tokens')
                return {
                    text: content,
                    usage: usage(
                        promptTokens,
                        completionTokens,
                        promptTokens + completionTokens,
                    ),
                }
            },
        })
    }
}

export class GoogleAdapter implements ProviderAdapter {
    readonly id = 'google'

    async generate(options: GenerateOptions): Promise<GenerationResult> {
        const {modelId, prompt, system, config, format, signal} = options
        if (!config.apiKey)
            return adapterFailure(this.id, modelId, {
                kind: 'configuration',
                message: 'Google API key missing.',
                retryable: false,
                fatal: true,
            })

        return requestJson({
            providerId: this.id,
            modelId,
            url: `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${config.apiKey}`,
            body: {
                contents: [{role: 'user', parts: [{text: prompt}]}],
                generationConfig: {
                    temperature: options.temperature ?? 0.1,
                    responseMimeType: format === 'json' ? 'application/json' : 'text/plain',
                },
                ...(system ? {systemInstruction: {parts: [{text: system}]}} : {}),
            },
            signal,
            read: data => ({
                text: stringAt(data, 'candidates', 0, 'content', 'parts', 0, 'text'),
                usage: usage(
                    numberAt(data, 'usageMetadata', 'promptTokenCount'),
                    numberAt(data, 'usageMetadata', 'candidatesTokenCount'),
                    numberAt(data, 'usageMetadata', 'totalTokenCount'),
                ),
            }),
        })
    }
}

export class OllamaProvider implements ProviderAdapter {
    readonly id = 'ollama'

    async generate(options: GenerateOptions): Promise<GenerationResult> {
        const {modelId, prompt, system, config, format, signal} = options
        const host = config.host ?? 'localhost'
        const baseUrl = host.startsWith('http') ? host : `http://${host}:11434`

        return requestJson({
            providerId: this.id,
            modelId,
            url: `${baseUrl}/api/generate`,
            body: {
                model: modelId,
                prompt,
                system,
                stream: false,
                format: format === 'json' ? 'json' : undefined,
                options: {temperature: options.temperature ?? 0.1},
            },
            signal,
            read: data => {
                const promptTokens = numberAt(data, 'prompt_eval_count')
                const completionTokens = numberAt(data, 'eval_count')
                return {
                    text: stringAt(data, 'response'),
                    usage: usage(
                        promptTokens,
                        completionTokens,
                        promptTokens + completionTokens,
                    ),
                }
            },
        })
    }
}

type RequestOptions = {
    providerId: ProviderId
    modelId: string
    url: string
    headers?: Record<string, string>
    body: JsonRecord
    signal?: AbortSignal | null | undefined
    read(data: JsonRecord): Pick<GenerationResult, 'text' | 'usage'>
}

async function requestJson(options: RequestOptions): Promise<GenerationResult> {
    try {
        const response = await fetch(options.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
            body: JSON.stringify(options.body),
            ...(options.signal === undefined ? {} : {signal: options.signal}),
        })
        const raw = await readJsonResponse(response)

        if (!response.ok)
            return adapterFailure(
                options.providerId,
                options.modelId,
                providerFailure(response.status, response.statusText, raw),
            )

        const data = recordAt(raw)
        if (!data)
            return adapterFailure(options.providerId, options.modelId, {
                kind: 'invalid_response',
                message: 'Provider returned a non-object JSON response.',
                retryable: false,
                fatal: false,
                raw,
            })

        const result = options.read(data)
        return {
            ...result,
            ok: true,
            model: {
                providerId: options.providerId,
                modelId: options.modelId,
            },
            raw,
        }
    } catch (error) {
        return adapterFailure(
            options.providerId,
            options.modelId,
            thrownFailure(error),
        )
    }
}

async function readJsonResponse(response: Response): Promise<unknown> {
    const text = await response.text()
    if (!text)
        return undefined
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

function providerFailure(status: number, statusText: string, raw: unknown): LlmFailure {
    const record = recordAt(raw)
    const error = recordAt(record?.error)
    const code = stringValue(error?.code ?? record?.code)
    const message = stringValue(error?.message ?? record?.message ?? record?.error)
        || statusText
        || `Provider request failed with HTTP ${status}.`

    if (status === 401 || status === 403)
        return {kind: 'authentication', message, status, code, retryable: false, fatal: true, raw}

    if (status === 429) {
        const quota = code === 'insufficient_quota'
            || /(?:quota|billing|credit)/i.test(message)
        return {
            kind: quota ? 'quota' : 'rate_limit',
            message,
            status,
            code,
            retryable: !quota,
            fatal: quota,
            raw,
        }
    }

    if (status === 408 || status === 504)
        return {kind: 'timeout', message, status, code, retryable: true, fatal: false, raw}

    return {
        kind: 'provider',
        message,
        status,
        code,
        retryable: status >= 500,
        fatal: false,
        raw,
    }
}

function thrownFailure(error: unknown): LlmFailure {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof DOMException && error.name === 'AbortError')
        return {kind: 'timeout', message, retryable: true, fatal: false, raw: error}
    return {kind: 'network', message, retryable: true, fatal: false, raw: error}
}

function adapterFailure(
    providerId: ProviderId,
    modelId: string,
    failure: LlmFailure,
): GenerationResult {
    return {
        text: '',
        ok: false,
        failure,
        error: failure.message,
        err: failure.message,
        model: {providerId, modelId},
    }
}

function usage(
    promptTokens: number,
    completionTokens: number,
    totalTokens: number,
): NonNullable<GenerationResult['usage']> {
    return {
        promptTokens,
        completionTokens,
        totalTokens,
        available: true,
    }
}

function recordAt(value: unknown): JsonRecord | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as JsonRecord
        : undefined
}

function arrayAt(value: unknown, ...path: Array<string | number>): unknown[] {
    const found = valueAt(value, path)
    return Array.isArray(found) ? found : []
}

function stringAt(value: unknown, ...path: Array<string | number>): string {
    return stringValue(valueAt(value, path))
}

function numberAt(value: unknown, ...path: Array<string | number>): number {
    const found = valueAt(value, path)
    return typeof found === 'number' && Number.isFinite(found) ? found : 0
}

function valueAt(value: unknown, path: Array<string | number>): unknown {
    let current = value
    for (const key of path) {
        if (typeof key === 'number') {
            if (!Array.isArray(current))
                return undefined
            current = current[key]
        } else {
            const record = recordAt(current)
            if (!record)
                return undefined
            current = record[key]
        }
    }
    return current
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : ''
}
