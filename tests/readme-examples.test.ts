import {expect, test} from 'bun:test'
import * as IndexExports from '../src/index.ts'
import {
    Asker,
    calculateUsageCost,
    CompletionEngine,
    createMetricsPubSub,
    FileTemplateSource,
    InMemoryMetricsStore,
    LLMActor,
    LLMPipeline,
    LLMSession,
    LlmMetrics,
    ModelRouter,
    OpenAIAdapter,
    parseStructuredJson,
    parseStructuredJsonResult,
    PromptEngine,
    ProviderCircuit,
    ProviderDiscovery,
    resolveResponseFormat,
    z,
    zodToJsonSchema,
    type ActorRunOptions,
    type ActorRunResult,
    type ActorStepRecord,
    type AggregateMetrics,
    type AskOptions,
    type ContextRequest,
    type ContextResolver,
    type ContextResult,
    type ExecutionPlan,
    type GenerationFailure,
    type GenerationResult,
    type LlmMetricEvent,
    type MetricsQuery,
    type ModelTarget,
    type PipelineExceptionHandler,
    type PipelineExceptionResolution,
    type PipelineRunResult,
    type PipelineStepException,
    type PlanStep,
    type PreprocessedIntent,
    type ProviderAdapter,
    type ProviderConfig,
    type ResponseFormat,
    type ToolDefinition,
    type ToolExecutionResult,
    type ToolInvocation,
} from '../src/index.ts'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

function createEchoAsker(responses: Record<string, unknown> = {}, options: {promptsDir?: string} = {}): Asker {
    const completion = new CompletionEngine([]).registerAdapter({
        id: 'mock-provider',
        async generate(genOptions) {
            const prompt = genOptions.prompt
            for (const [key, val] of Object.entries(responses)) {
                if (prompt.includes(key)) {
                    return {
                        ok: true,
                        text: typeof val === 'string' ? val : JSON.stringify(val),
                        model: {providerId: 'mock-provider', modelId: genOptions.modelId},
                        usage: {promptTokens: 10, completionTokens: 15, totalTokens: 25, available: true},
                    }
                }
            }
            return {
                ok: true,
                text: 'Mock response text for prompt: ' + prompt.slice(0, 50),
                model: {providerId: 'mock-provider', modelId: genOptions.modelId},
                usage: {promptTokens: 10, completionTokens: 15, totalTokens: 25, available: true},
            }
        },
    })

    return new Asker({
        promptsDir: options.promptsDir,
        providers: {
            'mock-provider': {id: 'mock-provider', available: true},
            openai: {id: 'openai', available: true},
            google: {id: 'google', available: true},
            anthropic: {id: 'anthropic', available: true},
            ollama: {id: 'ollama', available: true},
        },
        completion,
        routes: {
            default: 'mock-provider/test-model',
            code: 'mock-provider/code-model',
            fast: 'mock-provider/fast-model',
            reasoning: 'mock-provider/reasoning-model',
            creative: 'mock-provider/creative-model',
            local: 'mock-provider/local-model',
        },
    })
}

function createQueueAsker(responses: Array<Record<string, unknown> | string>): Asker {
    let callIndex = 0
    const completion = new CompletionEngine([]).registerAdapter({
        id: 'mock-provider',
        async generate(options) {
            const resp = responses[callIndex] ?? responses[responses.length - 1]
            callIndex += 1
            return {
                ok: true,
                text: typeof resp === 'string' ? resp : JSON.stringify(resp),
                model: {providerId: 'mock-provider', modelId: options.modelId},
                usage: {promptTokens: 10, completionTokens: 15, totalTokens: 25, available: true},
            }
        },
    })
    return new Asker({
        providers: {
            'mock-provider': {id: 'mock-provider', available: true},
            openai: {id: 'openai', available: true},
            google: {id: 'google', available: true},
            anthropic: {id: 'anthropic', available: true},
            ollama: {id: 'ollama', available: true},
        },
        completion,
        routes: {
            default: 'mock-provider/test-model',
            code: 'mock-provider/code-model',
            fast: 'mock-provider/fast-model',
            reasoning: 'mock-provider/reasoning-model',
            creative: 'mock-provider/creative-model',
            local: 'mock-provider/local-model',
        },
    })
}

test('README snippet: Public exports alignment', () => {
    // Verify all runtime exports listed in README
    expect(IndexExports.Asker).toBe(Asker)
    expect(IndexExports.LLMActor).toBe(LLMActor)
    expect(IndexExports.LLMPipeline).toBe(LLMPipeline)
    expect(IndexExports.LLMSession).toBe(LLMSession)
    expect(IndexExports.z).toBe(z)
    expect(IndexExports.CompletionEngine).toBe(CompletionEngine)
    expect(IndexExports.ModelRouter).toBe(ModelRouter)
    expect(IndexExports.PromptEngine).toBe(PromptEngine)
    expect(IndexExports.FileTemplateSource).toBe(FileTemplateSource)
    expect(IndexExports.ProviderCircuit).toBe(ProviderCircuit)
    expect(IndexExports.LlmMetrics).toBe(LlmMetrics)
    expect(IndexExports.InMemoryMetricsStore).toBe(InMemoryMetricsStore)
    expect(IndexExports.createMetricsPubSub).toBe(createMetricsPubSub)
    expect(IndexExports.calculateUsageCost).toBe(calculateUsageCost)
    expect(IndexExports.parseStructuredJson).toBe(parseStructuredJson)
    expect(IndexExports.parseStructuredJsonResult).toBe(parseStructuredJsonResult)
    expect(IndexExports.zodToJsonSchema).toBe(zodToJsonSchema)
    expect(IndexExports.resolveResponseFormat).toBe(resolveResponseFormat)
    expect(IndexExports.ProviderDiscovery).toBe(ProviderDiscovery)
})

test('README snippet: Bun & Node Native Usage', async () => {
    const asker = createEchoAsker()
    const res = await asker.ask('Hello from Bun!')

    expect(res.ok).toBe(true)
    if (res.ok) {
        expect(res.text).toBeDefined()
        const tokens = res.usage?.totalTokens ?? 0
        const provider = res.model.providerId
        const model = res.model.modelId
        expect(tokens).toBe(25)
        expect(provider).toBe('mock-provider')
        expect(model).toBe('test-model')
    }
})

test('README snippet: Plain Text Asks & Task Overrides', async () => {
    const asker = createEchoAsker()

    // Direct execution with default router
    const res = await asker.ask('Explain ACID transactions in 2 sentences.')
    expect(res.ok).toBe(true)

    // Override model or task classification
    const codeRes = await asker.ask('Write TypeScript debounce', {task: 'code'})
    expect(codeRes.ok).toBe(true)
    expect(codeRes.model.modelId).toBe('code-model')

    const exactRes = await asker.ask('Analyze log trace', {model: 'mock-provider/gpt-4o'})
    expect(exactRes.ok).toBe(true)
    expect(exactRes.model.modelId).toBe('gpt-4o')
})

test('README snippet: Typed Structured JSON (asker.json()) with SentimentSchema', async () => {
    const asker = createEchoAsker({
        'The delivery arrived on time': {
            sentiment: 'positive',
            confidence: 0.95,
            keyPhrases: ['on time', 'works great'],
        },
    })

    const SentimentSchema = z.object({
        sentiment: z.enum(['positive', 'neutral', 'negative']),
        confidence: z.number().min(0).max(1),
        keyPhrases: z.array(z.string()),
    })

    const result = await asker.json('The delivery arrived on time and works great!', SentimentSchema)

    expect(result.ok).toBe(true)
    if (result.ok && result.data) {
        expect(result.data.sentiment).toBe('positive')
        expect(result.data.confidence).toBe(0.95)
        expect(result.data.keyPhrases).toEqual(['on time', 'works great'])
    }
})

test('README snippet: Custom Local Endpoints (LM Studio / vLLM / llama.cpp)', async () => {
    // Ephemeral OpenAI-compatible mock server
    const server = Bun.serve({
        port: 0,
        fetch(_req) {
            return Response.json({
                id: 'chatcmpl-mock-123',
                object: 'chat.completion',
                created: Date.now(),
                model: 'local-model',
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: 'Greetings from mock local server!',
                        },
                        finish_reason: 'stop',
                    },
                ],
                usage: {
                    prompt_tokens: 12,
                    completion_tokens: 8,
                    total_tokens: 20,
                },
            })
        },
    })

    try {
        const asker = new Asker({
            providers: {
                lmstudio: {
                    id: 'lmstudio',
                    baseUrl: `http://127.0.0.1:${server.port}/v1`,
                    available: true,
                },
            },
        })

        const res = await asker.ask('Hello from local server', {model: 'lmstudio/local-model'})
        expect(res.ok).toBe(true)
        expect(res.text).toBe('Greetings from mock local server!')
        expect(res.model.providerId).toBe('lmstudio')
        expect(res.usage?.totalTokens).toBe(20)
    } finally {
        server.stop()
    }
})

test('README snippet: Defining Tools & Running an Autonomous Loop (LLMActor)', async () => {
    let notificationDelivered = false

    const asker = createQueueAsker([
        {
            thought: 'Need to get the weather for Tokyo first',
            action: 'tool_call',
            toolCalls: [{id: 'call_1', name: 'get_weather', parameters: {city: 'Tokyo'}}],
        },
        {
            thought: 'Weather is sunny in Tokyo, sending notification',
            action: 'tool_call',
            toolCalls: [{id: 'call_2', name: 'send_notification', parameters: {message: 'Tokyo is 22C and Sunny!'}}],
        },
        {
            thought: 'Notification sent successfully. Goal completed.',
            action: 'final_answer',
            finalAnswer: 'Tokyo weather is sunny at 22C, and the user has been notified.',
        },
    ])

    const actor = new LLMActor(asker, {
        maxSteps: 5,
        tools: [
            {
                name: 'get_weather',
                description: 'Fetch current weather temperature and condition for a given city',
                parameters: z.object({
                    city: z.string().describe('Target city name'),
                }),
                execute: async ({city}) => {
                    return {city, temperatureC: 22, condition: 'Sunny'}
                },
            },
            {
                name: 'send_notification',
                description: 'Send a push notification to user device',
                parameters: z.object({
                    message: z.string().describe('Notification text to display'),
                }),
                execute: async ({message}) => {
                    notificationDelivered = true
                    return {delivered: true}
                },
            },
        ],
    })

    const result = await actor.run('Check weather in Tokyo and notify the user if sunny.')

    expect(result.ok).toBe(true)
    expect(result.finalText).toContain('Tokyo weather is sunny')
    expect(result.totalSteps).toBe(3)
    expect(notificationDelivered).toBe(true)
})

test('README snippet: Step-by-Step Control with actor.step()', async () => {
    const asker = createQueueAsker([
        {
            thought: 'Initiating diagnostic tool check',
            action: 'tool_call',
            toolCalls: [{id: 'step_1', name: 'diag_tool', parameters: {}}],
        },
        {
            thought: 'Diagnostics complete',
            action: 'final_answer',
            finalAnswer: 'System diagnostics all normal.',
        },
    ])

    const actor = new LLMActor(asker, {
        tools: [
            {
                name: 'diag_tool',
                description: 'Runs diagnostic check',
                parameters: z.object({}),
                execute: () => ({status: 'ok', memoryFreeMb: 2048}),
            },
        ],
    })

    const history: ActorStepRecord[] = []

    // Turn 1
    const turn1 = await actor.step('Execute diagnostic inspection', history)
    history.push(turn1.record)
    expect(turn1.isDone).toBe(false)
    expect(turn1.record.action).toBe('tool_call')
    expect(turn1.record.toolCalls?.length).toBe(1)
    expect(turn1.record.toolResults?.[0].result).toEqual({status: 'ok', memoryFreeMb: 2048})

    // Turn 2
    const turn2 = await actor.step('Execute diagnostic inspection', history)
    expect(turn2.isDone).toBe(true)
    expect(turn2.record.finalAnswer).toBe('System diagnostics all normal.')
})

test('README snippet: Multi-Phase Agent Pipelines (LLMPipeline)', async () => {
    const phasesObserved: string[] = []

    const asker = createQueueAsker([
        // 1. Preprocess
        {
            normalizedGoal: 'Check status for client c_123 and calculate discount',
            domain: 'billing',
            constraints: ['State both tier and discount'],
            relevantTools: ['get_client_status', 'calculate_discount'],
            suggestedPhases: ['status', 'discount'],
        },
        // 2. Plan
        {
            strategy: 'Fetch status then calculate discount',
            steps: [
                {
                    id: 'step_status',
                    description: 'Get client subscription tier and credits',
                    assignedTools: ['get_client_status'],
                },
                {
                    id: 'step_discount',
                    description: 'Calculate discount using credits',
                    assignedTools: ['calculate_discount'],
                    dependsOn: ['step_status'],
                },
            ],
        },
        // 3. Step 1 tool call
        {
            thought: 'Calling get_client_status',
            action: 'tool_call',
            toolCalls: [{id: 'call_1', name: 'get_client_status', parameters: {clientId: 'c_123'}}],
        },
        // 4. Step 1 final answer
        {
            thought: 'Have client status',
            action: 'final_answer',
            finalAnswer: 'Client c_123 is on enterprise tier with 450 credits.',
        },
        // 5. Step 2 tool call
        {
            thought: 'Calling calculate_discount',
            action: 'tool_call',
            toolCalls: [{id: 'call_2', name: 'calculate_discount', parameters: {credits: 450}}],
        },
        // 6. Step 2 final answer
        {
            thought: 'Have discount',
            action: 'final_answer',
            finalAnswer: 'Discount is 20%.',
        },
        // 7. Synthesize
        'Client c_123 is on enterprise tier with 450 credits, earning a 20% discount.',
    ])

    const pipeline = new LLMPipeline(asker, {
        tools: [
            {
                name: 'get_client_status',
                description: 'Returns client subscription tier and credits',
                parameters: z.object({clientId: z.string()}),
                execute: ({clientId}) => ({clientId, tier: 'enterprise', credits: 450}),
            },
            {
                name: 'calculate_discount',
                description: 'Calculates renewal discount based on tier and credits',
                parameters: z.object({credits: z.number()}),
                execute: ({credits}) => ({discountPercent: credits > 400 ? 20 : 10}),
            },
        ],
        onPhaseChange: (phase) => {
            phasesObserved.push(phase)
        },
    })

    const result = await pipeline.run(
        'Check status for client "c_123" with get_client_status, then calculate their discount using calculate_discount. State both tier and discount.',
    )

    expect(result.ok).toBe(true)
    expect(result.finalText).toContain('enterprise tier with 450 credits, earning a 20% discount')
    expect(result.plan.steps.length).toBe(2)
    expect(phasesObserved).toContain('preprocess')
    expect(phasesObserved).toContain('plan')
    expect(phasesObserved).toContain('execute')
    expect(phasesObserved).toContain('verify')
})

test('README snippet: Pluggable Architecture (Custom Preprocessor & Planner)', async () => {
    const asker = createQueueAsker([
        // Step 1 tool call
        {
            thought: 'Running custom step',
            action: 'tool_call',
            toolCalls: [{id: 'c1', name: 'custom_tool', parameters: {}}],
        },
        // Step 1 final answer
        {
            thought: 'Done custom step',
            action: 'final_answer',
            finalAnswer: 'Custom step completed',
        },
        // Synthesize
        'All custom operations succeeded.',
    ])

    const customPreprocessor = {
        async preprocess(goal: string) {
            return {
                normalizedGoal: `[Custom]: ${goal}`,
                domain: 'custom',
                constraints: ['custom constraint'],
                relevantTools: ['custom_tool'],
                suggestedPhases: ['custom'],
            }
        },
    }

    const customPlanner = {
        async plan() {
            return {
                strategy: 'Custom execution strategy',
                steps: [
                    {
                        id: 'custom_step_1',
                        description: 'Execute custom tool',
                        assignedTools: ['custom_tool'],
                    },
                ],
            }
        },
    }

    const pipeline = new LLMPipeline(asker, {
        tools: [
            {
                name: 'custom_tool',
                description: 'Custom tool',
                parameters: z.object({}),
                execute: () => ({success: true}),
            },
        ],
        preprocessor: customPreprocessor,
        planner: customPlanner,
    })

    const result = await pipeline.run('Run custom workflow')
    expect(result.ok).toBe(true)
    expect(result.intent.domain).toBe('custom')
    expect(result.plan.strategy).toBe('Custom execution strategy')
})

test('README snippet: Happy Path + Exception Wisdom Interceptor', async () => {
    let attempts = 0

    const asker = createQueueAsker([
        // 1. Preprocess
        {
            normalizedGoal: 'Access protected server stats',
            domain: 'ops',
            constraints: [],
            relevantTools: ['get_server_metrics'],
            suggestedPhases: ['metrics'],
        },
        // 2. Plan
        {
            strategy: 'Fetch metrics',
            steps: [
                {
                    id: 'fetch_metrics',
                    description: 'Fetch server metrics',
                    assignedTools: ['get_server_metrics'],
                },
            ],
        },
        // 3. First attempt tool call (fails because missing apiToken)
        {
            thought: 'Fetching server metrics without token',
            action: 'tool_call',
            toolCalls: [{id: 'call_fail', name: 'get_server_metrics', parameters: {}}],
        },
        // 4. Retry attempt tool call (with wisdom apiToken)
        {
            thought: 'Fetching server metrics with apiToken SECRET_123',
            action: 'tool_call',
            toolCalls: [{id: 'call_ok', name: 'get_server_metrics', parameters: {apiToken: 'SECRET_123'}}],
        },
        // 5. Step final answer
        {
            thought: 'Got metrics',
            action: 'final_answer',
            finalAnswer: 'Server cpu is 18%, memory usage is normal.',
        },
        // 6. Final synthesis
        'Server cpu is 18%, memory usage is normal.',
    ])

    const pipeline = new LLMPipeline(asker, {
        tools: [
            {
                name: 'get_server_metrics',
                description: 'Get metrics',
                parameters: z.object({apiToken: z.string().optional()}),
                execute: ({apiToken}) => {
                    attempts += 1
                    if (apiToken !== 'SECRET_123') {
                        throw new Error('Unauthorized: missing or invalid apiToken')
                    }
                    return {cpu: '18%', memory: 'normal'}
                },
            },
        ],
        maxStepRetries: 2,
        throwOnError: true,
        onException: (exc) => {
            if (exc.error.includes('Unauthorized')) {
                return {
                    action: 'retry',
                    wisdom: 'Authentication required. Call get_server_metrics with apiToken "SECRET_123".',
                }
            }
            return {action: 'abort', reason: 'Unhandled error'}
        },
    })

    const result = await pipeline.run('Fetch current server metrics')
    expect(result.ok).toBe(true)
    expect(result.finalText).toContain('cpu is 18%')
    expect(attempts).toBe(2)
})

test('README snippet: Loading Prompt Templates from Filesystem & Typed JSON', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'llm-readme-test-'))
    const promptPath = join(tempDir, 'db-review.prompt')

    writeFileSync(
        promptPath,
        `---
system: You are a principal database administrator.
task: reasoning
temperature: 0.2
---
Analyze this slow query log for {{ database.name }}:
{{ queryLog }}

Suggest up to {{ maxSuggestions }} indexes.`,
        'utf-8',
    )

    try {
        const asker = createEchoAsker({
            'Analyze this slow query log for analytics_prod': {
                suggestedIndexes: ['CREATE INDEX idx_user_created ON events(user_id, created_at DESC)'],
                estimatedSpeedup: '10x',
                risks: ['Minimal index write overhead'],
            },
        }, {promptsDir: tempDir})

        const RecommendationSchema = z.object({
            suggestedIndexes: z.array(z.string()),
            estimatedSpeedup: z.string(),
            risks: z.array(z.string()),
        })

        const result = await asker.promptJson(
            'db-review',
            {
                database: {name: 'analytics_prod'},
                queryLog: 'SELECT * FROM events WHERE user_id = 42 ORDER BY created_at DESC;',
                maxSuggestions: 3,
            },
            RecommendationSchema,
        )

        expect(result.ok).toBe(true)
        if (result.ok && result.data) {
            expect(result.data.suggestedIndexes.length).toBe(1)
            expect(result.data.suggestedIndexes[0]).toContain('idx_user_created')
            expect(result.data.estimatedSpeedup).toBe('10x')
        }
    } finally {
        rmSync(tempDir, {recursive: true, force: true})
    }
})

test('README snippet: Context Injection & RAG Protocol', async () => {
    let receivedPrompt = ''

    const completion = new CompletionEngine([]).registerAdapter({
        id: 'rag-adapter',
        async generate(options) {
            receivedPrompt = options.prompt
            return {
                ok: true,
                text: 'Email is stored as TEXT in the users table.',
                model: {providerId: 'rag-adapter', modelId: options.modelId},
            }
        },
    })

    const resolver: ContextResolver = async () => {
        return {
            items: [
                {id: '1', title: 'schema.sql', content: 'CREATE TABLE users (id INT, email TEXT);'},
            ],
        }
    }

    const asker = new Asker({
        contextResolver: resolver,
        completion,
        providers: {'rag-adapter': {id: 'rag-adapter', available: true}},
        routes: {default: 'rag-adapter/rag-model'},
    })

    const res = await asker.ask('How is email stored in the users table?', {
        context: {query: 'users table definition'},
    })

    expect(res.ok).toBe(true)
    expect(receivedPrompt).toContain('## Retrieved Context')
    expect(receivedPrompt).toContain('CREATE TABLE users (id INT, email TEXT);')
    expect(receivedPrompt).toContain('## Question\nHow is email stored in the users table?')
})

test('README snippet: Multi-Turn Session Memory (LLMSession)', async () => {
    const asker = createQueueAsker([
        'Acknowledged workspace directory.',
        'Your workspace path is /home/user/app.',
    ])

    const session = new LLMSession(asker, {maxHistoryTurns: 10})

    await session.ask('My workspace directory is /home/user/app.')
    const res = await session.ask('What was my workspace path?')

    expect(res.ok).toBe(true)
    expect(res.text).toBe('Your workspace path is /home/user/app.')
    expect(session.history.length).toBe(4) // user, ai, user, ai
    expect(session.history[0].content).toBe('My workspace directory is /home/user/app.')
    expect(session.history[2].content).toBe('What was my workspace path?')
})

test('README snippet: Telemetry & Metrics (LlmMetrics)', () => {
    const recordedEvents: LlmMetricEvent[] = []
    const bus = createMetricsPubSub('llm-telemetry')

    bus.on('metrics:recorded', (_event, metric) => {
        recordedEvents.push(metric)
    })

    const metrics = new LlmMetrics(undefined, {bus})

    metrics.record({
        timestamp: new Date().toISOString(),
        providerId: 'openai',
        modelId: 'gpt-4o',
        promptTokens: 120,
        completionTokens: 45,
        latencyMs: 410,
        success: true,
    })

    const totals = metrics.totals()
    expect(totals.calls).toBe(1)
    expect(totals.successes).toBe(1)
    expect(totals.promptTokens).toBe(120)
    expect(totals.completionTokens).toBe(45)
    expect(totals.totalTokens).toBe(165)
    expect(totals.avgLatencyMs).toBe(410)

    expect(recordedEvents.length).toBe(1)
    expect(recordedEvents[0].providerId).toBe('openai')
    expect(recordedEvents[0].totalTokens).toBe(165)
})
