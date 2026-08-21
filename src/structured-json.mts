import {jsonrepair} from 'jsonrepair'
import {z, type ZodError, type ZodIssue, type ZodType} from 'zod'
import type {JsonSchema, ResponseFormat} from './types.mts'

export type StructuredJsonFailure = 'parse_failed' | 'schema_invalid'

export class StructuredJsonError extends Error {
    constructor(
        public readonly kind: StructuredJsonFailure,
        message: string,
        public readonly zodError?: ZodError | undefined,
        public readonly rawText?: string | undefined,
    ) {
        super(message)
        this.name = 'StructuredJsonError'
    }
}

export function zodToJsonSchema(schema: ZodType): {ok: true; schema: JsonSchema} | {ok: false; reason: string} {
    try {
        const jsonSchema = z.toJSONSchema(schema)
        if (typeof jsonSchema === 'object' && jsonSchema !== null)
            return {ok: true, schema: jsonSchema as JsonSchema}
        return {ok: false, reason: 'Generated schema is not an object.'}
    } catch (err) {
        return {ok: false, reason: err instanceof Error ? err.message : String(err)}
    }
}

export function resolveResponseFormat(schema?: ZodType | undefined, name = 'structured_response'): ResponseFormat {
    if (!schema)
        return {type: 'json'}
    const converted = zodToJsonSchema(schema)
    if (converted.ok)
        return {type: 'json_schema', name, schema: converted.schema, strict: true}
    return {type: 'json'}
}

export function extractJsonCandidate(raw: string): string {
    const text = raw.trim()
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    if (fenceMatch?.[1])
        return fenceMatch[1].trim()

    // Find the outer-most balanced curly or square brackets
    const firstBrace = text.indexOf('{')
    const firstBracket = text.indexOf('[')
    let start = -1
    let endChar = '}'

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        start = firstBrace
        endChar = '}'
    } else if (firstBracket !== -1) {
        start = firstBracket
        endChar = ']'
    }

    if (start !== -1) {
        const last = text.lastIndexOf(endChar)
        if (last > start)
            return text.slice(start, last + 1).trim()
    }

    return text
}

export function parseStructuredJsonResult<T = unknown>(
    raw: string,
    schema?: ZodType<T> | undefined,
    label = 'response',
): {ok: true; data: T} | {ok: false; kind: StructuredJsonFailure; message: string; zodError?: ZodError | undefined; zodIssues?: ZodIssue[] | undefined} {
    const candidate = extractJsonCandidate(raw)
    let parsed: unknown

    try {
        parsed = JSON.parse(candidate)
    } catch {
        try {
            parsed = JSON.parse(jsonrepair(candidate))
        } catch (err) {
            return {
                ok: false,
                kind: 'parse_failed',
                message: `Failed to parse JSON for ${label}: ${err instanceof Error ? err.message : String(err)}`,
            }
        }
    }

    if (parsed === null || typeof parsed !== 'object') {
        return {
            ok: false,
            kind: 'parse_failed',
            message: `JSON root for ${label} must be an object or array.`,
        }
    }

    if (!schema)
        return {ok: true, data: parsed as T}

    const validation = schema.safeParse(parsed)
    if (validation.success)
        return {ok: true, data: validation.data}

    const issues = validation.error.issues
    const message = `Validation failed for ${label}:\n`
        + issues.map(i => `  - ${i.path.join('.') || '<root>'}: ${i.message}`).join('\n')

    return {
        ok: false,
        kind: 'schema_invalid',
        message,
        zodError: validation.error,
        zodIssues: issues,
    }
}

export function parseStructuredJson<T = unknown>(
    raw: string,
    schema?: ZodType<T> | undefined,
    label = 'response',
): T {
    const result = parseStructuredJsonResult(raw, schema, label)
    if (result.ok)
        return result.data
    throw new StructuredJsonError(result.kind, result.message, result.zodError, raw)
}
