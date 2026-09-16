import type {ZodType} from 'zod'

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
}

export interface ModelInfo {
    id: string
    providerId: ProviderId
    quality?: 'low' | 'medium' | 'high'
    local?: boolean
    sizeB?: number
}

export interface GenerateOptions {
    modelId: string
    prompt: string
    system?: string
    config: ProviderConfig
    format?: ResponseFormat
    temperature?: number
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
    preferLocal?: boolean
    signal?: AbortSignal
    timeoutMs?: number
    maxRetries?: number
    providerConfig?: ProviderConfig
}
