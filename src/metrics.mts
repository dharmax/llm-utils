import {PubSub} from '@dharmax/pubsub'
import type {GenerationResult, Usage} from './types.mjs'

export interface LlmMetricEvent {
    timestamp: string
    providerId: string
    modelId: string
    promptTokens: number
    completionTokens: number
    totalTokens: number
    latencyMs: number
    success: boolean
    error?: string | null
    taskClass?: string
    costUsd?: number | null
    metadata?: Record<string, unknown>
}

export interface MetricsQuery {
    from?: string
    to?: string
    providerId?: string
    modelId?: string
    taskClass?: string
    success?: boolean
    limit?: number | null
    order?: 'asc' | 'desc'
}

export interface AggregateMetrics {
    calls: number
    successes: number
    failures: number
    successRate: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
    totalLatencyMs: number
    avgLatencyMs: number
    avgPromptTokens: number
    avgCompletionTokens: number
    avgTotalTokens: number
    totalCostUsd: number
    avgCostUsd: number
}

export interface UsagePricing {
    inputCostPerMillionTokensUsd?: number
    outputCostPerMillionTokensUsd?: number
}

export class InMemoryMetricsStore {
    private events: LlmMetricEvent[] = []

    constructor(options: {initialEvents?: LlmMetricEvent[]; maxEvents?: number | null} = {}) {
        if (options.initialEvents)
            this.events = [...options.initialEvents]
    }

    append(event: LlmMetricEvent): void {
        this.events.push({...event})
    }

    query(query: MetricsQuery = {}): LlmMetricEvent[] {
        const fromMs = query.from ? Date.parse(query.from) : null
        const toMs = query.to ? Date.parse(query.to) : null
        const order = query.order ?? 'desc'

        let rows = this.events.filter(event => {
            const eventMs = Date.parse(event.timestamp)
            if (fromMs !== null && eventMs < fromMs)
                return false
            if (toMs !== null && eventMs > toMs)
                return false
            if (query.providerId && event.providerId !== query.providerId)
                return false
            if (query.modelId && event.modelId !== query.modelId)
                return false
            if (query.taskClass && event.taskClass !== query.taskClass)
                return false
            if (typeof query.success === 'boolean' && event.success !== query.success)
                return false
            return true
        })

        rows.sort((a, b) => {
            const delta = Date.parse(a.timestamp) - Date.parse(b.timestamp)
            return order === 'asc' ? delta : -delta
        })

        if (typeof query.limit === 'number' && query.limit >= 0)
            rows = rows.slice(0, query.limit)

        return rows.map(r => ({...r}))
    }
}

export class LlmMetrics {
    readonly store: InMemoryMetricsStore
    readonly bus: PubSub | null
    readonly origin: string

    constructor(store = new InMemoryMetricsStore(), options: {bus?: PubSub | null; origin?: string} = {}) {
        this.store = store
        this.bus = options.bus ?? null
        this.origin = options.origin ?? 'llm-metrics'
    }

    record(event: Omit<LlmMetricEvent, 'totalTokens'> & {totalTokens?: number}): LlmMetricEvent {
        const promptTokens = Math.max(0, Number(event.promptTokens ?? 0))
        const completionTokens = Math.max(0, Number(event.completionTokens ?? 0))
        const totalTokens = Number.isFinite(event.totalTokens)
            ? Math.max(0, Number(event.totalTokens))
            : promptTokens + completionTokens

        const normalized: LlmMetricEvent = {
            timestamp: event.timestamp || new Date().toISOString(),
            providerId: String(event.providerId),
            modelId: String(event.modelId),
            promptTokens,
            completionTokens,
            totalTokens,
            latencyMs: Math.max(0, Number(event.latencyMs ?? 0)),
            success: Boolean(event.success),
            error: event.error ?? null,
            ...(event.taskClass ? {taskClass: event.taskClass} : {}),
            costUsd: Number.isFinite(event.costUsd) ? Number(event.costUsd) : 0,
            ...(event.metadata ? {metadata: {...event.metadata}} : {}),
        }

        this.store.append(normalized)
        this.bus?.trigger(this.origin, 'metrics:recorded', normalized)
        return normalized
    }

    list(query: MetricsQuery = {}): LlmMetricEvent[] {
        return this.store.query(query)
    }

    totals(query: MetricsQuery = {}): AggregateMetrics {
        const events = this.list(query)
        if (events.length === 0)
            return emptyAggregate()

        let totalPrompt = 0
        let totalCompletion = 0
        let totalTokens = 0
        let totalLatency = 0
        let totalCost = 0
        let successes = 0
        let failures = 0

        for (const e of events) {
            if (e.success)
                successes += 1
            else
                failures += 1
            totalPrompt += e.promptTokens
            totalCompletion += e.completionTokens
            totalTokens += e.totalTokens
            totalLatency += e.latencyMs
            totalCost += e.costUsd ?? 0
        }

        const calls = events.length
        return {
            calls,
            successes,
            failures,
            successRate: Math.round((successes / calls) * 10000) / 100,
            promptTokens: totalPrompt,
            completionTokens: totalCompletion,
            totalTokens,
            totalLatencyMs: totalLatency,
            avgLatencyMs: Math.round(totalLatency / calls),
            avgPromptTokens: Math.round(totalPrompt / calls),
            avgCompletionTokens: Math.round(totalCompletion / calls),
            avgTotalTokens: Math.round(totalTokens / calls),
            totalCostUsd: totalCost,
            avgCostUsd: Math.round((totalCost / calls) * 1_000_000) / 1_000_000,
        }
    }

    byProvider(query: MetricsQuery = {}): Array<{providerId: string; metrics: AggregateMetrics}> {
        const events = this.list(query)
        const groups = new Map<string, LlmMetricEvent[]>()
        for (const e of events) {
            const list = groups.get(e.providerId) ?? []
            list.push(e)
            groups.set(e.providerId, list)
        }
        return [...groups.entries()].map(([providerId, evts]) => {
            const sub = new LlmMetrics(new InMemoryMetricsStore({initialEvents: evts}))
            return {providerId, metrics: sub.totals()}
        })
    }

    byModel(query: MetricsQuery = {}): Array<{providerId: string; modelId: string; metrics: AggregateMetrics}> {
        const events = this.list(query)
        const groups = new Map<string, LlmMetricEvent[]>()
        for (const e of events) {
            const key = `${e.providerId}::${e.modelId}`
            const list = groups.get(key) ?? []
            list.push(e)
            groups.set(key, list)
        }
        return [...groups.entries()].map(([key, evts]) => {
            const [providerId, modelId] = key.split('::')
            const sub = new LlmMetrics(new InMemoryMetricsStore({initialEvents: evts}))
            return {providerId: providerId ?? '', modelId: modelId ?? '', metrics: sub.totals()}
        })
    }
}

export class MetricsEngine {
    readonly metrics: LlmMetrics

    constructor(store = new InMemoryMetricsStore()) {
        this.metrics = new LlmMetrics(store)
    }

    record(result: GenerationResult, latencyMs: number, pricing?: UsagePricing): void {
        if (!result.ok || !result.usage)
            return
        this.metrics.record({
            timestamp: new Date().toISOString(),
            providerId: result.model.providerId,
            modelId: result.model.modelId,
            promptTokens: result.usage.promptTokens,
            completionTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
            latencyMs,
            success: result.ok,
            error: result.failure?.message ?? null,
            costUsd: calculateUsageCost(result.usage, pricing),
        })
    }

    getReport(): Record<string, number> {
        const totals = this.metrics.totals()
        return {
            turnCount: totals.calls,
            totalPromptTokens: totals.promptTokens,
            totalCompletionTokens: totals.completionTokens,
            totalTokens: totals.totalTokens,
            totalLatencyMs: totals.totalLatencyMs,
            averageLatencyMs: totals.avgLatencyMs,
            estimatedCostUsd: totals.totalCostUsd,
        }
    }
}

export function createMetricsPubSub(name = 'LLM Metrics'): PubSub {
    return new PubSub(name)
}

export function calculateUsageCost(usage?: Usage, pricing?: UsagePricing): number {
    if (!usage || !pricing)
        return 0
    const inCost = (usage.promptTokens / 1_000_000) * (pricing.inputCostPerMillionTokensUsd ?? 0)
    const outCost = (usage.completionTokens / 1_000_000) * (pricing.outputCostPerMillionTokensUsd ?? 0)
    return inCost + outCost
}

function emptyAggregate(): AggregateMetrics {
    return {
        calls: 0,
        successes: 0,
        failures: 0,
        successRate: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        totalLatencyMs: 0,
        avgLatencyMs: 0,
        avgPromptTokens: 0,
        avgCompletionTokens: 0,
        avgTotalTokens: 0,
        totalCostUsd: 0,
        avgCostUsd: 0,
    }
}
