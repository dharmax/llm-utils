import {expect, test} from 'bun:test'
import {availableTransitionTargets, LLMPipeline, type Asker, type PlanStep} from '../src/index.ts'

const step = (id: string, description: string, dependsOn?: string[]): PlanStep =>
    ({id, description, assignedTools: [], dependsOn})

function makePipeline(steps: PlanStep[]) {
    const asker = {
        json: async () => ({ok: true, data: {
            thought: 'Finished', action: 'final_answer', finalAnswer: 'Observation complete',
        }}),
        ask: async () => ({ok: true, text: 'Final synthesis'}),
    } as unknown as Asker
    return new LLMPipeline(asker, {
        preprocessor: {async preprocess(goal) {
            return {normalizedGoal: goal, constraints: [], relevantTools: [], suggestedPhases: []}
        }},
        planner: {async plan() {return {strategy: 'Test', steps}}},
    })
}

test('callback can enumerate meaningful destinations without guessing IDs or dependencies', async () => {
    const steps = [
        step('inspect', 'Collect baseline'),
        step('memory', 'Investigate memory', ['inspect']),
        step('cpu', 'Investigate CPU', ['inspect']),
        step('report', 'Write findings', ['memory']),
    ]
    const targetNames: string[][] = []
    const result = await makePipeline(steps).run('Diagnose', {onTransition: context => {
        targetNames.push(availableTransitionTargets(context).map(target => target.description))
        switch (context.step.id) {
            case 'inspect': return {action: 'goto', stepId: 'memory'}
            case 'memory': return {action: 'goto', stepId: 'report'}
        }
    }})
    expect(result.ok).toBe(true)
    expect(targetNames[0]).toEqual(['Collect baseline', 'Investigate memory', 'Investigate CPU'])
    expect(targetNames[1]).toContain('Write findings')
})

test('target list drops invalidated prerequisites after a backward transition', async () => {
    const steps = [
        step('sample', 'Sample'),
        step('check', 'Check sample', ['sample']),
        step('report', 'Report', ['check']),
    ]
    const seen: string[][] = []
    let checks = 0
    const result = await makePipeline(steps).run('Diagnose', {onTransition: context => {
        seen.push(availableTransitionTargets(context).map(target => target.id))
        if (context.step.id === 'check' && ++checks === 1)
            return {action: 'goto', stepId: 'sample'}
    }})
    expect(result.ok).toBe(true)
    // After re-sampling, the previous check was invalidated; reporting isn't reachable yet.
    expect(seen[2]).toEqual(['sample', 'check'])
    expect(result.executionHistory?.map(entry => entry.stepId))
        .toEqual(['sample', 'check', 'sample', 'check', 'report'])
})
