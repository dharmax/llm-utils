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
    /** Actual execution locality, preserved by Asker from provider configuration. */
    local?: boolean
    /** Provider-reported or explicitly priced cost; absent means unknown. */
    costUsd?: number
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
    /** Optional caller-supplied prices. Missing prices remain unknown. */
    pricing?: import('./metrics.ts').UsagePricing
    /** Caller-declared facts, never inferred from credentials. */
    entitlements?: string[]
    /** Default context capacity where supported; Ollama maps this to num_ctx. */
    contextWindow?: number
    /** Default maximum generated tokens. Per-call values override this. */
    maxTokens?: number
    /** Default sampling temperature. Per-call values override this. */
    temperature?: number
    /** Default wall-clock timeout for one provider inference. Per-call values override this. */
    timeoutMs?: number
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
    maxOutputTokens?: number
    inputPer1M?: number
    outputPer1M?: number
    cachedInputPer1M?: number
    supportedParameters?: string[]
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

export interface TokenBudgetExtensionRequest {
    requiredTokens: number
    remainingTokens: number
    estimatedInputTokens: number
    maxOutputTokens: number
    providerId: ProviderId
    modelId: string
    local: boolean
}

export interface TokenBudget {
    /** Mutable remaining budget shared by calls in one execution scope. */
    remainingTokens: number
    /** Optional host policy hook. Return additional tokens to grant, or 0 to deny. */
    requestExtension?: (request: TokenBudgetExtensionRequest) => number | Promise<number>
}

export interface AskOptions<T = unknown> {
    model?: string | ModelTarget
    task?: string
    /** Context for situated model selection; separate from retrieval context. */
    routingContext?: {
        query?: string; role?: string; objective?: string; sessionSummary?: string;
        requirements?: string[]; expectedTurns?: number; expectedInputTokens?: number;
        expectedOutputTokens?: number; residentLocalModels?: string[] | null;
        switchingOverheadMs?: number | null;
    }
    schema?: ZodType<T>
    system?: string
    temperature?: number
    maxTokens?: number
    contextWindow?: number
    providerOptions?: Record<string, unknown>
    preferLocal?: boolean
    /** Hard provider eligibility constraint; unlike preferLocal this cannot be bypassed. */
    allowedProviders?: string[]
    signal?: AbortSignal
    timeoutMs?: number
    /** Hard serialized input-size guard; independent of token accounting. */
    maxInputBytes?: number
    /** Shared cumulative inference budget for this execution scope. */
    tokenBudget?: TokenBudget
    maxRetries?: number
    providerConfig?: ProviderConfig
    context?: ContextRequest | ContextResolver
    metrics?: MetricsContext
    metricsSink?: MetricsSink
}
