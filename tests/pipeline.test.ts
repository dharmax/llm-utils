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
