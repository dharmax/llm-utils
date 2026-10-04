import {afterEach, describe, expect, it} from 'bun:test'
import {AnthropicAdapter, GoogleAdapter, OllamaProvider} from '../src/adapters.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
    globalThis.fetch = originalFetch
})

describe('provider output budgets and finish reasons', () => {
    it('honors maxTokens consistently and preserves provider termination reasons', async () => {
        const bodies: Record<string, any> = {}
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input)
            const body = JSON.parse(String(init?.body ?? '{}'))
            if (url.includes('anthropic')) {
                bodies.anthropic = body
                return Response.json({
                    content: [{type: 'text', text: 'ok'}],
                    stop_reason: 'max_tokens',
                    usage: {input_tokens: 3, output_tokens: 5},
                })
            }
            if (url.includes('googleapis')) {
                bodies.google = body
                return Response.json({
                    candidates: [{content: {parts: [{text: 'ok'}]}, finishReason: 'MAX_TOKENS'}],
                    usageMetadata: {promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8},
                })
            }
            bodies.ollama = body
            return Response.json({
                message: {content: 'ok'},
                done_reason: 'length',
                prompt_eval_count: 3,
                eval_count: 5,
            })
        }) as typeof fetch

        const maxTokens = 321
        const anthropic = await new AnthropicAdapter().generate({
            modelId: 'claude-test', prompt: 'x', config: {id: 'anthropic', apiKey: 'test'},
            maxTokens,
        })
        const google = await new GoogleAdapter().generate({
            modelId: 'gemini-test', prompt: 'x', config: {id: 'google', apiKey: 'test'},
            maxTokens,
        })
        const ollama = await new OllamaProvider().generate({
            modelId: 'qwen-test', prompt: 'x', config: {id: 'ollama', host: 'http://ollama.test'},
            maxTokens,
        })

        expect(bodies.anthropic.max_tokens).toBe(maxTokens)
        expect(bodies.google.generationConfig.maxOutputTokens).toBe(maxTokens)
        expect(bodies.ollama.options.num_predict).toBe(maxTokens)
        expect(anthropic.finishReason).toBe('max_tokens')
        expect(google.finishReason).toBe('MAX_TOKENS')
        expect(ollama.finishReason).toBe('length')
    })

    it('passes arbitrary Ollama model options while typed controls win', async () => {
        let body: any
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            body = JSON.parse(String(init?.body ?? '{}'))
            return Response.json({
                message: {content: 'ok'},
                done_reason: 'stop',
                prompt_eval_count: 1,
                eval_count: 1,
            })
        }) as typeof fetch

        await new OllamaProvider().generate({
            modelId: 'qwen-test',
            prompt: 'x',
            config: {
                id: 'ollama',
                host: 'http://ollama.test',
                contextWindow: 8192,
                providerOptions: {
                    top_k: 20,
                    repeat_penalty: 1.05,
                    num_ctx: 1024,
                    num_predict: 10,
                },
            },
            contextWindow: 32768,
            maxTokens: 777,
            temperature: 0.2,
            providerOptions: {
                top_p: 0.9,
                seed: 42,
                num_ctx: 2048,
                temperature: 0.8,
            },
        })

        expect(body.options).toMatchObject({
            top_k: 20,
            top_p: 0.9,
            repeat_penalty: 1.05,
            seed: 42,
            num_ctx: 32768,
            num_predict: 777,
            temperature: 0.2,
        })
    })

})
