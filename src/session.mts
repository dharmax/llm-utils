import {Asker} from './asker.mts'
import {ContextCompressor} from './context.mts'
import {MetricsEngine} from './metrics.mts'
import type {GenerationResult, SessionContext} from './types.mts'

export class LLMSession {
    private context: SessionContext
    private readonly metrics: MetricsEngine

  constructor(
        private readonly asker: Asker,
        private readonly toolkit: Record<string, unknown> = {},
        initialContext?: SessionContext,
    ) {
        this.context = initialContext ?? {history: []}
        this.metrics = new MetricsEngine()
    }

    async prompt(
        templateName: string,
        data: Record<string, unknown>,
    ): Promise<GenerationResult> {
        this.context.managedContext = ContextCompressor.densify(this.context.history)
        const enrichedData = {
            ...data,
            ...this.toolkit,
            history: this.context.history,
            managedContext: this.context.managedContext,
        }

        const startedAt = Date.now()
        const result = await this.asker.prompt(templateName, this.toolkit, enrichedData)
        const latencyMs = Date.now() - startedAt

        if (result.ok) {
            this.metrics.record(result, latencyMs)
            this.context.metrics = this.metrics.getReport()
            this.context.history.push({
                role: 'user',
                content: typeof data.inputText === 'string' ? data.inputText : 'Prompt',
            })
            this.context.history.push({role: 'ai', content: result.text})
            this.context.history = this.context.history.slice(-20)
        }

        return {...result, latencyMs}
    }

    getContext(): SessionContext {
        return this.context
    }
}
