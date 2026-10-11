import {describe, expect, it} from 'bun:test'
import {Asker, CompletionEngine, type GenerateOptions, type GenerationResult, type ProviderAdapter, type ProviderConfig} from '../src/index.ts'

class CaptureAdapter implements ProviderAdapter {
    readonly id = 'capture'
    timeoutMs?: number

    async generate(options: GenerateOptions): Promise<GenerationResult> {
        this.timeoutMs = options.timeoutMs
        return {ok: true, text: 'ok', model: {providerId: this.id, modelId: options.modelId}}
    }
}

describe('provider inference timeout', () => {
    it('uses provider timeout and lets a call override it', async () => {
        const adapter = new CaptureAdapter()
        const completion = new CompletionEngine([adapter])
        const provider: ProviderConfig = {id: 'capture', available: true, local: true, timeoutMs: 1234}
        const asker = new Asker({providers: [provider], defaultModel: 'capture/model', completion})

        expect((await asker.ask('first')).ok).toBe(true)
        expect(adapter.timeoutMs).toBe(1234)

        expect((await asker.ask('second', {timeoutMs: 4321})).ok).toBe(true)
        expect(adapter.timeoutMs).toBe(4321)
    })

    it('defaults local providers to a longer timeout than remote providers', async () => {
        const localAdapter = new CaptureAdapter()
        const local = new Asker({
            providers: [{id: 'capture', available: true, local: true}],
            defaultModel: 'capture/model',
            completion: new CompletionEngine([localAdapter]),
        })
        await local.ask('local')
        expect(localAdapter.timeoutMs).toBe(180000)

        const remoteAdapter = new CaptureAdapter()
        const remote = new Asker({
            providers: [{id: 'capture', available: true, local: false}],
            defaultModel: 'capture/model',
            completion: new CompletionEngine([remoteAdapter]),
        })
        await remote.ask('remote')
        expect(remoteAdapter.timeoutMs).toBe(60000)
    })
})
