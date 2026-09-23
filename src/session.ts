/**
 * Responsibility: maintain bounded multi-turn LLM conversation state across direct asks, prompts, and actor runs.
 * Scope: inject prior conversational context, record user/AI turns and actor tool observations, expose session history and metrics.
 * Rules: execution semantics stay in Asker/LLMActor; session history must not store actor reasoning/thoughts.
 */
import type {Asker} from './asker.ts'
import type {ActorRunOptions, ActorRunResult, ActorStepRecord, LLMActor} from './actor.ts'
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

            this.pruneHistory()
        }

        return {...result, latencyMs}
    }

    /**
     * Runs one autonomous actor turn with prior conversational context and records its result.
     */
    async run<T = unknown>(
        actor: LLMActor,
        goal: string,
        options: ActorRunOptions<T> = {},
    ): Promise<ActorRunResult<T>> {
        const contextualGoal = this._history.length > 0
            ? `## Session History
${this.renderHistory()}

## Current User Goal
${goal}`
            : goal

        const result = await actor.run(contextualGoal, options)

        if (result.ok) {
            this._history.push({role: 'user', content: goal})

            const observations = this.renderActorObservations(result.steps)
            if (observations)
                this._history.push({role: 'system', content: observations})

            this._history.push({role: 'ai', content: result.finalText})
            this.pruneHistory()
        }

        return result
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

            this.pruneHistory()
        }

        return {...result, latencyMs}
    }

    private renderHistory(): string {
        return this._history
            .map(message => `[${message.role.toUpperCase()}]: ${message.content}`)
            .join('\n')
    }

    private renderActorObservations(steps: ActorStepRecord[]): string {
        const observations: string[] = []

        for (const step of steps) {
            for (let i = 0; i < step.toolCalls.length; i += 1) {
                const call = step.toolCalls[i]
                const result = step.toolResults[i]
                if (!call || !result)
                    continue

                const observation = result.isError
                    ? `ERROR: ${result.error ?? 'Unknown tool error'}`
                    : JSON.stringify(result.result)

                observations.push(`${call.toolName}(${JSON.stringify(call.parameters)}) -> ${observation}`)
            }
        }

        return observations.length > 0
            ? `Tool observations:\n${observations.map(value => `- ${value}`).join('\n')}`
            : ''
    }

    private pruneHistory(): void {
        const max = this.options.maxHistory ?? this.options.maxHistoryTurns ?? 50
        if (this._history.length > max)
            this._history = this._history.slice(-max)
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
