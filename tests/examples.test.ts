import assert from 'node:assert/strict'
import test from 'node:test'
import {
    createDesktopActor,
    createDesktopTools,
    linuxCommandTool,
    popupMessageTool,
    ttsTool,
    webSearchTool,
} from '../examples/tools-actor.ts'
import {
    Asker,
    CompletionEngine,
    LLMActor,
} from '../dist/index.js'

function createMockAsker(responses) {
    let callIndex = 0
    const completion = new CompletionEngine([]).registerAdapter({
        id: 'mock',
        async generate() {
            const resp = responses[callIndex] ?? responses[responses.length - 1]
            callIndex += 1
            return {
                ok: true,
                text: typeof resp === 'string' ? resp : JSON.stringify(resp),
                model: {providerId: 'mock', modelId: 'mock-model'},
            }
        },
    })

    return new Asker({
        providers: {mock: {id: 'mock', available: true}},
        completion,
        defaultModel: 'mock/mock-model',
    })
}

test('createDesktopTools returns all 4 standard tools', () => {
    const tools = createDesktopTools()
    assert.equal(tools.length, 4)
    const names = tools.map(t => t.name)
    assert.ok(names.includes('run_linux_command'))
    assert.ok(names.includes('popup_message'))
    assert.ok(names.includes('web_search'))
    assert.ok(names.includes('tts'))
})

test('linuxCommandTool executes echo command successfully', async () => {
    const result = await linuxCommandTool.execute({command: 'echo "actor-test"'})
    assert.equal(result.stdout, 'actor-test')
    assert.equal(result.stderr, '')
})

test('popupMessageTool executes and returns displayed status', async () => {
    const result = await popupMessageTool.execute({title: 'Alert', message: 'Server online'})
    assert.equal(result.displayed, true)
})

test('webSearchTool returns structured results', async () => {
    const result = await webSearchTool.execute({query: 'Bun TypeScript', maxResults: 2})
    assert.equal(result.query, 'Bun TypeScript')
    assert.equal(result.results.length, 2)
    assert.ok(result.results[0].title.includes('Bun TypeScript'))
})

test('ttsTool executes and returns spoken status', async () => {
    const result = await ttsTool.execute({text: 'Task complete'})
    assert.equal(result.spoken, true)
    assert.equal(result.text, 'Task complete')
})

test('createDesktopActor executes multi-turn scenario using desktop tools', async () => {
    const asker = createMockAsker([
        // Step 1: Execute bash command
        {
            thought: 'Check current directory files.',
            action: 'tool_call',
            toolCalls: [
                {callId: 'c1', name: 'run_linux_command', parameters: {command: 'echo "hello from actor"'}},
            ],
        },
        // Step 2: Speak completion and show popup
        {
            thought: 'Notify user with TTS and popup.',
            action: 'tool_call',
            toolCalls: [
                {callId: 'c2', name: 'tts', parameters: {text: 'Command finished'}},
                {callId: 'c3', name: 'popup_message', parameters: {title: 'Status', message: 'Finished'}},
            ],
        },
        // Step 3: Conclude with final answer
        {
            thought: 'All actions completed.',
            action: 'final_answer',
            finalAnswer: 'Finished executing command and notified user.',
        },
    ])

    const actor = createDesktopActor(asker)
    const result = await actor.run('Run command and notify user')

    assert.equal(result.ok, true)
    assert.equal(result.haltReason, 'completed')
    assert.equal(result.totalSteps, 3)
    assert.equal(result.finalText, 'Finished executing command and notified user.')
    assert.equal(result.steps[0].toolResults[0].result.stdout, 'hello from actor')
})
