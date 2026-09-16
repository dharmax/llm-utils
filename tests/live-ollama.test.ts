import {expect, test} from 'bun:test'
import {
    Asker,
    type ContextResolver,
    LLMActor,
    PromptEngine,
    ProviderDiscovery,
    z,
} from '../src/index.ts'

const ollamaHost = process.env.OLLAMA_HOST || 'http://lotus:11434'

// Probe if Ollama is accessible
const probe = await ProviderDiscovery.probeOllama(ollamaHost)
const isOllamaUp = probe.installed && probe.models.length > 0
const testModel = probe.models.find(m => m.id.includes('qwen2.5-coder:7b'))?.id
    ?? probe.models[0]?.id
    ?? 'qwen2.5-coder:7b'

test('Live Ollama: Asker.prompt resolves and injects RAG context into templates with live model', async () => {
    if (!isOllamaUp) {
        console.warn(`Skipping live Ollama test: Ollama not reachable at ${ollamaHost}`)
        return
    }

    const knowledgeBase: Record<string, string> = {
        'codename': 'Project Apollo codename is: MOONSHOT_99',
    }

    const contextResolver: ContextResolver = async ({query}) => {
        if (query.toLowerCase().includes('apollo')) {
            return knowledgeBase.codename
        }
        return ''
    }

    const template = '## Context\n{{ context }}\n\nWhat is the codename of Project Apollo based on your context? Answer with just the codename.'
    const promptEngine = new PromptEngine({
        async load() {
            return template
        },
    })

    const asker = new Asker({
        providers: {
            ollama: {id: 'ollama', host: ollamaHost, available: true},
        },
        defaultModel: `ollama/${testModel}`,
        promptEngine,
        context: contextResolver,
    })

    const result = await asker.prompt('apollo', {query: 'apollo'})

    expect(result.ok).toBe(true)
    expect(result.text).toContain('MOONSHOT_99')
}, 60000)

test('Live Ollama: LLMActor executes end-to-end RAG + autonomous tool augmentation from natural language', async () => {
    if (!isOllamaUp) {
        console.warn(`Skipping live Ollama test: Ollama not reachable at ${ollamaHost}`)
        return
    }

    const asker = new Asker({
        providers: {
            ollama: {id: 'ollama', host: ollamaHost, available: true},
        },
        defaultModel: `ollama/${testModel}`,
    })

    let toolExecutedWith = ''
    const stringLengthTool = {
        name: 'get_string_length',
        description: 'Returns the exact character count of a provided text string',
        parameters: z.object({
            text: z.string().describe('The string to measure'),
        }),
        execute: ({text}: {text: string}) => {
            toolExecutedWith = text
            return {length: text.length}
        },
    }

    const knowledgeBase: Record<string, string> = {
        'alpha-auth': 'Project Alpha authentication key: AUTH_TOKEN_SEC_7788',
    }

    const contextResolver: ContextResolver = async ({query}) => {
        if (query.includes('Project Alpha')) {
            return knowledgeBase['alpha-auth']
        }
        return ''
    }

    const actor = new LLMActor(asker, {
        maxSteps: 4,
        tools: [stringLengthTool],
        contextResolver,
    })

    const goal = 'Find the authentication key for Project Alpha and use get_string_length to compute its character length. State both the key and the count.'
    const result = await actor.run(goal)

    expect(result.ok).toBe(true)
    expect(result.haltReason).toBe('completed')
    expect(result.steps.length).toBeGreaterThanOrEqual(2)

    // Check that tool was called with the key from RAG
    expect(toolExecutedWith).toContain('AUTH_TOKEN_SEC_7788')

    // Check that final text mentions both the key and length (19 characters)
    expect(result.finalText).toContain('AUTH_TOKEN_SEC_7788')
    expect(result.finalText).toContain('19')
}, 60000)
