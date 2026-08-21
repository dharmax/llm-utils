import type {GenerationResult, ModelTarget} from './types.mts'

export class ProviderCircuit {
    private readonly failures = new Map<string, string>()

    async execute(
        target: ModelTarget,
        request: () => Promise<GenerationResult>,
    ): Promise<GenerationResult> {
        const blocked = this.failures.get(target.providerId)
        if (blocked) {
            return {
                ok: false,
                text: '',
                model: target,
                failure: {
                    kind: 'provider',
                    message: `Provider circuit open for ${target.providerId}: ${blocked}`,
                    retryable: false,
                    fatal: true,
                },
            }
        }

        const result = await request()
        if (!result.ok && result.failure?.fatal)
            this.failures.set(target.providerId, result.failure.message)

        return result
    }

    failure(providerId: string): string | undefined {
        return this.failures.get(providerId)
    }

    reset(providerId?: string): void {
        if (providerId)
            this.failures.delete(providerId)
        else
            this.failures.clear()
    }
}
