import {describe, expect, it} from 'bun:test'
import {
  FallbackSystemOne,
  JevSystemOne,
  LayaSystemOne,
  RemoteSystemOne,
  type SystemOneQuestion,
} from '../src/system-one.ts'

const questions: Record<string, SystemOneQuestion> = {
  route: {
    type: 'choice',
    instructions: 'Choose route',
    criteria: {fast: 'Fast path', deep: 'Deep path'},
  },
  safe: {
    type: 'noul',
    instructions: 'Is this safe?',
  },
}

describe('SystemOne', () => {
  it('preserves batched Laya answers and probabilities', async () => {
    let calls = 0
    const systemOne = new LayaSystemOne({
      id: 'test-laya',
      quality: 'medium',
      load: async () => ({
        async systemOne(state, receivedQuestions) {
          calls++
          expect(state).toEqual({input: 'hello'})
          expect(receivedQuestions).toBe(questions)
          return {
            answers: {
              route: {choice: 'fast', probabilities: {fast: 0.8, deep: 0.2}},
              safe: {noul: 0.93},
            },
            usage: {tokens: 17},
          }
        },
      }),
    })

    const result = await systemOne.assess({input: 'hello'}, questions)
    expect(calls).toBe(1)
    expect(result?.answers.route?.choice).toBe('fast')
    expect(result?.answers.route?.probabilities?.fast).toBe(0.8)
    expect(result?.answers.safe?.noul).toBe(0.93)
    expect(result?.usage).toEqual({tokens: 17})
    expect(result?.backendId).toBe('test-laya')
    expect(result?.quality).toBe('medium')
  })

  it('maps Jev through the shared SystemOne contract', async () => {
    let request: any
    let callOptions: any
    const systemOne = new JevSystemOne({
      id: 'test-jev',
      model: 'jev-latest',
      timeoutMs: 1200,
      load: async () => ({
        async systemOne(receivedRequest, receivedOptions) {
          request = receivedRequest
          callOptions = receivedOptions
          return {
            answers: {
              route: {type: 'choice', choice: 'deep', confidence: 0.9, probabilities: {fast: 0.1, deep: 0.9}},
              safe: {type: 'noul', noul: 0.98},
            },
            usage: {input_tokens: 11, output_tokens: 3},
          }
        },
      }),
    })

    const result = await systemOne.assess({input: 'hello'}, questions)
    expect(request).toEqual({state: {input: 'hello'}, questions, model: 'jev-latest'})
    expect(callOptions).toEqual({timeout: 1200})
    expect(result?.answers.route?.choice).toBe('deep')
    expect(result?.answers.route?.probabilities?.deep).toBe(0.9)
    expect(result?.answers.safe?.noul).toBe(0.98)
    expect(result?.usage).toEqual({input_tokens: 11, output_tokens: 3})
    expect(result?.backendId).toBe('test-jev')
    expect(result?.quality).toBe('low')
  })

  it('returns null when Jev is unavailable or malformed', async () => {
    expect(await new JevSystemOne({load: async () => null}).assess({}, questions)).toBeNull()
    expect(await new JevSystemOne({
      load: async () => ({async systemOne() { return {} }}),
    }).assess({}, questions)).toBeNull()
  })

  it('returns null when Laya is unavailable or malformed', async () => {
    expect(await new LayaSystemOne({load: async () => null}).assess({}, questions)).toBeNull()
    expect(await new LayaSystemOne({
      load: async () => ({async systemOne() { return {} }}),
    }).assess({}, questions)).toBeNull()
  })

  it('uses the shared remote protocol and preserves answers', async () => {
    const systemOne = new RemoteSystemOne({
      url: 'http://system-one.test/',
      fetch: async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toEqual({state: {input: 'x'}, questions})
        return new Response(JSON.stringify({
          ok: true,
          answers: {safe: {noul: 0.7}},
        }))
      },
    })

    const result = await systemOne.assess({input: 'x'}, questions)
    expect(result?.answers.safe?.noul).toBe(0.7)
  })

  it('falls back to the next backend only when needed', async () => {
    let fallbackCalls = 0
    const systemOne = new FallbackSystemOne([
      {assess: async () => null},
      {
        assess: async () => {
          fallbackCalls++
          return {
            answers: {safe: {noul: 1}},
            backendId: 'fallback',
            quality: 'low',
            latencyMs: 0,
          }
        },
      },
    ])

    expect((await systemOne.assess({}, questions))?.backendId).toBe('fallback')
    expect(fallbackCalls).toBe(1)
  })
})
