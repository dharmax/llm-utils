import {expect, test} from 'bun:test'
import {
    Asker,
    CompletionEngine,
    extractJsonCandidate,
    GoogleAdapter,
    OllamaProvider,
    OpenAIAdapter,
    parseStructuredJson,
    parseStructuredJsonResult,
    resolveResponseFormat,
    z,
    zodToJsonSchema,
} from '../src/index.ts'

test('parses direct object and array roots', () => {
    expect(parseStructuredJson('{"value":1}')).toEqual({value: 1})
    expect(parseStructuredJson('[1,2,3]')).toEqual([1, 2, 3])
})

test('parses fenced and prose-surrounded JSON', () => {
    const schema = z.object({value: z.string()})
    expect(
        parseStructuredJson('before ```json\n{"value":"fenced"}\n``` after', schema),
    ).toEqual({value: 'fenced'})
    expect(
        parseStructuredJson('The result is {"value":"embedded"}; done.', schema),
    ).toEqual({value: 'embedded'})
})

test('extractJsonCandidate handles fences and outer delimiters correctly', () => {
    expect(extractJsonCandidate('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJsonCandidate('prose prefix {"a":1} prose suffix')).toBe('{"a":1}')
    expect(extractJsonCandidate('prose prefix [1, 2, 3] prose suffix')).toBe('[1, 2, 3]')
})

test('deterministically repairs malformed object-shaped JSON using jsonrepair', () => {
    expect(
        parseStructuredJson("{value: 'repaired', trailing: [1,2,],}"),
    ).toEqual({value: 'repaired', trailing: [1, 2]})
})

test('rejects unrecoverable JSON, prose, and scalar JSON roots', () => {
    for (const raw of ['', '   ', 'only prose', '"json string"', '42', 'true']) {
        const result = parseStructuredJsonResult(raw)
        expect(result.ok).toBe(false)
        expect(result.kind).toBe('parse_failed')
    }
})

test('Zod validation returns detailed error messages on schema failure', () => {
    const schema = z.object({
        outer: z.object({
            rows: z.array(z.object({name: z.string().min(3)})),
        }),
    })
    const result = parseStructuredJsonResult('{"outer":{"rows":[{"name":"x"}]}}', schema)
    expect(result.ok).toBe(false)
    expect(result.kind).toBe('schema_invalid')
    expect(result.message).toMatch(/outer\.rows\.0\.name/)
    expect(result.zodIssues?.[0]?.path.join('.')).toBe('outer.rows.0.name')
})

test('zodToJsonSchema converts representable schemas', () => {
    const schema = z.object({
        value: z.string(),
        count: z.number(),
    })
    const converted = zodToJsonSchema(schema)
    expect(converted.ok).toBe(true)
    if (converted.ok) {
        expect((converted.schema as any).type).toBe('object')
    }
})

test('resolveResponseFormat maps schema to json_schema format', () => {
    const schema = z.object({value: z.string()})
    const format = resolveResponseFormat(schema, 'my_schema')
    expect(typeof format === 'object' && format.type).toBe('json_schema')
    if (typeof format === 'object') {
        expect(format.name).toBe('my_schema')
    }
})

test('OpenAI, Google, and Ollama format payloads and normalize URLs correctly', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{url: string; body: any}> = []

    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(String(init?.body))
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
        return new Response(JSON.stringify({message: {content: '{"value":"ollama"}'}}))
    }

    try {
        const format = {
            type: 'json_schema' as const,
            name: 'test',
            schema: {type: 'object', properties: {value: {type: 'string'}}},
        }

        // Test with trailing slash in baseUrl to verify URL normalization
        await new OpenAIAdapter().generate({
            modelId: 'gpt-4o',
            prompt: 'hi',
            config: {id: 'openai', apiKey: 'key', baseUrl: 'https://api.openai.com/v1/'},
            format,
        })
        await new GoogleAdapter().generate({
            modelId: 'models/gemini-flash',
            prompt: 'hi',
            config: {id: 'google', apiKey: 'key', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/'},
            format,
        })
        await new OllamaProvider().generate({
            modelId: 'llama3',
            prompt: 'hi',
            config: {id: 'ollama', host: 'http://localhost:11434/'},
            format,
        })

        expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions')
        expect(calls[0]?.body.response_format.type).toBe('json_schema')
        expect(calls[1]?.url.includes('models/gemini-flash:generateContent')).toBe(true)
        expect(calls[1]?.body.generationConfig.responseMimeType).toBe('application/json')
        expect(calls[2]?.url).toBe('http://localhost:11434/api/chat')
        expect(calls[2]?.body.format).toEqual(format.schema)
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

    expect(result.ok).toBe(true)
    expect(result.data).toEqual({count: 42})
    expect(callCount).toBe(2)
})
