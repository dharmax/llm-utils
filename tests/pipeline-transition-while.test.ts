import {expect, test} from 'bun:test'
import {LLMPipeline, type Asker, type PlanStep, z} from '../src/index.ts'

const read = {name: 'read', description: 'Read observation', parameters: z.object({}), execute: () => 'observed'}
const stage = (id: string, dependsOn?: string[]): PlanStep => ({id, description: id, assignedTools: ['read'], dependsOn})

function setup(steps: PlanStep[]) {
    const visited: string[] = []
    const asker = {
        json: async (prompt: string) => {
            const name = prompt.match(/## Goal\n([^\n]+)/)?.[1] ?? ''
            visited.push(name)
            return {ok: true, data: {thought: 'done', action: 'final_answer', finalAnswer: name}}
        },
        ask: async () => ({ok: true, text: 'Complete'}),
    } as unknown as Asker
    return {visited, pipeline: new LLMPipeline(asker, {
        tools: [read],
        preprocessor: {async preprocess(goal) {
            return {normalizedGoal: goal, constraints: [], relevantTools: [], suggestedPhases: []}
        }},
        planner: {async plan() {return {strategy: 'script', steps}}},
    })}
}

test('while cursor moves to exact forward goto target and ends after last stage', async () => {
    const {visited, pipeline} = setup([stage('a'), stage('skipped'), stage('c')])
    const result = await pipeline.run('branch', {
        onTransition: ({step}) => step.id === 'a'
            ? {action: 'goto', stepId: 'c'} : {action: 'next'},
    })
    expect(result.ok).toBe(true)
    expect(visited).toEqual(['a', 'c'])
    expect(result.executionHistory?.map(item => item.stepId)).toEqual(['a', 'c'])
    expect(result.stepOutputs.skipped).toBeUndefined()
})

test('backward goto reexecutes its target, invalidates downstream and preserves history', async () => {
    const {visited, pipeline} = setup([stage('a'), stage('b', ['a']), stage('c', ['b'])])
    let bVisits = 0
    const result = await pipeline.run('loop', {maxStageExecutions: 5,
        onTransition: ({step}) => {
            switch (step.id) {
                case 'b':
                    return ++bVisits === 1 ? {action: 'goto', stepId: 'a'} : {action: 'next'}
                default: return {action: 'next'}
            }
        },
    })
    expect(result.ok).toBe(true)
    expect(visited).toEqual(['a', 'b', 'a', 'b', 'c'])
    expect(result.executionHistory?.map(item => item.stepId)).toEqual(visited)
    expect(Object.keys(result.stepOutputs).sort()).toEqual(['a', 'b', 'c'])
})
