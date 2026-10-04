import type {
    GenerateOptions,
    GenerationResult,
    LlmFailure,
    ProviderAdapter,
    ResponseFormat,
    Usage,
} from './types.ts'

export class OpenAIAdapter implements ProviderAdapter {
    readonly id: string

    constructor(id = 'openai') {
        this.id = id
    }

    async generate(options: GenerateOptions): Promise<GenerationResult> {
        const {modelId, prompt, system, config, format, signal, timeoutMs, temperature, maxTokens} = options
        if (!config.apiKey && !config.baseUrl)
            return missingApiKey(this.id, modelId)

        const baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')
        const {responseFormat, fallbackSchema} = toOpenAiFormat(format)
        let effectivePrompt = prompt
        if (fallbackSchema) {
            effectivePrompt = `${prompt}\n\nYou MUST respond with valid JSON adhering to this JSON Schema:\n${JSON.stringify(fallbackSchema, null, 2)}`
        } else if (responseFormat?.type === 'json_object' && !/json/i.test(prompt) && !(system && /json/i.test(system))) {
            effectivePrompt = `${prompt}\n\nRespond with valid JSON.`
        }
        const messages = [
            ...(system ? [{role: 'system', content: system}] : []),
            {role: 'user', content: effectivePrompt},
        ]

        const headers: Record<string, string> = {}
        if (config.apiKey)
            headers.Authorization = `Bearer ${config.apiKey}`

        return postJson({
            providerId: this.id,
            modelId,
            url: `${baseUrl}/chat/completions`,
            headers,
            body: {
                model: modelId,
                messages,
                temperature: temperature ?? 0.1,
                max_tokens: maxTokens ?? 4096,
                ...(responseFormat ? {response_format: responseFormat} : {}),
            },
            signal,
            timeoutMs,
            extract: data => {
                const choice = (data as {choices?: Array<{message?: {content?: string}; finish_reason?: string}>})?.choices?.[0]
                const usageData = (data as {usage?: {prompt_tokens?: number; completion_tokens?: number; total_tokens?: number}})?.usage
                return {
                    text: choice?.message?.content ?? '',
                    usage: usageData ? toUsage(usageData.prompt_tokens, usageData.completion_tokens, usageData.total_tokens) : undefined,
                    finishReason: choice?.finish_reason,
                }
            },
        })
    }
}

export class AnthropicAdapter implements ProviderAdapter {
    readonly id = 'anthropic'

    async generate(options: GenerateOptions): Promise<GenerationResult> {
        const {modelId, prompt, system, config, format, signal, timeoutMs, temperature, maxTokens} = options
        if (!config.apiKey)
            return missingApiKey(this.id, modelId)

        const baseUrl = (config.baseUrl ?? 'https://api.anthropic.com/v1').replace(/\/+$/, '')

        const isJson = isJsonFormat(format)
        const schema = format && typeof format === 'object' && format.type === 'json_schema' ? format.schema : undefined

        let effectiveSystem = system
        if (schema) {
            const schemaInstruction = `You MUST return strictly valid JSON matching this schema:\n${JSON.stringify(schema, null, 2)}\nDo not enclose in markdown code fences or add explanations.`
            effectiveSystem = effectiveSystem ? `${effectiveSystem}\n\n${schemaInstruction}` : schemaInstruction
        } else if (isJson) {
            const jsonInstruction = 'You MUST return strictly valid JSON. Do not enclose in markdown code fences or add explanations.'
            effectiveSystem = effectiveSystem ? `${effectiveSystem}\n\n${jsonInstruction}` : jsonInstruction
        }

        return postJson({
            providerId: this.id,
            modelId,
            url: `${baseUrl}/messages`,
            headers: {
                'x-api-key': config.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: {
                model: modelId,
                messages: [{role: 'user', content: prompt}],
                system: effectiveSystem || undefined,
                max_tokens: maxTokens ?? 4096,
                temperature: temperature ?? 0.1,
            },
            signal,
            timeoutMs,
            extract: data => {
                const content = (data as {content?: Array<{type: string; text?: string}>})?.content ?? []
                const finishReason = (data as {stop_reason?: string})?.stop_reason
                const text = content
                    .filter(c => c.type === 'text')
                    .map(c => c.text ?? '')
                    .join('\n')
                const usageData = (data as {usage?: {input_tokens?: number; output_tokens?: number}})?.usage
                const promptTokens = usageData?.input_tokens ?? 0
                const completionTokens = usageData?.output_tokens ?? 0
                return {
                    text,
                    usage: usageData ? toUsage(promptTokens, completionTokens, promptTokens + completionTokens) : undefined,
                    finishReason,
                }
            },
        })
    }
}

export class GoogleAdapter implements ProviderAdapter {
    readonly id = 'google'

    async generate(options: GenerateOptions): Promise<GenerationResult> {
        const {modelId, prompt, system, config, format, signal, timeoutMs, temperature, maxTokens} = options
        if (!config.apiKey)
            return missingApiKey(this.id, modelId)

        const cleanModel = modelId.startsWith('models/') ? modelId.slice(7) : modelId
        const baseUrl = (config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '')

        const isJson = isJsonFormat(format)
        const schema = format && typeof format === 'object' && format.type === 'json_schema' ? format.schema : undefined

        return postJson({
            providerId: this.id,
            modelId,
            url: `${baseUrl}/models/${cleanModel}:generateContent?key=${config.apiKey}`,
            body: {
                contents: [{role: 'user', parts: [{text: prompt}]}],
                generationConfig: {
                    temperature: temperature ?? 0.1,
                    maxOutputTokens: maxTokens ?? 4096,
                    ...(isJson ? {responseMimeType: 'application/json'} : {}),
                    ...(schema ? {responseJsonSchema: schema} : {}),
                },
                ...(system ? {systemInstruction: {parts: [{text: system}]}} : {}),
            },
            signal,
            timeoutMs,
            extract: data => {
                const cand = (data as {candidates?: Array<{content?: {parts?: Array<{text?: string}>}; finishReason?: string}>})?.candidates?.[0]
                const text = cand?.content?.parts?.[0]?.text ?? ''
                const meta = (data as {usageMetadata?: {promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number}})?.usageMetadata
                return {
                    text,
                    usage: meta ? toUsage(meta.promptTokenCount, meta.candidatesTokenCount, meta.totalTokenCount) : undefined,
                    finishReason: cand?.finishReason,
                }
            },
        })
    }
}

export class OllamaProvider implements ProviderAdapter {
    readonly id = 'ollama'

    async generate(options: GenerateOptions): Promise<GenerationResult> {
        const {modelId, prompt, system, config, format, signal, timeoutMs, temperature, maxTokens, contextWindow, providerOptions} = options
        const host = config.host ?? config.baseUrl ?? 'http://127.0.0.1:11434'
        const baseUrl = (host.startsWith('http') ? host : `http://${host}`).replace(/\/+$/, '')

        const isJson = isJsonFormat(format)
        const schema = format && typeof format === 'object' && format.type === 'json_schema' ? format.schema : undefined

        // Modern Ollama chat completions
        const isChatEndpoint = true
        const endpoint = isChatEndpoint ? `${baseUrl}/api/chat` : `${baseUrl}/api/generate`

        const ollamaOptions = {
            ...(config.providerOptions ?? {}),
            ...(providerOptions ?? {}),
            temperature: temperature ?? 0.1,
            num_predict: maxTokens ?? 2048,
            ...((contextWindow ?? config.contextWindow) !== undefined ? {num_ctx: contextWindow ?? config.contextWindow} : {}),
        }

        const body = isChatEndpoint
            ? {
                model: modelId,
                messages: [
                    ...(system ? [{role: 'system', content: system}] : []),
                    {role: 'user', content: prompt},
                ],
                stream: false,
                ...(schema ? {format: schema} : isJson ? {format: 'json'} : {}),
                options: ollamaOptions,
            }
            : {
                model: modelId,
                prompt,
                system,
                stream: false,
                ...(schema ? {format: schema} : isJson ? {format: 'json'} : {}),
                options: ollamaOptions,
            }

        return postJson({
            providerId: this.id,
            modelId,
            url: endpoint,
            body,
            signal,
            timeoutMs,
            extract: data => {
                const msg = (data as {message?: {content?: string}})?.message
                const text = msg?.content ?? (data as {response?: string})?.response ?? ''
                const promptTokens = (data as {prompt_eval_count?: number})?.prompt_eval_count ?? 0
                const completionTokens = (data as {eval_count?: number})?.eval_count ?? 0
                const finishReason = (data as {done_reason?: string})?.done_reason
                return {
                    text,
                    usage: toUsage(promptTokens, completionTokens, promptTokens + completionTokens),
                    finishReason,
                }
            },
        })
    }
}

interface PostJsonOptions {
    providerId: string
    modelId: string
    url: string
    headers?: Record<string, string>
    body: Record<string, unknown>
    signal?: AbortSignal
    timeoutMs?: number
    extract: (data: unknown) => {text: string; usage?: Usage; finishReason?: string}
}

async function postJson(opts: PostJsonOptions): Promise<GenerationResult> {
    const {providerId, modelId, url, headers, body, signal, timeoutMs, extract} = opts
    try {
        let effectiveSignal: AbortSignal | undefined

        if (timeoutMs && timeoutMs > 0) {
            const timeoutSignal = AbortSignal.timeout(timeoutMs)
            if (signal) {
                effectiveSignal = (AbortSignal as {any?: (signals: AbortSignal[]) => AbortSignal}).any
                    ? (AbortSignal as unknown as {any: (signals: AbortSignal[]) => AbortSignal}).any([signal, timeoutSignal])
                    : signal
            } else {
                effectiveSignal = timeoutSignal
            }
        } else if (signal) {
            effectiveSignal = signal
        }

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...headers,
            },
            body: JSON.stringify(body),
            ...(effectiveSignal ? {signal: effectiveSignal} : {}),
        })

        const rawText = await response.text()
        let parsed: unknown
        try {
            parsed = rawText ? JSON.parse(rawText) : {}
        } catch {
            parsed = rawText
        }

        if (!response.ok) {
            return {
                ok: false,
                text: '',
                model: {providerId, modelId},
                failure: parseHttpFailure(response.status, response.statusText, parsed),
                raw: parsed,
            }
        }

        const extracted = extract(parsed)
        return {
            ok: true,
            text: extracted.text,
            usage: extracted.usage,
            finishReason: extracted.finishReason,
            model: {providerId, modelId},
            raw: parsed,
        }
    } catch (err) {
        return {
            ok: false,
            text: '',
            model: {providerId, modelId},
            failure: parseThrownError(err),
            raw: err,
        }
    }
}

function parseHttpFailure(status: number, statusText: string, raw: unknown): LlmFailure {
    const rec = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
    const errRec = typeof rec.error === 'object' && rec.error !== null ? rec.error as Record<string, unknown> : {}
    const code = String(errRec.code ?? rec.code ?? '')
    const message = String(errRec.message ?? rec.message ?? rec.error ?? statusText ?? `HTTP ${status}`)

    if (status === 401 || status === 403)
        return {kind: 'authentication', message, status, code, retryable: false, fatal: true, raw}

    if (status === 429) {
        const isQuota = code === 'insufficient_quota' || /(?:quota|billing|credit)/i.test(message)
        return {
            kind: isQuota ? 'quota' : 'rate_limit',
            message,
            status,
            code,
            retryable: !isQuota,
            fatal: isQuota,
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

function parseThrownError(err: unknown): LlmFailure {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof DOMException && (err.name === 'AbortError' || err.name === 'TimeoutError'))
        return {kind: 'timeout', message, retryable: true, fatal: false, raw: err}
    return {kind: 'network', message, retryable: true, fatal: false, raw: err}
}

function missingApiKey(providerId: string, modelId: string): GenerationResult {
    return {
        ok: false,
        text: '',
        model: {providerId, modelId},
        failure: {
            kind: 'configuration',
            message: `Missing API key for ${providerId}`,
            retryable: false,
            fatal: true,
        },
    }
}

function toUsage(prompt = 0, completion = 0, total = 0): Usage {
    return {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: total || prompt + completion,
        available: true,
    }
}

function isJsonFormat(format?: ResponseFormat): boolean {
    if (!format)
        return false
    if (format === 'json')
        return true
    return typeof format === 'object' && (format.type === 'json' || format.type === 'json_schema' || Boolean(format.schema))
}

function hasDisallowedOpenAiSchema(schema: unknown): boolean {
    if (!schema || typeof schema !== 'object') return false
    const obj = schema as Record<string, unknown>
    if ('oneOf' in obj) return true
    if (obj.type === 'object' && obj.properties) {
        const props = Object.keys(obj.properties as object)
        const req = Array.isArray(obj.required) ? obj.required : []
        if (!props.every(p => req.includes(p))) return true
    }
    return Object.values(obj).some(val => typeof val === 'object' && val !== null && hasDisallowedOpenAiSchema(val))
}

function toOpenAiFormat(format?: ResponseFormat): { responseFormat?: Record<string, unknown>; fallbackSchema?: Record<string, unknown> } {
    if (!format || format === 'text')
        return {}
    if (typeof format === 'object' && format.type === 'text' && !format.schema)
        return {}
    if (format === 'json' || (typeof format === 'object' && format.type === 'json' && !format.schema))
        return {responseFormat: {type: 'json_object'}}
    if (typeof format === 'object' && (format.type === 'json_schema' || format.schema)) {
        const schema = (format.schema ?? {}) as Record<string, unknown>
        const isStrict = format.strict ?? false
        if (schema.type !== 'object' || (isStrict && hasDisallowedOpenAiSchema(schema)))
            return {responseFormat: {type: 'json_object'}, fallbackSchema: schema}
        return {
            responseFormat: {
                type: 'json_schema',
                json_schema: {
                    name: format.name ?? 'structured_response',
                    schema,
                    ...(isStrict ? {strict: true} : {}),
                },
            }
        }
    }
    return {}
}
