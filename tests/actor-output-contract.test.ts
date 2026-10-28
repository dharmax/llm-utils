import {expect, test} from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {Asker, CompletionEngine, LLMActor, z} from '../src/index.ts'

const ProposalSchema = z.object({
    changes: z.array(z.object({action: z.literal('replace_text'), filePath: z.string(), oldText: z.string(), newText: z.string()})),
    testCommands: z.array(z.array(z.string())),
    required: z.array(z.object({question: z.string(), why: z.string(), target: z.string()})).optional(),
})

function observedAsker(decide: (prompt: string) => unknown) {
    const prompts: string[] = []
    const completion = new CompletionEngine([]).registerAdapter({
        id: 'mock',
        async generate({prompt}: {prompt: string}) {
            prompts.push(prompt)
            return {ok: true, text: JSON.stringify(decide(prompt)), model: {providerId: 'mock', modelId: 'mock-model'}}
        },
    })
    const asker = new Asker({providers: {mock: {id: 'mock', available: true}}, completion, defaultModel: 'mock/mock-model'})
    return {asker, prompts}
}

test('Actor accepts typed final values in one decision', async () => {
    const proposal = {changes: [], testCommands: []}
    const {asker, prompts} = observedAsker(() => ({thought: 'Hand off to host checks', action: 'final_answer', finalAnswer: proposal}))
    const result = await new LLMActor(asker).run('Return a proposal', {schema: ProposalSchema})
    expect(result.ok).toBe(true)
    expect(result.output).toEqual(proposal)
    expect(prompts).toHaveLength(1)
})

test.each([
    '{"changes":[],"testCommands":[]}',
    "```json\n{changes: [], testCommands: [],}\n```",
])('Actor accepts observed proposal formatting without another inference: %s', async finalAnswer => {
    const {asker, prompts} = observedAsker(() => ({thought: '', action: 'final_answer', finalAnswer}))
    const result = await new LLMActor(asker).run('Return a proposal', {schema: ProposalSchema})
    expect(result.ok).toBe(true)
    expect(result.output).toEqual({changes: [], testCommands: []})
    expect(result.finalText).toBe(finalAnswer)
    expect(prompts).toHaveLength(1)
})

test.each(['The implementation meets the requirements.', '{"changes":"not a list","testCommands":[]}'])(
    'Actor fails closed for unsupported proposal: %s', async finalAnswer => {
        const {asker, prompts} = observedAsker(() => ({thought: '', action: 'final_answer', finalAnswer}))
        const result = await new LLMActor(asker).run('Return a proposal', {schema: ProposalSchema})
        expect(result.ok).toBe(false)
        expect(result.haltReason).toBe('error')
        expect(result.output).toBeUndefined()
        expect(result.finalText).toBe(finalAnswer)
        expect(result.error).toBeTruthy()
        expect(result.issues[0]).toMatchObject({kind: 'llm', message: result.error, step: 1, retryable: false})
        expect(prompts).toHaveLength(1)
    },
)

test('Actor preserves actual edit and observation history when final prose cannot supply a proposal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actor-output-contract-'))
    const file = path.join(root, 'budget.ts')
    const before = 'export const minimum = 1\n'
    const after = 'export const minimum = 128\n'
    const finalAnswer = 'The constructor already rejects limits below 128 bytes.'
    fs.writeFileSync(file, before)
    try {
        const {asker, prompts} = observedAsker(prompt => {
            if (!prompt.includes('### Step 1'))
                return {thought: '', action: 'tool_call', toolCalls: [{name: 'read_source', parameters: {}}]}
            if (!prompt.includes('### Step 2')) {
                expect(prompt).toContain(JSON.stringify(before))
                return {thought: '', action: 'tool_call', toolCalls: [{name: 'replace_source', parameters: {oldText: before, newText: after}}]}
            }
            expect(prompt).toContain('"changed":true')
            expect(prompt).toContain(JSON.stringify(before))
            return {thought: '', action: 'final_answer', finalAnswer}
        })
        const actor = new LLMActor(asker, {tools: [
            {name: 'read_source', description: 'Read current source', readOnly: true, parameters: z.object({}),
                execute: () => ({code: fs.readFileSync(file, 'utf8')})},
            {name: 'replace_source', description: 'Replace a unique observed source anchor', parameters: z.object({oldText: z.string(), newText: z.string()}),
                execute: ({oldText, newText}) => {
                    const current = fs.readFileSync(file, 'utf8')
                    if (current.split(oldText).length !== 2) throw new Error('Expected unique source anchor')
                    fs.writeFileSync(file, current.replace(oldText, newText))
                    return {changed: true}
                }},
        ]})
        const result = await actor.run('Raise the minimum and return a proposal', {schema: ProposalSchema})
        expect(fs.readFileSync(file, 'utf8')).toBe(after)
        expect(result.ok).toBe(false)
        expect(result.output).toBeUndefined()
        expect(result.finalText).toBe(finalAnswer)
        expect(result.steps).toHaveLength(3)
        expect(result.steps[0]?.toolResults[0]?.result).toEqual({code: before})
        expect(result.steps[1]?.toolResults[0]?.result).toEqual({changed: true})
        expect(prompts).toHaveLength(3)
    } finally {
        fs.rmSync(root, {recursive: true, force: true})
    }
})

test('Actor honors abort after final decision without starting an output inference', async () => {
    const controller = new AbortController()
    const {asker, prompts} = observedAsker(() => ({thought: '', action: 'final_answer', finalAnswer: 'Unsupported prose'}))
    const result = await new LLMActor(asker).run('Return a proposal', {
        schema: ProposalSchema, signal: controller.signal, onStep: () => controller.abort(),
    })
    expect(result.ok).toBe(false)
    expect(result.haltReason).toBe('aborted')
    expect(result.steps[0]?.finalAnswer).toBe('Unsupported prose')
    expect(prompts).toHaveLength(1)
})
