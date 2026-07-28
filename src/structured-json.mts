import {jsonrepair} from 'jsonrepair'
import {z, type ZodError, type ZodIssue, type ZodType} from 'zod'
import type {
    GenerationResult,
    JsonSchema,
    LlmFailure,
    ResponseFormat,
} from './types.mts'

export type StructuredJsonFailure = 'parse_failed' | 'schema_invalid'

export type StructuredGenerationFailureKind =
    | StructuredJsonFailure
    | 'model_failed'

export type StructuredJsonDiagnostic = {
    stage: 'parse' | 'repair' | 'schema'
    candidate: number
    message: string
    preview: string
    repaired?: boolean
    issues?: ZodIssue[]
}

export type StructuredJsonSuccess<T> = {
    ok: true
    data: T
    diagnostics: StructuredJsonDiagnostic[]
}

export type StructuredJsonFailureResult = {
    ok: false
    kind: StructuredJsonFailure
    message: string
    diagnostics: StructuredJsonDiagnostic[]
    zodIssues?: ZodIssue[]
    zodError?: ZodError
}

export type StructuredJsonResult<T> =
    | StructuredJsonSuccess<T>
    | StructuredJsonFailureResult

export type PersistedValidationResult<T> =
    | {
        ok: true
        data: T
        diagnostics: string[]
    }
    | {
        ok: false
        kind: 'schema_invalid'
        message: string
        diagnostics: string[]
        zodIssues: ZodIssue[]
        zodError: ZodError
    }

export type ZodJsonSchemaResult =
    | {
        ok: true
        schema: JsonSchema
    }
    | {
        ok: false
        reason: string
        error?: unknown
    }

export type StructuredOutputPlan = {
    responseFormat: ResponseFormat
    providerSchema?: JsonSchema
    providerSchemaSource: 'automatic' | 'override' | 'none'
    nativeJsonSchemaRequested: boolean
    fallbackReason?: string
}

export type StructuredOutputOptions = {
    providerSchema?: JsonSchema
    schemaName?: string
    strict?: boolean
}

export type StructuredRequestContext<T> = StructuredOutputPlan & {
    schema?: ZodType<T>
}

export type StructuredCorrectionContext<T> = StructuredRequestContext<T> & {
    failedRawResponse: string
    failureKind: StructuredJsonFailure
    diagnostics: StructuredJsonDiagnostic[]
    formattedDiagnostics: string
    zodIssues?: ZodIssue[]
    zodError?: ZodError
    correctionAttempt: number
}

export type StructuredJsonRequestOptions<T> = StructuredOutputOptions & {
    execute(context: StructuredRequestContext<T>): Promise<GenerationResult>
    label: string
    schema?: ZodType<T>
    correct?: (context: StructuredCorrectionContext<T>) => Promise<GenerationResult>
    maxCorrectionAttempts?: number
}

export type StructuredGenerationResult<T> =
    | {
        ok: true
        data: T
        raw: string
        generation: GenerationResult
        generations: GenerationResult[]
        diagnostics: StructuredJsonDiagnostic[]
        responseFormat: ResponseFormat
        providerSchema?: JsonSchema
        providerSchemaSource: StructuredOutputPlan['providerSchemaSource']
        nativeJsonSchemaUsed: boolean
        substantiveCalls: number
        correctiveCalls: number
    }
    | {
        ok: false
        kind: StructuredGenerationFailureKind
        message: string
        raw?: string
        failure?: LlmFailure
        generation?: GenerationResult
        generations: GenerationResult[]
        diagnostics: StructuredJsonDiagnostic[]
        zodIssues?: ZodIssue[]
        zodError?: ZodError
        responseFormat: ResponseFormat
        providerSchema?: JsonSchema
        providerSchemaSource: StructuredOutputPlan['providerSchemaSource']
        nativeJsonSchemaUsed: boolean
        substantiveCalls: number
        correctiveCalls: number
    }

export class StructuredJsonError extends Error {
    constructor(
        public readonly kind: StructuredJsonFailure,
        message: string,
        public readonly diagnostics: StructuredJsonDiagnostic[] = [],
        public readonly zodIssues?: ZodIssue[],
        public readonly zodError?: ZodError,
        options?: ErrorOptions,
    ) {
        super(message, options)
        this.name = 'StructuredJsonError'
    }
}

export function zodToJsonSchema(schema: ZodType): ZodJsonSchemaResult {
    const unsafe = unsafeZodFeature(schema)
    if (unsafe)
        return {ok: false, reason: unsafe}

    try {
        const converted = z.toJSONSchema(schema)
        if (!isJsonSchema(converted))
            return {ok: false, reason: 'Zod returned a non-object JSON Schema.'}
        return {ok: true, schema: converted}
    } catch (error) {
        return {
            ok: false,
            reason: error instanceof Error ? error.message : String(error),
            error,
        }
    }
}

export function resolveStructuredOutput(
    schema: ZodType | undefined,
    options: StructuredOutputOptions = {},
): StructuredOutputPlan {
    const name = schemaName(options.schemaName)
    if (options.providerSchema) {
        return {
            responseFormat: {
                type: 'json_schema',
                name,
                schema: options.providerSchema,
                ...(options.strict === undefined ? {} : {strict: options.strict}),
            },
            providerSchema: options.providerSchema,
            providerSchemaSource: 'override',
            nativeJsonSchemaRequested: true,
        }
    }

    if (schema) {
        const converted = zodToJsonSchema(schema)
        if (converted.ok) {
            return {
                responseFormat: {
                    type: 'json_schema',
                    name,
                    schema: converted.schema,
                    ...(options.strict === undefined ? {} : {strict: options.strict}),
                },
                providerSchema: converted.schema,
                providerSchemaSource: 'automatic',
                nativeJsonSchemaRequested: true,
            }
        }
        return {
            responseFormat: {type: 'json'},
            providerSchemaSource: 'none',
            nativeJsonSchemaRequested: false,
            fallbackReason: converted.reason,
        }
    }

    return {
        responseFormat: {type: 'json'},
        providerSchemaSource: 'none',
        nativeJsonSchemaRequested: false,
    }
}

export function validateStructuredValue<T>(
    value: unknown,
    schema: ZodType<T>,
    label = 'persisted structured value',
): PersistedValidationResult<T> {
    const result = schema.safeParse(value)
    if (result.success)
        return {ok: true, data: result.data, diagnostics: []}

    const diagnostics = formatZodIssues(result.error.issues)
    return {
        ok: false,
        kind: 'schema_invalid',
        message: `Stored value for ${label} failed schema validation:\n${diagnostics.join('\n')}`,
        diagnostics,
        zodIssues: result.error.issues,
        zodError: result.error,
    }
}

export function parseStructuredJsonResult<T = unknown>(
    raw: string,
    label = 'LLM request',
    schema?: ZodType<T>,
): StructuredJsonResult<T> {
    const text = raw.trim()
    if (!text) {
        return {
            ok: false,
            kind: 'parse_failed',
            message: `Model returned an empty JSON reply for ${label}.`,
            diagnostics: [],
        }
    }

    const candidates = jsonCandidates(text)
    const diagnostics: StructuredJsonDiagnostic[] = []
    const schemaFailures: Array<{
        index: number
        error: ZodError
        diagnostic: StructuredJsonDiagnostic
    }> = []

    for (const [index, candidate] of candidates.entries()) {
        const parsed = parseCandidate(candidate, index, diagnostics)
        if (!parsed.ok)
            continue

        if (!isStructuredRoot(parsed.value)) {
            diagnostics.push({
                stage: 'parse',
                candidate: index,
                message: 'Parsed JSON root must be an object or array.',
                preview: preview(candidate),
                repaired: parsed.repaired,
            })
            continue
        }

        if (!schema)
            return {ok: true, data: parsed.value as T, diagnostics}

        const validation = schema.safeParse(parsed.value)
        if (validation.success)
            return {ok: true, data: validation.data, diagnostics}

        const diagnostic: StructuredJsonDiagnostic = {
            stage: 'schema',
            candidate: index,
            message: formatZodIssues(validation.error.issues).join('\n'),
            preview: preview(candidate),
            repaired: parsed.repaired,
            issues: validation.error.issues,
        }
        diagnostics.push(diagnostic)
        schemaFailures.push({index, error: validation.error, diagnostic})
    }

    if (schemaFailures.length > 0) {
        const best = [...schemaFailures].sort((left, right) => (
            left.error.issues.length - right.error.issues.length
            || left.index - right.index
        ))[0]!
        return {
            ok: false,
            kind: 'schema_invalid',
            message: `Model JSON reply for ${label} failed schema validation:\n${best.diagnostic.message}`,
            diagnostics,
            zodIssues: best.error.issues,
            zodError: best.error,
        }
    }

    return {
        ok: false,
        kind: 'parse_failed',
        message: `Failed to parse an object or array JSON reply for ${label}: ${preview(text)}`,
        diagnostics,
    }
}

export function parseStructuredJson<T = unknown>(
    raw: string,
    label = 'LLM request',
    schema?: ZodType<T>,
): T {
    const result = parseStructuredJsonResult(raw, label, schema)
    if (result.ok)
        return result.data
    throw new StructuredJsonError(
        result.kind,
        result.message,
        result.diagnostics,
        result.zodIssues,
        result.zodError,
        {cause: result.zodError},
    )
}

export async function requestStructuredJson<T>(
    options: StructuredJsonRequestOptions<T>,
): Promise<StructuredGenerationResult<T>>
export async function requestStructuredJson<T>(
    execute: (context: StructuredRequestContext<T>) => Promise<GenerationResult>,
    label: string,
    schema?: ZodType<T>,
): Promise<StructuredGenerationResult<T>>
export async function requestStructuredJson<T>(
    optionsOrExecute:
        | StructuredJsonRequestOptions<T>
        | ((context: StructuredRequestContext<T>) => Promise<GenerationResult>),
    legacyLabel?: string,
    legacySchema?: ZodType<T>,
): Promise<StructuredGenerationResult<T>> {
    const options: StructuredJsonRequestOptions<T> = typeof optionsOrExecute === 'function'
        ? {
            execute: optionsOrExecute,
            label: legacyLabel ?? 'LLM request',
            ...(legacySchema ? {schema: legacySchema} : {}),
        }
        : optionsOrExecute
    const plan = resolveStructuredOutput(options.schema, {
        ...(options.providerSchema ? {providerSchema: options.providerSchema} : {}),
        schemaName: options.schemaName ?? options.label,
        ...(options.strict === undefined ? {} : {strict: options.strict}),
    })
    const requestContext: StructuredRequestContext<T> = {
        ...plan,
        ...(options.schema ? {schema: options.schema} : {}),
    }
    const generations: GenerationResult[] = []
    let substantiveCalls = 0
    let correctiveCalls = 0
    let generation: GenerationResult

    try {
        substantiveCalls += 1
        generation = await options.execute(requestContext)
    } catch (cause) {
        return generationFailure(
            cause instanceof Error ? cause.message : String(cause),
            plan,
            generations,
            substantiveCalls,
            correctiveCalls,
        )
    }
    generations.push(generation)
    if (!generation.ok) {
        return generationFailure(
            generation.failure?.message
                ?? generation.error
                ?? 'Model request failed.',
            plan,
            generations,
            substantiveCalls,
            correctiveCalls,
            generation,
        )
    }

    let raw = generation.text
    let parsed = parseStructuredJsonResult(raw, options.label, options.schema)
    const accumulatedDiagnostics = [...parsed.diagnostics]
    const maximumCorrections = Math.max(0, options.maxCorrectionAttempts ?? 0)

    while (!parsed.ok && options.correct && correctiveCalls < maximumCorrections) {
        correctiveCalls += 1
        let correction: GenerationResult
        try {
            correction = await options.correct({
                ...requestContext,
                failedRawResponse: raw,
                failureKind: parsed.kind,
                diagnostics: parsed.diagnostics,
                formattedDiagnostics: formatStructuredDiagnostics(parsed),
                ...(parsed.zodIssues ? {zodIssues: parsed.zodIssues} : {}),
                ...(parsed.zodError ? {zodError: parsed.zodError} : {}),
                correctionAttempt: correctiveCalls,
            })
        } catch (cause) {
            return generationFailure(
                cause instanceof Error ? cause.message : String(cause),
                plan,
                generations,
                substantiveCalls,
                correctiveCalls,
                generation,
                raw,
                {...parsed, diagnostics: accumulatedDiagnostics},
            )
        }
        generations.push(correction)
        generation = correction
        if (!correction.ok) {
            return generationFailure(
                correction.failure?.message
                    ?? correction.error
                    ?? 'Corrective model request failed.',
                plan,
                generations,
                substantiveCalls,
                correctiveCalls,
                correction,
                raw,
                {...parsed, diagnostics: accumulatedDiagnostics},
            )
        }
        raw = correction.text
        parsed = parseStructuredJsonResult(raw, options.label, options.schema)
        accumulatedDiagnostics.push(...parsed.diagnostics)
    }

    const nativeJsonSchemaUsed = generations.some(item => (
        item.structuredOutput?.nativeJsonSchemaUsed === true
    ))
    if (parsed.ok) {
        return {
            ok: true,
            data: parsed.data,
            raw,
            generation,
            generations,
            diagnostics: accumulatedDiagnostics,
            responseFormat: plan.responseFormat,
            ...(plan.providerSchema ? {providerSchema: plan.providerSchema} : {}),
            providerSchemaSource: plan.providerSchemaSource,
            nativeJsonSchemaUsed,
            substantiveCalls,
            correctiveCalls,
        }
    }

    return {
        ok: false,
        kind: parsed.kind,
        message: parsed.message,
        raw,
        generation,
        generations,
        diagnostics: accumulatedDiagnostics,
        ...(parsed.zodIssues ? {zodIssues: parsed.zodIssues} : {}),
        ...(parsed.zodError ? {zodError: parsed.zodError} : {}),
        responseFormat: plan.responseFormat,
        ...(plan.providerSchema ? {providerSchema: plan.providerSchema} : {}),
        providerSchemaSource: plan.providerSchemaSource,
        nativeJsonSchemaUsed,
        substantiveCalls,
        correctiveCalls,
    }
}

function generationFailure<T>(
    message: string,
    plan: StructuredOutputPlan,
    generations: GenerationResult[],
    substantiveCalls: number,
    correctiveCalls: number,
    generation?: GenerationResult,
    raw?: string,
    parsed?: StructuredJsonFailureResult,
): StructuredGenerationResult<T> {
    return {
        ok: false,
        kind: 'model_failed',
        message,
        ...(raw === undefined ? {} : {raw}),
        ...(generation?.failure ? {failure: generation.failure} : {}),
        ...(generation ? {generation} : {}),
        generations,
        diagnostics: parsed?.diagnostics ?? [],
        ...(parsed?.zodIssues ? {zodIssues: parsed.zodIssues} : {}),
        ...(parsed?.zodError ? {zodError: parsed.zodError} : {}),
        responseFormat: plan.responseFormat,
        ...(plan.providerSchema ? {providerSchema: plan.providerSchema} : {}),
        providerSchemaSource: plan.providerSchemaSource,
        nativeJsonSchemaUsed: generations.some(item => (
            item.structuredOutput?.nativeJsonSchemaUsed === true
        )),
        substantiveCalls,
        correctiveCalls,
    }
}

function parseCandidate(
    candidate: string,
    index: number,
    diagnostics: StructuredJsonDiagnostic[],
): {ok: true; value: unknown; repaired: boolean} | {ok: false} {
    try {
        return {ok: true, value: JSON.parse(candidate), repaired: false}
    } catch (error) {
        diagnostics.push({
            stage: 'parse',
            candidate: index,
            message: error instanceof Error ? error.message : String(error),
            preview: preview(candidate),
        })
    }

    if (!isRepairCandidate(candidate) || hasMismatchedDelimiters(candidate))
        return {ok: false}

    try {
        return {
            ok: true,
            value: JSON.parse(jsonrepair(candidate)),
            repaired: true,
        }
    } catch (error) {
        diagnostics.push({
            stage: 'repair',
            candidate: index,
            message: error instanceof Error ? error.message : String(error),
            preview: preview(candidate),
            repaired: true,
        })
        return {ok: false}
    }
}

function jsonCandidates(text: string): string[] {
    const fenced = fencedJsonBlocks(text)
    const direct = isRepairCandidate(text) ? [text] : []
    const balanced = balancedJsonCandidates(text)
    return unique([...fenced, ...direct, ...balanced])
}

function fencedJsonBlocks(text: string): string[] {
    return Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi))
        .map(match => match[1]?.trim())
        .filter((candidate): candidate is string => Boolean(
            candidate && isRepairCandidate(candidate),
        ))
}

function balancedJsonCandidates(text: string): string[] {
    const candidates: string[] = []
    let index = 0
    while (index < text.length) {
        const opening = text[index]
        if (opening !== '{' && opening !== '[') {
            index += 1
            continue
        }

        const end = balancedEnd(text, index)
        if (end === undefined) {
            index += 1
            continue
        }
        candidates.push(text.slice(index, end + 1).trim())
        index = end + 1
    }
    return candidates
}

function balancedEnd(text: string, start: number): number | undefined {
    const stack: string[] = []
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
        const character = text[index]!
        if (inString) {
            if (escaped) {
                escaped = false
                continue
            }
            if (character === '\\') {
                escaped = true
                continue
            }
            if (character === '"')
                inString = false
            continue
        }
        if (character === '"') {
            inString = true
            continue
        }
        if (character === '{' || character === '[') {
            stack.push(character)
            continue
        }
        if (character !== '}' && character !== ']')
            continue

        const expected = character === '}' ? '{' : '['
        if (stack.pop() !== expected)
            return undefined
        if (stack.length === 0)
            return index
    }
    return undefined
}

function formatStructuredDiagnostics(result: StructuredJsonFailureResult): string {
    if (result.kind === 'schema_invalid' && result.zodIssues)
        return formatZodIssues(result.zodIssues).join('\n')
    return result.diagnostics
        .map(item => `- candidate ${item.candidate + 1} ${item.stage}: ${item.message}`)
        .join('\n') || result.message
}

export function formatZodIssues(issues: readonly ZodIssue[]): string[] {
    return issues.map(issue => {
        const path = issue.path.length > 0
            ? issue.path.map(String).join('.')
            : '<root>'
        return `- ${path}: ${issue.message}`
    })
}

function unsafeZodFeature(schema: ZodType): string | undefined {
    const seen = new Set<object>()
    return inspectSchema(schema as unknown as object, seen)
}

function inspectSchema(value: object, seen: Set<object>): string | undefined {
    if (seen.has(value))
        return undefined
    seen.add(value)
    const schema = value as {
        _zod?: {def?: Record<string, unknown>}
        _def?: Record<string, unknown>
    }
    const definition = schema._zod?.def ?? schema._def
    if (!definition)
        return undefined

    const type = String(definition.type ?? definition.typeName ?? '')
    if (['transform', 'custom'].includes(type)) {
        return `Zod schema contains ${type || 'an unrepresentable'} behavior that JSON Schema cannot enforce safely.`
    }

    const checks = Array.isArray(definition.checks) ? definition.checks : []
    for (const check of checks) {
        if (!check || typeof check !== 'object')
            continue
        const checkRecord = check as {
            _zod?: {def?: Record<string, unknown>}
            _def?: Record<string, unknown>
        }
        const checkDefinition = checkRecord._zod?.def ?? checkRecord._def
        if (checkDefinition?.check === 'custom') {
            return 'Zod schema contains a custom refinement that provider JSON Schema cannot enforce safely.'
        }
    }

    for (const child of schemaChildren(definition)) {
        const unsafe = inspectSchema(child, seen)
        if (unsafe)
            return unsafe
    }
    return undefined
}

function schemaChildren(value: unknown, seen = new Set<object>()): object[] {
    if (!value || typeof value !== 'object' || seen.has(value as object))
        return []
    seen.add(value as object)
    if (isZodSchemaObject(value))
        return [value]
    if (Array.isArray(value))
        return value.flatMap(item => schemaChildren(item, seen))
    return Object.values(value as Record<string, unknown>)
        .flatMap(item => schemaChildren(item, seen))
}

function isZodSchemaObject(value: unknown): value is {
    _zod?: unknown
    _def?: unknown
} {
    return typeof value === 'object'
        && value !== null
        && ('_zod' in value || '_def' in value)
}

function isStructuredRoot(value: unknown): value is Record<string, unknown> | unknown[] {
    return Array.isArray(value)
        || typeof value === 'object' && value !== null
}

function isRepairCandidate(candidate: string): boolean {
    return /^[{[]/.test(candidate.trimStart())
}

function hasMismatchedDelimiters(candidate: string): boolean {
    const stack: string[] = []
    let inString = false
    let escaped = false
    for (const character of candidate) {
        if (inString) {
            if (escaped) {
                escaped = false
                continue
            }
            if (character === '\\') {
                escaped = true
                continue
            }
            if (character === '"')
                inString = false
            continue
        }
        if (character === '"') {
            inString = true
            continue
        }
        if (character === '{' || character === '[') {
            stack.push(character)
            continue
        }
        if (character !== '}' && character !== ']')
            continue
        const expected = character === '}' ? '{' : '['
        if (stack.pop() !== expected)
            return true
    }
    return false
}

function isJsonSchema(value: unknown): value is JsonSchema {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function schemaName(value: string | undefined): string {
    const normalized = (value ?? 'structured_response')
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64)
    return normalized || 'structured_response'
}

function unique(values: string[]): string[] {
    return [...new Set(values)]
}

function preview(text: string): string {
    return text.replace(/\s+/g, ' ').trim().slice(0, 240)
}
