import {
    AnthropicAdapter,
    GoogleAdapter,
    OllamaProvider,
    OpenAIAdapter,
} from './adapters.mjs'
import type {
    GenerateOptions,
    GenerationResult,
    ModelTarget,
    ProviderAdapter,
    ProviderConfig,
    ResponseFormat,
} from './types.mjs'

export interface CompletionOptions {
    system?: string | undefined
    temperature?: number | undefined
    format?: ResponseFormat | undefined
    signal?: AbortSignal | null | undefined
    timeoutMs?: number | undefined
}

export function builtInAdapters(): ProviderAdapter[] {
    return [
        new OpenAIAdapter(),
        new GoogleAdapter(),
        new AnthropicAdapter(),
        new OllamaProvider(),
    ]
}

export class CompletionEngine {
    private readonly adapters = new Map<string, ProviderAdapter>()

    constructor(adapters: Iterable<ProviderAdapter> = builtInAdapters()) {
        for (const adapter of adapters)
            this.registerAdapter(adapter)
    }

    registerAdapter(adapter: ProviderAdapter): this {
        this.adapters.set(adapter.id, adapter)
        return this
    }

    getRegisteredProviderIds(): string[] {
        return [...this.adapters.keys()]
    }

    async generate(
        prompt: string,
        model: ModelTarget,
        config: ProviderConfig,
        options: CompletionOptions = {},
    ): Promise<GenerationResult> {
        const adapter = this.adapters.get(model.providerId)
        if (!adapter) {
            return {
                ok: false,
                text: '',
                model,
                failure: {
                    kind: 'unsupported',
                    message: `No adapter registered for provider: ${model.providerId}`,
                    retryable: false,
                    fatal: true,
                },
            }
        }

        const generateOptions: GenerateOptions = {
            modelId: model.modelId,
            prompt,
            config,
            system: options.system,
            temperature: options.temperature,
            format: options.format,
            signal: options.signal,
            timeoutMs: options.timeoutMs,
        }

        try {
            return await adapter.generate(generateOptions)
        } catch (err) {
            return {
                ok: false,
                text: '',
                model,
                failure: {
                    kind: 'provider',
                    message: err instanceof Error ? err.message : String(err),
                    retryable: false,
                    fatal: true,
                    raw: err,
                },
            }
        }
    }
}
