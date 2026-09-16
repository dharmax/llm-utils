import {expect, test} from 'bun:test'
import {
    Asker,
    type ContextResolver,
    LLMActor,
    LLMPipeline,
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

test('Live Ollama: LLMActor chains multi-tool outputs with data dependencies', async () => {
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

    const tools = [
        {
            name: 'get_user_scores',
            description: 'Returns list of test scores for a user',
            parameters: z.object({
                username: z.string().describe('The user name'),
            }),
            execute: ({username}: {username: string}) => {
                return {username, scores: [80, 90, 70]}
            },
        },
        {
            name: 'eval_math',
            description: 'Calculates arithmetic expressions. Pass the mathematical formula as a string, e.g. "(80 + 90 + 70) / 3".',
            parameters: z.object({
                expression: z.string().describe('Arithmetic string formula to calculate, e.g. "(80 + 90 + 70) / 3"'),
            }),
            execute: ({expression}: {expression: string}) => {
                const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, '')
                const fn = new Function(`return (${sanitized});`)
                return {result: fn()}
            },
        },
    ]

    const actor = new LLMActor(asker, {
        maxSteps: 5,
        tools,
    })

    const goal = 'Get the scores for user "alice" using get_user_scores, then calculate the average score using eval_math. State the average.'
    const result = await actor.run(goal)

    expect(result.ok).toBe(true)
    expect(result.haltReason).toBe('completed')
    expect(result.finalText).toContain('80')
}, 60000)

test('Live Ollama: LLMActor recovers from tool errors and executes conditional fallback', async () => {
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

    const tools = [
        {
            name: 'read_config_file',
            description: 'Reads a configuration file from disk',
            parameters: z.object({
                filename: z.string().describe('File name to read'),
            }),
            execute: async ({filename}: {filename: string}) => {
                if (filename.includes('backup_config')) {
                    throw new Error(`File "${filename}" not found: 404 No such file`)
                }
                if (filename.includes('primary_config')) {
                    return {env: 'production', port: 8080}
                }
                return {unknown: true}
            },
        },
    ]

    const actor = new LLMActor(asker, {
        maxSteps: 5,
        tools,
    })

    const goal = 'Try to read "backup_config.json" using read_config_file. If that fails or does not exist, read "primary_config.json" instead and report the port number.'
    const result = await actor.run(goal)

    expect(result.ok).toBe(true)
    expect(result.haltReason).toBe('completed')
    expect(result.finalText).toContain('8080')
}, 60000)

test('Live Ollama: LLMPipeline executes full multi-phase lifecycle end-to-end', async () => {
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

    const tools = [
        {
            name: 'get_client_status',
            description: 'Returns client subscription and balance info',
            parameters: z.object({
                clientId: z.string().describe('Client ID'),
            }),
            execute: ({clientId}: {clientId: string}) => {
                return {clientId, tier: 'enterprise', credits: 450}
            },
        },
        {
            name: 'calculate_discount',
            description: 'Calculates renewal discount based on tier and credits',
            parameters: z.object({
                credits: z.number().describe('Current credit balance'),
            }),
            execute: ({credits}: {credits: number}) => {
                return {discountPercent: credits > 400 ? 20 : 10}
            },
        },
    ]

    const phaseEvents: string[] = []
    const pipeline = new LLMPipeline(asker, {
        tools,
        maxStepsPerPhase: 3,
        onPhaseChange: (phase) => {
            phaseEvents.push(phase)
        },
    })

    const goal = 'Check status for client "c_123" with get_client_status, then calculate their discount using calculate_discount. State both tier and discount.'
    const result = await pipeline.run(goal)

    expect(result.ok).toBe(true)
    expect(result.intent.normalizedGoal).toBeDefined()
    expect(result.plan.steps.length).toBeGreaterThanOrEqual(1)
    expect(result.finalText.toLowerCase()).toContain('enterprise')
    expect(result.finalText).toContain('20')
    expect(phaseEvents).toContain('preprocess')
    expect(phaseEvents).toContain('plan')
    expect(phaseEvents).toContain('execute')
    expect(phaseEvents).toContain('verify')
}, 90000)

