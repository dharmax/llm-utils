import type {
    AskerOptions,
    CompletionClient,
    GenerationResult,
    InteractionTurn,
    ModelCapabilities,
    ModelInfo,
    ProviderConfig,
    ProviderId,
    SystemStatus,
    TaskType,
} from './types.mjs'
import {PromptEngine} from './prompts.mjs'
import {
    type ContextHistoryItem,
    ContextManager,
    type ContextRequest,
    isLegacyContextManager,
    isPromptContextManager,
    LegacyContextManagerAdapter,
    type PromptContextManager,
    renderContextResult,
} from './context.mjs'
import {CompletionEngine} from './completion.mjs'
import {ModelRouter} from './routing.mjs'
import {SystemProbe} from './discovery.mjs'

type PromptData = Record<string, unknown>

type ContextInjection = {
    type: 'context_blocks'
    key: string
    categories?: string[]
    maxItems?: number
    maxTokens?: number
    hints?: ContextRequest['hints']
}

export class Asker {
    private providerConfigs = new Map<ProviderId, ProviderConfig>()
    private taskTypes = new Map<string, TaskType>()
    private modelFitMatrix = new Map<string, ModelInfo[]>()
    private contextManager: ContextManager | PromptContextManager | undefined
    private readonly promptEngine: PromptEngine
    private readonly completion: CompletionClient
    private router?: ModelRouter

    constructor(options: AskerOptions)
    constructor(
        providers: ProviderConfig[],
        taskTypes: TaskType[],
        contextManager: ContextManager | PromptContextManager,
        promptEngine: PromptEngine,
        completion?: CompletionClient,
    )
    constructor(
        providersOrOptions: AskerOptions | ProviderConfig[],
        taskTypes: TaskType[] = [],
        contextManager?: ContextManager | PromptContextManager,
        promptEngine?: PromptEngine,
        completion?: CompletionClient,
    ) {
        if (Array.isArray(providersOrOptions)) {
            this.providerConfigs = new Map(providersOrOptions.map(provider => [provider.id, provider]))
            this.taskTypes = new Map(taskTypes.map(task => [task.id, task]))
            this.contextManager = contextManager
            this.promptEngine = promptEngine ?? new PromptEngine()
            this.completion = completion ?? new CompletionEngine()
            return
        }

        const options = providersOrOptions
        this.router = new ModelRouter(options.providerState)
        this.promptEngine = options.promptEngine ?? new PromptEngine()
        this.completion = options.completion ?? new CompletionEngine()
        this.providerConfigs = new Map(
            Object.values(options.providerState.providers).map(provider => [provider.id, provider]),
        )
    }

    getPromptEngine(): PromptEngine {
        return this.promptEngine
    }

    async getSystemStatus(): Promise<SystemStatus> {
        return SystemProbe.getStatus()
    }

    async refreshMapping(availableModels: ModelInfo[] = []): Promise<void> {
        if (this.router)
            return

        const providers = [...this.providerConfigs.values()]
        const availableProviders = new Set(
            providers
                .filter(provider => provider.enabled !== false
                    && (provider.id === 'ollama' || Boolean(provider.apiKey) || provider.available))
                .map(provider => provider.id),
        )

        for (const task of this.taskTypes.values()) {
            const candidates = ModelRouter.scoreModels(
                providers,
                task,
                availableModels.filter(model => availableProviders.has(model.providerId)),
            )
            this.modelFitMatrix.set(task.id, candidates)
        }
    }

    async prompt(turn: InteractionTurn): Promise<GenerationResult>
    async prompt(
        templateName: string,
        toolkit: PromptData,
        data: PromptData,
    ): Promise<GenerationResult>
    async prompt(
        turnOrTemplateName: InteractionTurn | string,
        toolkit: PromptData = {},
        data: PromptData = {},
    ): Promise<GenerationResult> {
        if (typeof turnOrTemplateName !== 'string')
            return this.ask(turnOrTemplateName.prompt, 'default', turnOrTemplateName)

        const {content, manifest} = await this.promptEngine.load(turnOrTemplateName)
        const variables: PromptData = {...data, ...toolkit}
        const injections = contextInjections(manifest.inject)

        if (this.contextManager) {
            for (const item of injections)
                variables[item.key] = await this.resolveInjectedContext(item, data, manifest)
        }

        const finalPrompt = this.promptEngine.render(content, variables)
        const taskType = stringValue(data.taskType)
            || stringValue(manifest.taskType)
            || 'default'
        return this.ask(finalPrompt, taskType, {system: stringValue(manifest.system)})
    }

    async ask(
        prompt: string,
        taskTypeId: string,
        options: Partial<InteractionTurn> = {},
    ): Promise<GenerationResult> {
        const model = this.selectModel(taskTypeId, options)
        if (!model)
            return {
                text: '',
                ok: false,
                failure: {
                    kind: 'configuration',
                    message: `No model routed for task: ${taskTypeId}`,
                    retryable: false,
                    fatal: true,
                },
                error: `No model routed for task: ${taskTypeId}`,
                model: {providerId: 'unknown', modelId: 'none'},
            }

        const config = this.router
            ? this.router.getProviderConfig(model.providerId) ?? {id: model.providerId}
            : this.providerConfigs.get(model.providerId) ?? {id: model.providerId}

        const result = await this.completion.generate(prompt, model, config, {
            ...(options.system === undefined ? {} : {system: options.system}),
            ...(options.format === undefined ? {} : {format: options.format}),
            ...(options.signal === undefined ? {} : {signal: options.signal}),
        })
        result.response = result.text
        return result
    }

    private selectModel(
        taskTypeId: string,
        options: Partial<InteractionTurn>,
    ): ModelInfo | null {
        let model: ModelInfo | null
        if (this.router) {
            model = this.router.route({
                id: taskTypeId,
                shortName: taskTypeId,
                description: 'Generic task',
                weights: this.weightsForTask(taskTypeId),
            }, {
                allowWeak: options.providerId === 'ollama' || Boolean(options.modelId?.includes('mock')),
            })
        } else {
            model = ModelRouter.route(this.modelFitMatrix.get(taskTypeId) ?? [])
        }

        if (!model && options.providerId && options.modelId)
            return {id: options.modelId, providerId: options.providerId}
        return model
    }

    private weightsForTask(id: string): Partial<ModelCapabilities> {
        const task = this.taskTypes.get(id)
        if (task)
            return task.weights
        return id === 'code-generation'
            ? {logic: 0.7, strategy: 0.3}
            : {logic: 0.5, strategy: 0.5}
    }

    private async resolveInjectedContext(
        item: ContextInjection,
        data: PromptData,
        manifest: PromptData,
    ): Promise<string> {
        const historyItems = history(data.history)
        const request: ContextRequest = {
            query: stringValue(data.inputText) || stringValue(data.prompt),
            taskType: stringValue(data.taskType) || stringValue(manifest.taskType) || 'default',
            categories: item.categories ?? [],
            ...(historyItems === undefined ? {} : {history: historyItems}),
            ...(item.maxItems === undefined ? {} : {maxItems: item.maxItems}),
            ...(item.maxTokens === undefined ? {} : {maxTokens: item.maxTokens}),
            ...(item.hints === undefined ? {} : {hints: item.hints}),
            output: {mode: 'both', format: 'markdown'},
        }

        if (isPromptContextManager(this.contextManager))
            return renderContextResult(await this.contextManager.resolve(request), 'markdown')

        if (isLegacyContextManager(this.contextManager)) {
            const adapter = new LegacyContextManagerAdapter(this.contextManager)
            return renderContextResult(await adapter.resolve(request), 'markdown')
        }

        return ''
    }
}

function contextInjections(value: unknown): ContextInjection[] {
    if (!Array.isArray(value))
        return []
    return value.filter((item): item is ContextInjection => {
        if (!isRecord(item))
            return false
        return item.type === 'context_blocks'
            && typeof item.key === 'string'
            && (item.categories === undefined
                || Array.isArray(item.categories)
                    && item.categories.every(category => typeof category === 'string'))
    })
}

function history(value: unknown): ContextHistoryItem[] | undefined {
    if (!Array.isArray(value))
        return undefined
    const items = value.filter((item): item is ContextHistoryItem => (
        isRecord(item)
        && typeof item.role === 'string'
        && typeof item.content === 'string'
    ))
    return items.length === value.length ? items : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : ''
}
