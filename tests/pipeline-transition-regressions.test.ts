import {expect, test} from 'bun:test'
import {LLMPipeline, type Asker, type PlanStep, z} from '../src/index.ts'

const inspect = {
    name: 'inspect', description: 'Read a value', parameters: z.object({}),
    execute: () => ({reading: 42}),
}

function makePipeline(steps: PlanStep[], decide: (prompt: string) => unknown) {
    let syntheses = 0
    const asker = {
        json: async (prompt: string) => ({ok: true, data: decide(prompt)}),
        ask: async () => {
            syntheses++
            return {ok: true, text: 'Synthesized'}
        },
    } as unknown as Asker
    const pipeline = new LLMPipeline(asker, {
        tools: [inspect],
        maxStepsPerPhase: 2,
        preprocessor: {async preprocess(goal) {
            return {normalizedGoal: goal, constraints: [], relevantTools: ['inspect'], suggestedPhases: []}
        }},
        planner: {async plan() {return {strategy: 'Fixed stages', steps}}},
    })
    return {pipeline, syntheses: () => syntheses}
}

const stage = (id: string, dependsOn?: string[]): PlanStep => ({
    id, description: id, assignedTools: ['inspect'], dependsOn,
})

test('a skipped stage followed by an explicit next is not successful completion', async () => {
    const {pipeline, syntheses} = makePipeline([stage('required'), stage('report')], prompt =>
        prompt.includes('## Goal\nrequired')
            ? {thought: 'fail', action: 'tool_call', toolCalls: [{name: 'missing_tool', parameters: {}}]}
            : {thought: 'done', action: 'final_answer', finalAnswer: 'Report'})
    const result = await pipeline.run('Do required work', {
        onException: () => ({action: 'skip'}),
        onTransition: () => ({action: 'next'}),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unresolved skipped or substituted')
    expect(result.executionHistory?.map(item => item.outcome)).toEqual(['skipped', 'completed'])
    expect(syntheses()).toBe(0)
})

test('a fallback is never automatically promoted into success in transition mode', async () => {
    const {pipeline, syntheses} = makePipeline([stage('required')], () => ({
        thought: 'fail', action: 'tool_call', toolCalls: [{name: 'missing_tool', parameters: {}}],
    }))
    const result = await pipeline.run('Do required work', {
        onException: () => ({action: 'continue', fallbackOutput: 'cache'}),
        onTransition: () => ({action: 'next'}),
    })
    expect(result.ok).toBe(false)
    expect(result.stepOutputs.required).toBe('cache')
    expect(result.error).toContain('Unresolved skipped or substituted')
    expect(syntheses()).toBe(0)
})

test('retry clears an unresolved result and uses corrective wisdom', async () => {
    const {pipeline} = makePipeline([stage('read')], prompt => {
        if (prompt.includes('Corrective Guidance / Wisdom')) {
            if (prompt.includes('Prior Action History'))
                return {thought: 'done', action: 'final_answer', finalAnswer: 'Reading: 42'}
            return {thought: 'read', action: 'tool_call', toolCalls: [{name: 'inspect', parameters: {}}]}
        }
        return {thought: 'guess', action: 'final_answer', finalAnswer: 'Unobserved'}
    })
    const result = await pipeline.run('Read', {
        onTransition: ({result}) => result.steps.some(s => s.toolResults.some(t => !t.isError))
            ? {action: 'next'} : {action: 'retry', wisdom: 'Obtain an actual observation'},
    })
    expect(result.ok).toBe(true)
    expect(result.executionHistory?.map(item => item.stepId)).toEqual(['read', 'read'])
    expect(result.stepOutputs.read).toBe('Reading: 42')
})

test('branch callback can reject a claimed success with no observations', async () => {
    const {pipeline} = makePipeline([stage('read')], () => ({
        thought: 'guess', action: 'final_answer', finalAnswer: 'Everything is fine',
    }))
    const result = await pipeline.run('Investigate', {
        maxStageExecutions: 3,
        onTransition: ({result}) => result.steps.some(s => s.toolResults.some(t => !t.isError))
            ? {action: 'next'} : {action: 'retry', wisdom: 'Collect evidence'},
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Transition retries exhausted')
    expect(result.executionHistory).toHaveLength(3)
})
