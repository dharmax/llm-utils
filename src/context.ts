export type ContextHistoryRole = 'user' | 'ai' | 'system' | string

export interface ContextHistoryItem {
    role: ContextHistoryRole
    content: string
}

export interface ContextRequest {
    query: string
    taskType?: string
    maxTokens?: number
    maxItems?: number
    categories?: string[]
    history?: ContextHistoryItem[]
    hints?: Record<string, unknown>
    output?: {
        mode?: 'rendered' | 'items' | 'both'
        format?: 'markdown' | 'plain'
    }
}

export interface ContextItem {
    id: string
    title: string
    content: string
    kind?: string
    score?: number
    source?: string
    metadata?: Record<string, unknown>
}

export interface ContextResult {
    rendered?: string
    items?: ContextItem[]
}

export interface PromptContextManager {
    resolve(request: ContextRequest): Promise<ContextResult | string>
}

export type ContextResolver =
    | PromptContextManager
    | ((request: ContextRequest) => Promise<ContextResult | string>)

export function renderContextItems(items: ContextItem[], format: 'markdown' | 'plain' = 'markdown'): string {
    if (format === 'plain')
        return items.map(i => `${i.title}\n${i.content}`).join('\n\n')
    return items.map(i => `### ${i.title}\n${i.content}`).join('\n\n')
}

export function renderContextResult(result: ContextResult | string, format: 'markdown' | 'plain' = 'markdown'): string {
    if (typeof result === 'string')
        return result
    if (result.rendered)
        return result.rendered
    return renderContextItems(result.items ?? [], format)
}

export async function resolveContext(
    resolver: ContextResolver | undefined,
    request: ContextRequest,
): Promise<string> {
    if (!resolver)
        return ''
    if (typeof resolver === 'function') {
        const res = await resolver(request)
        return renderContextResult(res, request.output?.format)
    }
    if (typeof resolver.resolve === 'function') {
        const res = await resolver.resolve(request)
        return renderContextResult(res, request.output?.format)
    }
    return ''
}
