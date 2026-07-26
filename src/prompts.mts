import type {PromptTemplate} from './types.mjs'

export interface TemplateSource {
    fetch?(name: string): Promise<string>
    load?(name: string): Promise<string>
}

export class PromptEngine {
    constructor(private readonly source: TemplateSource = {}) {}

    async load(name: string): Promise<PromptTemplate> {
        const load = this.source.fetch ?? this.source.load ?? (async () => '')
        const system = this.parse(await load.call(this.source, `${name}.system`).catch(() => ''))
        const prompt = this.parse(await load.call(this.source, `${name}.prompt`).catch(() => ''))

        return {
            content: prompt.content,
            manifest: {
                ...system.manifest,
                ...prompt.manifest,
                system: system.content,
            },
        }
    }

    parse(raw: string): PromptTemplate {
        if (!raw)
            return {content: '', manifest: {}}

        let manifest: Record<string, unknown> = {}
        let content = raw
        const match = raw.match(/^---\s*json\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/)
        if (match?.[1]) {
            try {
                const parsed: unknown = JSON.parse(match[1])
                manifest = isRecord(parsed) ? parsed : {}
                content = raw.slice(match[0].length)
            } catch {
                manifest = {}
            }
        }

        return {
            content: content.replace(/<!--[\s\S]*?-->/g, '').trim(),
            manifest,
        }
    }

    render(template: string, variables: Record<string, unknown> = {}): string {
        let rendered = template
        for (const [key, value] of Object.entries(variables)) {
            const pattern = new RegExp(`\\{\\{[ \\t]*${escapeRegExp(key)}[ \\t]*\\}\\}`, 'g')
            rendered = rendered.replace(pattern, String(value ?? ''))
        }
        return rendered
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}
