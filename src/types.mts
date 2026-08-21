import type {ZodType} from 'zod'

export type ProviderId = 'google' | 'openai' | 'anthropic' | 'ollama' | string

export type JsonSchema = Record<string, unknown>

export type ResponseFormat =
    | 'text'
    | 'json'
    | {type: 'text'}
    | {type: 'json'}
    | {
        type: 'json_schema'
        name?: string | undefined
        schema: JsonSchema
        strict?: boolean | undefined
    }

export interface ModelTarget {
    providerId: ProviderId
    modelId: string
}

export type LlmFailureKind =
    | 'authentication'
    | 'quota'
    | 'rate_limit'
    | 'timeout'
    | 'network'
    | 'provider'
    | 'invalid_response'
    | 'configuration'
    | 'unsupported'

export interface LlmFailure {
    kind: LlmFailureKind
    message: string
    retryable: boolean
    fatal: boolean
    status?: number | undefined
    code?: string | undefined
    raw?: unknown
}

export interface Usage {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    available: boolean
}

export interface GenerationResult<T = unknown> {
    ok: boolean
    text: string
    data?: T | undefined
    usage?: Usage | undefined
    model: ModelTarget
    failure?: LlmFailure | undefined
    raw?: unknown
    latencyMs?: number | undefined
}

export interface ProviderConfig {
    id: ProviderId
    apiKey?: string | undefined
    baseUrl?: string | undefined
    host?: string | undefined
    enabled?: boolean | undefined
    available?: boolean | undefined
    models?: ModelInfo[] | undefined
    local?: boolean | undefined
}

export interface ModelInfo {
    id: string
    providerId: ProviderId
    quality?: 'low' | 'medium' | 'high' | undefined
    local?: boolean | undefined
    sizeB?: number | null | undefined
}

export interface GenerateOptions {
    modelId: string
    prompt: string
    system?: string | undefined
    config: ProviderConfig
    format?: ResponseFormat | undefined
    temperature?: number | undefined
    signal?: AbortSignal | null | undefined
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
    model?: string | ModelTarget | undefined
    task?: string | undefined
    schema?: ZodType<T> | undefined
    system?: string | undefined
    temperature?: number | undefined
    signal?: AbortSignal | null | undefined
    maxRetries?: number | undefined
    providerConfig?: ProviderConfig | undefined
}
