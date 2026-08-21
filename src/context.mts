export type ContextHistoryRole = 'user' | 'ai' | 'system' | string

export interface ContextHistoryItem {
    role: ContextHistoryRole
    content: string
}

export interface ContextRequest {
    query: string
    taskType?: string | undefined
    maxTokens?: number | undefined
    maxItems?: number | undefined
    categories?: string[] | undefined
    history?: ContextHistoryItem[] | undefined
    hints?: Record<string, unknown> | undefined
    output?: {
        mode?: 'rendered' | 'items' | 'both' | undefined
        format?: 'markdown' | 'plain' | undefined
    } | undefined
}

export interface ContextItem {
    id: string
    title: string
    content: string
    kind?: string | undefined
    score?: number | undefined
    source?: string | undefined
    metadata?: Record<string, unknown> | undefined
}

export interface ContextResult {
    rendered?: string | undefined
    items?: ContextItem[] | undefined
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
