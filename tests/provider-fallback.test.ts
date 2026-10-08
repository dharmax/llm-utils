import {expect, test} from 'bun:test'
import {Asker, CompletionEngine, InMemoryMetricsStore, z, type GenerateOptions, type LlmFailure} from '../src/index.ts'

const quota: LlmFailure = {kind: 'quota', message: 'credit_balance_exhausted', retryable: false, fatal: true}

function fixture(failure = quota, fallbackFails = false) {
    const calls: Array<{provider: string; options: GenerateOptions}> = []
    const completion = new CompletionEngine([])
    for (const provider of ['openai', 'ollama']) completion.registerAdapter({
        id: provider,
        async generate(options) {
            calls.push({provider, options})
            const model = {providerId: provider, modelId: options.modelId}
            return provider === 'openai' || fallbackFails
                ? {ok: false, text: '', model, failure}
                : {ok: true, text: '{"value":7}', model}
        },
    })
    const metrics = new InMemoryMetricsStore()
    const asker = new Asker({
        providers: {openai: {id: 'openai', available: true}, ollama: {id: 'ollama', available: true}},
        defaultModel: 'ollama/qwen2.5-coder:7b', preferLocal: true, advicePath: false,
        completion, metricsSink: metrics,
    })
    return {asker, calls, metrics}
}

test('fatal task-provider failure uses eligible fallback and preserves request and metrics', async () => {
    const {asker, calls, metrics} = fixture()
    const result = await asker.json('exact goal', z.object({value: z.literal(7)}), {
        task: 'code', system: 'exact system', maxTokens: 123, contextWindow: 456, temperature: 0,
    })
    expect(result.ok).toBe(true)
    expect(result.data?.value).toBe(7)
    expect(result.model).toEqual({providerId: 'ollama', modelId: 'qwen2.5-coder:7b'})
    expect(calls.map(c => c.provider)).toEqual(['openai', 'ollama'])
    expect(calls[1]!.options.prompt).toBe('exact goal')
    expect(calls[1]!.options.system).toBe('exact system')
    expect(calls[1]!.options.maxTokens).toBe(123)
    expect(calls[1]!.options.contextWindow).toBe(456)
    expect(calls[1]!.options.format).toEqual(calls[0]!.options.format)
    expect(metrics.query({kind: 'llm', order: 'asc'}).map(e => e.kind === 'llm' ? [e.providerId, e.success, e.attempt] : [])).toEqual([
        ['openai', false, 1], ['ollama', true, 2],
    ])
    const next = await asker.ask('next goal', {task: 'code'})
    expect(next.ok).toBe(true)
    expect(calls.map(c => c.provider)).toEqual(['openai', 'ollama', 'ollama'])
})

test('explicit model and provider override do not silently switch', async () => {
    for (const options of [{model: 'openai/gpt-4o'}, {task: 'code', providerConfig: {id: 'openai'}}]) {
        const {asker, calls} = fixture()
        expect((await asker.ask('goal', options)).ok).toBe(false)
        expect(calls.map(c => c.provider)).toEqual(['openai'])
    }
})

test('retryable rate limit uses eligible alternate', async () => {
    const {asker, calls} = fixture({...quota, kind: 'rate_limit', fatal: false, retryable: true})
    expect((await asker.ask('goal', {task: 'code'})).ok).toBe(true)
    expect(calls.map(c => c.provider)).toEqual(['openai', 'ollama'])
})

test('nonfatal nonretryable response failure does not trigger provider switching', async () => {
    const {asker, calls} = fixture({kind: 'invalid_response', message: 'Bad response', retryable: false, fatal: false})
    expect((await asker.ask('goal', {task: 'code'})).ok).toBe(false)
    expect(calls.map(c => c.provider)).toEqual(['openai'])
})

test('retryable network failure uses alternate without permanently opening primary circuit', async () => {
    const {asker, calls} = fixture({kind: 'network', message: 'Connection failed', retryable: true, fatal: false})
    expect((await asker.ask('goal', {task: 'code'})).ok).toBe(true)
    expect(calls.map(c => c.provider)).toEqual(['openai', 'ollama'])
    expect((await asker.ask('next goal', {task: 'code'})).ok).toBe(true)
    expect(calls.map(c => c.provider)).toEqual(['openai', 'ollama', 'openai', 'ollama'])
})

test('all retryable providers terminate after one failed attempt each', async () => {
    const {asker, calls} = fixture({kind: 'network', message: 'Connection failed', retryable: true, fatal: false}, true)
    expect((await asker.ask('goal', {task: 'code'})).ok).toBe(false)
    expect(calls.map(c => c.provider)).toEqual(['openai', 'ollama'])
})

test('cancellation prevents fallback even when primary reports fatal failure', async () => {
    const {asker, calls} = fixture()
    expect((await asker.ask('goal', {task: 'code', signal: AbortSignal.abort()})).ok).toBe(false)
    expect(calls.map(c => c.provider)).toEqual(['openai'])
})

test('all fatal providers terminate after one attempt each', async () => {
    const {asker, calls} = fixture(quota, true)
    const result = await asker.ask('goal', {task: 'code'})
    expect(result.ok).toBe(false)
    expect(result.failure?.kind).toBe('quota')
    expect(calls.map(c => c.provider)).toEqual(['openai', 'ollama'])
    expect((await asker.ask('next', {task: 'code'})).ok).toBe(false)
    expect(calls).toHaveLength(2)
})

test('configured concrete gateway fallback is eligible before unrelated legacy models', async () => {
    const calls: string[] = []
    const completion = new CompletionEngine([])
    for (const provider of ['openai', 'openrouter']) completion.registerAdapter({id:provider, async generate(options) {
        calls.push(`${provider}/${options.modelId}`)
        return provider === 'openai' ? {ok:false,text:'',model:{providerId:provider,modelId:options.modelId},failure:quota} : {ok:true,text:'ready',model:{providerId:provider,modelId:options.modelId}}
    }})
    const asker = new Asker({providers:{openai:{id:'openai',available:true},openrouter:{id:'openrouter',available:true}},routes:{code:'openai/gpt-4o-mini'},fallbacks:{code:['openrouter/openai/gpt-4o-mini']},advicePath:false,completion} as ConstructorParameters<typeof Asker>[0])
    expect((await asker.ask('goal',{task:'code'})).ok).toBe(true)
    expect(calls).toEqual(['openai/gpt-4o-mini','openrouter/openai/gpt-4o-mini'])
})

test('hard provider restrictions reject conflicting explicit choices without transport', async () => {
    const {asker,calls}=fixture()
    const result=await asker.ask('goal',{model:'openai/gpt-4o',allowedProviders:['ollama']} as Parameters<Asker['ask']>[1])
    expect(result.failure?.kind).toBe('configuration')
    expect(calls).toHaveLength(0)
    expect((await asker.ask('goal',{task:'code',allowedProviders:['ollama']} as Parameters<Asker['ask']>[1])).ok).toBe(true)
    expect(calls.map(c=>c.provider)).toEqual(['ollama'])
})
