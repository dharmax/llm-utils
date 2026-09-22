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
