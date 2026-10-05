import type {ModelInfo, ProviderConfig} from './types.ts'
import {arch, cpus, platform, totalmem} from 'node:os'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readdir, readFile} from 'node:fs/promises'

export interface DiscoveryOptions {
    ollamaHost?: string
    customProviders?: Record<string, ProviderConfig>
    timeoutMs?: number
}

export interface HardwareSummary {
    platform: string
    architecture: string
    ramBytes: number
    cpu: string
    logicalCpus: number
    gpus: Array<{name: string; vramBytes?: number}>
}

export interface ProviderAccessSummary {
    id: string
    configured: boolean
    available: boolean
    local: boolean
    verification: 'verified' | 'rejected' | 'unverified'
    entitlements: string[]
    /** Absent means unknown; empty means verified no accessible models. */
    models?: ModelInfo[]
}

export interface ModelEnvironmentSummary {
    hardware: HardwareSummary
    providers: ProviderAccessSummary[]
}

export interface EnvironmentDiscoveryOptions extends DiscoveryOptions {
    providers?: Record<string, ProviderConfig>
    entitlements?: Record<string, string[]>
    hardware?: () => Promise<HardwareSummary>
    /** Verify custom providers without coupling advice to a web/API vendor. */
    verifyProvider?: (config: ProviderConfig) => Promise<{verification: ProviderAccessSummary['verification']; models?: ModelInfo[]}>
}

/** Redact known credentials even when accidentally embedded in free-form facts. */
export function sanitizeFacts<T>(facts: T, providers: Record<string, ProviderConfig> = {}): T {
    const secrets = [...Object.values(providers).flatMap(p => p.apiKey ? [p.apiKey] : []),
        ...Object.entries(process.env).flatMap(([key, value]) => /key|token|secret|password|credential/i.test(key) && value ? [value] : [])]
    const clean = (value: unknown): unknown => {
        if (typeof value === 'string') {
            let result = value.replace(/https?:\/\/[^\s]+/g, raw => {
                try {
                    const url = new URL(raw)
                    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
                    return url.toString()
                } catch { return '[redacted-url]' }
            })
            for (const secret of secrets)
                result = result.split(secret).join('[redacted]')
            return result.replace(/\b(?:sk-[\w-]{8,}|Bearer\s+[^\s]+)\b/gi, '[redacted]')
        }
        if (Array.isArray(value)) return value.map(clean)
        if (value && typeof value === 'object')
            return Object.fromEntries(Object.entries(value).filter(([key]) => !/api.?key|secret|password|credential|access.?token/i.test(key)).map(([key, item]) => [clean(key), clean(item)]))
        return value
    }
    return clean(facts) as T
}

export async function discoverHardware(): Promise<HardwareSummary> {
    const processors = cpus()
    const gpus: HardwareSummary['gpus'] = []
    try {
        const {stdout} = await promisify(execFile)('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {timeout: 2000, maxBuffer: 64 * 1024})
        for (const row of stdout.trim().split('\n')) {
            const [name, memory] = row.split(',').map(s => s.trim())
            if (name) gpus.push({name, ...(Number(memory) > 0 ? {vramBytes: Number(memory) * 1024 ** 2} : {})})
        }
    } catch { /* Optional hardware evidence. */ }
    if (platform() === 'linux' && !gpus.length) {
        try {
            for (const card of (await readdir('/sys/class/drm')).filter(name => /^card\d+$/.test(name))) {
                try {
                    const bytes = Number((await readFile(`/sys/class/drm/${card}/device/mem_info_vram_total`, 'utf8')).trim())
                    if (bytes > 0) gpus.push({name: card, vramBytes: bytes})
                } catch { /* This card does not expose VRAM. */ }
            }
        } catch { /* DRM unavailable. */ }
    }
    return {platform: platform(), architecture: arch(), ramBytes: totalmem(), cpu: processors[0]?.model ?? 'unknown', logicalCpus: processors.length, gpus}
}

function modelFacts(model: ModelInfo): ModelInfo {
    return {id: model.id, providerId: model.providerId, local: model.local, sizeB: model.sizeB,
        parameterSize: model.parameterSize, quantization: model.quantization, family: model.family,
        architecture: model.architecture, contextWindow: model.contextWindow}
}

export class ProviderDiscovery {
    /**
     * Probes an Ollama instance to check for availability and installed models.
     */
    static async probeOllama(host = 'http://127.0.0.1:11434', options: {enrich?: boolean; timeoutMs?: number} = {}): Promise<{
        installed: boolean
        models: ModelInfo[]
        host: string
    }> {
        const url = host.startsWith('http://') || host.startsWith('https://')
            ? host
            : `http://${host}`

        try {
            const res = await fetch(`${url.replace(/\/$/, '')}/api/tags`, {signal: AbortSignal.timeout(options.timeoutMs ?? 3000)})
            if (!res.ok)
                return {installed: false, models: [], host: url}

            const data = await res.json() as {models?: Array<{name?: string; model?: string; size?: number}>}
            const models: ModelInfo[] = (data?.models ?? []).flatMap(m => {
                const name = m.name ?? m.model
                if (!name)
                    return []
                return [{
                    id: name,
                    providerId: 'ollama',
                    local: true,
                    sizeB: typeof m.size === 'number' ? Number((m.size / 1024 ** 3).toFixed(1)) : undefined,
                }]
            })

            if (options.enrich) {
                // Bounded sequential metadata requests, never a pull or generation call.
                for (const model of models) {
                    try {
                        const show = await fetch(`${url.replace(/\/$/, '')}/api/show`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({model: model.id}), signal: AbortSignal.timeout(options.timeoutMs ?? 3000)})
                        if (!show.ok) continue
                        const metadata = await show.json() as {details?: Record<string, unknown>; model_info?: Record<string, unknown>}
                        const details = metadata.details ?? {}
                        const info = metadata.model_info ?? {}
                        if (typeof details.parameter_size === 'string') model.parameterSize = details.parameter_size
                        if (typeof details.quantization_level === 'string') model.quantization = details.quantization_level
                        if (typeof details.family === 'string') model.family = details.family
                        if (typeof info['general.architecture'] === 'string') model.architecture = info['general.architecture']
                        const context = Object.entries(info).find(([key, value]) => key.endsWith('.context_length') && typeof value === 'number')?.[1]
                        if (typeof context === 'number' && Number.isFinite(context) && context > 0) model.contextWindow = context
                    } catch { /* Preserve tags if optional show fails. */ }
                }
            }
            return {installed: true, models, host: url}
        } catch {
            return {installed: false, models: [], host: url}
        }
    }

    /** Explicit environment observation. Returned facts never contain provider configuration/secrets. */
    static async discoverEnvironment(options: EnvironmentDiscoveryOptions = {}): Promise<ModelEnvironmentSummary> {
        const configs = options.providers ?? await this.discover(options)
        const providers: ProviderAccessSummary[] = []
        const allConfigs: Record<string, ProviderConfig> = {...Object.fromEntries(Object.keys(options.entitlements ?? {}).map(id => [id, {id, available: false}])), ...configs}
        for (const [id, config] of Object.entries(allConfigs)) {
            const summary: ProviderAccessSummary = {id, configured: Boolean(config.apiKey || config.baseUrl || config.host || config.available),
                available: config.enabled !== false && config.available !== false,
                local: config.local ?? id === 'ollama', verification: 'unverified',
                entitlements: options.entitlements?.[id] ?? config.entitlements ?? [],
                ...(config.models ? {models: config.models.map(modelFacts)} : {})}
            if (config.enabled === false) summary.available = false
            else if (id === 'ollama') {
                const probe = await this.probeOllama(config.host ?? options.ollamaHost, {enrich: true, timeoutMs: options.timeoutMs})
                summary.verification = probe.installed ? 'verified' : 'unverified'
                summary.available = probe.installed
                summary.models = probe.models
            } else if (summary.configured) {
                try {
                    const verified = options.verifyProvider ? await options.verifyProvider(config) : await this.verifyRemote(config, options.timeoutMs ?? 3000)
                    summary.verification = verified.verification
                    if (verified.models) summary.models = verified.models.map(modelFacts)
                    if (verified.verification === 'rejected') summary.available = false
                    if (verified.verification === 'verified') summary.available = true
                } catch { /* Unknown access is explicitly unverified. */ }
            }
            providers.push(summary)
        }
        return sanitizeFacts({hardware: await (options.hardware ?? discoverHardware)(), providers}, configs)
    }

    private static async verifyRemote(config: ProviderConfig, timeoutMs: number): Promise<{verification: ProviderAccessSummary['verification']; models?: ModelInfo[]}> {
        if (!config.apiKey) return {verification: 'unverified'}
        let url: string
        let headers: Record<string, string>
        if (config.id === 'openai') {
            url = `${(config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/models`
            headers = {Authorization: `Bearer ${config.apiKey}`}
        } else if (config.id === 'google') {
            url = `${(config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')}/models`
            headers = {'x-goog-api-key': config.apiKey}
        } else if (config.id === 'anthropic') {
            url = `${(config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/models`
            headers = {'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01'}
        } else return {verification: 'unverified'}
        const res = await fetch(url, {headers, signal: AbortSignal.timeout(timeoutMs)})
        if (res.status === 401 || res.status === 403) return {verification: 'rejected'}
        if (!res.ok) return {verification: 'unverified'}
        const data = await res.json() as {data?: Array<{id?: string}>; models?: Array<{name?: string}>; has_more?: boolean; nextPageToken?: string}
        // A partial page must not be mistaken for an exhaustive access list.
        if (data.has_more || data.nextPageToken) return {verification: 'verified'}
        const rows = data.data ?? data.models
        return {verification: 'verified', ...(Array.isArray(rows) ? {models: rows.flatMap(row => {
            const id = 'id' in row ? row.id : 'name' in row ? row.name?.replace(/^models\//, '') : undefined
            return typeof id === 'string' ? [{id, providerId: config.id, local: false}] : []
        })} : {})}
    }

    /**
     * Auto-detects providers from environment variables and optional explicit config.
     */
    static async discover(options: DiscoveryOptions = {}): Promise<Record<string, ProviderConfig>> {
        const env = typeof process !== 'undefined' ? process.env : {}
        const ollamaHost = options.ollamaHost ?? env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'

        const ollama = await this.probeOllama(ollamaHost, {timeoutMs: options.timeoutMs})
        const providers: Record<string, ProviderConfig> = {
            ollama: {
                id: 'ollama',
                host: ollama.host,
                available: ollama.installed && ollama.models.length > 0,
                local: true,
                models: ollama.models,
            },
            openai: {
                id: 'openai',
                apiKey: env.OPENAI_API_KEY,
                baseUrl: env.OPENAI_BASE_URL,
                available: Boolean(env.OPENAI_API_KEY || env.OPENAI_BASE_URL),
                local: false,
            },
            google: {
                id: 'google',
                apiKey: env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY,
                available: Boolean(env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY),
                local: false,
            },
            anthropic: {
                id: 'anthropic',
                apiKey: env.ANTHROPIC_API_KEY,
                baseUrl: env.ANTHROPIC_BASE_URL,
                available: Boolean(env.ANTHROPIC_API_KEY),
                local: false,
            },
            ...options.customProviders,
        }

        return providers
    }
}
