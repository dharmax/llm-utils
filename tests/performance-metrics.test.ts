import {describe, expect, it} from 'bun:test'
import {
    Asker,
    CompletionEngine,
    FallbackSystemOne,
    InMemoryMetricsStore,
    LayaSystemOne,
    LLMActor,
    z,
    type MetricEvent,
    type MetricsSink,
    type SystemOneQuestion,
} from '../src/index.ts'

function mockAsker(responses: Array<{text: string; usage?: {promptTokens: number; completionTokens: number; totalTokens: number; available: boolean}}>) {
    let index = 0
    const completion = new CompletionEngine([]).registerAdapter({
        id: 'mock',
        async generate() {
            const response = responses[Math.min(index, responses.length - 1)]!
            index += 1
            return {
                ok: true,
                text: response.text,
                usage: response.usage,
                model: {providerId: 'mock', modelId: 'mock-model'},
            }
        },
    })

    return new Asker({
        providers: {mock: {id: 'mock', available: true}},
        completion,
        defaultModel: 'mock/mock-model',
    })
}

describe('correlated performance metrics', () => {
    it('records every actual Asker provider call, including structured repair retries', async () => {
        const sink = new InMemoryMetricsStore()
        const asker = mockAsker([
            {
                text: 'not-json',
                usage: {promptTokens: 10, completionTokens: 2, totalTokens: 12, available: true},
            },
            {
                text: '{"value":1}',
                usage: {promptTokens: 14, completionTokens: 4, totalTokens: 18, available: true},
            },
        ])

        const result = await asker.json('return value', z.object({value: z.number()}), {
            maxRetries: 1,
            metrics: {traceId: 'trace-ask', taskClass: 'test'},
            metricsSink: sink,
        })

        expect(result.ok).toBe(true)
        const events = sink.query({kind: 'llm', traceId: 'trace-ask', order: 'asc'})
        expect(events).toHaveLength(2)
        expect(events.map(event => event.kind === 'llm' ? event.attempt : 0)).toEqual([1, 2])
        expect(events.every(event => event.traceId === 'trace-ask')).toBe(true)
    })

    it('correlates Actor and child Asker calls without duplicating token accounting', async () => {
        const sink = new InMemoryMetricsStore()
        const asker = mockAsker([{
            text: JSON.stringify({
                thought: 'Done',
                action: 'final_answer',
                finalAnswer: 'finished',
            }),
            usage: {promptTokens: 20, completionTokens: 5, totalTokens: 25, available: true},
        }])
        const actor = new LLMActor(asker)

        const result = await actor.run('finish', {
            metrics: {traceId: 'trace-actor', taskClass: 'resolve'},
            metricsSink: sink,
        })

        expect(result.ok).toBe(true)
        const events = sink.query({traceId: 'trace-actor'})
        const actorEvent = events.find((event): event is Extract<MetricEvent, {kind: 'actor'}> => event.kind === 'actor')
        const llmEvents = events.filter((event): event is Extract<MetricEvent, {kind: 'llm'}> => event.kind === 'llm')
        expect(actorEvent).toBeDefined()
        expect(llmEvents).toHaveLength(1)
        expect(llmEvents[0]!.parentSpanId).toBe(actorEvent!.spanId)
        expect(llmEvents[0]!.totalTokens).toBe(25)
        expect(actorEvent!.metadata?.totalTokens).toBeUndefined()
    })

    it('records System-1 fallback attempts under one trace without logging inputs', async () => {
        const sink = new InMemoryMetricsStore()
        const questions: Record<string, SystemOneQuestion> = {
            route: {
                type: 'choice',
                instructions: 'Choose route',
                criteria: {fast: 'Fast', deep: 'Deep'},
            },
        }
        const systemOne = new FallbackSystemOne([
            new LayaSystemOne({id: 'missing', load: async () => null}),
            new LayaSystemOne({
                id: 'working',
                quality: 'medium',
                load: async () => ({
                    async systemOne() {
                        return {answers: {route: {choice: 'fast', probabilities: {fast: 1}}}}
                    },
                }),
            }),
        ])

        const result = await systemOne.assess(
            {secret: 'must-not-be-recorded'},
            questions,
            {metrics: {traceId: 'trace-s1'}, metricsSink: sink},
        )

        expect(result?.backendId).toBe('working')
        const events = sink.query({kind: 'system1', traceId: 'trace-s1', order: 'asc'})
        expect(events).toHaveLength(2)
        expect(events.every(event => !JSON.stringify(event).includes('must-not-be-recorded'))).toBe(true)
    })

    it('never lets a failing sink fail the measured operation', async () => {
        const sink: MetricsSink = {
            append() {
                throw new Error('metrics unavailable')
            },
        }
        const asker = mockAsker([{text: 'ok'}])
        const result = await asker.ask('hello', {
            metrics: {traceId: 'trace-failure'},
            metricsSink: sink,
        })
        expect(result.ok).toBe(true)
        expect(result.text).toBe('ok')
    })
})
