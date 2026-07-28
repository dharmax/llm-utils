import {
    AnthropicAdapter,
    GoogleAdapter,
    OllamaProvider,
    OpenAIAdapter,
} from './adapters.mts'
import type {
    GenerateOptions,
    GenerationResult,
    LlmFailure,
    ModelInfo,
    ProviderAdapter,
    ProviderConfig,
    ResponseFormat,
} from './types.mts'

export interface CompletionOptions {
    system?: string
    temperature?: number
    format?: ResponseFormat
    signal?: AbortSignal | null
}

export function builtInAdapters(): ProviderAdapter[] {
    return [
        new OllamaProvider(),
        new OpenAIAdapter(),
        new GoogleAdapter(),
        new AnthropicAdapter(),
    ]
}

/** Dispatches generation to instance-owned provider adapters. */
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
        model: ModelInfo,
        config: ProviderConfig,
        options: CompletionOptions = {},
    ): Promise<GenerationResult> {
        const adapter = this.adapters.get(model.providerId)
        if (!adapter)
            return failedGeneration(model, {
                kind: 'unsupported',
                message: `Unsupported provider for completion: ${model.providerId}`,
                retryable: false,
                fatal: true,
            })

        const generateOptions: GenerateOptions = {
            modelId: model.id,
            prompt,
            config,
            ...(options.system === undefined ? {} : {system: options.system}),
            ...(options.temperature === undefined ? {} : {temperature: options.temperature}),
            ...(options.format === undefined ? {} : {format: options.format}),
            ...(options.signal === undefined ? {} : {signal: options.signal}),
        }

        try {
            return await adapter.generate(generateOptions)
        } catch (cause) {
            return failedGeneration(model, {
                kind: 'provider',
                message: `Adapter failed unexpectedly: ${errorMessage(cause)}`,
                retryable: false,
                fatal: true,
                raw: cause,
            })
        }
    }
}

function failedGeneration(model: ModelInfo, failure: LlmFailure): GenerationResult {
    return {
        text: '',
        ok: false,
        failure,
        error: failure.message,
        err: failure.message,
        model: {
            providerId: model.providerId,
            modelId: model.id,
        },
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
