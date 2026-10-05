import {afterEach, beforeEach, expect, test} from 'bun:test'
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {
    Asker, CompletionEngine, InMemoryMetricsStore, LlmMetrics, ModelRouter,
    ProviderDiscovery, readModelAdvice, refreshModelAdvice, discoverHardware,
    type ModelAdviceAuthority, type ModelRecommendation, type ProviderConfig,
} from '../src/index.ts'

let directory: string
let path: string
const originalFetch = globalThis.fetch
const hardware = async () => ({
    platform: 'linux', architecture: 'x64', ramBytes: 32 * 1024 ** 3,
    cpu: 'fixture CPU', logicalCpus: 8, gpus: [{name: 'fixture GPU', vramBytes: 12 * 1024 ** 3}],
})
const providers: Record<string, ProviderConfig> = {
    ollama: {id: 'ollama', host: 'http://fixture:11434', available: true, local: true},
    remote: {id: 'remote', apiKey: 'private-fixture-credential', available: true},
}
const local = (modelId: string): ModelRecommendation => ({
    target: {providerId: 'ollama', modelId}, availability: 'installed',
    reason: 'Good fit for measured hardware', localFit: 'good',
})
const remote: ModelRecommendation = {
    target: {providerId: 'remote', modelId: 'precise-model'}, availability: 'accessible',
    contextWindow: 128000, capabilities: ['code', 'tools'], expectedQuality: 'strong',
    economics: {inputPer1M: 0.5, outputPer1M: 2, cachedInputPer1M: 0.05,
        tokenEfficiency: 'high', reasoningOverhead: 'medium', expectedRetryRisk: 'low'},
    reason: 'Expected fewer retries and less output per successful task',
    evidence: ['https://example.org/model-card'],
}
const pull: ModelRecommendation = {
    ...local('new-family:14b'), availability: 'pullable',
    reason: 'Material quality improvement within available VRAM',
}
const research = () => ({
    workloads: {code: {primary: local('installed:7b'), fallbacks: [remote, local('backup:3b')]}},
    recommendedPulls: [pull], notes: ['Prices may vary'],
})
const authority = (output: unknown = research()): ModelAdviceAuthority => ({id: 'fixture-live-advisor', async research() {return output}})

function mockOllama(installed = ['installed:7b', 'backup:3b'], showFailure = false) {
    const calls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/api/tags'))
            return Response.json({models: installed.map(name => ({name, size: 4 * 1024 ** 3}))})
        if (url.endsWith('/api/show')) {
            expect(options?.method).toBe('POST')
            expect(installed).toContain(JSON.parse(String(options?.body)).model)
            if (showFailure) return new Response('', {status: 500})
            return Response.json({details: {parameter_size: '7B', quantization_level: 'Q4_K_M', family: 'fixture'},
                model_info: {'general.architecture': 'fixture-arch', 'fixture-arch.context_length': 32768},
                modelfile: 'unneeded private template'})
        }
        throw new Error('Unexpected network operation: ' + url)
    }) as typeof fetch
    return calls
}
const refresh = (advisor = authority()) => refreshModelAdvice(advisor, {code: 'Agentic coding'}, {providers, hardware, advicePath: path})
const current = (): Record<string, ProviderConfig> => ({
    remote: {...providers.remote!}, ollama: {...providers.ollama!, models: [{id: 'installed:7b', providerId: 'ollama'}, {id: 'backup:3b', providerId: 'ollama'}]},
})
const completion = () => new CompletionEngine(['ollama', 'remote', 'openai'].map(id => ({
    id, async generate(options: {modelId: string}) {
        return {ok: true, text: 'done', model: {providerId: id, modelId: options.modelId}}
    },
})))

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'llm-advice-'))
    path = join(directory, 'snapshot.json')
})
afterEach(async () => {
    globalThis.fetch = originalFetch
    await rm(directory, {recursive: true, force: true})
})

test('tags discovers actual installed models and show enriches only useful facts', async () => {
    const calls = mockOllama()
    const result = await ProviderDiscovery.probeOllama('fixture:11434', {enrich: true})
    expect(result.installed).toBe(true)
    expect(result.models[0]).toEqual({id: 'installed:7b', providerId: 'ollama', local: true, sizeB: 4,
        parameterSize: '7B', quantization: 'Q4_K_M', family: 'fixture', architecture: 'fixture-arch', contextWindow: 32768})
    expect(calls.filter(url => url.endsWith('/api/tags'))).toHaveLength(1)
    expect(calls.filter(url => url.endsWith('/api/show'))).toHaveLength(2)
    mockOllama(['installed:7b'], true)
    expect((await ProviderDiscovery.probeOllama('fixture:11434', {enrich: true})).models[0]?.id).toBe('installed:7b')
})

test('environment separates configuration, verified access and declarations without secrets', async () => {
    mockOllama()
    const configs = {...providers, remote: {...providers.remote!, entitlements: ['Team plan', 'accidental private-fixture-credential'],
        baseUrl: 'https://user:password@example.org?api_key=private-fixture-credential',
        providerOptions: {headers: {Authorization: 'Bearer private-fixture-credential'}}},
        configured: {id: 'configured', apiKey: 'another-private-credential', available: true},
        disabled: {id: 'disabled', apiKey: 'disabled-secret', enabled: false}}
    const result = await ProviderDiscovery.discoverEnvironment({providers: configs, hardware, entitlements: {declaredOnly: ['Chat subscription']},
        verifyProvider: async config => config.id === 'remote' ? {verification: 'verified', models: [{id: 'precise-model', providerId: config.id}]} : {verification: 'unverified'}})
    const encoded = JSON.stringify(result)
    for (const secret of ['private-fixture-credential', 'another-private-credential', 'disabled-secret', 'Authorization', 'apiKey', 'password'])
        expect(encoded).not.toContain(secret)
    expect(result.hardware.gpus[0]?.vramBytes).toBe(12 * 1024 ** 3)
    expect(result.providers.find(p => p.id === 'remote')).toMatchObject({configured: true, verification: 'verified', entitlements: ['Team plan', 'accidental [redacted]']})
    expect(result.providers.find(p => p.id === 'configured')).toMatchObject({configured: true, verification: 'unverified', entitlements: []})
    expect(result.providers.find(p => p.id === 'disabled')?.available).toBe(false)
    expect(result.providers.find(p => p.id === 'declaredOnly')).toMatchObject({configured: false, available: false, verification: 'unverified', entitlements: ['Chat subscription']})
})

test('remote model listing verifies practical access; rejected credentials stay distinct from entitlement', async () => {
    const calls: Array<{url: string; headers?: HeadersInit}> = []
    globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
        calls.push({url: String(input), headers: options?.headers})
        if (String(input).includes('openai')) return Response.json({data: [{id: 'gpt-fixture'}]})
        if (String(input).includes('google')) return Response.json({models: [{name: 'models/gemini-fixture'}], nextPageToken: 'more'})
        return new Response('', {status: 401})
    }) as typeof fetch
    const result = await ProviderDiscovery.discoverEnvironment({hardware, providers: {
        openai: {id: 'openai', apiKey: 'openai-private'},
        google: {id: 'google', apiKey: 'google-private', baseUrl: 'https://google.example/v1beta'},
        anthropic: {id: 'anthropic', apiKey: 'anthropic-private', entitlements: ['Declared Pro subscription']},
    }})
    expect(result.providers[0]).toMatchObject({verification: 'verified', models: [{id: 'gpt-fixture', providerId: 'openai'}]})
    expect(result.providers[1]?.verification).toBe('verified')
    expect(result.providers[1]?.models).toBeUndefined() // partial page is not an exhaustive access list
    expect(result.providers[2]).toMatchObject({verification: 'rejected', available: false, entitlements: ['Declared Pro subscription']})
    expect(calls.every(call => !call.url.includes('private'))).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private')
})

test('refresh researches discovered facts/workloads/aggregate metrics and persists economics/provenance', async () => {
    mockOllama()
    let count = 0
    const metrics = new LlmMetrics(new InMemoryMetricsStore())
    metrics.record({timestamp: new Date().toISOString(), providerId: 'remote', modelId: 'precise-model',
        promptTokens: 100, completionTokens: 25, latencyMs: 42, success: true, costUsd: 0.001,
        metadata: {privatePrompt: 'DO NOT SEND'}, error: 'DO NOT SEND'})
    const snapshot = await refreshModelAdvice({id: 'web-authority', async research(request) {
        count++
        expect(request.prompt).toContain('Agentic coding')
        expect(request.prompt).toContain('Q4_K_M')
        expect(request.prompt).toContain('cached-input')
        expect(request.prompt).toContain('precise-model')
        expect(request.prompt).toContain('avgLatencyMs')
        expect(request.prompt).not.toContain('DO NOT SEND')
        expect(request.prompt).not.toContain('private-fixture-credential')
        expect(request.schema).toHaveProperty('properties')
        return JSON.stringify(research())
    }}, {code: {description: 'Agentic coding', constraints: ['Reliable tool calls'], contextTokens: 16000}},
    {providers, hardware, metrics, advicePath: path})
    expect(count).toBe(1)
    expect(snapshot.advisor).toBe('web-authority')
    expect(Date.parse(snapshot.updatedAt)).not.toBeNaN()
    expect(readModelAdvice(path)).toEqual(snapshot)
    expect(readModelAdvice(path)?.workloads.code?.fallbacks[0]?.economics).toEqual(remote.economics)
    expect(readModelAdvice(path)?.recommendedPulls).toEqual([pull])
    expect(await readFile(path, 'utf8')).not.toContain('private-fixture-credential')
})

test('reconstructed router and Asker reuse persistent primary with zero authority/research/pull calls', async () => {
    const calls = mockOllama()
    let refreshCalls = 0
    await refresh({id: 'one-call-authority', async research() {refreshCalls++; return research()}})
    calls.length = 0
    const router = new ModelRouter({advicePath: path, providers: current()})
    expect(router.resolve('code', ['ollama', 'remote'])).toEqual(local('installed:7b').target)
    expect(calls).toHaveLength(0)
    const asker = new Asker({advicePath: path, providers, completion: completion()})
    expect((await asker.ask('Implement this', {task: 'code'})).model).toEqual(local('installed:7b').target)
    expect(calls).toEqual(['http://fixture:11434/api/tags'])
    expect(refreshCalls).toBe(1)
    expect(new ModelRouter({advicePath: path, providers: current()}).resolve('code', ['ollama', 'remote'])).toEqual(local('installed:7b').target)
})

test('local preference filters remote advice and Asker.local stays local', async () => {
    mockOllama()
    await refreshModelAdvice(authority({...research(), workloads: {
        default: {primary: remote, fallbacks: [local('installed:7b')]},
        code: {primary: remote, fallbacks: [local('installed:7b')]},
    }}), {default: 'General work', code: 'Agentic coding'}, {providers, hardware, advicePath: path})

    const configs = current()
    const router = new ModelRouter({advicePath: path, providers: configs, preferLocal: true})
    expect(router.resolve(undefined, ['ollama', 'remote'])).toEqual(local('installed:7b').target)
    expect(router.resolve('code', ['ollama', 'remote'])).toEqual(local('installed:7b').target)

    const calls = mockOllama()
    const asker = new Asker({advicePath: path, providers, completion: completion()})
    expect((await asker.local('Keep this local')).model).toEqual(local('installed:7b').target)
    expect(calls).toEqual(['http://fixture:11434/api/tags'])
})

test('explicit targets, bare model overrides and configured task routes outrank advice', async () => {
    mockOllama()
    await refresh()
    const router = new ModelRouter({advicePath: path, providers: current(), routes: {code: 'remote/configured'}})
    expect(router.resolve('code', ['remote', 'ollama'])).toEqual({providerId: 'remote', modelId: 'configured'})
    expect(router.resolve({providerId: 'openai', modelId: 'explicit'}, ['remote'])).toEqual({providerId: 'openai', modelId: 'explicit'})
    expect(router.resolve('gpt-explicit', ['remote'])).toEqual({providerId: 'openai', modelId: 'gpt-explicit'})
    const calls = mockOllama()
    const asker = new Asker({advicePath: path, providers, routes: {code: 'remote/configured'}, completion: completion()})
    expect((await asker.ask('x', {task: 'code', model: 'openai/override'})).model).toEqual({providerId: 'openai', modelId: 'override'})
    expect((await asker.ask('x', {task: 'code', model: 'gpt-override'})).model).toEqual({providerId: 'openai', modelId: 'gpt-override'})
    expect((await asker.ask('x', {task: 'code'})).model).toEqual({providerId: 'remote', modelId: 'configured'})
    expect(calls).toHaveLength(0)
})

test('deleted primary and unavailable providers fall through ranked choices without rewriting snapshot', async () => {
    mockOllama()
    await refresh()
    const before = await readFile(path, 'utf8')
    const configs = current()
    configs.ollama!.models = [{id: 'backup:3b', providerId: 'ollama'}]
    const router = new ModelRouter({advicePath: path, providers: configs})
    expect(router.resolve('code', ['remote', 'ollama'])).toEqual(remote.target)
    configs.remote!.available = false
    expect(router.resolve('code', ['remote', 'ollama'])).toEqual(local('backup:3b').target)
    configs.remote!.available = true
    configs.remote!.models = [] // directly known inaccessible model
    expect(router.resolve('code', ['remote', 'ollama'])).toEqual(local('backup:3b').target)
    mockOllama(['backup:3b'])
    const asker = new Asker({advicePath: path, providers, completion: completion()})
    expect((await asker.ask('x', {task: 'code'})).model).toEqual(remote.target)
    expect(await readFile(path, 'utf8')).toBe(before)
})

test('missing, corrupt, unusable and disabled advice preserve deterministic fallback', async () => {
    const router = new ModelRouter({advicePath: path})
    expect(router.resolve('code', ['openai'])).toEqual({providerId: 'openai', modelId: 'gpt-4o'})
    await writeFile(path, '{broken')
    expect(router.resolve('code', ['openai'])).toEqual({providerId: 'openai', modelId: 'gpt-4o'})
    mockOllama()
    await refresh()
    expect(router.resolve('code', ['openai'])).toEqual({providerId: 'openai', modelId: 'gpt-4o'})
    expect(new ModelRouter({advicePath: false}).resolve('code', ['openai'])).toEqual({providerId: 'openai', modelId: 'gpt-4o'})
    expect(new ModelRouter({advicePath: path, defaultModel: 'remote/configured'}).resolve(undefined, ['remote'])).toEqual({providerId: 'remote', modelId: 'configured'})
})

test('generic workload names and default advice use the existing router without a closed task enum', async () => {
    mockOllama()
    await refreshModelAdvice(authority({...research(), workloads: {
        'qwen-review': {primary: remote, fallbacks: []}, default: {primary: remote, fallbacks: []},
    }}), {'qwen-review': 'Review arbitrary models', default: 'General work'}, {providers, hardware, advicePath: path})
    const router = new ModelRouter({advicePath: path, providers: current()})
    expect(router.resolve('qwen-review')).toEqual(remote.target)
    expect(router.resolve()).toEqual(remote.target)
    const custom = new ModelRouter({advicePath: path, router: () => 'remote/custom'})
    expect(custom.resolve('gpt-explicit')).toEqual({providerId: 'openai', modelId: 'gpt-explicit'})
})

test('pull recommendations are inspectable but never routed or installed even when provider exists', async () => {
    const calls = mockOllama()
    await refresh(authority({...research(), workloads: {code: {primary: pull, fallbacks: [remote]}}}))
    calls.length = 0
    expect(readModelAdvice(path)?.recommendedPulls[0]?.target.modelId).toBe('new-family:14b')
    expect(new ModelRouter({advicePath: path, providers: current()}).resolve('code', ['ollama', 'remote'])).toEqual(remote.target)
    expect(calls).toHaveLength(0)
})

test('malformed authority responses never corrupt previous advice and explicit refresh replaces it', async () => {
    mockOllama()
    await refresh()
    const before = await readFile(path, 'utf8')
    for (const bad of ['not-json', {workloads: {}}, {...research(), workloads: {}},
        {...research(), workloads: {code: {primary: {...remote, economics: {inputPer1M: -1}}, fallbacks: []}}},
        {...research(), recommendedPulls: [remote]}]) {
        await expect(refresh(authority(bad))).rejects.toThrow('Invalid model advice')
        expect(await readFile(path, 'utf8')).toBe(before)
    }
    await refresh(authority({...research(), workloads: {code: {primary: remote, fallbacks: []}}}))
    expect(readModelAdvice(path)?.workloads.code?.primary.target).toEqual(remote.target)
})

test('known credentials in authority reasons/evidence and caller workloads are sanitized', async () => {
    mockOllama()
    const key = providers.remote!.apiKey!
    const snapshot = await refreshModelAdvice({id: 'advisor ' + key, async research(request) {
        expect(request.prompt).not.toContain(key)
        return {...research(), notes: [key], workloads: {code: {primary: {...remote, reason: key, evidence: ['https://user:pass@example.org?key=' + key]}, fallbacks: []}}}
    }}, {code: 'coding with ' + key}, {providers, hardware, advicePath: path, constraints: [key]})
    expect(JSON.stringify(snapshot)).not.toContain(key)
    expect(await readFile(path, 'utf8')).not.toContain('user:pass')
})

test('basic hardware discovery returns real process host facts without requiring a GPU', async () => {
    const result = await discoverHardware()
    expect(result.ramBytes).toBeGreaterThan(0)
    expect(result.logicalCpus).toBeGreaterThan(0)
    expect(result.architecture).toBeTruthy()
    expect(Array.isArray(result.gpus)).toBe(true)
})
