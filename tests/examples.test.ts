import {expect, test} from 'bun:test'
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
} from '../src/index.ts'

function createMockAsker(responses: any[]) {
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
    expect(tools.length).toBe(4)
    const names = tools.map(t => t.name)
    expect(names).toContain('run_linux_command')
    expect(names).toContain('popup_message')
    expect(names).toContain('web_search')
    expect(names).toContain('tts')
})

test('linuxCommandTool executes echo command successfully', async () => {
    const result = await linuxCommandTool.execute({command: 'echo "actor-test"'})
    expect(result.stdout).toBe('actor-test')
    expect(result.stderr).toBe('')
})

test('popupMessageTool executes and returns displayed status', async () => {
    const result = await popupMessageTool.execute({title: 'Alert', message: 'Server online'})
    expect(result.displayed).toBe(true)
})

test('webSearchTool returns structured results', async () => {
    const result = await webSearchTool.execute({query: 'Bun TypeScript', maxResults: 2})
    expect(result.query).toBe('Bun TypeScript')
    expect(result.results.length).toBe(2)
    expect(result.results[0].title).toContain('Bun TypeScript')
})

test('ttsTool executes and returns spoken status', async () => {
    const result = await ttsTool.execute({text: 'Task complete'})
    expect(result.spoken).toBe(true)
    expect(result.text).toBe('Task complete')
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

    expect(result.ok).toBe(true)
    expect(result.haltReason).toBe('completed')
    expect(result.totalSteps).toBe(3)
    expect(result.finalText).toBe('Finished executing command and notified user.')
    expect((result.steps[0].toolResults[0].result as any).stdout).toBe('hello from actor')
})
