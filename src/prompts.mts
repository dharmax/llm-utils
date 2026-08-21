import type {PromptTemplate} from './types.mts'

export interface TemplateSource {
    fetch?(name: string): Promise<string>
    load?(name: string): Promise<string>
}

export class PromptEngine {
    constructor(private readonly source: TemplateSource = {}) {}

    async load(name: string): Promise<PromptTemplate> {
        const loader = this.source.fetch ?? this.source.load ?? (async () => '')
        const systemRaw = await loader.call(this.source, `${name}.system`).catch(() => '')
        const promptRaw = await loader.call(this.source, `${name}.prompt`).catch(() => '')

        const system = this.parse(systemRaw)
        const prompt = this.parse(promptRaw || systemRaw)

        const systemInstruction = system.content || (typeof system.manifest.system === 'string' ? system.manifest.system : undefined)

        return {
            content: prompt.content,
            manifest: {
                ...system.manifest,
                ...prompt.manifest,
                ...(systemInstruction ? {system: systemInstruction} : {}),
            },
        }
    }

    parse(raw: string): PromptTemplate {
        if (!raw)
            return {content: '', manifest: {}}

        let manifest: Record<string, unknown> = {}
        let content = raw

        const frontmatterMatch = raw.match(/^---\s*(?:json)?\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/)
        if (frontmatterMatch?.[1]) {
            try {
                const parsed = JSON.parse(frontmatterMatch[1])
                if (typeof parsed === 'object' && parsed !== null)
                    manifest = parsed as Record<string, unknown>
                content = raw.slice(frontmatterMatch[0].length)
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
        return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
            const val = variables[key]
            return val !== undefined && val !== null ? String(val) : ''
        })
    }
}
