import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AnthropicAdapter,
    CompletionEngine,
    GoogleAdapter,
    OllamaProvider,
    OpenAIAdapter,
    parseStructuredJson,
    parseStructuredJsonResult,
    requestStructuredJson,
    resolveStructuredOutput,
    validateStructuredValue,
    z,
    zodToJsonSchema,
} from '../dist/index.mjs'

const model = {providerId: 'mock', modelId: 'structured-test'}

function generation(text, extra = {}) {
    return {ok: true, text, model, ...extra}
}

test('parses direct object and array roots', () => {
    assert.deepEqual(parseStructuredJson('{"value":1}'), {value: 1})
    assert.deepEqual(parseStructuredJson('[1,2,3]'), [1, 2, 3])
})

test('parses fenced and prose-surrounded JSON with deterministic fence priority', () => {
    const schema = z.object({value: z.string()})
    assert.deepEqual(
        parseStructuredJson('before ```json\n{"value":"fenced"}\n``` after {"value":"later"}', 'fence', schema),
        {value: 'fenced'},
    )
    assert.deepEqual(
        parseStructuredJson('The result is {"value":"embedded"}; done.', 'prose', schema),
        {value: 'embedded'},
    )
})

test('balanced extraction respects quoted braces and escaped quotes', () => {
    const raw = 'prefix {"text":"brace } and quote \\" and [ still text","nested":{"ok":true}} suffix'
    assert.deepEqual(parseStructuredJson(raw), {
        text: 'brace } and quote " and [ still text',
        nested: {ok: true},
    })
})

test('multiple candidates continue until one passes the schema', () => {
    const schema = z.object({kind: z.literal('accepted'), nested: z.object({value: z.number()})})
    const raw = [
        'First {"kind":"rejected","nested":{"value":"wrong"}}.',
        'Second {"kind":"accepted","nested":{"value":7}}.',
    ].join(' ')
    assert.deepEqual(parseStructuredJson(raw, 'multiple', schema), {
        kind: 'accepted',
        nested: {value: 7},
    })
})

test('deterministically repairs malformed object-shaped JSON', () => {
    assert.deepEqual(
        parseStructuredJson("{value: 'repaired', trailing: [1,2,],}"),
        {value: 'repaired', trailing: [1, 2]},
    )
})

test('rejects unrecoverable JSON, prose, and scalar JSON roots', () => {
    for (const raw of ['{]', 'only prose', '"json string"', '42', 'true', 'null']) {
        const result = parseStructuredJsonResult(raw, 'rejection')
        assert.equal(result.ok, false, raw)
        assert.equal(result.kind, 'parse_failed', raw)
    }
})

test('nested Zod diagnostics retain paths, issues, and the original error', () => {
    const schema = z.object({
        outer: z.object({
            rows: z.array(z.object({name: z.string().min(3)})),
        }),
    })
    const result = parseStructuredJsonResult('{"outer":{"rows":[{"name":"x"}]}}', 'nested', schema)
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'schema_invalid')
    assert.match(result.message, /outer\.rows\.0\.name/)
    assert.equal(result.zodIssues[0].path.join('.'), 'outer.rows.0.name')
    assert.equal(result.zodError instanceof z.ZodError, true)
})

test('validates persisted values without reparsing or throwing', () => {
    const schema = z.object({value: z.number().int()})
    assert.deepEqual(validateStructuredValue({value: 3}, schema), {
        ok: true,
        data: {value: 3},
        diagnostics: [],
    })
    const invalid = validateStructuredValue({value: 3.5}, schema, 'checkpoint')
    assert.equal(invalid.ok, false)
    assert.equal(invalid.kind, 'schema_invalid')
    assert.match(invalid.message, /checkpoint/)
    assert.equal(invalid.zodIssues.length, 1)
})

test('re-exported Zod builds schemas and converts representable schemas', () => {
    const schema = z.object({
        value: z.string().min(2),
        count: z.number().int().min(0),
    }).strict()
    const converted = zodToJsonSchema(schema)
    assert.equal(converted.ok, true)
    assert.equal(converted.schema.type, 'object')
    assert.equal(converted.schema.additionalProperties, false)
})

test('unrepresentable Zod behavior falls back to generic JSON mode', () => {
    const schemas = [
        z.preprocess(value => value, z.object({value: z.string()})),
        z.object({value: z.string()}).transform(value => value.value),
        z.object({value: z.string()}).superRefine(() => {}),
    ]
    for (const schema of schemas) {
        const plan = resolveStructuredOutput(schema, {schemaName: 'complex'})
        assert.deepEqual(plan.responseFormat, {type: 'json'})
        assert.equal(plan.nativeJsonSchemaRequested, false)
        assert.equal(plan.providerSchemaSource, 'none')
        assert.equal(typeof plan.fallbackReason, 'string')
    }
})

test('explicit provider JSON Schema overrides automatic conversion', () => {
    const providerSchema = {
        type: 'object',
        properties: {value: {type: 'string'}},
        required: ['value'],
        additionalProperties: false,
    }
    const plan = resolveStructuredOutput(
        z.object({value: z.string()}).transform(value => value.value),
        {providerSchema, schemaName: 'override', strict: true},
    )
    assert.deepEqual(plan.responseFormat, {
        type: 'json_schema',
        name: 'override',
        schema: providerSchema,
        strict: true,
    })
    assert.equal(plan.providerSchemaSource, 'override')
})

test('OpenAI transports named JSON Schema natively', async () => {
    const originalFetch = globalThis.fetch
    let body
    globalThis.fetch = async (_input, init) => {
        body = JSON.parse(String(init.body))
        return new Response(JSON.stringify({
            choices: [{message: {content: '{"value":"ok"}'}}],
            usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
        }))
    }
    try {
        const schema = z.object({value: z.string()})
        const completion = new CompletionEngine([new OpenAIAdapter()])
        const result = await requestStructuredJson({
            label: 'openai transport',
            schema,
            strict: true,
            execute: context => completion.generate(
                'return data',
                {providerId: 'openai', id: 'gpt-test'},
                {id: 'openai', apiKey: 'test'},
                {format: context.responseFormat},
            ),
        })
        assert.equal(result.ok, true)
        assert.equal(result.nativeJsonSchemaUsed, true)
        assert.equal(body.response_format.type, 'json_schema')
        assert.equal(body.response_format.json_schema.name, 'openai_transport')
        assert.equal(body.response_format.json_schema.strict, true)
        assert.equal(body.response_format.json_schema.schema.type, 'object')
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('Google and Ollama map provider-native JSON Schema requests', async () => {
    const originalFetch = globalThis.fetch
    const bodies = []
    globalThis.fetch = async (input, init) => {
        bodies.push({url: String(input), body: JSON.parse(String(init.body))})
        if (String(input).includes('generativelanguage')) {
            return new Response(JSON.stringify({
                candidates: [{content: {parts: [{text: '{"value":"google"}'}]}}],
                usageMetadata: {},
            }))
        }
        return new Response(JSON.stringify({response: '{"value":"ollama"}'}))
    }
    try {
        const format = {
            type: 'json_schema',
            name: 'native',
            schema: {type: 'object', properties: {value: {type: 'string'}}},
        }
        const google = await new GoogleAdapter().generate({
            modelId: 'gemini-test',
            prompt: 'data',
            config: {id: 'google', apiKey: 'test'},
            format,
        })
        const ollama = await new OllamaProvider().generate({
            modelId: 'qwen-test',
            prompt: 'data',
            config: {id: 'ollama', host: 'localhost'},
            format,
        })
        assert.equal(google.structuredOutput.nativeJsonSchemaUsed, true)
        assert.deepEqual(bodies[0].body.generationConfig.responseJsonSchema, format.schema)
        assert.equal(ollama.structuredOutput.nativeJsonSchemaUsed, true)
        assert.deepEqual(bodies[1].body.format, format.schema)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('unsupported native schema transport falls back without inventing Anthropic behavior', async () => {
    const originalFetch = globalThis.fetch
    let body
    globalThis.fetch = async (_input, init) => {
        body = JSON.parse(String(init.body))
        return new Response(JSON.stringify({
            content: [{type: 'text', text: '{"value":"ok"}'}],
            usage: {input_tokens: 1, output_tokens: 1},
        }))
    }
    try {
        const result = await new AnthropicAdapter().generate({
            modelId: 'claude-test',
            prompt: 'data',
            config: {id: 'anthropic', apiKey: 'test'},
            format: {
                type: 'json_schema',
                name: 'unsupported',
                schema: {type: 'object'},
            },
        })
        assert.deepEqual(result.structuredOutput, {
            requested: 'json_schema',
            nativeJsonSchemaUsed: false,
            fallbackReason: 'provider_unsupported',
        })
        assert.equal('response_format' in body, false)
        assert.equal('tools' in body, false)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('complex schemas use generic JSON transport and full local validation', async () => {
    const originalFetch = globalThis.fetch
    let body
    globalThis.fetch = async (_input, init) => {
        body = JSON.parse(String(init.body))
        return new Response(JSON.stringify({
            choices: [{message: {content: '{"value":"bad"}'}}],
            usage: {},
        }))
    }
    try {
        const schema = z.object({value: z.string()}).superRefine((value, context) => {
            if (value.value !== 'good')
                context.addIssue({code: 'custom', path: ['value'], message: 'Expected good'})
        })
        const completion = new CompletionEngine([new OpenAIAdapter()])
        const result = await requestStructuredJson({
            label: 'complex',
            schema,
            execute: context => completion.generate(
                'data',
                {providerId: 'openai', id: 'gpt-test'},
                {id: 'openai', apiKey: 'test'},
                {format: context.responseFormat},
            ),
        })
        assert.equal(body.response_format.type, 'json_object')
        assert.equal(result.ok, false)
        assert.equal(result.kind, 'schema_invalid')
        assert.equal(result.nativeJsonSchemaUsed, false)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('deterministic repair succeeds without a corrective LLM call', async () => {
    let corrections = 0
    const result = await requestStructuredJson({
        label: 'repair',
        schema: z.object({value: z.string()}),
        execute: async () => generation("{value:'ok'}"),
        maxCorrectionAttempts: 3,
        correct: async () => {
            corrections += 1
            return generation('{"value":"unused"}')
        },
    })
    assert.equal(result.ok, true)
    assert.equal(result.substantiveCalls, 1)
    assert.equal(result.correctiveCalls, 0)
    assert.equal(corrections, 0)
})

test('a corrective response can succeed without rerunning substantive generation', async () => {
    let substantive = 0
    const contexts = []
    const result = await requestStructuredJson({
        label: 'correction',
        schema: z.object({nested: z.object({value: z.string()})}),
        execute: async () => {
            substantive += 1
            return generation('{"nested":{"value":7}}')
        },
        maxCorrectionAttempts: 2,
        correct: async context => {
            contexts.push(context)
            return generation('{"nested":{"value":"fixed"}}')
        },
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.data, {nested: {value: 'fixed'}})
    assert.equal(substantive, 1)
    assert.equal(result.substantiveCalls, 1)
    assert.equal(result.correctiveCalls, 1)
    assert.equal(contexts[0].failureKind, 'schema_invalid')
    assert.equal(contexts[0].correctionAttempt, 1)
    assert.match(contexts[0].formattedDiagnostics, /nested\.value/)
    assert.equal(contexts[0].failedRawResponse, '{"nested":{"value":7}}')
})

test('correction exhaustion and disabled correction report exact counts', async () => {
    const exhausted = await requestStructuredJson({
        label: 'exhausted',
        schema: z.object({value: z.string()}),
        execute: async () => generation('{"value":1}'),
        maxCorrectionAttempts: 2,
        correct: async context => generation(`{"value":${context.correctionAttempt + 1}}`),
    })
    assert.equal(exhausted.ok, false)
    assert.equal(exhausted.kind, 'schema_invalid')
    assert.equal(exhausted.substantiveCalls, 1)
    assert.equal(exhausted.correctiveCalls, 2)
    assert.equal(exhausted.generations.length, 3)

    let corrections = 0
    const disabled = await requestStructuredJson({
        label: 'disabled',
        schema: z.object({value: z.string()}),
        execute: async () => generation('{"value":1}'),
        maxCorrectionAttempts: 0,
        correct: async () => {
            corrections += 1
            return generation('{"value":"fixed"}')
        },
    })
    assert.equal(disabled.ok, false)
    assert.equal(disabled.correctiveCalls, 0)
    assert.equal(corrections, 0)
})

test('provider failure is not mistaken for schema correction', async () => {
    let corrections = 0
    const failed = {
        ok: false,
        text: '',
        model,
        failure: {
            kind: 'network',
            message: 'connection lost',
            retryable: true,
            fatal: false,
        },
    }
    const result = await requestStructuredJson({
        label: 'provider failure',
        schema: z.object({value: z.string()}),
        execute: async () => failed,
        maxCorrectionAttempts: 3,
        correct: async () => {
            corrections += 1
            return generation('{"value":"wrong"}')
        },
    })
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'model_failed')
    assert.equal(result.failure.kind, 'network')
    assert.equal(result.substantiveCalls, 1)
    assert.equal(result.correctiveCalls, 0)
    assert.equal(corrections, 0)
})
