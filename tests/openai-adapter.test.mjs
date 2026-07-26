import test from 'node:test'
import assert from 'node:assert/strict'

import {OpenAIAdapter} from '../dist/index.mjs'

test('OpenAIAdapter uses Responses API for GPT-5 reasoning models', async () => {
    const originalFetch = globalThis.fetch
    let captured
    globalThis.fetch = async (url, init) => {
        captured = {url: String(url), init}
        return new Response(JSON.stringify({
            output: [{
                type: 'message',
                content: [{type: 'output_text', text: '{"ok":true}'}],
            }],
            usage: {input_tokens: 11, output_tokens: 7, total_tokens: 18},
        }), {status: 200, headers: {'Content-Type': 'application/json'}})
    }

    try {
        const result = await new OpenAIAdapter().generate({
            modelId: 'gpt-5.6-sol',
            prompt: 'Return JSON.',
            system: 'Be exact.',
            config: {id: 'openai', apiKey: 'test-key'},
            format: 'json',
            temperature: 0.1,
        })

        assert.equal(result.ok, true)
        assert.equal(result.text, '{"ok":true}')
        assert.deepEqual(result.usage, {
            promptTokens: 11,
            completionTokens: 7,
            totalTokens: 18,
            available: true,
        })
        assert.equal(captured.url, 'https://api.openai.com/v1/responses')

        const request = JSON.parse(captured.init.body)
        assert.deepEqual(request.input, [
            {role: 'system', content: 'Be exact.'},
            {role: 'user', content: 'Return JSON.'},
        ])
        assert.deepEqual(request.reasoning, {effort: 'medium'})
        assert.deepEqual(request.text, {format: {type: 'json_object'}})
        assert.equal(request.store, false)
        assert.equal('temperature' in request, false)
        assert.equal(captured.init.headers.Authorization, 'Bearer test-key')
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('OpenAIAdapter preserves temperature for non-reasoning models', async () => {
    const originalFetch = globalThis.fetch
    let request
    globalThis.fetch = async (_url, init) => {
        request = JSON.parse(init.body)
        return new Response(JSON.stringify({
            output: [{content: [{type: 'output_text', text: 'ok'}]}],
            usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2},
        }), {status: 200})
    }

    try {
        const result = await new OpenAIAdapter().generate({
            modelId: 'gpt-4o-mini',
            prompt: 'Hello',
            config: {id: 'openai', apiKey: 'test-key'},
            temperature: 0.25,
        })

        assert.equal(result.ok, true)
        assert.equal(request.temperature, 0.25)
        assert.equal('reasoning' in request, false)
        assert.equal('text' in request, false)
    } finally {
        globalThis.fetch = originalFetch
    }
})
