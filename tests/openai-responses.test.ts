import {afterEach, describe, expect, it} from 'bun:test'
import {OpenAIAdapter} from '../src/adapters.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('OpenAIAdapter Responses routing', () => {
  it('uses Responses API for direct OpenAI while preserving execution and structured-output options', async () => {
    let capturedUrl = ''
    let capturedBody: any
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        status: 'completed',
        output: [{
          type: 'message',
          content: [{type: 'output_text', text: '{"answer":42}'}],
        }],
        usage: {input_tokens: 11, output_tokens: 7, total_tokens: 18},
      }), {status: 200})
    }) as typeof fetch

    const result = await new OpenAIAdapter().generate({
      modelId: 'gpt-6-sol',
      prompt: 'Return the answer.',
      system: 'Be exact.',
      config: {
        id: 'openai',
        apiKey: 'test-key',
        providerOptions: {service_tier: 'default'},
      },
      format: {
        type: 'json_schema',
        name: 'answer',
        schema: {
          type: 'object',
          properties: {answer: {type: 'number'}},
          required: ['answer'],
          additionalProperties: false,
        },
        strict: true,
      },
      maxTokens: 777,
      providerOptions: {metadata: {source: 'test'}},
    })

    expect(result.ok).toBe(true)
    expect(result.text).toBe('{"answer":42}')
    expect(result.usage?.totalTokens).toBe(18)
    expect(result.finishReason).toBe('completed')
    expect(capturedUrl).toBe('https://api.openai.com/v1/responses')
    expect(capturedBody.model).toBe('gpt-6-sol')
    expect(capturedBody.max_output_tokens).toBe(777)
    expect(capturedBody.store).toBe(false)
    expect(capturedBody.temperature).toBeUndefined()
    expect(capturedBody.service_tier).toBe('default')
    expect(capturedBody.metadata).toEqual({source: 'test'})
    expect(capturedBody.input).toEqual([
      {role: 'system', content: 'Be exact.'},
      {role: 'user', content: 'Return the answer.'},
    ])
    expect(capturedBody.text.format).toEqual({
      type: 'json_schema',
      name: 'answer',
      schema: {
        type: 'object',
        properties: {answer: {type: 'number'}},
        required: ['answer'],
        additionalProperties: false,
      },
      strict: true,
    })
  })

  it('keeps custom OpenAI-compatible endpoints on Chat Completions', async () => {
    let capturedUrl = ''
    let capturedBody: any
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        choices: [{message: {content: 'ok'}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2},
      }), {status: 200})
    }) as typeof fetch

    const result = await new OpenAIAdapter().generate({
      modelId: 'custom-model',
      prompt: 'Hello',
      config: {
        id: 'openai',
        apiKey: 'test-key',
        baseUrl: 'https://gateway.example/v1',
      },
      temperature: 0.25,
      maxTokens: 123,
    })

    expect(result.ok).toBe(true)
    expect(capturedUrl).toBe('https://gateway.example/v1/chat/completions')
    expect(capturedBody.temperature).toBe(0.25)
    expect(capturedBody.max_tokens).toBe(123)
  })

  it('preserves temperature for direct non-reasoning OpenAI models', async () => {
    let capturedBody: any
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        status: 'completed',
        output_text: 'ok',
      }), {status: 200})
    }) as typeof fetch

    await new OpenAIAdapter().generate({
      modelId: 'gpt-4o-mini',
      prompt: 'Hello',
      config: {id: 'openai', apiKey: 'test-key'},
      temperature: 0.25,
    })

    expect(capturedBody.temperature).toBe(0.25)
  })
})
