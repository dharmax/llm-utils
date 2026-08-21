import type {ModelTarget} from './types.mts'

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
    ): ModelTarget {
        if (typeof targetOrTask === 'object' && targetOrTask.providerId && targetOrTask.modelId)
            return targetOrTask

        const targetStr = targetOrTask ? String(targetOrTask).trim() : ''

        // 1. Direct provider/model string (e.g. 'openai/gpt-4o')
        if (targetStr.includes('/'))
            return parseModelTarget(targetStr)

        // 2. Custom router hook
        if (targetStr && this.customRouter) {
            const custom = this.customRouter(targetStr, availableProviders)
            if (custom)
                return typeof custom === 'string' ? parseModelTarget(custom) : custom
        }

        // 3. Local preference
        if (this.preferLocal && availableProviders.includes('ollama'))
            return {providerId: 'ollama', modelId: 'llama3.2'}

        // 4. Mapped task
        if (targetStr && this.routes[targetStr]) {
            const mapped = this.routes[targetStr]
            const parsed = typeof mapped === 'string' ? parseModelTarget(mapped) : mapped
            if (availableProviders.length === 0 || availableProviders.includes(parsed.providerId))
                return parsed
        }

        return this.resolveDefault(availableProviders)
    }

    private resolveDefault(availableProviders: string[]): ModelTarget {
        if (this.preferLocal && availableProviders.includes('ollama'))
            return {providerId: 'ollama', modelId: 'llama3.2'}

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
            {providerId: 'google', modelId: 'gemini-2.0-flash'},
            {providerId: 'openai', modelId: 'gpt-4o'},
            {providerId: 'anthropic', modelId: 'claude-3-7-sonnet'},
            {providerId: 'ollama', modelId: 'llama3.2'},
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
    if (slashIdx === -1)
        return {providerId: 'unknown', modelId: str}

    return {
        providerId: str.slice(0, slashIdx).trim(),
        modelId: str.slice(slashIdx + 1).trim(),
    }
}
