import {expect, test} from 'bun:test'
import {
    Asker,
    CompletionEngine,
    LLMActor,
    z,
} from '../src/index.ts'

function createMockAsker(responses: any[]) {
    let callIndex = 0
    const completion = new CompletionEngine([]).registerAdapter({
        id: 'mock',
        async generate() {
            const resp = responses[callIndex] ?? responses[responses.length - 1]
            callIndex += 1
            return {
                ok: true,
                text: typeof resp === 'string' ? resp : JSON.stringify(resp),
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

test('LLMActor registers, retrieves, and unregisters tools', () => {
    const asker = createMockAsker([])
    const actor = new LLMActor(asker)

    const tool = {
        name: 'test_tool',
        description: 'A test tool',
        parameters: z.object({query: z.string()}),
        execute: ({query}: {query: string}) => `echo:${query}`,
    }

    actor.registerTool(tool)
    expect(actor.getTools().length).toBe(1)
    expect(actor.getTool('test_tool')?.name).toBe('test_tool')

    actor.unregisterTool('test_tool')
    expect(actor.getTools().length).toBe(0)
    expect(actor.getTool('test_tool')).toBeUndefined()
})

test('LLMActor.step returns final_answer when model decides goal is achieved', async () => {
    const asker = createMockAsker([
        {
            thought: 'The answer is known directly.',
            action: 'final_answer',
            finalAnswer: 'Paris is the capital of France.',
        },
    ])

    const actor = new LLMActor(asker)
    const result = await actor.step('What is the capital of France?')

    expect(result.isDone).toBe(true)
    expect(result.record.action).toBe('final_answer')
    expect(result.record.finalAnswer).toBe('Paris is the capital of France.')
    expect(result.record.step).toBe(1)
})

test('LLMActor.step executes tool and records execution result', async () => {
    const asker = createMockAsker([
        {
            thought: 'Need to compute 2 + 2.',
            action: 'tool_call',
            toolCalls: [
                {callId: 'c1', name: 'add', parameters: {a: 2, b: 2}},
            ],
        },
    ])

    let executed = false
    const actor = new LLMActor(asker, {
        tools: [
            {
                name: 'add',
                description: 'Add two numbers',
                parameters: z.object({a: z.number(), b: z.number()}),
                execute: ({a, b}: {a: number; b: number}) => {
                    executed = true
                    return a + b
                },
            },
        ],
    })

    const result = await actor.step('Compute 2 + 2')
    expect(executed).toBe(true)
    expect(result.isDone).toBe(false)
    expect(result.record.toolCalls.length).toBe(1)
    expect(result.record.toolResults.length).toBe(1)
    expect(result.record.toolResults[0].callId).toBe('c1')
    expect(result.record.toolResults[0].isError).toBe(false)
    expect(result.record.toolResults[0].result).toBe(4)
})

test('LLMActor.run orchestrates multi-turn loop to completion', async () => {
    const asker = createMockAsker([
        // Turn 1: Call lookup
        {
            thought: 'Lookup user status first.',
            action: 'tool_call',
            toolCalls: [
                {callId: 'c1', name: 'getUser', parameters: {userId: 'u123'}},
            ],
        },
        // Turn 2: Final answer based on tool result
        {
            thought: 'User is active. Report status.',
            action: 'final_answer',
            finalAnswer: 'User u123 is active.',
        },
    ])

    const stepsObserved: any[] = []
    const actor = new LLMActor(asker, {
        tools: [
            {
                name: 'getUser',
                description: 'Fetch user details',
                parameters: z.object({userId: z.string()}),
                execute: ({userId}: {userId: string}) => ({id: userId, active: true}),
            },
        ],
        onStep: (record) => {
            stepsObserved.push(record)
        },
    })

    const result = await actor.run('Check user u123 status')

    expect(result.ok).toBe(true)
    expect(result.haltReason).toBe('completed')
    expect(result.totalSteps).toBe(2)
    expect(result.finalText).toBe('User u123 is active.')
    expect(stepsObserved.length).toBe(2)
})

test('LLMActor catches and contains tool exceptions without crashing', async () => {
    const asker = createMockAsker([
        {
            thought: 'Calling failing tool.',
            action: 'tool_call',
            toolCalls: [
                {callId: 'c1', name: 'failingTool', parameters: {}},
            ],
        },
    ])

    const actor = new LLMActor(asker, {
        tools: [
            {
                name: 'failingTool',
                description: 'Throws error',
                parameters: z.object({}),
                execute: () => {
                    throw new Error('Connection refused')
                },
            },
        ],
    })

    const result = await actor.step('Trigger failure')
    expect(result.isDone).toBe(false)
    expect(result.record.toolResults[0].isError).toBe(true)
    expect(result.record.toolResults[0].error).toBe('Connection refused')
})

test('LLMActor validates tool parameters against Zod schema', async () => {
    const asker = createMockAsker([
        {
            thought: 'Call tool with wrong types.',
            action: 'tool_call',
            toolCalls: [
                {callId: 'c1', name: 'strictTool', parameters: {count: 'not-a-number'}},
            ],
        },
    ])

    let executed = false
    const actor = new LLMActor(asker, {
        tools: [
            {
                name: 'strictTool',
                description: 'Requires number',
                parameters: z.object({count: z.number()}),
                execute: () => {
                    executed = true
                },
            },
        ],
    })

    const result = await actor.step('Call strict')
    expect(executed).toBe(false)
    expect(result.record.toolResults[0].isError).toBe(true)
    expect(result.record.toolResults[0].error).toMatch(/Invalid parameters/)
})

test('LLMActor handles unregistered tool gracefully', async () => {
    const asker = createMockAsker([
        {
            thought: 'Call hallucinated tool.',
            action: 'tool_call',
            toolCalls: [
                {callId: 'c1', name: 'phantom', parameters: {}},
            ],
        },
    ])

    const actor = new LLMActor(asker)
    const result = await actor.step('Call phantom')
    expect(result.record.toolResults[0].isError).toBe(true)
    expect(result.record.toolResults[0].error).toMatch(/not registered/)
})

test('LLMActor delegates to onMissingTool when tool is not registered', async () => {
    const asker = createMockAsker([
        {
            thought: 'Call dynamic tool.',
            action: 'tool_call',
            toolCalls: [
                {callId: 'c1', name: 'dynamicFilter', parameters: {limit: 5}},
            ],
        },
    ])

    const actor = new LLMActor(asker, {
        onMissingTool: (toolName, params) => {
            if (toolName === 'dynamicFilter') {
                return {
                    callId: 'c1',
                    toolName,
                    isError: false,
                    result: {filteredCount: params.limit},
                }
            }
            return undefined
        },
    })

    const result = await actor.step('Call dynamic')
    expect(result.record.toolResults[0].isError).toBe(false)
    expect((result.record.toolResults[0].result as any).filteredCount).toBe(5)
})

test('LLMActor.run halts with max_steps_exceeded when budget is exhausted', async () => {
    const asker = createMockAsker([
        {
            thought: 'Always calling loopTool.',
            action: 'tool_call',
            toolCalls: [
                {callId: 'c_loop', name: 'loopTool', parameters: {}},
            ],
        },
    ])

    const actor = new LLMActor(asker, {
        maxSteps: 3,
        tools: [
            {
                name: 'loopTool',
                description: 'No-op loop tool',
                parameters: z.object({}),
                execute: () => ({ok: true}),
            },
        ],
    })

    const result = await actor.run('Never-ending task')
    expect(result.ok).toBe(false)
    expect(result.haltReason).toBe('max_steps_exceeded')
    expect(result.totalSteps).toBe(3)
    expect(result.error).toMatch(/Exceeded maximum step budget of 3/)
})

test('LLMActor.run respects AbortSignal', async () => {
    const asker = createMockAsker([
        {
            thought: 'Step 1.',
            action: 'tool_call',
            toolCalls: [],
        },
    ])

    const controller = new AbortController()
    controller.abort()

    const actor = new LLMActor(asker)
    const result = await actor.run('Aborted task', {signal: controller.signal})
    expect(result.ok).toBe(false)
    expect(result.haltReason).toBe('aborted')
})

test('LLMActor.run parses structured output schema when specified', async () => {
    const ResultSchema = z.object({
        status: z.enum(['healthy', 'unhealthy']),
        latency: z.number(),
    })

    const asker = createMockAsker([
        {
            thought: 'System is healthy.',
            action: 'final_answer',
            finalAnswer: '```json\n{"status": "healthy", "latency": 42}\n```',
        },
    ])

    const actor = new LLMActor(asker)
    const result = await actor.run('Health check', {schema: ResultSchema})

    expect(result.ok).toBe(true)
    expect(result.haltReason).toBe('completed')
    expect(result.output).toEqual({status: 'healthy', latency: 42})
})

test('LLMActor rejects hallucinated tool name before execution and corrects to real tool via retry', async () => {
    // Model initially responds with hallucinated 'system_info.gpu_load', then corrects to 'shell'
    const asker = createMockAsker([
        {
            thought: 'Querying GPU load via phantom tool.',
            action: 'tool_call',
            toolCalls: [{callId: 'c1', name: 'system_info.gpu_load', parameters: {}}],
        },
        {
            thought: 'Correcting to real tool shell.',
            action: 'tool_call',
            toolCalls: [{callId: 'c1', name: 'shell', parameters: {cmd: 'nvidia-smi'}}],
        },
    ])

    let executedCommand = ''
    const actor = new LLMActor(asker, {
        tools: [
            {
                name: 'shell',
                description: 'Execute shell command',
                parameters: z.object({cmd: z.string()}),
                execute: ({cmd}: {cmd: string}) => {
                    executedCommand = cmd
                    return 'GPU 0: 45%'
                },
            },
        ],
    })

    const stepResult = await actor.step('Get GPU load')
    expect(stepResult.isDone).toBe(false)
    expect(stepResult.record.toolCalls[0].toolName).toBe('shell')
    expect(stepResult.record.toolResults[0].result).toBe('GPU 0: 45%')
    expect(executedCommand).toBe('nvidia-smi')
})

test('LLMActor feeds back real tool failure and actor replans with alternative tool', async () => {
    const asker = createMockAsker([
        // Turn 1: Attempt tool A
        {
            thought: 'Attempt primary service inspection tool.',
            action: 'tool_call',
            toolCalls: [{callId: 'c1', name: 'primaryCheck', parameters: {}}],
        },
        // Turn 2: Primary failed, replan to use secondary tool
        {
            thought: 'Primary check failed with network error. Replanning to fallback inspection.',
            action: 'tool_call',
            toolCalls: [{callId: 'c2', name: 'fallbackCheck', parameters: {}}],
        },
        // Turn 3: Conclude successfully
        {
            thought: 'Fallback succeeded. Reporting status.',
            action: 'final_answer',
            finalAnswer: 'Service is operational via fallback.',
        },
    ])

    const actor = new LLMActor(asker, {
        tools: [
            {
                name: 'primaryCheck',
                description: 'Primary check',
                parameters: z.object({}),
                execute: () => {
                    throw new Error('Service endpoint unreachable')
                },
            },
            {
                name: 'fallbackCheck',
                description: 'Fallback check',
                parameters: z.object({}),
                execute: () => ({status: 'operational_fallback'}),
            },
        ],
    })

    const result = await actor.run('Check service health')
    expect(result.ok).toBe(true)
    expect(result.haltReason).toBe('completed')
    expect(result.steps.length).toBe(3)
    expect(result.steps[0].toolResults[0].isError).toBe(true)
    expect(result.steps[1].toolResults[0].isError).toBe(false)
    expect(result.finalText).toBe('Service is operational via fallback.')
})

test('LLMActor feeds back invalid parameter error and actor repairs arguments on next turn', async () => {
    const asker = createMockAsker([
        // Turn 1: Send bad parameters
        {
            thought: 'Call search with negative limit.',
            action: 'tool_call',
            toolCalls: [{callId: 'c1', name: 'search', parameters: {query: 'test', limit: -5}}],
        },
        // Turn 2: Repair parameters
        {
            thought: 'Limit was invalid. Repairing limit to 5.',
            action: 'tool_call',
            toolCalls: [{callId: 'c2', name: 'search', parameters: {query: 'test', limit: 5}}],
        },
        // Turn 3: Complete
        {
            thought: 'Results obtained.',
            action: 'final_answer',
            finalAnswer: 'Found 1 item.',
        },
    ])

    const actor = new LLMActor(asker, {
        tools: [
            {
                name: 'search',
                description: 'Search items',
                parameters: z.object({
                    query: z.string(),
                    limit: z.number().positive(),
                }),
                execute: ({query, limit}: {query: string; limit: number}) => ({count: 1, limit}),
            },
        ],
    })

    const result = await actor.run('Search test')
    expect(result.ok).toBe(true)
    expect(result.steps[0].toolResults[0].isError).toBe(true)
    expect(result.steps[0].toolResults[0].error).toMatch(/Invalid parameters/)
    expect(result.steps[1].toolResults[0].isError).toBe(false)
    expect(result.finalText).toBe('Found 1 item.')
})


test('LLMActor.run uses an exact run-local tool surface without mutating registered tools', async () => {
    const asker = createMockAsker([
        {
            thought: 'Use the local tool.',
            action: 'tool_call',
            toolCalls: [{callId: 'c1', name: 'local_tool', parameters: {}}],
        },
        {
            thought: 'Done.',
            action: 'final_answer',
            finalAnswer: 'local result',
        },
    ])

    let globalExecuted = false
    let localExecuted = false

    const globalTool = {
        name: 'global_tool',
        description: 'Globally registered tool',
        parameters: z.object({}),
        execute: () => {
            globalExecuted = true
            return 'global'
        },
    }
    const localTool = {
        name: 'local_tool',
        description: 'Tool available only for this run',
        parameters: z.object({}),
        execute: () => {
            localExecuted = true
            return 'local'
        },
    }

    const actor = new LLMActor(asker, {tools: [globalTool]})
    const result = await actor.run('Use only the selected tool', {tools: [localTool]})

    expect(result.ok).toBe(true)
    expect(localExecuted).toBe(true)
    expect(globalExecuted).toBe(false)
    expect(actor.getTools()).toEqual([globalTool])
})

test('LLMActor.run rejects globally registered tools excluded from a run-local surface', async () => {
    const asker = createMockAsker([
        {
            thought: 'Try the global tool.',
            action: 'tool_call',
            toolCalls: [{callId: 'c1', name: 'global_tool', parameters: {}}],
        },
    ])

    let executed = false
    const actor = new LLMActor(asker, {
        maxSteps: 1,
        tools: [{
            name: 'global_tool',
            description: 'Globally registered tool',
            parameters: z.object({}),
            execute: () => {
                executed = true
                return 'global'
            },
        }],
    })

    const result = await actor.run('Do not expose the global tool', {tools: []})

    expect(executed).toBe(false)
    expect(result.steps[0].toolResults[0].isError).toBe(true)
    expect(result.steps[0].toolResults[0].error).toContain('not available for this run')
})

test('LLMActor.run does not expand an exact run-local surface through actor-level onMissingTool', async () => {
    const asker = createMockAsker([
        {
            thought: 'Try a dynamic tool.',
            action: 'tool_call',
            toolCalls: [{callId: 'c1', name: 'dynamic_tool', parameters: {}}],
        },
    ])

    let recovered = false
    const actor = new LLMActor(asker, {
        maxSteps: 1,
        onMissingTool: () => {
            recovered = true
            return {
                name: 'dynamic_tool',
                description: 'Dynamically discovered tool',
                parameters: z.object({}),
                execute: () => 'dynamic',
            }
        },
    })

    const result = await actor.run('Use only this run surface', {tools: []})

    expect(recovered).toBe(false)
    expect(result.steps[0].toolResults[0].isError).toBe(true)
    expect(result.steps[0].toolResults[0].error).toContain('not available for this run')
})

test('LLMActor.run recovers missing tool on-demand via run-local onMissingTool without mutating global actor', async () => {
    const asker = createMockAsker([
        {
            thought: 'Need missing tool first.',
            action: 'tool_call',
            toolCalls: [{callId: 'c1', name: 'recovered_tool', parameters: {query: 'abc'}}],
        },
        {
            thought: 'Use recovered tool again in next step.',
            action: 'tool_call',
            toolCalls: [{callId: 'c2', name: 'recovered_tool', parameters: {query: 'xyz'}}],
        },
        {
            thought: 'Done.',
            action: 'final_answer',
            finalAnswer: 'finished successfully',
        },
    ])

    const executionLog: string[] = []
    let onMissingCalled = 0

    const initialLocalTool = {
        name: 'initial_tool',
        description: 'Initial tool in run-local surface',
        parameters: z.object({}),
        execute: () => 'initial',
    }

    const globalTool = {
        name: 'global_tool',
        description: 'Globally registered tool',
        parameters: z.object({}),
        execute: () => 'global',
    }

    const actor = new LLMActor(asker, {
        maxSteps: 5,
        tools: [globalTool],
    })

    const result = await actor.run('Run with recovery', {
        tools: [initialLocalTool],
        onMissingTool: (toolName, params) => {
            onMissingCalled++
            if (toolName === 'recovered_tool') {
                return {
                    name: 'recovered_tool',
                    description: 'Dynamically recovered tool',
                    parameters: z.object({query: z.string()}),
                    execute: ({query}: {query: string}) => {
                        executionLog.push(query)
                        return `result for ${query}`
                    },
                }
            }
            return undefined
        },
    })

    expect(result.ok).toBe(true)
    expect(result.haltReason).toBe('completed')
    expect(result.steps.length).toBe(3)
    expect(onMissingCalled).toBe(1)
    expect(executionLog).toEqual(['abc', 'xyz'])
    expect(result.steps[0].toolResults[0].isError).toBe(false)
    expect(result.steps[0].toolResults[0].result).toBe('result for abc')
    expect(result.steps[1].toolResults[0].isError).toBe(false)
    expect(result.steps[1].toolResults[0].result).toBe('result for xyz')
    // Crucial: Global actor tools MUST NOT be mutated
    expect(actor.getTools()).toEqual([globalTool])
    expect(actor.getTool('recovered_tool')).toBeUndefined()
})

test('LLMActor.run treats unresolvable run-local missing tools as ordinary tool errors', async () => {
    const asker = createMockAsker([
        {
            thought: 'Try unknown tool.',
            action: 'tool_call',
            toolCalls: [{callId: 'c1', name: 'nonexistent_tool', parameters: {}}],
        },
        {
            thought: 'Recover from error.',
            action: 'final_answer',
            finalAnswer: 'handled missing tool',
        },
    ])

    const actor = new LLMActor(asker, {maxSteps: 2})
    const result = await actor.run('Try missing tool', {
        tools: [],
        onMissingTool: () => undefined,
    })

    expect(result.ok).toBe(true)
    expect(result.steps[0].toolResults[0].isError).toBe(true)
    expect(result.steps[0].toolResults[0].error).toContain('not available for this run')
    expect(result.finalText).toBe('handled missing tool')
})
