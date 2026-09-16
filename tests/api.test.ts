import {expect, test} from 'bun:test'
import {
    Asker,
    CompletionEngine,
    createMetricsPubSub,
    FileTemplateSource,
    InMemoryMetricsStore,
    LLMSession,
    LlmMetrics,
    ModelRouter,
    OpenAIAdapter,
    parseStructuredJson,
    PromptEngine,
    ProviderDiscovery,
    StructuredJsonError,
    z,
} from '../src/index.ts'

class MemoryTemplateSource {
    constructor(private readonly entries: Record<string, string>) {}

    async fetch(name: string) {
        return this.entries[name] ?? ''
    }
}

function registerEchoAdapter(id: string) {
    return new CompletionEngine([]).registerAdapter({
        id,
        async generate(options) {
            return {
                text: `adapter:${id}|model:${options.modelId}|prompt:${options.prompt}|system:${options.system ?? ''}`,
                ok: true,
                usage: {
                    promptTokens: 3,
                    completionTokens: 5,
                    totalTokens: 8,
                    available: true,
                },
                model: {
                    providerId: id,
                    modelId: options.modelId,
                },
                raw: {echoed: true},
            }
        },
    })
}

test('CompletionEngine owns adapters per instance', async () => {
    const first = registerEchoAdapter('isolated')
    const second = new CompletionEngine([])
    const model = {id: 'model', providerId: 'isolated', modelId: 'model'}
    const config = {id: 'isolated'}

    expect((await first.generate('hello', model, config)).ok).toBe(true)
    const missing = await second.generate('hello', model, config)
    expect(missing.ok).toBe(false)
    expect(missing.failure?.kind).toBe('unsupported')
    expect(missing.failure?.fatal).toBe(true)
})

test('parseStructuredJson extracts, repairs, and validates model responses', () => {
    const schema = z.object({answer: z.literal(42)})

    expect(
        parseStructuredJson('```json\n{"answer": 42}\n```', schema),
    ).toEqual({answer: 42})
    expect(
        parseStructuredJson('{answer: 42}', schema),
    ).toEqual({answer: 42})
    expect(
        () => parseStructuredJson('not JSON'),
    ).toThrow()
    expect(
        () => parseStructuredJson('{"answer": 1}', schema),
    ).toThrow()
})

test('provider HTTP failures preserve typed quota evidence', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({
        error: {
            code: 'insufficient_quota',
            message: 'No API credits remain.',
        },
    }), {
        status: 429,
        headers: {'Content-Type': 'application/json'},
    })

    try {
        const completion = new CompletionEngine([new OpenAIAdapter()])
        const result = await completion.generate(
            'hello',
            {modelId: 'gpt-test', providerId: 'openai'},
            {id: 'openai', apiKey: 'test-key'},
        )

        expect(result.ok).toBe(false)
        expect(result.failure).toEqual({
            kind: 'quota',
            message: 'No API credits remain.',
            status: 429,
            code: 'insufficient_quota',
            retryable: false,
            fatal: true,
            raw: {
                error: {
                    code: 'insufficient_quota',
                    message: 'No API credits remain.',
                },
            },
        })
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('PromptEngine loads multipart templates, parses JSON frontmatter, and renders variables', async () => {
    const engine = new PromptEngine(new MemoryTemplateSource({
        'greeting.system': '--- json\n{"format":"json"}\n---\nSystem rules',
        'greeting.prompt': 'Hello {{ name }}<!-- hidden --> | User: {{ user }}',
    }))

    const loaded = await engine.load('greeting')

    expect(loaded.content).toBe('Hello {{ name }} | User: {{ user }}')
    expect(loaded.manifest.system).toBe('System rules')
    expect(loaded.manifest.format).toBe('json')
    expect(
        engine.render(loaded.content, {name: 'Ada', user: {id: 1, role: 'admin'}}),
    ).toBe('Hello Ada | User: {\n  "id": 1,\n  "role": "admin"\n}')
})

test('PromptEngine parses YAML frontmatter and resolves nested dot-notation paths', async () => {
    const engine = new PromptEngine(new MemoryTemplateSource({
        'profile': '---\ntaskType: code\nsystem: You are a principal engineer.\n---\nHello {{ user.profile.name }}! Role: {{ user.profile.role }}. Email: {{ user.contact.email }}',
    }))

    const loaded = await engine.load('profile')
    expect(loaded.manifest.taskType).toBe('code')
    expect(loaded.manifest.system).toBe('You are a principal engineer.')

    const rendered = engine.render(loaded.content, {
        user: {
            profile: { name: 'Dharmax', role: 'architect' },
            contact: { email: 'dev@example.com' }
        }
    })
    expect(rendered).toBe('Hello Dharmax! Role: architect. Email: dev@example.com')
})

test('FileTemplateSource loads prompt files from disk and integrates with Asker promptsDir', async () => {
    const testDir = `/tmp/llm-test-prompts-${Date.now()}`

    try {
        await Bun.write(`${testDir}/reviewer.md`, '---\nsystem: Strict Code Reviewer\n---\nReview diff for {{ project.name }}:\n{{ diff }}')
        await Bun.write(`${testDir}/calculator.system`, 'System calculator instructions')
        await Bun.write(`${testDir}/calculator.prompt`, 'Compute {{ expr }}')

        const fileSource = new FileTemplateSource(testDir)
        const engine = new PromptEngine(fileSource)

        // 1. Direct FileTemplateSource loading of .md with frontmatter
        const reviewer = await engine.load('reviewer.md')
        expect(reviewer.manifest.system).toBe('Strict Code Reviewer')
        expect(engine.render(reviewer.content, { project: { name: 'Semantic Studio' }, diff: '+const x = 1;' })).toBe('Review diff for Semantic Studio:\n+const x = 1;')

        // 2. Multipart .system and .prompt loading from disk
        const calc = await engine.load('calculator')
        expect(calc.manifest.system).toBe('System calculator instructions')
        expect(engine.render(calc.content, { expr: '2 + 2' })).toBe('Compute 2 + 2')

        // 3. Asker with promptsDir auto-wiring
        const providerId = 'unit-prompt-provider'
        const completion = registerEchoAdapter(providerId)
        const asker = new Asker({
            promptsDir: testDir,
            providers: { [providerId]: { id: providerId, available: true } },
            completion,
            defaultModel: `${providerId}/model-prompts`,
        })

        const res = await asker.prompt('reviewer.md', { project: { name: 'Text Compiler' }, diff: '-old\n+new' })
        expect(res.ok).toBe(true)
        expect(res.text.includes('system:Strict Code Reviewer')).toBe(true)
        expect(res.text.includes('prompt:Review diff for Text Compiler:\n-old\n+new')).toBe(true)
    } finally {
        await Bun.$`rm -rf ${testDir}`.quiet()
    }
})

test('Asker executes direct ask with model routing', async () => {
    const providerId = 'unit-provider'
    const completion = registerEchoAdapter(providerId)

    const asker = new Asker({
        providers: {
            [providerId]: {id: providerId, available: true},
        },
        completion,
        routes: {'code': `${providerId}/model-1`},
    })

    const result = await asker.ask('ping', {task: 'code', system: 'be terse'})

    expect(result.ok).toBe(true)
    expect(result.text.includes('prompt:ping')).toBe(true)
    expect(result.text.includes('system:be terse')).toBe(true)
    expect(result.model).toEqual({providerId, modelId: 'model-1'})
})

test('Asker.ask infers provider from bare model names and local models', async () => {
    const targets: Array<{providerId: string; modelId: string}> = []
    const completion = new CompletionEngine([]).registerAdapter({
        id: 'openai',
        async generate(options) {
            targets.push({providerId: 'openai', modelId: options.modelId})
            return {ok: true, text: 'ok', model: {providerId: 'openai', modelId: options.modelId}}
        },
    }).registerAdapter({
        id: 'ollama',
        async generate(options) {
            targets.push({providerId: 'ollama', modelId: options.modelId})
            return {ok: true, text: 'ok', model: {providerId: 'ollama', modelId: options.modelId}}
        },
    })

    const asker = new Asker({
        providers: {
            openai: {id: 'openai', available: true},
            ollama: {id: 'ollama', available: true},
        },
        completion,
    })

    await asker.ask('hello', {model: 'gpt-4o'})
    expect(targets[0]).toEqual({providerId: 'openai', modelId: 'gpt-4o'})

    await asker.ask('local task', {model: 'qwen2.5-coder:7b'})
    expect(targets[1]).toEqual({providerId: 'ollama', modelId: 'qwen2.5-coder:7b'})

    await asker.local('local prompt')
    expect(targets[2]).toEqual({providerId: 'ollama', modelId: 'qwen2.5-coder:7b'})
})

test('Asker.json executes, parses, repairs, and returns typed data', async () => {
    const providerId = 'unit-json'
    let requestOptions: any
    const completion = new CompletionEngine([]).registerAdapter({
        id: providerId,
        async generate(options) {
            requestOptions = options
            return {
                text: 'Result:\n```json\n{answer: 42}\n```',
                ok: true,
                model: {providerId, modelId: options.modelId},
            }
        },
    })

    const asker = new Asker({
        providers: {[providerId]: {id: providerId, available: true}},
        completion,
        routes: {'default': `${providerId}/json-model`},
    })

    const schema = z.object({answer: z.literal(42)})
    const result = await asker.json('What is six times seven?', schema)

    expect(result.ok).toBe(true)
    expect(result.data).toEqual({answer: 42})
    expect(requestOptions.format.type).toBe('json_schema')
})

test('Asker.prompt loads template, resolves context, and executes', async () => {
    const providerId = 'unit-template'
    const completion = registerEchoAdapter(providerId)
    const promptEngine = new PromptEngine(new MemoryTemplateSource({
        'draft.system': '--- json\n{"taskType":"code"}\n---\nStay grounded',
        'draft.prompt': 'Question: {{ inputText }}\nContext:\n{{ context }}',
    }))

    const contextResolver = async (req: any) => `Context for: ${req.query}`

    const asker = new Asker({
        providers: {[providerId]: {id: providerId, available: true}},
        completion,
        promptEngine,
        context: contextResolver,
        routes: {'default': `${providerId}/template-model`},
    })

    const result = await asker.prompt('draft', {inputText: 'Explain routing'})

    expect(result.ok).toBe(true)
    expect(result.text.includes('Question: Explain routing')).toBe(true)
    expect(result.text.includes('Context for: Explain routing')).toBe(true)
    expect(result.text.includes('system:Stay grounded')).toBe(true)
})

test('LLMSession records history and metrics across ask and prompt turns', async () => {
    const providerId = 'unit-session'
    const completion = registerEchoAdapter(providerId)
    const promptEngine = new PromptEngine(new MemoryTemplateSource({
        'reply.prompt': 'User said: {{ inputText }}',
    }))

    const asker = new Asker({
        providers: {[providerId]: {id: providerId, available: true}},
        completion,
        promptEngine,
        routes: {'default': `${providerId}/session-model`},
    })

    const session = new LLMSession(asker)
    const askResult = await session.ask('Direct chat message')
    expect(askResult.ok).toBe(true)
    expect(session.getHistory().length).toBe(2)

    const promptResult = await session.prompt('reply', {inputText: 'Hello there'})
    expect(promptResult.ok).toBe(true)
    expect(typeof promptResult.latencyMs).toBe('number')
    expect(session.getHistory().length).toBe(4)
    expect(session.getContext().metadata?.turnCount).toBe(2)
})

test('LlmMetrics aggregates totals, groupings, and pubsub events', () => {
    const bus = createMetricsPubSub('Metrics Test')
    const metrics = new LlmMetrics(new InMemoryMetricsStore(), {bus, origin: 'unit-test'})
    let received: any = null

    bus.on('metrics:recorded', (_event, data) => {
        received = data
        return true
    })

    metrics.record({
        timestamp: '2026-04-01T10:00:10.000Z',
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        promptTokens: 100,
        completionTokens: 40,
        latencyMs: 900,
        success: true,
        costUsd: 0.002,
    })

    metrics.record({
        timestamp: '2026-04-01T10:00:50.000Z',
        providerId: 'openai',
        modelId: 'gpt-4o-mini',
        promptTokens: 120,
        completionTokens: 30,
        latencyMs: 1100,
        success: false,
        error: 'timeout',
        costUsd: 0.003,
    })

    const totals = metrics.totals()
    expect(totals.calls).toBe(2)
    expect(totals.totalTokens).toBe(290)
    expect(totals.failures).toBe(1)
    expect(totals.successRate).toBe(50)
    expect(received.providerId).toBe('openai')

    const byProv = metrics.byProvider()
    expect(byProv.length).toBe(1)
    expect(byProv[0]?.providerId).toBe('openai')
    expect(byProv[0]?.metrics.calls).toBe(2)

    const byMod = metrics.byModel()
    expect(byMod.length).toBe(1)
    expect(byMod[0]?.modelId).toBe('gpt-4o-mini')
})

test('ProviderDiscovery auto-detects and normalizes ollama host', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => ({
        ok: true,
        async json() {
            return {
                models: [
                    {name: 'phi4', size: 2 * 1024 ** 3},
                ],
            }
        },
    } as any)

    try {
        const state = await ProviderDiscovery.discover({
            ollamaHost: '127.0.0.1:11434',
            customProviders: {
                custom: {id: 'custom', available: true},
            },
        })

        expect(state.ollama.host).toBe('http://127.0.0.1:11434')
        expect(state.ollama.available).toBe(true)
        expect(state.custom?.available).toBe(true)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('ModelRouter resolves explicit targets, bare models, and custom router functions', () => {
    const router = new ModelRouter({
        routes: {
            'custom-task': 'openai/gpt-4o',
        },
        router: (task) => {
            if (task === 'dynamic')
                return 'anthropic/claude-3-7-sonnet'
            return undefined
        },
    })

    expect(router.resolve('openai/gpt-4o')).toEqual({providerId: 'openai', modelId: 'gpt-4o'})
    expect(router.resolve('claude-3-7-sonnet')).toEqual({providerId: 'anthropic', modelId: 'claude-3-7-sonnet'})
    expect(router.resolve('gemini-2.0-flash')).toEqual({providerId: 'google', modelId: 'gemini-2.0-flash'})
    expect(router.resolve('deepseek-r1')).toEqual({providerId: 'ollama', modelId: 'deepseek-r1'})
    expect(router.resolve('custom-task')).toEqual({providerId: 'openai', modelId: 'gpt-4o'})
    expect(router.resolve('dynamic')).toEqual({providerId: 'anthropic', modelId: 'claude-3-7-sonnet'})
    expect(router.resolve(undefined, ['ollama'], true)).toEqual({providerId: 'ollama', modelId: 'qwen2.5-coder:7b'})
})
