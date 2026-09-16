import {expect, test} from 'bun:test'
import {
    Asker,
    calculateUsageCost,
    CompletionEngine,
    ProviderCircuit,
    z,
} from '../src/index.ts'

test('Asker.json executes and validates with an inferred schema result', async () => {
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
        providers: {mock: {id: 'mock', available: true}},
        completion,
    })
    const result = await asker.json('Return JSON.', z.object({value: z.literal(7)}), {
        model: 'mock/exact',
    })

    expect(result.ok).toBe(true)
    expect(result.data?.value).toBe(7)
    expect(result.model?.modelId).toBe('exact')
    expect(calls).toBe(1)
})

test('fatal provider circuits are instance-owned and block future requests', async () => {
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
                kind: 'authentication' as const,
                message: 'Denied.',
                retryable: false,
                fatal: true,
            },
        }
    }
    await circuit.execute(target, fail)
    const blocked = await circuit.execute(target, fail)

    expect(calls).toBe(1)
    expect(blocked.failure?.message).toMatch(/circuit open/i)
})

test('usage cost calculates correctly with pricing rates', () => {
    const usage = {
        promptTokens: 1_000_000,
        completionTokens: 500_000,
        totalTokens: 1_500_000,
        available: true,
    }
    expect(calculateUsageCost(usage)).toBe(0)
    expect(calculateUsageCost(usage, {
        inputCostPerMillionTokensUsd: 2,
        outputCostPerMillionTokensUsd: 4,
    })).toBe(4)
})
