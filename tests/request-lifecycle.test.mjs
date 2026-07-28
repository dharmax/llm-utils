import assert from 'node:assert/strict'
import test from 'node:test'
import {
    Asker,
    CompletionEngine,
    ProviderCircuit,
    calculateUsageCost,
    z,
} from '../dist/index.mjs'

test('Asker.askJson executes and validates once with an inferred schema result', async () => {
    let calls = 0
    const completion = new CompletionEngine([]).registerAdapter({
        id: 'mock',
        async generate(options) {
            calls += 1
            return {
                text: '```json\n{"value": 7}\n```',
                ok: true,
                model: {providerId: 'mock', modelId: options.modelId},
            }
        },
    })
    const asker = new Asker({
        providerState: {providers: {mock: {id: 'mock'}}},
        completion,
    })
    const result = await asker.askJson('Return JSON.', 'test', {
        schema: z.object({value: z.literal(7)}),
        providerId: 'mock',
        modelId: 'exact',
    })

    assert.equal(result.ok, true)
    assert.equal(result.data.value, 7)
    assert.equal(result.generation.model.modelId, 'exact')
    assert.equal(calls, 1)
})

test('fatal provider circuits are instance-owned', async () => {
    const target = {providerId: 'mock', modelId: 'model'}
    const circuit = new ProviderCircuit()
    let calls = 0
    const fail = async () => {
        calls += 1
        return {
            text: '',
            ok: false,
            model: target,
            failure: {
                kind: 'authentication',
                message: 'Denied.',
                retryable: false,
                fatal: true,
            },
        }
    }
    await circuit.execute(target, fail)
    const blocked = await circuit.execute(target, fail)

    assert.equal(calls, 1)
    assert.match(blocked.failure.message, /circuit open/)
})

test('usage cost requires caller-supplied pricing', () => {
    const usage = {
        promptTokens: 1_000_000,
        completionTokens: 500_000,
        totalTokens: 1_500_000,
        available: true,
    }
    assert.equal(calculateUsageCost(usage), 0)
    assert.equal(calculateUsageCost(usage, {
        inputCostPerMillionTokensUsd: 2,
        outputCostPerMillionTokensUsd: 4,
    }), 4)
})
