import type {ModelTarget, ProviderConfig, ProviderId} from './types.ts'
import {isAdviceUsable, readModelAdvice, type ModelAdviceSnapshot} from './model-advice.ts'

export interface TaskRouteMap {
    [task: string]: string | ModelTarget
}

export type CustomRouterFn = (task: string, availableProviders: string[]) => ModelTarget | string | undefined

export interface ModelRouterOptions {
    routes?: TaskRouteMap
    router?: CustomRouterFn
    preferLocal?: boolean
    defaultModel?: string | ModelTarget
    /** Defaults to the user-level snapshot. false disables advice. */
    advicePath?: string | false
    /** Supply current model lists for synchronous availability validation. */
    providers?: Record<string, ProviderConfig>
}

export const DEFAULT_TASK_ROUTES: TaskRouteMap = {
    'code': 'openai/gpt-4o',
    'fast': 'google/gemini-2.0-flash',
    'reasoning': 'openai/o3-mini',
    'creative': 'anthropic/claude-3-7-sonnet',
    'summarization': 'google/gemini-2.0-flash',
    'local': 'ollama/qwen2.5-coder:7b',
    'default': 'google/gemini-2.0-flash',
}

export class ModelRouter {
    private readonly routes: TaskRouteMap
    private readonly customRouter?: CustomRouterFn
    private readonly defaultModel: ModelTarget
    private readonly preferLocal: boolean
    private readonly explicitRoutes: TaskRouteMap
    private readonly configuredDefault: boolean
    private readonly advicePath?: string | false
    private readonly providers?: Record<string, ProviderConfig>

    constructor(options: ModelRouterOptions = {}) {
        this.routes = {...DEFAULT_TASK_ROUTES, ...options.routes}
        this.explicitRoutes = {...options.routes}
        this.configuredDefault = options.defaultModel !== undefined || options.routes?.default !== undefined
        this.advicePath = options.advicePath
        this.providers = options.providers
        this.customRouter = options.router
        this.preferLocal = Boolean(options.preferLocal)
        this.defaultModel = parseModelTarget(
            options.defaultModel
            ?? options.routes?.default
            ?? DEFAULT_TASK_ROUTES.default
            ?? 'google/gemini-2.0-flash',
        )
    }

    /**
     * Resolves a task or model name to a concrete ModelTarget given available providers.
     */
    resolve(
        targetOrTask?: string | ModelTarget,
        availableProviders: string[] = this.providers ? Object.keys(this.providers) : ['google', 'openai', 'anthropic', 'ollama'],
        preferLocalOverride?: boolean,
        providers = this.providers,
    ): ModelTarget {
        const useLocal = preferLocalOverride !== undefined ? preferLocalOverride : this.preferLocal

        if (typeof targetOrTask === 'object' && targetOrTask.providerId && targetOrTask.modelId)
            return targetOrTask

        const targetStr = targetOrTask ? String(targetOrTask).trim() : ''

        // 1. Direct provider/model string (e.g. 'openai/gpt-4o' or 'ollama/llama3.2')
        if (targetStr.includes('/'))
            return parseModelTarget(targetStr)

        const snapshot = this.getModelAdvice()
        // Known task keys are tasks; other recognizable bare model names are explicit selections.
        if (targetStr && !this.routes[targetStr] && !snapshot?.workloads[targetStr]) {
            const inferred = inferProviderFromModelName(targetStr)
            if (inferred) return {providerId: inferred, modelId: targetStr}
        }

        // 2. Custom router hook
        if (targetStr && this.customRouter) {
            const custom = this.customRouter(targetStr, availableProviders)
            if (custom)
                return typeof custom === 'string' ? parseModelTarget(custom) : custom
        }

        // 3. Explicit task routes outrank preferences.
        const configured = this.explicitRoutes[targetStr || 'default']
            ?? (!targetStr && this.configuredDefault ? this.defaultModel : undefined)
        if (configured) {
            const mapped = configured
            const parsed = typeof mapped === 'string' ? parseModelTarget(mapped) : mapped
            if (availableProviders.length === 0 || availableProviders.includes(parsed.providerId))
                return parsed
        }

        const advice = snapshot?.workloads[targetStr || 'default']
        if (advice) {
            const current = providers ?? Object.fromEntries(availableProviders.map(id => [id, {id, available: true}]))
            for (const choice of [advice.primary, ...advice.fallbacks]) {
                const provider = current[choice.target.providerId]
                if (useLocal && choice.target.providerId !== 'ollama' && !provider?.local)
                    continue
                if (availableProviders.includes(choice.target.providerId) && isAdviceUsable(choice, current))
                    return {...choice.target}
            }
        }

        // Legacy task routes remain the last resort after persisted advice.
        if (targetStr && this.routes[targetStr]) {
            const parsed = parseModelTarget(this.routes[targetStr]!)
            if (availableProviders.length === 0 || availableProviders.includes(parsed.providerId))
                return parsed
        }

        // 5. Local preference applies only when no explicit model/task route resolved.
        if (useLocal && availableProviders.includes('ollama')) {
            if (this.defaultModel.providerId === 'ollama')
                return this.defaultModel
            return parseModelTarget(this.routes.local ?? 'ollama/llama3.2')
        }

        return this.resolveDefault(availableProviders, useLocal)
    }

    getModelAdvice(): ModelAdviceSnapshot | undefined {
        return this.advicePath === false ? undefined : readModelAdvice(this.advicePath)
    }

    /** Asker can recheck local installation only for tasks that could consult advice. */
    needsLocalAdviceCheck(task?: string): boolean {
        if (this.explicitRoutes[task || 'default'] || (!task && this.configuredDefault)) return false
        const advice = this.getModelAdvice()?.workloads[task || 'default']
        return Boolean(advice && [advice.primary, ...advice.fallbacks].some(r => r.availability === 'installed' && r.target.providerId === 'ollama'))
    }

    private resolveDefault(availableProviders: string[], useLocal = false): ModelTarget {
        if (useLocal && availableProviders.includes('ollama')) {
            if (this.defaultModel.providerId === 'ollama')
                return this.defaultModel
            return parseModelTarget(this.routes.local ?? 'ollama/llama3.2')
        }

        // The configured default model is authoritative when its provider is available.
        if (availableProviders.length === 0 || availableProviders.includes(this.defaultModel.providerId))
            return this.defaultModel

        // Fallback to first available provider
        const priorities: Array<{providerId: string; modelId: string}> = [
            {providerId: 'ollama', modelId: 'qwen2.5-coder:7b'},
            {providerId: 'google', modelId: 'gemini-2.0-flash'},
            {providerId: 'openai', modelId: 'gpt-4o'},
            {providerId: 'anthropic', modelId: 'claude-3-7-sonnet'},
        ]

        for (const candidate of priorities) {
            if (availableProviders.includes(candidate.providerId))
                return candidate
        }

        // If any provider is available at all, return the first one
        if (availableProviders.length > 0) {
            const first = availableProviders[0]!
            return {providerId: first, modelId: 'default'}
        }

        return this.defaultModel
    }
}

export function parseModelTarget(input: string | ModelTarget): ModelTarget {
    if (typeof input === 'object' && input.providerId && input.modelId)
        return input

    const str = String(input).trim()
    const slashIdx = str.indexOf('/')
    if (slashIdx === -1) {
        const inferred = inferProviderFromModelName(str)
        return {providerId: inferred ?? 'unknown', modelId: str}
    }

    return {
        providerId: str.slice(0, slashIdx).trim(),
        modelId: str.slice(slashIdx + 1).trim(),
    }
}

export function inferProviderFromModelName(name: string): ProviderId | undefined {
    const lower = name.toLowerCase()
    if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3') || lower.includes('text-embedding'))
        return 'openai'
    if (lower.startsWith('claude'))
        return 'anthropic'
    if (lower.startsWith('gemini'))
        return 'google'
    if (
        lower.startsWith('llama')
        || lower.startsWith('qwen')
        || lower.startsWith('phi')
        || lower.startsWith('mistral')
        || lower.startsWith('deepseek')
        || lower.startsWith('gemma')
        || lower.startsWith('codellama')
        || lower.startsWith('smollm')
        || lower.startsWith('tinyllama')
        || lower.startsWith('nemotron')
        || lower.startsWith('starcoder')
        || lower.startsWith('yi')
        || lower.startsWith('command-r')
        || lower.startsWith('vicuna')
        || lower.startsWith('hermes')
        || lower.startsWith('wizardlm')
        || lower.startsWith('falcon')
        || lower.startsWith('solar')
        || lower.startsWith('openhermes')
    )
        return 'ollama'
    return undefined
}
