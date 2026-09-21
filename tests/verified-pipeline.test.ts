import {expect, test} from 'bun:test'
import {Asker, CompletionEngine, LLMPipeline, z} from '../src/index.ts'

const tool = {
    name: 'inspect', description: 'Read an observation', parameters: z.object({}),
    execute: async () => ({reading: 42}),
}

function askerFor(decide: (prompt: string) => string) {
    const completion = new CompletionEngine([]).registerAdapter({
        id: 'verified-test',
        async generate(options) {
            return {ok: true, text: decide(options.prompt),
                model: {providerId: 'verified-test', modelId: options.modelId}}
        },
    })
    return new Asker({providers: {'verified-test': {id: 'verified-test', available: true}},
        completion, routes: {default: 'verified-test/test'}})
}

const prep = {async preprocess(goal: string) {
    return {normalizedGoal: goal, constraints: ['Do not modify'], relevantTools: ['inspect'], suggestedPhases: ['observe']}
}}
const plan = {async plan() {return {strategy: 'Observe', steps: [{id: 'observe', description: 'Observe', assignedTools: ['inspect']}]}}}

test('verified stage rejects an immediate explanation and recovers through onException', async () => {
    let exceptions = 0
    const asker = askerFor(prompt => {
        if (prompt.includes('Synthesize the final')) return 'Observed value: 42'
        if (prompt.includes('Prior Action History')) return JSON.stringify({thought: 'I have a reading', action: 'final_answer', finalAnswer: '42'})
        if (prompt.includes('Corrective Guidance / Wisdom')) return JSON.stringify({thought: 'Collect first', action: 'tool_call', toolCalls: [{name: 'inspect', parameters: {}}]})
        return JSON.stringify({thought: 'Guess', action: 'final_answer', finalAnswer: 'Everything is fine'})
    })
    const result = await new LLMPipeline(asker, {
        tools: [tool], preprocessor: prep, planner: plan, verified: true,
        stageValidator: ({result}) => result.steps.some(step => step.toolResults.some(res => !res.isError))
            ? {ok: true} : {ok: false, reason: 'No host observation'},
        onException: exception => {exceptions++; expect(exception.error).toBe('No host observation'); return {action: 'retry', wisdom: 'Collect an observation first'}},
    }).run('Inspect my computer')
    expect(exceptions).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.verification).toBe('verified')
    expect(result.phaseTraces.observe.some(step => step.toolResults.some(res => !res.isError))).toBe(true)
})

test('verified plan refuses unregistered tools rather than widening scope', async () => {
    const asker = askerFor(() => JSON.stringify({thought: 'done', action: 'final_answer', finalAnswer: 'done'}))
    const result = await new LLMPipeline(asker, {
        tools: [tool], preprocessor: prep, verified: true,
        planner: {async plan() {return {strategy: 'bad', steps: [{id: 'one', description: 'Do it', assignedTools: ['nonexistent']}]}}},
    }).run('Inspect')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unregistered tool')
})

test('verified pipeline reports unverified fallback as incomplete', async () => {
    const asker = askerFor(prompt => prompt.includes('Synthesize the final') ? 'Claimed success' :
        JSON.stringify({thought: 'Guess', action: 'final_answer', finalAnswer: 'done'}))
    const result = await new LLMPipeline(asker, {
        tools: [tool], preprocessor: prep, planner: plan, verified: true,
        stageValidator: () => ({ok: false, reason: 'Missing evidence'}),
        onException: () => ({action: 'continue', fallbackOutput: 'Unverified cache'}),
    }).run('Inspect')
    expect(result.ok).toBe(false)
    expect(result.stepOutputs.observe).toBe('Unverified cache')
    expect(result.error).toContain('unverified fallback')
})

test('verified pipeline refuses missing and out-of-order dependencies', async () => {
    const asker = askerFor(() => JSON.stringify({thought: 'done', action: 'final_answer', finalAnswer: 'done'}))
    const result = await new LLMPipeline(asker, {
        tools: [tool], preprocessor: prep, verified: true,
        planner: {async plan() {return {strategy: 'bad', steps: [{id: 'one', description: 'Do it', assignedTools: ['inspect'], dependsOn: ['two']}]}}},
    }).run('Inspect')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('out-of-order dependency')
})
