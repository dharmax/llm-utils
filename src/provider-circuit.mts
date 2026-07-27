import type {
    GenerationResult,
    ModelTarget,
} from './types.mts'

/**
 * Stops repeated calls after a fatal provider failure. Circuit state belongs to
 * this instance; separate clients and application runs cannot affect each other.
 */
export class ProviderCircuit {
    private readonly failures = new Map<string, string>()

    async execute(
        target: ModelTarget,
        request: () => Promise<GenerationResult>,
    ): Promise<GenerationResult> {
        const blocked = this.failures.get(target.providerId)
        if (blocked)
            return blockedResult(target, blocked)

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

function blockedResult(target: ModelTarget, cause: string): GenerationResult {
    const message = `Provider circuit open for ${target.providerId}: ${cause}`
    return {
        text: '',
        ok: false,
        model: target,
        failure: {
            kind: 'provider',
            message,
            retryable: false,
            fatal: true,
        },
        error: message,
    }
}
