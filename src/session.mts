import type {Asker} from './asker.mts'
import {MetricsEngine} from './metrics.mts'
import type {GenerationResult} from './types.mts'

export interface SessionMessage {
    role: 'user' | 'ai' | 'system'
    content: string
}

export interface SessionContext {
    history: SessionMessage[]
    metadata?: Record<string, number> | undefined
}

export class LLMSession {
    private history: SessionMessage[] = []
    private readonly metrics: MetricsEngine

    constructor(
        private readonly asker: Asker,
        private readonly options: {
            initialHistory?: SessionMessage[] | undefined
            maxHistory?: number | undefined
            system?: string | undefined
        } = {},
    ) {
        if (options.initialHistory)
            this.history = [...options.initialHistory]
        this.metrics = new MetricsEngine()
    }

    async prompt(
        templateName: string,
        data: Record<string, unknown> = {},
    ): Promise<GenerationResult> {
        const enrichedData = {
            ...data,
            history: this.history,
        }

        const startedAt = Date.now()
        const result = await this.asker.prompt(templateName, enrichedData, {
            system: this.options.system,
        })
        const latencyMs = Date.now() - startedAt

        if (result.ok) {
            this.metrics.record(result, latencyMs)
            const userContent = typeof data.inputText === 'string'
                ? data.inputText
                : typeof data.prompt === 'string'
                    ? data.prompt
                    : 'Prompt'
            this.history.push({role: 'user', content: userContent})
            this.history.push({role: 'ai', content: result.text})

            const max = this.options.maxHistory ?? 50
            if (this.history.length > max)
                this.history = this.history.slice(-max)
        }

        return {...result, latencyMs}
    }

    getHistory(): SessionMessage[] {
        return [...this.history]
    }

    getContext(): SessionContext {
        return {
            history: this.getHistory(),
            metadata: this.metrics.getReport(),
        }
    }

    clear(): void {
        this.history = []
    }
}
