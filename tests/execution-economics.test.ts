import {describe, expect, it} from 'bun:test'
import {z} from 'zod'
import {Asker, CompletionEngine, InMemoryMetricsStore, LlmMetrics, LLMActor, ToolExecutionError, calculateUsageCost} from '../src/index.ts'

describe('truthful execution economics', () => {
    it('keeps local/remote usage and known/unknown price independent, including zero prices', async () => {
        const store = new InMemoryMetricsStore(), completion = new CompletionEngine()
        completion.registerAdapter({id: 'fixture', generate: async ({modelId}) => ({ok: true, text: 'ok', model: {providerId: 'fixture', modelId}, usage: {promptTokens: 100, completionTokens: 50, totalTokens: 150, available: true}})})
        const asker = new Asker({providers: {fixture: {id: 'fixture', local: true}}, completion, metricsSink: store})
        await asker.ask('PRIVATE', {model: 'fixture/local'})
        await asker.ask('PRIVATE', {model: 'fixture/remote-priced', providerConfig: {id: 'fixture', local: false, pricing: {inputCostPerMillionTokensUsd: 2, outputCostPerMillionTokensUsd: 4}}})
        await asker.ask('PRIVATE', {model: 'fixture/remote-free', providerConfig: {id: 'fixture', local: false, pricing: {inputCostPerMillionTokensUsd: 0, outputCostPerMillionTokensUsd: 0}}})
        await asker.ask('PRIVATE', {model: 'fixture/remote-unknown', providerConfig: {id: 'fixture', local: false}})
        const metrics = new LlmMetrics(store), totals = metrics.totals()
        expect(totals.execution.local).toMatchObject({calls: 1, promptTokens: 100, completionTokens: 50, totalTokens: 150})
        expect(totals.execution.remote).toMatchObject({calls: 3, totalTokens: 450, knownCostUsd: 0.0004, costKnownCalls: 2, unknownCostTokens: 150})
        expect(totals.totalCostUsd).toBeNull()
        expect(metrics.byModel().find(row => row.modelId === 'remote-free')?.metrics.totalCostUsd).toBe(0)
        expect(metrics.byModel().find(row => row.modelId === 'remote-unknown')?.metrics.totalCostUsd).toBeNull()
        expect(JSON.stringify(store.query())).not.toContain('PRIVATE')
        expect(calculateUsageCost({promptTokens: 100, completionTokens: 50, totalTokens: 150, available: true}, {inputCostPerMillionTokensUsd: 2})).toBeNull()
        expect(calculateUsageCost({promptTokens: 100, completionTokens: 50, totalTokens: 150, available: false}, {inputCostPerMillionTokensUsd: 0, outputCostPerMillionTokensUsd: 0})).toBeNull()
    })
    it('preserves provider-reported remote cost, including explicitly reported zero', async () => {
        const server = Bun.serve({port: 0, fetch: () => Response.json({choices: [{message: {content: 'ok'}, finish_reason: 'stop'}], usage: {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost: 0}})})
        try {
            const store = new InMemoryMetricsStore()
            const asker = new Asker({providers: {openrouter: {id: 'openrouter', baseUrl: server.url.toString(), local: false}}, metricsSink: store})
            const result = await asker.ask('PRIVATE', {model: 'openrouter/fixture'})
            expect(result.costUsd).toBe(0)
            expect(new LlmMetrics(store).totals().execution.remote).toMatchObject({knownCostUsd: 0, costKnownCalls: 1, unknownCostTokens: 0})
        } finally {server.stop(true)}
    })
    it('keeps legacy events unclassified rather than inventing locality', () => {
        const metrics = new LlmMetrics()
        metrics.record({timestamp: new Date().toISOString(), providerId: 'ollama', modelId: 'old', promptTokens: 8, completionTokens: 2, latencyMs: 3, success: true})
        expect(metrics.totals().execution.unknown.totalTokens).toBe(10)
        expect(metrics.totals().execution.local.totalTokens).toBe(0)
        expect(metrics.totals().totalCostUsd).toBeNull()
    })
    it('categorizes parameter, not-found and safety-preview failures without storing arguments', async () => {
        const store = new InMemoryMetricsStore()
        const replies = [
            {thought: 'Observe failure', action: 'tool_call', toolCalls: [{name: 'number', parameters: {value: 'bad'}}]},
            {thought: 'Observe failure', action: 'tool_call', toolCalls: [{name: 'find', parameters: {}}]},
            {thought: 'Observe failure', action: 'tool_call', toolCalls: [{name: 'preview', parameters: {}}]},
            {thought: 'Finished', action: 'final_answer', finalAnswer: 'done'},
        ]
        const asker = {json: async () => ({ok: true, data: replies.shift(), text: '', model: {providerId: 'fixture', modelId: 'fixture'}})} as unknown as Asker
        const actor = new LLMActor(asker, {tools: [
            {name: 'number', description: 'Number', parameters: z.object({value: z.number()}), execute: async () => null},
            {name: 'find', description: 'Find', parameters: z.object({}), execute: async () => {throw new ToolExecutionError('No match', undefined, 'not_found')}},
            {name: 'preview', description: 'Preview', parameters: z.object({}), execute: async () => {throw new ToolExecutionError('Unsafe', undefined, 'safety_preview')}},
        ]})
        const result = await actor.run('PRIVATE', {metricsSink: store})
        expect(result.ok).toBe(true)
        const event = store.query({kind: 'actor'})[0]
        expect(event).toMatchObject({toolCalls: 3, toolFailures: 3, toolFailureCategories: {malformed_parameters: 1, not_found: 1, safety_preview: 1}})
        expect(JSON.stringify(event)).not.toContain('PRIVATE')
        expect(JSON.stringify(event)).not.toContain('"parameters":')
    })
})
