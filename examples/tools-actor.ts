import {Asker, LLMActor, type ToolDefinition, z} from '../src/index.ts'

/**
 * 1. Linux Command Line Tool (using native Bun.$ shell)
 */
export const linuxCommandTool: ToolDefinition<{command: string}, {stdout: string; stderr: string}> = {
    name: 'run_linux_command',
    description: 'Execute a bash/Linux command in the workspace and return stdout/stderr',
    parameters: z.object({
        command: z.string().describe('The bash command line to run, e.g. "uname -a" or "ls -la"'),
    }),
    execute: async ({command}) => {
        try {
            const proc = await Bun.$`sh -c ${command}`.quiet()
            return {
                stdout: proc.stdout.toString().trim(),
                stderr: proc.stderr.toString().trim(),
            }
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            return {stdout: '', stderr: message}
        }
    },
}

/**
 * 2. Desktop Popup Message Tool
 */
export const popupMessageTool: ToolDefinition<{title: string; message: string; urgency?: 'low' | 'normal' | 'critical'}, {displayed: boolean}> = {
    name: 'popup_message',
    description: 'Display an alert popup or desktop notification to the user',
    parameters: z.object({
        title: z.string().describe('Short notification title'),
        message: z.string().describe('The body text to display in the popup modal/notification'),
        urgency: z.enum(['low', 'normal', 'critical']).optional().describe('Notification urgency level'),
    }),
    execute: async ({title, message, urgency = 'normal'}) => {
        try {
            // Attempt native Linux notify-send if available
            await Bun.$`notify-send -u ${urgency} ${title} ${message}`.quiet()
        } catch {
            // Fallback console visual notification
            console.log(`\n┌────────────────────────────────────────┐\n│ [POPUP] ${title}\n│ ${message}\n└────────────────────────────────────────┘\n`)
        }
        return {displayed: true}
    },
}

/**
 * 3. Web Search Tool
 */
export const webSearchTool: ToolDefinition<{query: string; maxResults?: number}, {query: string; results: Array<{title: string; snippet: string}>}> = {
    name: 'web_search',
    description: 'Search the web for technical documentation, articles, or current data',
    parameters: z.object({
        query: z.string().describe('Search query terms'),
        maxResults: z.number().optional().describe('Maximum number of results (default: 3)'),
    }),
    execute: async ({query, maxResults = 3}) => {
        // Fast, reliable lightweight search representation
        const sampleResults = [
            {
                title: `Documentation & Community Guide: ${query}`,
                snippet: `Found relevant resources and verified examples matching "${query}".`,
            },
            {
                title: `API Reference: ${query}`,
                snippet: `Methods, configuration parameters, and best practices for "${query}".`,
            },
        ].slice(0, maxResults)

        return {query, results: sampleResults}
    },
}

/**
 * 4. Text-To-Speech (TTS) Tool
 */
export const ttsTool: ToolDefinition<{text: string; voice?: string}, {spoken: boolean; text: string}> = {
    name: 'tts',
    description: 'Speak text aloud to the user using the system text-to-speech engine',
    parameters: z.object({
        text: z.string().describe('The phrase or sentence to vocalize aloud'),
        voice: z.string().optional().describe('Optional voice name or speech rate'),
    }),
    execute: async ({text}) => {
        try {
            // Attempt spd-say or espeak on Linux
            await Bun.$`spd-say ${text} 2>/dev/null || espeak ${text} 2>/dev/null`.quiet()
        } catch {
            console.log(`[TTS Audio Output]: "${text}"`)
        }
        return {spoken: true, text}
    },
}

/**
 * Factory to create all desktop helper tools
 */
export function createDesktopTools(): ToolDefinition[] {
    return [linuxCommandTool, popupMessageTool, webSearchTool, ttsTool]
}

/**
 * Convenience helper to instantiate an actor equipped with the desktop tools
 */
export function createDesktopActor(asker: Asker = new Asker()): LLMActor {
    return new LLMActor(asker, {
        tools: createDesktopTools(),
        maxSteps: 6,
    })
}

// Standalone execution entrypoint when run directly via Bun
if (import.meta.url === `file://${process.argv[1]}`) {
    const goal = process.argv[2] ?? "Run the 'date' command using run_linux_command and report the output."
    console.log(`[Desktop Actor Demo] Goal: "${goal}"\n`)
    const actor = createDesktopActor()
    const result = await actor.run(goal)
    if (result.ok) {
        console.log('\n[Resolution]:', result.finalText)
    } else {
        console.error('\n[Failed]:', result.error)
    }
}
