import type {ModelTarget, ProviderId} from './types.mjs'

export interface TaskRouteMap {
    [task: string]: string | ModelTarget
}

export type CustomRouterFn = (task: string, availableProviders: string[]) => ModelTarget | string | undefined

export interface ModelRouterOptions {
    routes?: TaskRouteMap | undefined
    router?: CustomRouterFn | undefined
    preferLocal?: boolean | undefined
    defaultModel?: string | ModelTarget | undefined
}

export const DEFAULT_TASK_ROUTES: TaskRouteMap = {
    'code': 'openai/gpt-4o',
    'fast': 'google/gemini-2.0-flash',
    'reasoning': 'openai/o3-mini',
    'creative': 'anthropic/claude-3-7-sonnet',
    'summarization': 'google/gemini-2.0-flash',
    'local': 'ollama/llama3.2',
    'default': 'google/gemini-2.0-flash',
}

export class ModelRouter {
    private readonly routes: TaskRouteMap
    private readonly customRouter: CustomRouterFn | undefined
    private readonly defaultModel: ModelTarget
    private readonly preferLocal: boolean

    constructor(options: ModelRouterOptions = {}) {
        this.routes = {...DEFAULT_TASK_ROUTES, ...options.routes}
        this.customRouter = options.router
        this.preferLocal = Boolean(options.preferLocal)
        this.defaultModel = parseModelTarget(options.defaultModel ?? 'google/gemini-2.0-flash')
    }

    /**
     * Resolves a task or model name to a concrete ModelTarget given available providers.
     */
    resolve(
        targetOrTask?: string | ModelTarget | undefined,
        availableProviders: string[] = ['google', 'openai', 'anthropic', 'ollama'],
        preferLocalOverride?: boolean | undefined,
    ): ModelTarget {
        const useLocal = preferLocalOverride !== undefined ? preferLocalOverride : this.preferLocal

        if (typeof targetOrTask === 'object' && targetOrTask.providerId && targetOrTask.modelId)
            return targetOrTask

        const targetStr = targetOrTask ? String(targetOrTask).trim() : ''

        // 1. Direct provider/model string (e.g. 'openai/gpt-4o' or 'ollama/llama3.2')
        if (targetStr.includes('/'))
            return parseModelTarget(targetStr)

        // 2. Custom router hook
        if (targetStr && this.customRouter) {
            const custom = this.customRouter(targetStr, availableProviders)
            if (custom)
                return typeof custom === 'string' ? parseModelTarget(custom) : custom
        }

        // 3. Local preference explicitly requested
        if (useLocal && availableProviders.includes('ollama')) {
            if (targetStr && this.routes[targetStr] && String(this.routes[targetStr]).startsWith('ollama/'))
                return parseModelTarget(this.routes[targetStr]!)
            if (targetStr && (targetStr.startsWith('ollama/') || inferProviderFromModelName(targetStr) === 'ollama'))
                return parseModelTarget(targetStr)
            if (this.defaultModel.providerId === 'ollama')
                return this.defaultModel
            return parseModelTarget(this.routes.local ?? 'ollama/llama3.2')
        }

        // 4. Mapped task (e.g. 'code', 'fast', 'local')
        if (targetStr && this.routes[targetStr]) {
            const mapped = this.routes[targetStr]
            const parsed = typeof mapped === 'string' ? parseModelTarget(mapped) : mapped
            if (availableProviders.length === 0 || availableProviders.includes(parsed.providerId))
                return parsed
        }

        // 5. Bare model name inference (e.g. 'gpt-4o', 'qwen2.5-coder', 'llama3.2', 'deepseek-r1')
        if (targetStr) {
            const inferred = inferProviderFromModelName(targetStr)
            if (inferred)
                return {providerId: inferred, modelId: targetStr}
        }

        return this.resolveDefault(availableProviders, useLocal)
    }

    private resolveDefault(availableProviders: string[], useLocal = false): ModelTarget {
        if (useLocal && availableProviders.includes('ollama')) {
            if (this.defaultModel.providerId === 'ollama')
                return this.defaultModel
            return parseModelTarget(this.routes.local ?? 'ollama/llama3.2')
        }

        // Check routes['default']
        const defaultRoute = this.routes.default
        if (defaultRoute) {
            const parsed = typeof defaultRoute === 'string' ? parseModelTarget(defaultRoute) : defaultRoute
            if (availableProviders.length === 0 || availableProviders.includes(parsed.providerId))
                return parsed
        }

        // If the configured default provider is available, use it
        if (availableProviders.includes(this.defaultModel.providerId))
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
