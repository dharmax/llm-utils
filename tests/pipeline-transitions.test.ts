import {expect, test} from 'bun:test'
import {LLMPipeline, type Asker, type PlanStep, z} from '../src/index.ts'

const readTool = {name: 'inspect', description: 'Read a value', parameters: z.object({}), execute: () => ({value: 42})}

function harness(steps: PlanStep[], decide?: (goal: string, prompt: string) => unknown) {
    const visited: string[] = []
    const asker = {
        json: async (prompt: string) => {
            const goal = prompt.match(/## Goal\n([^\n]+)/)?.[1] ?? ''
            visited.push(goal)
            const decision = decide?.(goal, prompt) ?? {thought: 'Complete', action: 'final_answer', finalAnswer: `Result of ${goal}`}
            return {ok: true, data: decision}
        },
        ask: async () => ({ok: true, text: 'Synthesis completed'}),
    } as unknown as Asker
    const pipeline = new LLMPipeline(asker, {
        tools: [readTool],
        preprocessor: {async preprocess(goal) {
            return {normalizedGoal: goal, constraints: [], relevantTools: ['inspect'], suggestedPhases: []}
        }},
        planner: {async plan() {return {strategy: 'Scripted', steps}}},
    })
    return {pipeline, visited}
}

const stage = (id: string, dependsOn?: string[]): PlanStep => ({id, description: id, assignedTools: ['inspect'], dependsOn})

test('without transitions the original happy path remains sequential', async () => {
    const {pipeline, visited} = harness([stage('one'), stage('two')])
    const result = await pipeline.run('Do both')
    expect(result.ok).toBe(true)
    expect(visited).toEqual(['one', 'two'])
    expect(result.executionHistory).toBeUndefined()
})

test('switch-style branching executes the chosen path and joins', async () => {
    const steps = [stage('inspect'), stage('memory'), stage('cpu'), stage('finish')]
    for (const branch of ['memory', 'cpu'] as const) {
        const {pipeline, visited} = harness(steps)
        const result = await pipeline.run('Diagnose', {onTransition: ({step}) => {
            switch (step.id) {
                case 'inspect': return {action: 'goto', stepId: branch}
                case 'memory':
                case 'cpu': return {action: 'goto', stepId: 'finish'}
            }
        }})
        expect(result.ok).toBe(true)
        expect(visited).toEqual(['inspect', branch, 'finish'])
        expect(result.executionHistory?.map(item => item.stepId)).toEqual(visited)
    }
})

test('unknown condition takes an explicit observation path', async () => {
    const {pipeline, visited} = harness([stage('inspect'), stage('memory'), stage('cpu'), stage('gather'), stage('finish')])
    const result = await pipeline.run('Diagnose', {onTransition: ({step}) => {
        if (step.id === 'inspect') return {action: 'goto', stepId: 'gather'}
        if (step.id === 'gather') return {action: 'goto', stepId: 'finish'}
    }})
    expect(result.ok).toBe(true)
    expect(visited).toEqual(['inspect', 'gather', 'finish'])
})

test('backward goto loops with bounded visits and chronological history', async () => {
    const {pipeline, visited} = harness([stage('sample'), stage('check', ['sample']), stage('report', ['check'])])
    let checks = 0
    const result = await pipeline.run('Sample until ready', {maxStageExecutions: 7,
        onTransition: ({step, history}) => {
            if (step.id === 'check' && ++checks < 3) {
                expect(history.at(-1)?.stepId).toBe('check')
                return {action: 'goto', stepId: 'sample'}
            }
        },
    })
    expect(result.ok).toBe(true)
    expect(visited).toEqual(['sample', 'check', 'sample', 'check', 'sample', 'check', 'report'])
    expect(result.executionHistory).toHaveLength(7)
})

test('unbounded conditional cycle stops at the configured stage budget', async () => {
    const {pipeline} = harness([stage('repeat')])
    const result = await pipeline.run('Loop', {maxStageExecutions: 3,
        onTransition: () => ({action: 'goto', stepId: 'repeat'}),
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('budget exceeded')
    expect(result.executionHistory).toHaveLength(3)
})

test('unknown destinations, skipped prerequisites and duplicate IDs fail closed', async () => {
    const missing = harness([stage('start')]).pipeline
    const invalid = await missing.run('Test', {onTransition: () => ({action: 'goto', stepId: 'invented'})})
    expect(invalid.ok).toBe(false)
    expect(invalid.error).toContain('Unknown transition target')

    const prereq = harness([stage('start'), stage('required'), stage('finish', ['required'])]).pipeline
    const skipped = await prereq.run('Test', {onTransition: ({step}) => step.id === 'start'
        ? {action: 'goto', stepId: 'finish'} : undefined})
    expect(skipped.ok).toBe(false)
    expect(skipped.error).toContain('unsatisfied dependencies')

    const duplicate = harness([stage('same'), stage('same')]).pipeline
    const duplicated = await duplicate.run('Test', {onTransition: () => undefined})
    expect(duplicated.ok).toBe(false)
    expect(duplicated.error).toContain('duplicate stage IDs')
})

test('transition callback can reject premature success and retry with wisdom', async () => {
    const {pipeline, visited} = harness([stage('inspect')], (_goal, prompt) => {
        if (prompt.includes('Corrective Guidance / Wisdom')) {
            if (prompt.includes('Prior Action History'))
                return {thought: 'Observed', action: 'final_answer', finalAnswer: '42'}
            return {thought: 'Observe', action: 'tool_call', toolCalls: [{name: 'inspect', parameters: {}}]}
        }
        return {thought: 'Guess', action: 'final_answer', finalAnswer: 'No observation needed'}
    })
    const result = await pipeline.run('Inspect', {maxStageExecutions: 3,
        onTransition: ({result}) => result.steps.some(step => step.toolResults.some(res => !res.isError))
            ? {action: 'next'} : {action: 'retry', wisdom: 'Collect an actual observation'},
    })
    expect(result.ok).toBe(true)
    expect(visited).toEqual(['inspect', 'inspect', 'inspect'])
    expect(result.executionHistory).toHaveLength(2)
    expect(result.executionHistory?.[1]?.result.steps.some(step => step.toolResults.some(res => !res.isError))).toBe(true)
})

test('missing assigned tool never exposes the rest of the catalog', async () => {
    const {pipeline, visited} = harness([{...stage('inspect'), assignedTools: ['not_registered']}])
    const result = await pipeline.run('Inspect')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('unavailable tools')
    expect(visited).toEqual([])
})
