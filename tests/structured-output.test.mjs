import assert from 'node:assert/strict'
import test from 'node:test'
import {
    AnthropicAdapter,
    Asker,
    CompletionEngine,
    extractJsonCandidate,
    GoogleAdapter,
    OllamaProvider,
    OpenAIAdapter,
    parseStructuredJson,
    parseStructuredJsonResult,
    resolveResponseFormat,
    StructuredJsonError,
    z,
    zodToJsonSchema,
} from '../dist/index.mjs'

test('parses direct object and array roots', () => {
    assert.deepEqual(parseStructuredJson('{"value":1}'), {value: 1})
    assert.deepEqual(parseStructuredJson('[1,2,3]'), [1, 2, 3])
})

test('parses fenced and prose-surrounded JSON', () => {
    const schema = z.object({value: z.string()})
    assert.deepEqual(
        parseStructuredJson('before ```json\n{"value":"fenced"}\n``` after', schema),
        {value: 'fenced'},
    )
    assert.deepEqual(
        parseStructuredJson('The result is {"value":"embedded"}; done.', schema),
        {value: 'embedded'},
    )
})

test('extractJsonCandidate handles fences and outer delimiters correctly', () => {
    assert.equal(extractJsonCandidate('```json\n{"a":1}\n```'), '{"a":1}')
    assert.equal(extractJsonCandidate('prose prefix {"a":1} prose suffix'), '{"a":1}')
    assert.equal(extractJsonCandidate('prose prefix [1, 2, 3] prose suffix'), '[1, 2, 3]')
})

test('deterministically repairs malformed object-shaped JSON using jsonrepair', () => {
    assert.deepEqual(
        parseStructuredJson("{value: 'repaired', trailing: [1,2,],}"),
        {value: 'repaired', trailing: [1, 2]},
    )
})

test('rejects unrecoverable JSON, prose, and scalar JSON roots', () => {
    for (const raw of ['only prose', '"json string"', '42', 'true']) {
        const result = parseStructuredJsonResult(raw)
        assert.equal(result.ok, false, raw)
        assert.equal(result.kind, 'parse_failed', raw)
    }
})

test('Zod validation returns detailed error messages on schema failure', () => {
    const schema = z.object({
        outer: z.object({
            rows: z.array(z.object({name: z.string().min(3)})),
        }),
    })
    const result = parseStructuredJsonResult('{"outer":{"rows":[{"name":"x"}]}}', schema)
    assert.equal(result.ok, false)
    assert.equal(result.kind, 'schema_invalid')
    assert.match(result.message, /outer\.rows\.0\.name/)
    assert.equal(result.zodIssues[0].path.join('.'), 'outer.rows.0.name')
})

test('zodToJsonSchema converts representable schemas', () => {
    const schema = z.object({
        value: z.string(),
        count: z.number(),
    })
    const converted = zodToJsonSchema(schema)
    assert.equal(converted.ok, true)
    assert.equal(converted.schema.type, 'object')
})

test('resolveResponseFormat maps schema to json_schema format', () => {
    const schema = z.object({value: z.string()})
    const format = resolveResponseFormat(schema, 'my_schema')
    assert.equal(format.type, 'json_schema')
    assert.equal(format.name, 'my_schema')
})

test('OpenAI, Google, and Ollama format payloads correctly', async () => {
    const originalFetch = globalThis.fetch
    const calls = []

    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(String(init.body))
        calls.push({url: String(url), body})
        if (String(url).includes('openai')) {
            return new Response(JSON.stringify({
                choices: [{message: {content: '{"value":"openai"}'}}],
            }))
        }
        if (String(url).includes('generativelanguage')) {
            return new Response(JSON.stringify({
                candidates: [{content: {parts: [{text: '{"value":"google"}'}]}}],
            }))
        }
        return new Response(JSON.stringify({response: '{"value":"ollama"}'}))
    }

    try {
        const format = {
            type: 'json_schema',
            name: 'test',
            schema: {type: 'object', properties: {value: {type: 'string'}}},
        }

        await new OpenAIAdapter().generate({
            modelId: 'gpt-4o',
            prompt: 'hi',
            config: {id: 'openai', apiKey: 'key'},
            format,
        })
        await new GoogleAdapter().generate({
            modelId: 'gemini-flash',
            prompt: 'hi',
            config: {id: 'google', apiKey: 'key'},
            format,
        })
        await new OllamaProvider().generate({
            modelId: 'llama3',
            prompt: 'hi',
            config: {id: 'ollama', host: 'localhost'},
            format,
        })

        assert.equal(calls[0].body.response_format.type, 'json_schema')
        assert.equal(calls[1].body.generationConfig.responseMimeType, 'application/json')
        assert.deepEqual(calls[2].body.format, format.schema)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('Asker.ask performs bounded corrective retry when validation fails', async () => {
    let callCount = 0
    const completion = new CompletionEngine([]).registerAdapter({
        id: 'mock',
        async generate() {
            callCount += 1
            if (callCount === 1)
                return {ok: true, text: '{"count": "not a number"}', model: {providerId: 'mock', modelId: 'm'}}
            return {ok: true, text: '{"count": 42}', model: {providerId: 'mock', modelId: 'm'}}
        },
    })

    const asker = new Asker({
        providers: {mock: {id: 'mock', available: true}},
        completion,
    })

    const result = await asker.ask('give count', {
        model: 'mock/m',
        schema: z.object({count: z.number()}),
        maxRetries: 2,
    })

    assert.equal(result.ok, true)
    assert.deepEqual(result.data, {count: 42})
    assert.equal(callCount, 2)
})
