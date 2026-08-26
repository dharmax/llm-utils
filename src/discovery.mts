import type {ModelInfo, ProviderConfig} from './types.mjs'

export interface DiscoveryOptions {
    ollamaHost?: string | undefined
    customProviders?: Record<string, ProviderConfig> | undefined
}

export class ProviderDiscovery {
    /**
     * Probes an Ollama instance to check for availability and installed models.
     */
    static async probeOllama(host = 'http://127.0.0.1:11434'): Promise<{
        installed: boolean
        models: ModelInfo[]
        host: string
    }> {
        const url = host.startsWith('http://') || host.startsWith('https://')
            ? host
            : `http://${host}`

        try {
            const res = await fetch(`${url}/api/tags`)
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
                    sizeB: typeof m.size === 'number' ? Number((m.size / 1024 ** 3).toFixed(1)) : null,
                }]
            })

            return {installed: true, models, host: url}
        } catch {
            return {installed: false, models: [], host: url}
        }
    }

    /**
     * Auto-detects providers from environment variables and optional explicit config.
     */
    static async discover(options: DiscoveryOptions = {}): Promise<Record<string, ProviderConfig>> {
        const env = typeof process !== 'undefined' ? process.env : {}
        const ollamaHost = options.ollamaHost ?? env.OLLAMA_HOST ?? 'http://127.0.0.1:11434'

        const ollama = await this.probeOllama(ollamaHost)
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
