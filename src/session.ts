import type {Asker} from './asker.ts'
import {MetricsEngine} from './metrics.ts'
import type {AskOptions, GenerationResult} from './types.ts'

export interface SessionMessage {
    role: 'user' | 'ai' | 'system'
    content: string
}

export interface SessionContext {
    history: SessionMessage[]
    metadata?: Record<string, number>
}

export class LLMSession {
    private _history: SessionMessage[] = []
    private readonly metrics: MetricsEngine

    constructor(
        private readonly asker: Asker,
        private readonly options: {
            initialHistory?: SessionMessage[]
            maxHistory?: number
            maxHistoryTurns?: number
            system?: string
        } = {},
    ) {
        if (options.initialHistory)
            this._history = [...options.initialHistory]
        this.metrics = new MetricsEngine()
    }

    /**
     * Sends a direct chat turn in this session and appends it to history.
     */
    async ask(
        prompt: string,
        options: AskOptions = {},
    ): Promise<GenerationResult> {
        const startedAt = Date.now()
        const system = options.system ?? this.options.system

        // Prepend conversation context
        const contextPrompt = this._history.length > 0
            ? `${this._history.map(m => `[${m.role.toUpperCase()}]: ${m.content}`).join('\n')}\n[USER]: ${prompt}`
            : prompt

        const result = await this.asker.ask(contextPrompt, {
            ...options,
            system,
        })
        const latencyMs = Date.now() - startedAt

        if (result.ok) {
            this.metrics.record(result, latencyMs)
            this._history.push({role: 'user', content: prompt})
            this._history.push({role: 'ai', content: result.text})

            const max = this.options.maxHistory ?? this.options.maxHistoryTurns ?? 50
            if (this._history.length > max)
                this._history = this._history.slice(-max)
        }

        return {...result, latencyMs}
    }

    /**
     * Renders and executes a template with session history injected into variables.
     */
    async prompt(
        templateName: string,
        data: Record<string, unknown> = {},
        options: AskOptions = {},
    ): Promise<GenerationResult> {
        const enrichedData = {
            ...data,
            history: this._history,
        }

        const startedAt = Date.now()
        const system = options.system ?? this.options.system
        const result = await this.asker.prompt(templateName, enrichedData, {
            ...options,
            system,
        })
        const latencyMs = Date.now() - startedAt

        if (result.ok) {
            this.metrics.record(result, latencyMs)
            const userContent = typeof data.inputText === 'string'
                ? data.inputText
                : typeof data.prompt === 'string'
                    ? data.prompt
                    : 'Prompt'
            this._history.push({role: 'user', content: userContent})
            this._history.push({role: 'ai', content: result.text})

            const max = this.options.maxHistory ?? this.options.maxHistoryTurns ?? 50
            if (this._history.length > max)
                this._history = this._history.slice(-max)
        }

        return {...result, latencyMs}
    }

    get history(): SessionMessage[] {
        return this.getHistory()
    }

    getHistory(): SessionMessage[] {
        return [...this._history]
    }

    getContext(): SessionContext {
        return {
            history: this.getHistory(),
            metadata: this.metrics.getReport(),
        }
    }

    clear(): void {
        this._history = []
    }
}
