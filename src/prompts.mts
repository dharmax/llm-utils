import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import type {PromptTemplate} from './types.mjs'

export interface TemplateSource {
    fetch?(name: string): Promise<string>
    load?(name: string): Promise<string>
}

export class FileTemplateSource implements TemplateSource {
    private readonly baseDir: string

    constructor(baseDir: string | URL) {
        this.baseDir = baseDir instanceof URL ? fileURLToPath(baseDir) : baseDir
    }

    async fetch(name: string): Promise<string> {
        return this.load(name)
    }

    async load(name: string): Promise<string> {
        try {
            return await readFile(join(this.baseDir, name), 'utf-8')
        } catch {
            return ''
        }
    }
}

function parseSimpleYaml(body: string): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    const lines = body.split(/\r?\n/)
    for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const colonIdx = trimmed.indexOf(':')
        if (colonIdx === -1) continue
        const key = trimmed.slice(0, colonIdx).trim()
        let val: any = trimmed.slice(colonIdx + 1).trim()
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
            val = val.slice(1, -1)
        else if (val === 'true') val = true
        else if (val === 'false') val = false
        else if (val !== '' && !isNaN(Number(val))) val = Number(val)
        result[key] = val
    }
    return result
}

export class PromptEngine {
    constructor(private readonly source: TemplateSource = {}) {}

    async load(name: string): Promise<PromptTemplate> {
        const loader = this.source.fetch ?? this.source.load ?? (async () => '')
        const directRaw = await loader.call(this.source, name).catch(() => '')
        if (directRaw) {
            return this.parse(directRaw)
        }

        const systemRaw = await loader.call(this.source, `${name}.system`).catch(() => '')
        const promptRaw = await loader.call(this.source, `${name}.prompt`).catch(() => '')

        const system = this.parse(systemRaw)
        const prompt = this.parse(promptRaw || systemRaw)

        const systemInstruction = system.content
            || (typeof system.manifest.system === 'string' ? system.manifest.system : undefined)
            || (typeof prompt.manifest.system === 'string' ? prompt.manifest.system : undefined)

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

        const frontmatterMatch = raw.match(/^---\s*(?:json|ya?ml)?\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/)
        if (frontmatterMatch?.[1]) {
            const body = frontmatterMatch[1].trim()
            try {
                const parsed = JSON.parse(body)
                if (typeof parsed === 'object' && parsed !== null)
                    manifest = parsed as Record<string, unknown>
                content = raw.slice(frontmatterMatch[0].length)
            } catch {
                manifest = parseSimpleYaml(body)
                content = raw.slice(frontmatterMatch[0].length)
            }
        }

        return {
            content: content.replace(/<!--[\s\S]*?-->/g, '').trim(),
            manifest,
        }
    }

    render(template: string, variables: Record<string, unknown> = {}): string {
        return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
            const val = key.includes('.')
                ? key.split('.').reduce((acc: any, k: string) => (acc == null ? undefined : acc[k]), variables)
                : variables[key]
            if (val === undefined || val === null)
                return ''
            if (typeof val === 'object')
                return JSON.stringify(val, null, 2)
            return String(val)
        })
    }
}
