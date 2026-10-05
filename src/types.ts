import type {ZodType} from 'zod'
import type {ContextRequest, ContextResolver} from './context.ts'
import type {MetricsContext, MetricsSink} from './metrics.ts'

export type ProviderId = string

export type JsonSchema = Record<string, unknown>

export type ResponseFormat =
    | 'text'
    | 'json'
    | {
        type?: 'text' | 'json' | 'json_schema'
        name?: string
        schema?: JsonSchema
        strict?: boolean
    }

export interface ModelTarget {
    providerId: ProviderId
    modelId: string
}

export interface LlmFailure {
    kind:
        | 'authentication'
        | 'quota'
        | 'rate_limit'
        | 'timeout'
        | 'network'
        | 'provider'
        | 'invalid_response'
        | 'configuration'
        | 'unsupported'
    message: string
    retryable: boolean
    fatal: boolean
    status?: number
    code?: string
    raw?: unknown
}

export type GenerationFailure = LlmFailure

export interface Usage {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    available: boolean
}

export interface GenerationResult<T = unknown> {
    ok: boolean
    text: string
    data?: T
    usage?: Usage
    model: ModelTarget
    failure?: LlmFailure
    /** Provider-reported normal termination reason, e.g. stop/length. */
    finishReason?: string
    raw?: unknown
    latencyMs?: number
}

export interface ProviderConfig {
    id: ProviderId
    apiKey?: string
    baseUrl?: string
    host?: string
    enabled?: boolean
    available?: boolean
    models?: ModelInfo[]
    local?: boolean
    /** Caller-declared facts, never inferred from credentials. */
    entitlements?: string[]
    /** Default context capacity where supported; Ollama maps this to num_ctx. */
    contextWindow?: number
    /** Default maximum generated tokens. Per-call values override this. */
    maxTokens?: number
    /** Default sampling temperature. Per-call values override this. */
    temperature?: number
    /** Provider-specific defaults. Adapters interpret these without llm-utils inventing a universal taxonomy. */
    providerOptions?: Record<string, unknown>
}

export interface ModelInfo {
    id: string
    providerId: ProviderId
    quality?: 'low' | 'medium' | 'high'
    local?: boolean
    sizeB?: number
    parameterSize?: string
    quantization?: string
    family?: string
    architecture?: string
    contextWindow?: number
}

export interface GenerateOptions {
    modelId: string
    prompt: string
    system?: string
    config: ProviderConfig
    format?: ResponseFormat
    temperature?: number
    maxTokens?: number
    contextWindow?: number
    providerOptions?: Record<string, unknown>
    signal?: AbortSignal
    timeoutMs?: number
}

export interface ProviderAdapter {
    readonly id: ProviderId
    generate(options: GenerateOptions): Promise<GenerationResult>
}

export interface PromptTemplate {
    content: string
    manifest: Record<string, unknown>
}

export interface AskOptions<T = unknown> {
    model?: string | ModelTarget
    task?: string
    schema?: ZodType<T>
    system?: string
    temperature?: number
    maxTokens?: number
    contextWindow?: number
    providerOptions?: Record<string, unknown>
    preferLocal?: boolean
    signal?: AbortSignal
    timeoutMs?: number
    maxRetries?: number
    providerConfig?: ProviderConfig
    context?: ContextRequest | ContextResolver
    metrics?: MetricsContext
    metricsSink?: MetricsSink
}
