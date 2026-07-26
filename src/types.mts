import type {CompletionOptions} from './completion.mjs'
import type {PromptEngine} from './prompts.mjs'

export type ProviderId = 'google' | 'openai' | 'anthropic' | 'ollama' | string

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

export interface ModelCapabilities {
    logic: number
    strategy: number
    prose: number
    visual: number
    creative: number
    data: number
}

export interface ModelInfo {
    id: string
    providerId: ProviderId
    fitScore?: number
    fitReasons?: string[]
    quality?: 'low' | 'medium' | 'high'
    costTier?: number
    sizeB?: number | null
    capabilities?: Partial<ModelCapabilities>
    local?: boolean
}

export interface TaskType {
    id: string
    shortName?: string
    description?: string
    desc?: string
    weights: Partial<ModelCapabilities>
}

export interface InteractionTurn {
    prompt: string
    system?: string
    format?: 'text' | 'json'
    modelId?: string
    providerId?: ProviderId
    signal?: AbortSignal | null
}

export interface Usage {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    available: boolean
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
    status?: number
    code?: string
    raw?: unknown
}

export interface GenerationResult {
    text: string
    ok: boolean
    usage?: Usage
    model: {
        providerId: ProviderId
        modelId: string
    }
    failure?: LlmFailure
    /** @deprecated Use failure.message. Retained for 0.1 consumers. */
    error?: string
    /** @deprecated Use failure.message. Retained for 0.1 consumers. */
    err?: string
    raw?: unknown
    latencyMs?: number
    response?: string
    res?: string
}

export interface SessionContext {
    history: Array<{role: 'user' | 'ai'; content: string}>
    managedContext?: string
    metrics?: unknown
}

export interface PromptTemplate {
    content: string
    manifest: Record<string, unknown>
}

export interface SystemStatus {
    ok: boolean
    details?: string
    leanCtx?: unknown
}

export interface ProviderKnowledge {
    models?: Record<string, ModelInfo[]>
    heuristics?: Record<string, {keywords: string[]}>
    [key: string]: unknown
}

export interface ProviderState {
    providers: Record<string, ProviderConfig>
    routingPolicy?: unknown
    knowledge?: ProviderKnowledge
}

export interface CompletionClient {
    generate(
        prompt: string,
        model: ModelInfo,
        config: ProviderConfig,
        options?: CompletionOptions,
    ): Promise<GenerationResult>
    getRegisteredProviderIds(): string[]
}

export interface AskerOptions {
    providerState: ProviderState
    promptEngine?: PromptEngine
    completion?: CompletionClient
}

export interface ProviderAdapter {
    readonly id: ProviderId
    generate(options: GenerateOptions): Promise<GenerationResult>
}

export interface InteractionProvider {
    readonly id: ProviderId
    generate(turn: InteractionTurn, config: ProviderConfig): Promise<GenerationResult>
}

export interface GenerateOptions {
    modelId: string
    prompt: string
    system?: string
    config: ProviderConfig
    format?: 'text' | 'json'
    temperature?: number
    signal?: AbortSignal | null
}
