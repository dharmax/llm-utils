import type {ZodType} from 'zod'
import {CompletionEngine} from './completion.mts'
import {type ContextRequest, type ContextResolver, resolveContext} from './context.mts'
import {PromptEngine} from './prompts.mts'
import {ProviderCircuit} from './provider-circuit.mts'
import {ModelRouter} from './routing.mts'
import {
    parseStructuredJsonResult,
    resolveResponseFormat,
} from './structured-json.mts'
import type {
    AskOptions,
    GenerationResult,
    ModelTarget,
    ProviderConfig,
    ProviderId,
} from './types.mts'

export interface AskerOptions {
    providers?: Record<string, ProviderConfig> | ProviderConfig[] | undefined
    providerState?: {providers: Record<string, ProviderConfig>} | undefined
    router?: ModelRouter | undefined
    routes?: Record<string, string | ModelTarget> | undefined
    completion?: CompletionEngine | undefined
    promptEngine?: PromptEngine | undefined
    context?: ContextResolver | undefined
    circuit?: ProviderCircuit | undefined
}

export class Asker {
    private readonly providers = new Map<ProviderId, ProviderConfig>()
    private readonly completion: CompletionEngine
    private readonly promptEngine: PromptEngine
    private readonly router: ModelRouter
    private readonly circuit: ProviderCircuit
    private readonly defaultContext: ContextResolver | undefined

    constructor(options: AskerOptions = {}) {
        this.completion = options.completion ?? new CompletionEngine()
        this.promptEngine = options.promptEngine ?? new PromptEngine()
        this.circuit = options.circuit ?? new ProviderCircuit()
        this.defaultContext = options.context

        // Configure router
        this.router = options.router ?? new ModelRouter({
            routes: options.routes,
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
            const discovered: Record<string, ProviderConfig> = {
                ollama: {
                    id: 'ollama',
                    host: env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
                    available: true,
                    local: true,
                },
                openai: {
                    id: 'openai',
                    apiKey: env.OPENAI_API_KEY,
                    baseUrl: env.OPENAI_BASE_URL,
                    available: Boolean(env.OPENAI_API_KEY),
                },
                google: {
                    id: 'google',
                    apiKey: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY,
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
        const available = [...this.providers.keys()]
        const target = this.router.resolve(options.model ?? options.task, available)
        const config = options.providerConfig
            ?? this.providers.get(target.providerId)
            ?? {id: target.providerId}

        const format = options.schema
            ? resolveResponseFormat(options.schema)
            : undefined

        const executeCall = async (callPrompt: string): Promise<GenerationResult<T>> => {
            const res = await this.circuit.execute(target, () => this.completion.generate(
                callPrompt,
                target,
                config,
                {
                    system: options.system,
                    temperature: options.temperature,
                    format,
                    signal: options.signal,
                },
            ))
            return res as GenerationResult<T>
        }

        const initial = await executeCall(prompt)
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
            const correctionPrompt = `${prompt}\n\nPrevious response failed validation:\n${lastError}\nPlease output the correct JSON matching the required schema.`
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
     * Loads a prompt template, resolves context injection, renders variables, and executes the request.
     */
    async prompt<T = unknown>(
        templateName: string,
        data: Record<string, unknown> = {},
        options: AskOptions<T> & {context?: ContextResolver | undefined} = {},
    ): Promise<GenerationResult<T>> {
        const {content, manifest} = await this.promptEngine.load(templateName)
        const variables = {...data}

        // Context injection
        const contextResolver = options.context ?? this.defaultContext
        if (contextResolver) {
            const request: ContextRequest = {
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
