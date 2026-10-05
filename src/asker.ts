import {createHash} from 'node:crypto'
import type {ZodType} from 'zod'
import {CompletionEngine} from './completion.ts'
import {type ContextRequest, type ContextResolver, resolveContext} from './context.ts'
import {FileTemplateSource, PromptEngine} from './prompts.ts'
import {ProviderCircuit} from './provider-circuit.ts'
import {ModelRouter, parseModelTarget} from './routing.ts'
import {ProviderDiscovery} from './discovery.ts'
import {childMetricsContext, emitMetric, type MetricsSink} from './metrics.ts'
import {
    parseStructuredJsonResult,
    resolveResponseFormat,
} from './structured-json.ts'
import type {
    AskOptions,
    GenerationResult,
    ModelTarget,
    ProviderConfig,
    ProviderId,
} from './types.ts'

function providerOptionsEvidence(config: ProviderConfig, callOptions?: Record<string, unknown>): {keys: string[]; hash?: string} {
    const merged = {...(config.providerOptions ?? {}), ...(callOptions ?? {})}
    const keys = Object.keys(merged).sort()
    if (!keys.length)
        return {keys}
    const canonical = JSON.stringify(Object.fromEntries(keys.map(key => [key, merged[key]])))
    return {keys, hash: createHash('sha256').update(canonical).digest('hex')}
}

export interface AskerOptions {
    providers?: Record<string, ProviderConfig> | ProviderConfig[]
    providerState?: {providers: Record<string, ProviderConfig>}
    router?: ModelRouter
    routes?: Record<string, string | ModelTarget>
    defaultModel?: string | ModelTarget
    preferLocal?: boolean
    completion?: CompletionEngine
    promptEngine?: PromptEngine
    promptsDir?: string | URL
    context?: ContextResolver
    contextResolver?: ContextResolver
    circuit?: ProviderCircuit
    metricsSink?: MetricsSink
    advicePath?: string | false
}

export class Asker {
    private readonly providers = new Map<ProviderId, ProviderConfig>()
    private readonly completion: CompletionEngine
    private readonly promptEngine: PromptEngine
    private readonly router: ModelRouter
    private readonly circuit: ProviderCircuit
    private readonly defaultContext?: ContextResolver
    private readonly preferLocal: boolean
    private readonly metricsSink?: MetricsSink

    constructor(options: AskerOptions = {}) {
        this.completion = options.completion ?? new CompletionEngine()
        this.promptEngine = options.promptEngine ?? (options.promptsDir ? new PromptEngine(new FileTemplateSource(options.promptsDir)) : new PromptEngine())
        this.circuit = options.circuit ?? new ProviderCircuit()
        this.defaultContext = options.contextResolver ?? options.context
        this.preferLocal = Boolean(options.preferLocal)
        this.metricsSink = options.metricsSink

        // Configure router
        this.router = options.router ?? new ModelRouter({
            routes: options.routes,
            defaultModel: options.defaultModel,
            preferLocal: this.preferLocal,
            advicePath: options.advicePath,
        })

        // Configure providers (with environment variable auto-discovery)
        const explicit = options.providers
            ? Array.isArray(options.providers)
                ? Object.fromEntries(options.providers.map(p => [p.id, p]))
                : options.providers
            : options.providerState?.providers

        if (explicit) {
            for (const [id, config] of Object.entries(explicit))
                this.providers.set(id, config)
        } else {
            // Synchronous discovery from process.env
            const env = typeof process !== 'undefined' ? process.env : {}
            const rawHost = env.OLLAMA_HOST ?? env.LOCAL_LLM_URL ?? 'http://127.0.0.1:11434'
            const ollamaHost = rawHost.startsWith('http://') || rawHost.startsWith('https://')
                ? rawHost
                : `http://${rawHost}`
            const discovered: Record<string, ProviderConfig> = {
                ollama: {
                    id: 'ollama',
                    host: ollamaHost,
                    available: true,
                    local: true,
                },
                openai: {
                    id: 'openai',
                    apiKey: env.OPENAI_API_KEY,
                    baseUrl: env.OPENAI_BASE_URL,
                    available: Boolean(env.OPENAI_API_KEY || env.OPENAI_BASE_URL),
                },
                google: {
                    id: 'google',
                    apiKey: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY,
                    baseUrl: env.GEMINI_BASE_URL,
                    available: Boolean(env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY),
                },
                anthropic: {
                    id: 'anthropic',
                    apiKey: env.ANTHROPIC_API_KEY,
                    baseUrl: env.ANTHROPIC_BASE_URL,
                    available: Boolean(env.ANTHROPIC_API_KEY),
                },
            }
            for (const [id, config] of Object.entries(discovered)) {
                if (config.available)
                    this.providers.set(id, config)
            }
        }
    }

    setProvider(config: ProviderConfig): this {
        this.providers.set(config.id, config)
        return this
    }

    getProvider(id: ProviderId): ProviderConfig | undefined {
        return this.providers.get(id)
    }

    getPromptEngine(): PromptEngine {
        return this.promptEngine
    }

    getCompletion(): CompletionEngine {
        return this.completion
    }

    getRouter(): ModelRouter {
        return this.router
    }

    /**
     * Executes a direct prompt with automatic model routing and optional typed Zod schema validation.
     */
    async ask<T = unknown>(
        prompt: string,
        options: AskOptions<T> = {},
    ): Promise<GenerationResult<T>> {
        const current = Object.fromEntries(this.providers)
        if (!options.model && this.router.needsLocalAdviceCheck(options.task) && current.ollama && current.ollama.enabled !== false && current.ollama.available !== false) {
            const probe = await ProviderDiscovery.probeOllama(current.ollama.host)
            current.ollama = {...current.ollama, available: probe.installed, models: probe.models}
        }
        const available = Object.entries(current).filter(([, config]) => config.available !== false && config.enabled !== false).map(([id]) => id)
        const target = this.router.resolve(
            options.model ? parseModelTarget(options.model) : options.task,
            available,
            options.preferLocal ?? this.preferLocal,
            current,
        )
        const config = options.providerConfig
            ?? this.providers.get(target.providerId)
            ?? {id: target.providerId}

        const format = options.schema
            ? resolveResponseFormat(options.schema)
            : undefined

        let attempt = 0
        const executeCall = async (callPrompt: string): Promise<GenerationResult<T>> => {
            attempt += 1
            const started = performance.now()
            const parentMetrics = options.metrics
            const callMetrics = parentMetrics ? childMetricsContext(parentMetrics) : undefined
            const providerEvidence = providerOptionsEvidence(config, options.providerOptions)
            const maxTokens = options.maxTokens ?? config.maxTokens
            const temperature = options.temperature ?? config.temperature
            const contextWindow = options.contextWindow ?? config.contextWindow
            const res = await this.circuit.execute(target, () => this.completion.generate(
                callPrompt,
                target,
                config,
                {
                    system: options.system,
                    temperature,
                    maxTokens,
                    contextWindow,
                    providerOptions: options.providerOptions,
                    format,
                    signal: options.signal,
                    timeoutMs: options.timeoutMs,
                },
            )) as GenerationResult<T>
            const usage = res.usage
            emitMetric(options.metricsSink ?? this.metricsSink, {
                kind: 'llm',
                timestamp: new Date().toISOString(),
                providerId: target.providerId,
                modelId: target.modelId,
                promptTokens: usage?.promptTokens ?? 0,
                completionTokens: usage?.completionTokens ?? 0,
                totalTokens: usage?.totalTokens ?? 0,
                latencyMs: performance.now() - started,
                success: res.ok,
                error: res.failure?.message,
                failureKind: res.failure?.kind,
                finishReason: res.finishReason,
                taskClass: callMetrics?.taskClass ?? options.task,
                traceId: callMetrics?.traceId,
                spanId: callMetrics?.spanId,
                parentSpanId: callMetrics?.parentSpanId,
                tags: callMetrics?.tags,
                attempt,
                metadata: {
                    ...(maxTokens !== undefined ? {maxTokens} : {}),
                    ...(temperature !== undefined ? {temperature} : {}),
                    ...(contextWindow !== undefined ? {contextWindow} : {}),
                    ...(providerEvidence.keys.length ? {providerOptionKeys: providerEvidence.keys, providerOptionsHash: providerEvidence.hash} : {}),
                },
            })
            return res
        }

        let effectivePrompt = prompt
        const reqContext = options.context
        const activeResolver = (typeof reqContext === 'function' || (reqContext && 'resolve' in reqContext))
            ? (reqContext as ContextResolver)
            : this.defaultContext

        if (activeResolver) {
            const req: ContextRequest = (reqContext && typeof reqContext === 'object' && 'query' in reqContext)
                ? reqContext as ContextRequest
                : {query: prompt}
            const contextText = await resolveContext(activeResolver, req)
            if (contextText) {
                effectivePrompt = `## Retrieved Context\n${contextText}\n\n## Question\n${prompt}`
            }
        }

        const initial = await executeCall(effectivePrompt)
        if (!initial.ok || !options.schema)
            return initial

        // Parse and validate structured JSON
        const parsed = parseStructuredJsonResult(initial.text, options.schema)
        if (parsed.ok)
            return {...initial, data: parsed.data}

        // Bounded corrective retry if requested
        const maxRetries = Math.max(0, options.maxRetries ?? 0)
        let lastResult = initial
        let lastError = parsed.message

        for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
            const correctionPrompt = `${effectivePrompt}\n\nPrevious response failed validation:\n${lastError}\nPlease output the correct JSON matching the required schema.`
            const retryRes = await executeCall(correctionPrompt)
            if (!retryRes.ok)
                return retryRes

            const retryParsed = parseStructuredJsonResult(retryRes.text, options.schema)
            if (retryParsed.ok)
                return {...retryRes, data: retryParsed.data}

            lastResult = retryRes
            lastError = retryParsed.message
        }

        return {
            ...lastResult,
            ok: false,
            failure: {
                kind: 'invalid_response',
                message: `JSON schema validation failed: ${lastError}`,
                retryable: false,
                fatal: false,
            },
        }
    }

    /**
     * Convenience method for typed structured JSON generation.
     */
    async json<T>(
        prompt: string,
        schema: ZodType<T>,
        options: Omit<AskOptions<T>, 'schema'> = {},
    ): Promise<GenerationResult<T>> {
        return this.ask(prompt, {...options, schema})
    }

    /**
     * Convenience method for local-only execution (defaults to Ollama / local models).
     */
    async local<T = unknown>(
        prompt: string,
        options: AskOptions<T> = {},
    ): Promise<GenerationResult<T>> {
        return this.ask(prompt, {...options, preferLocal: true})
    }

    /**
     * Loads a prompt template, resolves context injection, renders variables, and executes the request.
     */
    async prompt<T = unknown>(
        templateName: string,
        data: Record<string, unknown> = {},
        options: AskOptions<T> & {contextResolver?: ContextResolver} = {},
    ): Promise<GenerationResult<T>> {
        const {content, manifest} = await this.promptEngine.load(templateName)
        const variables = {...data}

        // Context injection
        const reqContext = options.context
        const contextResolver = (typeof reqContext === 'function' || (reqContext && 'resolve' in reqContext))
            ? (reqContext as ContextResolver)
            : (options.contextResolver ?? this.defaultContext)

        if (contextResolver) {
            const request: ContextRequest = (reqContext && typeof reqContext === 'object' && 'query' in reqContext)
                ? (reqContext as ContextRequest)
                : {
                    query: String(data.inputText ?? data.prompt ?? data.query ?? ''),
                    taskType: options.task ?? (typeof manifest.taskType === 'string' ? manifest.taskType : undefined),
                    history: Array.isArray(data.history) ? data.history : undefined,
                }
            const contextText = await resolveContext(contextResolver, request)
            if (contextText)
                variables.context = contextText
        }

        const renderedPrompt = this.promptEngine.render(content, variables)
        const system = options.system ?? (typeof manifest.system === 'string' ? manifest.system : undefined)

        return this.ask(renderedPrompt, {
            ...options,
            system,
        })
    }

    /**
     * Convenience method for template-based typed structured JSON generation.
     */
    async promptJson<T>(
        templateName: string,
        data: Record<string, unknown>,
        schema: ZodType<T>,
        options: Omit<AskOptions<T>, 'schema'> = {},
    ): Promise<GenerationResult<T>> {
        return this.prompt(templateName, data, {...options, schema})
    }
}
