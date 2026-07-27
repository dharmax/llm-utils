import {jsonrepair} from 'jsonrepair'
import type {GenerationResult, LlmFailure} from './types.mts'

export type StructuredJsonFailure = 'parse_failed' | 'schema_invalid'

type SchemaResult<T> =
    | {success: true; data: T}
    | {success: false; error: unknown}

export type StructuredJsonSchema<T> = {
    safeParse(value: unknown): SchemaResult<T>
}

export type StructuredGenerationFailureKind =
    | StructuredJsonFailure
    | 'model_failed'

export type StructuredGenerationResult<T> =
    | {
        ok: true
        data: T
        raw: string
        generation: GenerationResult
    }
    | {
        ok: false
        kind: StructuredGenerationFailureKind
        message: string
        raw?: string
        failure?: LlmFailure
        generation?: GenerationResult
    }

export class StructuredJsonError extends Error {
    constructor(
        public readonly kind: StructuredJsonFailure,
        message: string,
        options?: ErrorOptions,
    ) {
        super(message, options)
        this.name = 'StructuredJsonError'
    }
}

/**
 * Parses model JSON without accepting arbitrary prose as a repaired JSON scalar.
 * Schema validation is deliberately structural, so callers may use Zod or any
 * validator that exposes safeParse().
 */
export function parseStructuredJson<T = unknown>(
    raw: string,
    label = 'LLM request',
    schema?: StructuredJsonSchema<T>,
): T {
    const parsed = parseJsonish(raw, label)
    if (!schema)
        return parsed as T

    const result = schema.safeParse(parsed)
    if (result.success)
        return result.data

    throw new StructuredJsonError(
        'schema_invalid',
        `Model JSON reply for ${label} failed schema validation:\n${formatValidationError(result.error)}`,
        {cause: result.error},
    )
}

/**
 * Runs one model request and validates its structured response. Deterministic
 * JSON repair is included; another paid model call is deliberately not.
 */
export async function requestStructuredJson<T>(
    execute: () => Promise<GenerationResult>,
    label: string,
    schema?: StructuredJsonSchema<T>,
): Promise<StructuredGenerationResult<T>> {
    let generation: GenerationResult
    try {
        generation = await execute()
    } catch (cause) {
        return {
            ok: false,
            kind: 'model_failed',
            message: cause instanceof Error ? cause.message : String(cause),
        }
    }
    if (!generation.ok) {
        return {
            ok: false,
            kind: 'model_failed',
            message: generation.failure?.message
                ?? generation.error
                ?? 'Model request failed.',
            ...(generation.failure ? {failure: generation.failure} : {}),
            generation,
        }
    }
    try {
        return {
            ok: true,
            data: parseStructuredJson(generation.text, label, schema),
            raw: generation.text,
            generation,
        }
    } catch (error) {
        const structured = error instanceof StructuredJsonError
            ? error
            : new StructuredJsonError(
                'parse_failed',
                error instanceof Error ? error.message : String(error),
                {cause: error},
            )
        return {
            ok: false,
            kind: structured.kind,
            message: structured.message,
            raw: generation.text,
            generation,
        }
    }
}

function parseJsonish(raw: string, label: string): unknown {
    const text = raw.trim()
    if (!text)
        throw new StructuredJsonError(
            'parse_failed',
            `Model returned an empty JSON reply for ${label}.`,
        )

    let lastError: unknown
    for (const candidate of jsonCandidates(text)) {
        try {
            return JSON.parse(candidate)
        } catch (error) {
            lastError = error
        }

        if (isRepairCandidate(candidate)) {
            try {
                return JSON.parse(jsonrepair(candidate))
            } catch (error) {
                lastError = error
            }
        }
    }

    throw new StructuredJsonError(
        'parse_failed',
        `Failed to parse model JSON reply for ${label}: ${preview(text)}`,
        {cause: lastError},
    )
}

function isRepairCandidate(candidate: string): boolean {
    return /^[{[]/.test(candidate.trimStart())
}

function jsonCandidates(text: string): string[] {
    return unique([
        ...fencedJsonBlocks(text),
        text,
        enclosedJson(text, '{', '}'),
        enclosedJson(text, '[', ']'),
    ].filter((candidate): candidate is string => Boolean(candidate?.trim())))
}

function fencedJsonBlocks(text: string): string[] {
    return Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))
        .map(match => match[1]?.trim())
        .filter((candidate): candidate is string => Boolean(candidate))
}

function enclosedJson(
    text: string,
    open: '{' | '[',
    close: '}' | ']',
): string | undefined {
    const start = text.indexOf(open)
    const end = text.lastIndexOf(close)
    return start >= 0 && end > start
        ? text.slice(start, end + 1).trim()
        : undefined
}

function unique(values: string[]): string[] {
    return [...new Set(values)]
}

function formatValidationError(error: unknown): string {
    if (!hasIssues(error))
        return String(error)

    return error.issues.map(issue => {
        const path = Array.isArray(issue.path) && issue.path.length
            ? issue.path.join('.')
            : '<root>'
        return `- ${path}: ${String(issue.message)}`
    }).join('\n')
}

function hasIssues(error: unknown): error is {
    issues: Array<{path?: unknown; message?: unknown}>
} {
    return typeof error === 'object'
        && error !== null
        && 'issues' in error
        && Array.isArray(error.issues)
}

function preview(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 240)
}
