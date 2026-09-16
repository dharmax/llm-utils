import {expect, test} from 'bun:test'
import {
    Asker,
    CompletionEngine,
    LLMPipeline,
    type ToolDefinition,
    z,
} from '../src/index.ts'

function createEchoAsker(responses: Record<string, unknown>): Asker {
    const completion = new CompletionEngine([]).registerAdapter({
        id: 'unit-pipeline',
        async generate(options) {
            const prompt = options.prompt
            for (const [key, val] of Object.entries(responses)) {
                if (prompt.includes(key)) {
                    return {
                        ok: true,
                        text: typeof val === 'string' ? val : JSON.stringify(val),
                        model: {providerId: 'unit-pipeline', modelId: options.modelId},
                    }
                }
            }
            return {
                ok: true,
                text: JSON.stringify({action: 'final_answer', thought: 'Done', finalAnswer: 'Fallback done'}),
                model: {providerId: 'unit-pipeline', modelId: options.modelId},
            }
        },
    })

    return new Asker({
        providers: {
            'unit-pipeline': {id: 'unit-pipeline', available: true},
        },
        completion,
        routes: {default: 'unit-pipeline/test-model'},
    })
}

test('LLMPipeline preprocessor extracts intent, constraints, and prunes tools', async () => {
    const asker = createEchoAsker({
        'Analyze this user goal': {
            normalizedGoal: 'Inspect package and compute hash',
            domain: 'filesystem',
            constraints: ['Must use sha256', 'Path must be relative'],
            relevantTools: ['read_file'],
            suggestedPhases: ['read', 'hash'],
        },
    })

    const pipeline = new LLMPipeline(asker, {
        tools: [
            {
                name: 'read_file',
                description: 'Read file',
                parameters: z.object({path: z.string()}),
                execute: () => ({data: 'content'}),
            },
            {
                name: 'irrelevant_tool',
                description: 'Unrelated tool',
                parameters: z.object({}),
                execute: () => ({}),
            },
        ],
    })

    const intent = await pipeline.preprocess('Read package.json and compute its sha256')

    expect(intent.normalizedGoal).toBe('Inspect package and compute hash')
    expect(intent.constraints).toEqual(['Must use sha256', 'Path must be relative'])
    expect(intent.relevantTools).toEqual(['read_file'])
})

test('LLMPipeline plans ordered steps with dependencies', async () => {
    const asker = createEchoAsker({
        'Decompose this normalized goal': {
            strategy: 'Fetch then calculate',
            steps: [
                {id: 'step_1', description: 'Fetch data', assignedTools: ['fetch_data']},
                {id: 'step_2', description: 'Process data', assignedTools: ['process_data'], dependsOn: ['step_1']},
            ],
        },
    })

    const pipeline = new LLMPipeline(asker)
    const plan = await pipeline.plan({
        normalizedGoal: 'Process user metrics',
        constraints: [],
        relevantTools: ['fetch_data', 'process_data'],
        suggestedPhases: ['fetch', 'process'],
    })

    expect(plan.strategy).toBe('Fetch then calculate')
    expect(plan.steps.length).toBe(2)
    expect(plan.steps[1].dependsOn).toEqual(['step_1'])
})

test('LLMPipeline executes full multi-phase pipeline passing dependency memory between steps', async () => {
    const executedTools: string[] = []

    const step1Tool: ToolDefinition = {
        name: 'fetch_user_id',
        description: 'Fetch user id',
        parameters: z.object({username: z.string()}),
        execute: ({username}) => {
            executedTools.push('fetch_user_id')
            return {userId: `uid_${username}`}
        },
    }

    const step2Tool: ToolDefinition = {
        name: 'fetch_user_balance',
        description: 'Fetch user balance using id',
        parameters: z.object({userId: z.string()}),
        execute: ({userId}) => {
            executedTools.push('fetch_user_balance')
            return {userId, balance: 150}
        },
    }

    const asker = createEchoAsker({
        'Analyze this user goal': {
            normalizedGoal: 'Look up Alice balance',
            constraints: ['Report numeric balance'],
            relevantTools: ['fetch_user_id', 'fetch_user_balance'],
            suggestedPhases: ['id', 'balance'],
        },
        'Decompose this normalized goal': {
            strategy: 'Two-step lookup',
            steps: [
                {id: 'step_1', description: 'Get ID for alice', assignedTools: ['fetch_user_id']},
                {id: 'step_2', description: 'Get balance for alice using ID', assignedTools: ['fetch_user_balance'], dependsOn: ['step_1']},
            ],
        },
        'Result: {"userId":"uid_alice"}': {
            thought: 'Have ID',
            action: 'final_answer',
            finalAnswer: 'Alice ID is uid_alice',
        },
        'Get ID for alice': {
            thought: 'Calling fetch_user_id',
            action: 'tool_call',
            toolCalls: [{callId: 'c1', name: 'fetch_user_id', parameters: {username: 'alice'}}],
        },
        'Result: {"userId":"uid_alice","balance":150}': {
            thought: 'Have balance',
            action: 'final_answer',
            finalAnswer: 'Balance is 150',
        },
        'Get balance for alice': {
            thought: 'Calling fetch_user_balance',
            action: 'tool_call',
            toolCalls: [{callId: 'c2', name: 'fetch_user_balance', parameters: {userId: 'uid_alice'}}],
        },
        'Synthesize the final, verified response': 'Alice account uid_alice has a balance of $150.',
    })

    const phaseEvents: string[] = []
    const pipeline = new LLMPipeline(asker, {
        tools: [step1Tool, step2Tool],
        onPhaseChange: (phase) => {
            phaseEvents.push(phase)
        },
    })

    const result = await pipeline.run('Find balance for user alice')

    expect(result.ok).toBe(true)
    expect(result.finalText).toContain('Alice account uid_alice has a balance of $150.')
    expect(executedTools).toEqual(['fetch_user_id', 'fetch_user_balance'])
    expect(phaseEvents).toContain('preprocess')
    expect(phaseEvents).toContain('plan')
    expect(phaseEvents).toContain('execute')
    expect(phaseEvents).toContain('verify')
})

test('LLMPipeline supports custom adapters via Service Adapter Pattern', async () => {
    const customPreprocessor = {
        async preprocess(goal: string) {
            return {
                normalizedGoal: `Custom: ${goal}`,
                constraints: ['Custom rule'],
                relevantTools: ['custom_tool'],
                suggestedPhases: ['custom_phase'],
            }
        },
    }

    const customPlanner = {
        async plan() {
            return {
                strategy: 'Custom plan strategy',
                steps: [{id: 's1', description: 'Run custom step', assignedTools: []}],
            }
        },
    }

    const asker = createEchoAsker({
        'Synthesize the final': 'Custom final response',
    })

    const pipeline = new LLMPipeline(asker, {
        preprocessor: customPreprocessor,
        planner: customPlanner,
    })

    const result = await pipeline.run('Do something')

    expect(result.ok).toBe(true)
    expect(result.intent.normalizedGoal).toBe('Custom: Do something')
    expect(result.plan.strategy).toBe('Custom plan strategy')
})

test('LLMPipeline onException injects wisdom and recovers on retry', async () => {
    let exceptionCaught = false
    let attemptCount = 0

    const asker = createEchoAsker({
        'Use port 8080': {
            thought: 'Applying injected wisdom to use port 8080',
            action: 'final_answer',
            finalAnswer: 'Service on port 8080 is online',
        },
        'Synthesize the final': 'Service is fully online on port 8080.',
    })

    const pipeline = new LLMPipeline(asker, {
        preprocessor: {
            async preprocess(goal) {
                return {
                    normalizedGoal: goal,
                    constraints: [],
                    relevantTools: [],
                    suggestedPhases: ['check'],
                }
            },
        },
        planner: {
            async plan() {
                return {
                    strategy: 'Single step',
                    steps: [{id: 'step_1', description: 'Connect to service', assignedTools: []}],
                }
            },
        },
        maxStepsPerPhase: 1,
    })

    // To simulate step failure on attempt 1:
    // With maxStepsPerPhase=1 and createEchoAsker returning tool_call when not matching,
    // let's pass an asker that fails on the first prompt and succeeds on the wisdom prompt.
    const failingFirstAsker = new CompletionEngine([]).registerAdapter({
        id: 'failing-adapter',
        async generate(options) {
            if (options.prompt.includes('Use port 8080')) {
                return {
                    ok: true,
                    text: JSON.stringify({
                        action: 'final_answer',
                        thought: 'Got wisdom',
                        finalAnswer: 'Success on port 8080',
                    }),
                    model: {providerId: 'failing-adapter', modelId: options.modelId},
                }
            }
            if (options.prompt.includes('Synthesize')) {
                return {
                    ok: true,
                    text: 'Final synthesized output with wisdom applied',
                    model: {providerId: 'failing-adapter', modelId: options.modelId},
                }
            }
            // First attempt produces a tool call to a non-existent tool or bad response
            return {
                ok: true,
                text: JSON.stringify({
                    action: 'tool_call',
                    thought: 'Connecting to default port 80',
                    toolCalls: [{callId: 'bad_call', name: 'unregistered_tool', parameters: {}}],
                }),
                model: {providerId: 'failing-adapter', modelId: options.modelId},
            }
        },
    })

    const testAsker = new Asker({
        providers: {'failing-adapter': {id: 'failing-adapter', available: true}},
        completion: failingFirstAsker,
        routes: {default: 'failing-adapter/model'},
    })

    const resilientPipeline = new LLMPipeline(testAsker, {
        preprocessor: {
            async preprocess(goal) {
                return {normalizedGoal: goal, constraints: [], relevantTools: [], suggestedPhases: ['test']}
            },
        },
        planner: {
            async plan() {
                return {strategy: 'Test', steps: [{id: 's1', description: 'Connect to port', assignedTools: []}]}
            },
        },
        maxStepsPerPhase: 1,
        onException: (exc) => {
            exceptionCaught = true
            attemptCount = exc.attempt
            expect(exc.step.id).toBe('s1')
            return {
                action: 'retry',
                wisdom: 'Use port 8080',
            }
        },
    })

    const result = await resilientPipeline.run('Connect to port')

    expect(exceptionCaught).toBe(true)
    expect(attemptCount).toBe(1)
    expect(result.ok).toBe(true)
    expect(result.stepOutputs['s1']).toBe('Success on port 8080')
    expect(result.finalText).toBe('Final synthesized output with wisdom applied')
})

test('LLMPipeline onException provides fallbackOutput and continues happy path', async () => {
    let exceptionCaught = false

    const completion = new CompletionEngine([]).registerAdapter({
        id: 'fallback-adapter',
        async generate(options) {
            if (options.prompt.includes('Synthesize')) {
                return {
                    ok: true,
                    text: 'Synthesized with fallback',
                    model: {providerId: 'fallback-adapter', modelId: options.modelId},
                }
            }
            if (options.prompt.includes('Result of s1')) {
                return {
                    ok: true,
                    text: JSON.stringify({
                        action: 'final_answer',
                        thought: 'Got fallback from s1',
                        finalAnswer: 'Processed fallback successfully',
                    }),
                    model: {providerId: 'fallback-adapter', modelId: options.modelId},
                }
            }
            // Step 1 fails by calling invalid tool with maxSteps 1
            return {
                ok: true,
                text: JSON.stringify({
                    action: 'tool_call',
                    thought: 'Failing step 1',
                    toolCalls: [{callId: 'fail', name: 'missing_tool', parameters: {}}],
                }),
                model: {providerId: 'fallback-adapter', modelId: options.modelId},
            }
        },
    })

    const asker = new Asker({
        providers: {'fallback-adapter': {id: 'fallback-adapter', available: true}},
        completion,
        routes: {default: 'fallback-adapter/model'},
    })

    const pipeline = new LLMPipeline(asker, {
        preprocessor: {
            async preprocess(goal) {
                return {normalizedGoal: goal, constraints: [], relevantTools: [], suggestedPhases: ['s1', 's2']}
            },
        },
        planner: {
            async plan() {
                return {
                    strategy: 'Two steps',
                    steps: [
                        {id: 's1', description: 'Fetch external data', assignedTools: []},
                        {id: 's2', description: 'Process external data', assignedTools: [], dependsOn: ['s1']},
                    ],
                }
            },
        },
        maxStepsPerPhase: 1,
        onException: (exc) => {
            exceptionCaught = true
            expect(exc.step.id).toBe('s1')
            return {
                action: 'continue',
                fallbackOutput: 'cached_dataset_v1',
            }
        },
    })

    const result = await pipeline.run('Fetch and process')

    expect(exceptionCaught).toBe(true)
    expect(result.ok).toBe(true)
    expect(result.stepOutputs['s1']).toBe('cached_dataset_v1')
    expect(result.stepOutputs['s2']).toBe('Processed fallback successfully')
})

test('LLMPipeline onException skips failing step when instructed', async () => {
    const completion = new CompletionEngine([]).registerAdapter({
        id: 'skip-adapter',
        async generate(options) {
            if (options.prompt.includes('Synthesize')) {
                return {
                    ok: true,
                    text: 'Synthesized after skip',
                    model: {providerId: 'skip-adapter', modelId: options.modelId},
                }
            }
            return {
                ok: true,
                text: JSON.stringify({
                    action: 'tool_call',
                    thought: 'Failing step',
                    toolCalls: [{callId: 'fail', name: 'missing', parameters: {}}],
                }),
                model: {providerId: 'skip-adapter', modelId: options.modelId},
            }
        },
    })

    const asker = new Asker({
        providers: {'skip-adapter': {id: 'skip-adapter', available: true}},
        completion,
        routes: {default: 'skip-adapter/model'},
    })

    const pipeline = new LLMPipeline(asker, {
        preprocessor: {
            async preprocess(goal) {
                return {normalizedGoal: goal, constraints: [], relevantTools: [], suggestedPhases: ['s1']}
            },
        },
        planner: {
            async plan() {
                return {strategy: 'Single', steps: [{id: 's1', description: 'Optional step', assignedTools: []}]}
            },
        },
        maxStepsPerPhase: 1,
        onException: () => ({action: 'skip'}),
    })

    const result = await pipeline.run('Try optional step')

    expect(result.ok).toBe(true)
    expect(result.stepOutputs['s1']).toBe('Skipped by exception handler')
})

test('LLMPipeline onException cleanly aborts or throws on error with explanation', async () => {
    const completion = new CompletionEngine([]).registerAdapter({
        id: 'abort-adapter',
        async generate() {
            return {
                ok: true,
                text: JSON.stringify({
                    action: 'tool_call',
                    thought: 'Failing step',
                    toolCalls: [{callId: 'f', name: 'missing', parameters: {}}],
                }),
                model: {providerId: 'abort-adapter', modelId: 'test'},
            }
        },
    })

    const asker = new Asker({
        providers: {'abort-adapter': {id: 'abort-adapter', available: true}},
        completion,
        routes: {default: 'abort-adapter/test'},
    })

    // 1. Abort returns { ok: false, error: ... }
    const abortPipeline = new LLMPipeline(asker, {
        preprocessor: {
            async preprocess(goal) {
                return {normalizedGoal: goal, constraints: [], relevantTools: [], suggestedPhases: ['s1']}
            },
        },
        planner: {
            async plan() {
                return {strategy: 'Single', steps: [{id: 's1', description: 'Critical step', assignedTools: []}]}
            },
        },
        maxStepsPerPhase: 1,
        onException: () => ({action: 'abort', reason: 'Security check failed: unauthorized'}),
    })

    const abortResult = await abortPipeline.run('Critical task')
    expect(abortResult.ok).toBe(false)
    expect(abortResult.error).toBe('Security check failed: unauthorized')

    // 2. throwOnError throws Error with explanation
    const throwPipeline = new LLMPipeline(asker, {
        preprocessor: {
            async preprocess(goal) {
                return {normalizedGoal: goal, constraints: [], relevantTools: [], suggestedPhases: ['s1']}
            },
        },
        planner: {
            async plan() {
                return {strategy: 'Single', steps: [{id: 's1', description: 'Critical step', assignedTools: []}]}
            },
        },
        maxStepsPerPhase: 1,
        throwOnError: true,
        onException: () => ({action: 'abort', reason: 'Unrecoverable critical failure'}),
    })

    expect(throwPipeline.run('Critical task')).rejects.toThrow('Unrecoverable critical failure')
})

