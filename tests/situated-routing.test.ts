import {expect, test} from 'bun:test'
import {Asker} from '../src/asker.ts'
import {CompletionEngine} from '../src/completion.ts'
import {ModelRouter} from '../src/routing.ts'
import type {ModelAdviceSnapshot} from '../src/model-advice.ts'
import type {SystemOne, SystemOneState, SystemOneQuestion} from '../src/system-one.ts'
import type {ProviderConfig} from '../src/types.ts'

const providers: Record<string, ProviderConfig> = {
  local: {id: 'local', available: true, local: true, models: [
    {id: 'cheap', providerId: 'local'}, {id: 'strong', providerId: 'local'},
  ]},
  remote: {id: 'remote', available: true, models: [{id: 'deep', providerId: 'remote'}]},
}

const advice = {
  updatedAt: '2026-10-26T00:00:00.000Z',
  advisor: 'research-authority',
  environment: {
    hardware: {platform: 'linux', architecture: 'x64', ramBytes: 32_000_000_000,
      cpu: 'fixture', logicalCpus: 8, gpus: []},
    providers: [],
  },
  workloads: {code: {
    primary: {target: {providerId: 'local', modelId: 'cheap'}, availability: 'installed',
      reason: 'Low latency for simple coding', expectedQuality: 'adequate'},
    fallbacks: [{target: {providerId: 'remote', modelId: 'deep'}, availability: 'accessible',
      reason: 'Stronger reasoning on complex coding', expectedQuality: 'strong'}],
  }},
  recommendedPulls: [],
  notes: [],
} satisfies ModelAdviceSnapshot

const completion = () => new CompletionEngine(['local', 'remote'].map(id => ({
  id,
  async generate({modelId}: {modelId: string}) {
    return {ok: true, text: 'ok', model: {providerId: id, modelId}}
  },
})))

function fixture(systemOne: SystemOne, routes: Record<string, string> = {}) {
  const router = new ModelRouter({routes, adviceSnapshot: advice, advicePath: false,
    defaultModel: 'local/cheap', providers})
  return new Asker({providers, router, completion: completion(), systemOne})
}

test('System 1 receives original query, task, authority evidence and chooses a validated provider/model', async () => {
  let state: SystemOneState = null
  let questions: Readonly<Record<string, SystemOneQuestion>> = {}
  const systemOne: SystemOne = {async assess(input, asked) {
    state = input; questions = asked
    return {answers: {route: {choice: 'choice1'}}, backendId: 'fixture', quality: 'low', latencyMs: 1}
  }}
  const asker = fixture(systemOne)
  const result = await asker.ask('Rendered implementation prompt', {task: 'code',
    routingContext: {query: 'Fix the broken indexing test', role: 'developer', requirements: ['structured output']}})
  expect(result.ok).toBe(true)
  expect(result.model).toEqual({providerId: 'remote', modelId: 'deep'})
  expect(state).toMatchObject({task: 'code', query: 'Fix the broken indexing test',
    role: 'developer', authority: {advisor: 'research-authority'}, residentLocalModels: null})
  expect(questions.route?.type).toBe('choice')
  expect(Object.keys(questions.route?.type === 'choice' ? questions.route.criteria : {})).toHaveLength(2)
})

test('tracks previously successful local model, without claiming residency', async () => {
  const states: SystemOneState[] = []
  const systemOne: SystemOne = {async assess(state) {
    states.push(state)
    return {answers: {route: {choice: states.length === 1 ? 'choice0' : 'choice1'}},
      backendId: 'fixture', quality: 'low', latencyMs: 1}
  }}
  const asker = fixture(systemOne)
  await asker.ask('simple', {task: 'code'})
  await asker.ask('complex', {task: 'code'})
  expect(states[1]).toMatchObject({previousLocalModel: 'local/cheap', residentLocalModels: null})
})

test('explicit model or task route bypasses System 1', async () => {
  let calls = 0
  const systemOne: SystemOne = {async assess() {
    calls++
    throw Error('must not consult selector')
  }}
  const asker = fixture(systemOne, {code: 'local/strong'})
  expect((await asker.ask('a', {task: 'code'})).model.modelId).toBe('strong')
  expect((await asker.ask('b', {task: 'code', model: 'local/cheap'})).model.modelId).toBe('cheap')
  expect(calls).toBe(0)
})

test('malformed, failing and ineligible selections use the existing router fallback', async () => {
  const bad: SystemOne = {async assess() {
    return {answers: {route: {choice: 'invented'}}, backendId: 'fixture', quality: 'low', latencyMs: 1}
  }}
  expect((await fixture(bad).ask('test', {task: 'code'})).model).toEqual({providerId: 'local', modelId: 'cheap'})
  expect((await fixture(bad).ask('test', {task: 'code', allowedProviders: ['local']})).model.providerId).toBe('local')
  const failure: SystemOne = {async assess() {throw Error('unavailable')}}
  expect((await fixture(failure).ask('test', {task: 'code'})).model.modelId).toBe('cheap')
})
