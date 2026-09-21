import {expect, test} from 'bun:test'
import {LLMPipeline, type Asker, type PlanStep, z} from '../src/index.ts'

const tool = {name: 'inspect', description: 'Observe a value', parameters: z.object({}), execute: () => ({value: 1})}
const stage = (id: string, dependsOn?: string[]): PlanStep => ({id, description: id, dependsOn, assignedTools: ['inspect']})

function pipeline(steps: PlanStep[], asker: Asker, onException?: () => {action: 'skip'}) {
    return new LLMPipeline(asker, {
        tools: [tool], onException,
        preprocessor: {async preprocess(goal) {
            return {normalizedGoal: goal, constraints: [], relevantTools: ['inspect'], suggestedPhases: []}
        }},
        planner: {async plan() {return {strategy: 'test', steps}}},
    })
}

test('a skipped stage requires an explicit decision and cannot silently succeed', async () => {
    const asker = {
        json: async () => ({ok: true, data: {thought: 'broken', action: 'tool_call',
            toolCalls: [{name: 'missing_tool', parameters: {}}]}}),
        ask: async () => ({ok: true, text: 'final'}),
    } as unknown as Asker
    const build = () => pipeline([stage('optional')], asker, () => ({action: 'skip'}))
    const rejected = await build().run('Inspect', {onTransition: () => undefined})
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toContain('explicitly resolve skipped')

    const advanced = await build().run('Inspect', {onTransition: ({outcome}) => {
        expect(outcome).toBe('skipped')
        return {action: 'next'}
    }})
    expect(advanced.ok).toBe(false)
    expect(advanced.error).toContain('Unresolved skipped or substituted')
    expect(advanced.executionHistory?.[0]?.outcome).toBe('skipped')
})

test('a skipped prerequisite cannot satisfy dependent work', async () => {
    const asker = {
        json: async () => ({ok: true, data: {thought: 'broken', action: 'tool_call',
            toolCalls: [{name: 'missing_tool', parameters: {}}]}}),
        ask: async () => ({ok: true, text: 'final'}),
    } as unknown as Asker
    const result = await pipeline([stage('first'), stage('dependent', ['first'])], asker,
        () => ({action: 'skip'})).run('Inspect', {onTransition: () => ({action: 'next'})})
    expect(result.ok).toBe(false)
    expect(result.error).toContain('unsatisfied dependencies')
    expect(result.executionHistory?.map(item => item.stepId)).toEqual(['first'])
})

test('loop rewind never injects a previous result invalidated by the jump', async () => {
    const prompts: string[] = []
    const asker = {
        json: async (prompt: string) => {
            prompts.push(prompt)
            return {ok: true, data: {thought: 'finished', action: 'final_answer', finalAnswer: 'observed'}}
        },
        ask: async () => ({ok: true, text: 'final'}),
    } as unknown as Asker
    let checks = 0
    const result = await pipeline([stage('sample'), stage('check', ['sample'])], asker).run('Inspect', {
        onTransition: ({step}) => step.id === 'check' && ++checks === 1
            ? {action: 'goto', stepId: 'sample'} : undefined,
    })
    expect(result.ok).toBe(true)
    expect(result.executionHistory?.map(item => item.stepId)).toEqual(['sample', 'check', 'sample', 'check'])
    const samplePrompts = prompts.filter(text => text.includes('## Goal\nsample'))
    expect(samplePrompts).toHaveLength(2)
    expect(samplePrompts[1]).not.toContain('Previous Stage (check)')
})
