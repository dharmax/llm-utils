import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
} from '../dist/index.mjs'

class MemoryTemplateSource {
    constructor(entries) {
        this.entries = entries
    }

    async fetch(name) {
        return this.entries[name] ?? ''
    }
}

function registerEchoAdapter(id) {
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

    assert.equal((await first.generate('hello', model, config)).ok, true)
    const missing = await second.generate('hello', model, config)
    assert.equal(missing.ok, false)
    assert.equal(missing.failure.kind, 'unsupported')
    assert.equal(missing.failure.fatal, true)
})

test('parseStructuredJson extracts, repairs, and validates model responses', () => {
    const schema = z.object({answer: z.literal(42)})

    assert.deepEqual(
        parseStructuredJson('```json\n{"answer": 42}\n```', schema),
        {answer: 42},
    )
    assert.deepEqual(
        parseStructuredJson('{answer: 42}', schema),
        {answer: 42},
    )
    assert.throws(
        () => parseStructuredJson('not JSON'),
        error => error instanceof StructuredJsonError && error.kind === 'parse_failed',
    )
    assert.throws(
        () => parseStructuredJson('{"answer": 1}', schema),
        error => error instanceof StructuredJsonError && error.kind === 'schema_invalid',
    )
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

        assert.equal(result.ok, false)
        assert.deepEqual(result.failure, {
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

    assert.equal(loaded.content, 'Hello {{ name }} | User: {{ user }}')
    assert.equal(loaded.manifest.system, 'System rules')
    assert.equal(loaded.manifest.format, 'json')
    assert.equal(
        engine.render(loaded.content, {name: 'Ada', user: {id: 1, role: 'admin'}}),
        'Hello Ada | User: {\n  "id": 1,\n  "role": "admin"\n}',
    )
})

test('PromptEngine parses YAML frontmatter and resolves nested dot-notation paths', async () => {
    const engine = new PromptEngine(new MemoryTemplateSource({
        'profile': '---\ntaskType: code\nsystem: You are a principal engineer.\n---\nHello {{ user.profile.name }}! Role: {{ user.profile.role }}. Email: {{ user.contact.email }}',
    }))

    const loaded = await engine.load('profile')
    assert.equal(loaded.manifest.taskType, 'code')
    assert.equal(loaded.manifest.system, 'You are a principal engineer.')

    const rendered = engine.render(loaded.content, {
        user: {
            profile: { name: 'Dharmax', role: 'architect' },
            contact: { email: 'dev@example.com' }
        }
    })
    assert.equal(rendered, 'Hello Dharmax! Role: architect. Email: dev@example.com')
})

test('FileTemplateSource loads prompt files from disk and integrates with Asker promptsDir', async () => {
    const testDir = join(tmpdir(), `llm-test-prompts-${Date.now()}`)
    mkdirSync(testDir, { recursive: true })

    try {
        writeFileSync(join(testDir, 'reviewer.md'), '---\nsystem: Strict Code Reviewer\n---\nReview diff for {{ project.name }}:\n{{ diff }}')
        writeFileSync(join(testDir, 'calculator.system'), 'System calculator instructions')
        writeFileSync(join(testDir, 'calculator.prompt'), 'Compute {{ expr }}')

        const fileSource = new FileTemplateSource(testDir)
        const engine = new PromptEngine(fileSource)

        // 1. Direct FileTemplateSource loading of .md with frontmatter
        const reviewer = await engine.load('reviewer')
        assert.equal(reviewer.manifest.system, 'Strict Code Reviewer')
        assert.equal(engine.render(reviewer.content, { project: { name: 'Semantic Studio' }, diff: '+const x = 1;' }), 'Review diff for Semantic Studio:\n+const x = 1;')

        // 2. Multipart .system and .prompt loading from disk
        const calc = await engine.load('calculator')
        assert.equal(calc.manifest.system, 'System calculator instructions')
        assert.equal(engine.render(calc.content, { expr: '2 + 2' }), 'Compute 2 + 2')

        // 3. Asker with promptsDir auto-wiring
        const providerId = 'unit-prompt-provider'
        const completion = registerEchoAdapter(providerId)
        const asker = new Asker({
            promptsDir: testDir,
            providers: { [providerId]: { id: providerId, available: true } },
            completion,
            defaultModel: `${providerId}/model-prompts`,
        })

        const res = await asker.prompt('reviewer', { project: { name: 'Text Compiler' }, diff: '-old\n+new' })
        assert.equal(res.ok, true)
        assert.equal(res.text.includes('system:Strict Code Reviewer'), true)
        assert.equal(res.text.includes('prompt:Review diff for Text Compiler:\n-old\n+new'), true)
    } finally {
        rmSync(testDir, { recursive: true, force: true })
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

    assert.equal(result.ok, true)
    assert.equal(result.text.includes('prompt:ping'), true)
    assert.equal(result.text.includes('system:be terse'), true)
    assert.deepEqual(result.model, {providerId, modelId: 'model-1'})
})

test('Asker.ask infers provider from bare model names and local models', async () => {
    const targets = []
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
    assert.deepEqual(targets[0], {providerId: 'openai', modelId: 'gpt-4o'})

    await asker.ask('local task', {model: 'qwen2.5-coder:7b'})
    assert.deepEqual(targets[1], {providerId: 'ollama', modelId: 'qwen2.5-coder:7b'})

    await asker.local('local prompt')
    assert.deepEqual(targets[2], {providerId: 'ollama', modelId: 'llama3.2'})
})

test('Asker.json executes, parses, repairs, and returns typed data', async () => {
    const providerId = 'unit-json'
    let requestOptions
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

    assert.equal(result.ok, true)
    assert.deepEqual(result.data, {answer: 42})
    assert.equal(requestOptions.format.type, 'json_schema')
})

test('Asker.prompt loads template, resolves context, and executes', async () => {
    const providerId = 'unit-template'
    const completion = registerEchoAdapter(providerId)
    const promptEngine = new PromptEngine(new MemoryTemplateSource({
        'draft.system': '--- json\n{"taskType":"code"}\n---\nStay grounded',
        'draft.prompt': 'Question: {{ inputText }}\nContext:\n{{ context }}',
    }))

    const contextResolver = async req => `Context for: ${req.query}`

    const asker = new Asker({
        providers: {[providerId]: {id: providerId, available: true}},
        completion,
        promptEngine,
        context: contextResolver,
        routes: {'default': `${providerId}/template-model`},
    })

    const result = await asker.prompt('draft', {inputText: 'Explain routing'})

    assert.equal(result.ok, true)
    assert.equal(result.text.includes('Question: Explain routing'), true)
    assert.equal(result.text.includes('Context for: Explain routing'), true)
    assert.equal(result.text.includes('system:Stay grounded'), true)
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
    assert.equal(askResult.ok, true)
    assert.equal(session.getHistory().length, 2)

    const promptResult = await session.prompt('reply', {inputText: 'Hello there'})
    assert.equal(promptResult.ok, true)
    assert.equal(typeof promptResult.latencyMs, 'number')
    assert.equal(session.getHistory().length, 4)
    assert.equal(session.getContext().metadata.turnCount, 2)
})

test('LlmMetrics aggregates totals, groupings, and pubsub events', () => {
    const bus = createMetricsPubSub('Metrics Test')
    const metrics = new LlmMetrics(new InMemoryMetricsStore(), {bus, origin: 'unit-test'})
    let received = null

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
    assert.equal(totals.calls, 2)
    assert.equal(totals.totalTokens, 290)
    assert.equal(totals.failures, 1)
    assert.equal(totals.successRate, 50)
    assert.equal(received.providerId, 'openai')

    const byProv = metrics.byProvider()
    assert.equal(byProv.length, 1)
    assert.equal(byProv[0].providerId, 'openai')
    assert.equal(byProv[0].metrics.calls, 2)

    const byMod = metrics.byModel()
    assert.equal(byMod.length, 1)
    assert.equal(byMod[0].modelId, 'gpt-4o-mini')
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
    })

    try {
        const state = await ProviderDiscovery.discover({
            ollamaHost: '127.0.0.1:11434',
            customProviders: {
                custom: {id: 'custom', available: true},
            },
        })

        assert.equal(state.ollama.host, 'http://127.0.0.1:11434')
        assert.equal(state.ollama.available, true)
        assert.equal(state.custom.available, true)
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

    assert.deepEqual(router.resolve('openai/gpt-4o'), {providerId: 'openai', modelId: 'gpt-4o'})
    assert.deepEqual(router.resolve('claude-3-7-sonnet'), {providerId: 'anthropic', modelId: 'claude-3-7-sonnet'})
    assert.deepEqual(router.resolve('gemini-2.0-flash'), {providerId: 'google', modelId: 'gemini-2.0-flash'})
    assert.deepEqual(router.resolve('deepseek-r1'), {providerId: 'ollama', modelId: 'deepseek-r1'})
    assert.deepEqual(router.resolve('custom-task'), {providerId: 'openai', modelId: 'gpt-4o'})
    assert.deepEqual(router.resolve('dynamic'), {providerId: 'anthropic', modelId: 'claude-3-7-sonnet'})
    assert.deepEqual(router.resolve(undefined, ['ollama'], true), {providerId: 'ollama', modelId: 'llama3.2'})
})
