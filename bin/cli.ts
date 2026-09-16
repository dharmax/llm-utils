#!/usr/bin/env bun
import {
    Asker,
    LLMActor,
    type ToolDefinition,
    ProviderDiscovery,
    z,
} from '../src/index.ts'
import {createDesktopTools} from '../examples/tools-actor.ts'

// Additional standard utilities for the REPL
const readFileTool: ToolDefinition<{path: string}, {content: string; size: number}> = {
    name: 'read_file',
    description: 'Read the contents of a local file from disk',
    parameters: z.object({
        path: z.string().describe('Absolute or relative file path to read'),
    }),
    execute: async ({path}) => {
        const file = Bun.file(path)
        if (!(await file.exists())) {
            return {content: `File not found: ${path}`, size: 0}
        }
        const text = await file.text()
        return {content: text.slice(0, 4000), size: file.size}
    },
}

const writeFileTool: ToolDefinition<{path: string; content: string}, {success: boolean; bytesWritten: number}> = {
    name: 'write_file',
    description: 'Write content to a file on disk',
    parameters: z.object({
        path: z.string().describe('File path to write to'),
        content: z.string().describe('Text content to write'),
    }),
    execute: async ({path, content}) => {
        const bytes = await Bun.write(path, content)
        return {success: true, bytesWritten: bytes}
    },
}

const evalMathTool: ToolDefinition<{expression: string}, {result: number | string}> = {
    name: 'eval_math',
    description: 'Safely evaluate a mathematical arithmetic expression (e.g. "(12 * 45) / 3")',
    parameters: z.object({
        expression: z.string().describe('Mathematical expression to calculate'),
    }),
    execute: async ({expression}) => {
        const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, '')
        try {
            const fn = new Function(`return (${sanitized});`)
            return {result: fn()}
        } catch (err) {
            return {result: `Error calculating: ${err instanceof Error ? err.message : String(err)}`}
        }
    },
}

function parseArgs(): {
    host: string
    model?: string
    maxSteps: number
    oncePrompt?: string
} {
    const args = process.argv.slice(2)

    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
Usage: bun run cli [options] [prompt...]
       llm [options] [prompt...]

Options:
  --host <url>        Ollama or local server host URL (default: $OLLAMA_HOST or http://127.0.0.1:11434)
  --model <model>     Target model name (auto-selects best local model if omitted)
  --max-steps <n>     Maximum agent execution steps (default: 8)
  --once <prompt>     Run single-shot prompt and exit without starting REPL
  -h, --help          Show this help message and exit

Interactive REPL:
  Run without prompt arguments to enter the interactive multi-tool REPL.
  REPL Commands: /tools, /models, /clear, exit
`)
        process.exit(0)
    }

    let host = process.env.OLLAMA_HOST || process.env.LOCAL_LLM_URL || 'http://127.0.0.1:11434'
    let model: string | undefined = undefined
    let maxSteps = 8
    const promptParts: string[] = []

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--host' && args[i + 1]) {
            host = args[++i]
        } else if (arg === '--model' && args[i + 1]) {
            model = args[++i]
        } else if (arg === '--max-steps' && args[i + 1]) {
            maxSteps = parseInt(args[++i], 10) || 8
        } else if (arg === '--once' && args[i + 1]) {
            promptParts.push(args[++i])
        } else if (!arg.startsWith('--')) {
            promptParts.push(arg)
        }
    }

    return {
        host,
        model,
        maxSteps,
        oncePrompt: promptParts.length > 0 ? promptParts.join(' ') : undefined,
    }
}

async function main() {
    const config = parseArgs()

    // 1. Discover Ollama models
    const probe = await ProviderDiscovery.probeOllama(config.host)
    const availableModels = probe.models.map(m => m.id)

    let selectedModel = config.model
    if (!selectedModel) {
        // Pick best available coding/reasoning local model
        const preferred = [
            'qwen2.5-coder:7b',
            'qwen2.5-coder:latest',
            'qwen2.5:7b',
            'llama3.2:latest',
            'llama3.1:8b',
            'mistral:latest',
        ]
        selectedModel = preferred.find(p => availableModels.includes(p)) ?? availableModels[0] ?? 'qwen2.5-coder:7b'
    }

    // 2. Assemble tools
    const tools: ToolDefinition[] = [
        ...createDesktopTools(),
        readFileTool,
        writeFileTool,
        evalMathTool,
    ]

    // 3. Configure Asker & Actor
    const asker = new Asker({
        providers: {
            ollama: {
                id: 'ollama',
                host: config.host,
                available: probe.installed,
            },
        },
        defaultModel: `ollama/${selectedModel}`,
    })

    const actor = new LLMActor(asker, {
        tools,
        maxSteps: config.maxSteps,
        onStep: (record) => {
            if (record.thought) {
                console.log(`\x1b[36m💭 [Thought]\x1b[0m ${record.thought}`)
            }
            for (const call of record.toolCalls) {
                console.log(`\x1b[33m⚡ [Tool Call]\x1b[0m ${call.toolName}(${JSON.stringify(call.parameters)})`)
            }
            for (const res of record.toolResults) {
                const icon = res.isError ? '\x1b[31m❌ [Error]\x1b[0m' : '\x1b[32m📥 [Result]\x1b[0m'
                const snippet = (res.isError
                    ? res.error
                    : typeof res.result === 'object'
                        ? JSON.stringify(res.result)
                        : String(res.result)) ?? ''
                console.log(`${icon} ${snippet.slice(0, 300)}${snippet.length > 300 ? '...' : ''}`)
            }
        },
    })

    // 4. Single-shot run if prompt passed in arguments
    if (config.oncePrompt) {
        console.log(`\x1b[1mPrompt:\x1b[0m ${config.oncePrompt}\n`)
        const start = performance.now()
        const res = await actor.run(config.oncePrompt)
        const duration = ((performance.now() - start) / 1000).toFixed(2)

        if (res.ok) {
            console.log(`\n\x1b[32;1m🎯 Final Answer:\x1b[0m\n${res.finalText}\n`)
            console.log(`\x1b[2m(Completed in ${duration}s, ${res.totalSteps} steps)\x1b[0m`)
        } else {
            console.error(`\x1b[31mExecution failed (${res.haltReason}): ${res.error}\x1b[0m`)
        }
        return
    }

    // 5. Interactive REPL Mode
    console.log(`\x1b[1;34m╔════════════════════════════════════════════════════════════════╗\x1b[0m`)
    console.log(`\x1b[1;34m║                 LLM-Utils Interactive REPL                     ║\x1b[0m`)
    console.log(`\x1b[1;34m╚════════════════════════════════════════════════════════════════╝\x1b[0m`)
    console.log(`\x1b[2mHost:\x1b[0m    ${config.host} ${probe.installed ? '\x1b[32m(online)\x1b[0m' : '\x1b[31m(offline)\x1b[0m'}`)
    console.log(`\x1b[2mModel:\x1b[0m   ollama/${selectedModel}`)
    console.log(`\x1b[2mTools:\x1b[0m   ${tools.map(t => t.name).join(', ')}`)
    console.log(`\x1b[2mCommands: /tools, /models, /clear, exit\x1b[0m\n`)

    while (true) {
        const input = prompt('\x1b[1m🤖 >\x1b[0m ')
        if (input === null) {
            console.log('\nGoodbye!')
            break
        }

        const trimmed = input.trim()
        if (!trimmed) continue

        if (trimmed === 'exit' || trimmed === 'quit' || trimmed === ':q') {
            console.log('Goodbye!')
            break
        }

        if (trimmed === '/clear') {
            console.clear()
            continue
        }

        if (trimmed === '/tools') {
            console.log('\n\x1b[1mAvailable Tools:\x1b[0m')
            for (const t of tools) {
                console.log(`  • \x1b[33m${t.name}\x1b[0m: ${t.description}`)
            }
            console.log()
            continue
        }

        if (trimmed === '/models') {
            console.log('\n\x1b[1mDetected Ollama Models:\x1b[0m')
            for (const m of availableModels) {
                const mark = m === selectedModel ? ' \x1b[32m(active)\x1b[0m' : ''
                console.log(`  • ${m}${mark}`)
            }
            console.log()
            continue
        }

        console.log()
        const start = performance.now()
        try {
            const res = await actor.run(trimmed)
            const duration = ((performance.now() - start) / 1000).toFixed(2)

            if (res.ok) {
                console.log(`\n\x1b[32;1m🎯 Answer:\x1b[0m\n${res.finalText}\n`)
                console.log(`\x1b[2m(Completed in ${duration}s, ${res.totalSteps} steps)\x1b[0m\n`)
            } else {
                console.log(`\n\x1b[31m❌ Failed [${res.haltReason}]: ${res.error}\x1b[0m\n`)
            }
        } catch (err) {
            console.error(`\x1b[31mUnexpected error: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`)
        }
    }
}

main().catch(err => {
    console.error('Fatal CLI error:', err)
    process.exit(1)
})
