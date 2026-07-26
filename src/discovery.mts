import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {CompletionEngine} from './completion.mts'
import type {
    CompletionClient,
    ModelInfo,
    ProviderKnowledge,
    ProviderState,
    SystemStatus,
} from './types.mts'

const execFileAsync = promisify(execFile)

export interface DiscoveryOptions {
    forceRefresh?: boolean
    cacheTtlMs?: number
}

export type DiscoveryConfiguration = {
    providers?: Record<string, {
        apiKey?: string
        enabled?: boolean
        host?: string
        baseUrl?: string
        models?: ModelInfo[]
    }>
    routingPolicy?: unknown
}

export class ProviderDiscovery {
    static async probeOllama(
        host = 'http://127.0.0.1:11434',
    ): Promise<{installed: boolean; models: ModelInfo[]; host: string}> {
        const url = host.startsWith('http://') || host.startsWith('https://')
            ? host
            : `http://${host}`
        try {
            const response = await fetch(`${url}/api/tags`)
            if (!response.ok)
                return {installed: false, models: [], host: url}

            const payload: unknown = await response.json()
            const models = isRecord(payload) && Array.isArray(payload.models)
                ? payload.models.flatMap(model => {
                    if (!isRecord(model))
                        return []
                    const id = stringValue(model.name) || stringValue(model.model)
                    if (!id)
                        return []
                    const bytes = typeof model.size === 'number' ? model.size : undefined
                    return [{
                        id,
                        sizeB: bytes === undefined
                            ? null
                            : Number((bytes / 1024 ** 3).toFixed(1)),
                        providerId: 'ollama',
                        local: true,
                    }]
                })
                : []
            return {installed: true, models, host: url}
        } catch {
            return {installed: false, models: [], host: url}
        }
    }

    static async discover(
        config: DiscoveryConfiguration = {},
        knowledge: ProviderKnowledge = {},
        completion: CompletionClient = new CompletionEngine(),
    ): Promise<ProviderState> {
        const configured = config.providers ?? {}
        const ollama = await this.probeOllama(
            configured.ollama?.host ?? 'http://127.0.0.1:11434',
        )
        const providers: ProviderState['providers'] = {
            ollama: {
                id: 'ollama',
                available: ollama.installed && ollama.models.length > 0,
                local: true,
                host: ollama.host,
                models: ollama.models,
            },
        }

        const providerIds = new Set([
            'google',
            'openai',
            'anthropic',
            ...completion.getRegisteredProviderIds(),
            ...Object.keys(configured),
        ])
        providerIds.delete('ollama')

        for (const id of providerIds) {
            const provider = configured[id] ?? {}
            providers[id] = {
                id,
                available: Boolean(provider.apiKey || provider.enabled),
                local: false,
                ...(provider.apiKey === undefined ? {} : {apiKey: provider.apiKey}),
                ...(provider.baseUrl === undefined ? {} : {baseUrl: provider.baseUrl}),
                models: knowledge.models?.[id] ?? provider.models ?? [],
            }
        }

        return {
            providers,
            knowledge,
            routingPolicy: config.routingPolicy ?? {quotaStrategy: 'prefer-free-remote'},
        }
    }

    static async refreshQuotaState(
        _options: unknown,
    ): Promise<{refreshed: unknown[]}> {
        return {refreshed: []}
    }
}

export class SystemProbe {
    static async getStatus(): Promise<SystemStatus> {
        return {ok: true, leanCtx: await this.probeLeanCtx()}
    }

    static leanCtxInstallHint(): string {
        return 'Install the lean-ctx CLI and ensure `lean-ctx` is on PATH, then rerun `ai-workflow doctor`.'
    }

    static leanCtxSetupHint(): string {
        return 'After install, verify with `lean-ctx -c git status` and use `lean-ctx -c <command>` for compressed shell output.'
    }

    private static async probeLeanCtx(): Promise<Record<string, unknown>> {
        try {
            const {stdout} = await execFileAsync(
                'bash',
                ['-lc', 'command -v lean-ctx'],
                {maxBuffer: 1024 * 1024},
            )
            const path = String(stdout ?? '').trim()
            if (!path)
                return this.missingLeanCtx('lean-ctx not found on PATH')
            return {
                installed: true,
                path,
                version: await this.probeLeanCtxVersion(),
                installHint: this.leanCtxInstallHint(),
                setupHint: this.leanCtxSetupHint(),
            }
        } catch (error) {
            return this.missingLeanCtx(errorMessage(error))
        }
    }

    private static async probeLeanCtxVersion(): Promise<string | null> {
        try {
            const {stdout} = await execFileAsync(
                'lean-ctx',
                ['--version'],
                {maxBuffer: 1024 * 1024},
            )
            const text = String(stdout ?? '').trim()
            return text.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] ?? text ?? null
        } catch {
            return null
        }
    }

    private static missingLeanCtx(details: string): Record<string, unknown> {
        return {
            installed: false,
            path: null,
            version: null,
            details,
            installHint: this.leanCtxInstallHint(),
            setupHint: this.leanCtxSetupHint(),
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : ''
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
