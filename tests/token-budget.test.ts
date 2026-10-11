import {describe, expect, it} from 'bun:test'
import {
    Asker,
    CompletionEngine,
    type GenerateOptions,
    type GenerationResult,
    type ProviderAdapter,
    type TokenBudget,
} from '../src/index.ts'

class UsageAdapter implements ProviderAdapter {
    readonly id = 'budget-test'
    calls = 0

    async generate(options: GenerateOptions): Promise<GenerationResult> {
        this.calls += 1
        return {
            ok: true,
            text: 'ok',
            model: {providerId: this.id, modelId: options.modelId},
            usage: {promptTokens: 40, completionTokens: 10, totalTokens: 50, available: true},
        }
    }
}

function asker(adapter: UsageAdapter): Asker {
    return new Asker({
        providers: [{id: adapter.id, available: true, local: true, maxTokens: 100}],
        defaultModel: `${adapter.id}/model`,
        completion: new CompletionEngine([adapter]),
    })
}

describe('token budget', () => {
    it('uses token estimates for admission and reconciles to actual provider usage', async () => {
        const adapter = new UsageAdapter()
        const budget: TokenBudget = {remainingTokens: 2000}
        const result = await asker(adapter).ask('x'.repeat(3000), {tokenBudget: budget})

        expect(result.ok).toBe(true)
        expect(adapter.calls).toBe(1)
        expect(budget.remainingTokens).toBe(1950)
    })

    it('keeps byte limits independent from token accounting', async () => {
        const adapter = new UsageAdapter()
        const budget: TokenBudget = {remainingTokens: 10000}
        const result = await asker(adapter).ask('x'.repeat(300), {tokenBudget: budget, maxInputBytes: 100})

        expect(result.ok).toBe(false)
        expect(result.failure?.code).toBe('input_size')
        expect(adapter.calls).toBe(0)
        expect(budget.remainingTokens).toBe(10000)
    })

    it('lets host policy grant a bounded runtime extension', async () => {
        const adapter = new UsageAdapter()
        const requests: number[] = []
        const budget: TokenBudget = {
            remainingTokens: 500,
            requestExtension: request => {
                requests.push(request.requiredTokens)
                return 700
            },
        }
        const result = await asker(adapter).ask('x'.repeat(3000), {tokenBudget: budget})

        expect(result.ok).toBe(true)
        expect(requests).toEqual([1100])
        expect(budget.remainingTokens).toBe(1150)
    })
})
