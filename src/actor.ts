import type {ZodType} from 'zod'
import {z} from 'zod'
import type {Asker} from './asker.ts'
import {type ContextResolver, resolveContext} from './context.ts'
import {parseStructuredJsonResult, zodToJsonSchema} from './structured-json.ts'
import type {AskOptions} from './types.ts'

export interface ToolDefinition<TParams = any, TResult = any> {
    name: string
    description: string
    parameters: ZodType<TParams>
    execute: (params: TParams, context?: unknown) => Promise<TResult> | TResult
}

export interface ToolInvocation {
    callId: string
    toolName: string
    parameters: Record<string, unknown>
}

export interface ToolExecutionResult {
    callId: string
    toolName: string
    result?: unknown
    error?: string
    isError: boolean
}

export interface ActorStepRecord {
    step: number
    thought: string
    action: 'tool_call' | 'final_answer'
    toolCalls: ToolInvocation[]
    toolResults: ToolExecutionResult[]
    finalAnswer?: string
}

export type ActorHaltReason = 'completed' | 'max_steps_exceeded' | 'aborted' | 'error'

export interface ActorRunResult<T = unknown> {
    ok: boolean
    output?: T
    finalText: string
    steps: ActorStepRecord[]
    totalSteps: number
    haltReason: ActorHaltReason
    error?: string
}

export interface ActorOptions {
    tools?: ToolDefinition[]
    maxSteps?: number
    system?: string
    askOptions?: AskOptions
    onStep?: (record: ActorStepRecord) => void | Promise<void>
    contextResolver?: ContextResolver
}

export interface ActorRunOptions<T = unknown> {
    maxSteps?: number
    schema?: ZodType<T>
    signal?: AbortSignal
    context?: unknown
    askOptions?: AskOptions
    contextResolver?: ContextResolver
}

export interface ActorStepResult {
    record: ActorStepRecord
    isDone: boolean
    error?: string
}

const ActorDecisionSchema = z.object({
    thought: z.string().describe('Reasoning on the current situation and required action'),
    action: z.enum(['tool_call', 'final_answer']).describe('Choose tool_call to execute tools, or final_answer if goal is achieved'),
    toolCalls: z.array(z.object({
        callId: z.string().optional().describe('Unique identifier for this call (e.g. call_1)'),
        id: z.string().optional().describe('Alias for callId'),
        name: z.string().describe('Name of the tool to invoke'),
        parameters: z.record(z.string(), z.unknown()).describe('Tool arguments as key-value pairs'),
    })).optional().default([]),
    finalAnswer: z.string().optional().describe('Final textual answer or summary to present when action is final_answer'),
})

export type ActorDecision = z.infer<typeof ActorDecisionSchema>

export function normalizeToolParameters(params: Record<string, unknown>, schema: ZodType): Record<string, unknown> {
    if (typeof params !== 'object' || params === null)
        return params

    if (schema.safeParse(params).success)
        return params

    const normalized: Record<string, unknown> = {...params}
    for (const [key, val] of Object.entries(normalized)) {
        if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
            const inner = val as Record<string, unknown>
            if (key in inner) {
                normalized[key] = inner[key]
            } else if ('value' in inner) {
                normalized[key] = inner.value
            } else if ('description' in inner && typeof inner.description === 'string') {
                normalized[key] = inner.description
            } else if ('text' in inner && typeof inner.text === 'string') {
                normalized[key] = inner.text
            } else if ('content' in inner && typeof inner.content === 'string') {
                normalized[key] = inner.content
            } else {
                const values = Object.values(inner)
                const keys = Object.keys(inner)
                const formulaVal = values.find(v => typeof v === 'string' && /[+\-*/()]/.test(v))
                if (typeof formulaVal === 'string') {
                    normalized[key] = formulaVal
                } else if (values.length === 1) {
                    const firstVal = values[0]
                    if (typeof firstVal === 'string' || typeof firstVal === 'number' || typeof firstVal === 'boolean') {
                        normalized[key] = firstVal
                    } else if (firstVal === null || firstVal === undefined || firstVal === '') {
                        normalized[key] = keys[0]
                    }
                }
            }
        }
    }
    return normalized
}

export class LLMActor {
    private readonly tools = new Map<string, ToolDefinition>()
    private readonly maxSteps: number
    private readonly system?: string
    private readonly defaultAskOptions?: AskOptions
    private readonly onStep?: (record: ActorStepRecord) => void | Promise<void>
    private readonly contextResolver?: ContextResolver

    constructor(
        private readonly asker: Asker,
        options: ActorOptions = {},
    ) {
        this.maxSteps = options.maxSteps ?? 5
        this.system = options.system
        this.defaultAskOptions = options.askOptions
        this.onStep = options.onStep
        this.contextResolver = options.contextResolver

        for (const tool of options.tools ?? [])
            this.registerTool(tool)
    }

    registerTool(tool: ToolDefinition): this {
        this.tools.set(tool.name, tool)
        return this
    }

    unregisterTool(name: string): this {
        this.tools.delete(name)
        return this
    }

    getTools(): ToolDefinition[] {
        return [...this.tools.values()]
    }

    getTool(name: string): ToolDefinition | undefined {
        return this.tools.get(name)
    }

    /**
     * Executes a single turn (Think + Act + Observe).
     */
    async step(
        goal: string,
        history: ActorStepRecord[] = [],
        context?: unknown,
        overrideOptions?: AskOptions,
    ): Promise<ActorStepResult> {
        const stepNumber = history.length + 1
        const catalog = this.renderToolCatalog()
        const systemPrompt = this.buildSystemPrompt(catalog)

        const conversationPrompt = this.buildTurnPrompt(goal, history, stepNumber)

        const {schema: _s1, ...defaultOpts} = this.defaultAskOptions ?? {}
        const {schema: _s2, ...overrideOpts} = overrideOptions ?? {}

        const askOptions: Omit<AskOptions<ActorDecision>, 'schema'> = {
            ...defaultOpts,
            ...overrideOpts,
            system: overrideOptions?.system ?? systemPrompt,
        }

        const res = await this.asker.json(conversationPrompt, ActorDecisionSchema, askOptions)
        if (!res.ok || !res.data) {
            const errorMsg = res.failure?.message ?? 'Failed to parse model decision.'
            const errorRecord: ActorStepRecord = {
                step: stepNumber,
                thought: `Error encountered: ${errorMsg}`,
                action: 'final_answer',
                toolCalls: [],
                toolResults: [],
                finalAnswer: '',
            }
            return {
                record: errorRecord,
                isDone: true,
                error: errorMsg,
            }
        }

        const decision = res.data

        // If model decided it is finished
        if (decision.action === 'final_answer') {
            const record: ActorStepRecord = {
                step: stepNumber,
                thought: decision.thought,
                action: 'final_answer',
                toolCalls: [],
                toolResults: [],
                finalAnswer: decision.finalAnswer ?? '',
            }
            return {record, isDone: true}
        }

        // Handle tool calls
        const toolCalls: ToolInvocation[] = (decision.toolCalls ?? []).map((tc, idx) => ({
            callId: tc.callId ?? tc.id ?? `call_${idx + 1}`,
            toolName: tc.name,
            parameters: tc.parameters,
        }))

        const toolResults: ToolExecutionResult[] = []

        for (const call of toolCalls) {
            const tool = this.tools.get(call.toolName)
            if (!tool) {
                toolResults.push({
                    callId: call.callId,
                    toolName: call.toolName,
                    isError: true,
                    error: `Tool "${call.toolName}" is not registered. Available tools: ${[...this.tools.keys()].join(', ')}`,
                })
                continue
            }

            // Validate parameters with normalization for local models
            const normalizedParams = normalizeToolParameters(call.parameters, tool.parameters)
            call.parameters = normalizedParams
            const parsed = tool.parameters.safeParse(normalizedParams)
            if (!parsed.success) {
                toolResults.push({
                    callId: call.callId,
                    toolName: call.toolName,
                    isError: true,
                    error: `Invalid parameters for tool "${call.toolName}": ${parsed.error.message}`,
                })
                continue
            }

            // Execute tool inside error boundary
            try {
                const execResult = await tool.execute(parsed.data, context)
                toolResults.push({
                    callId: call.callId,
                    toolName: call.toolName,
                    isError: false,
                    result: execResult,
                })
            } catch (err) {
                toolResults.push({
                    callId: call.callId,
                    toolName: call.toolName,
                    isError: true,
                    error: err instanceof Error ? err.message : String(err),
                })
            }
        }

        const record: ActorStepRecord = {
            step: stepNumber,
            thought: decision.thought,
            action: 'tool_call',
            toolCalls,
            toolResults,
        }

        return {record, isDone: false}
    }

    /**
     * Autonomous bounded loop until completion or maxSteps limit.
     */
    async run<T = unknown>(
        goal: string,
        options: ActorRunOptions<T> = {},
    ): Promise<ActorRunResult<T>> {
        const max = options.maxSteps ?? this.maxSteps
        const steps: ActorStepRecord[] = []
        const signal = options.signal

        // Auto-inject RAG context if contextResolver is provided
        let effectiveGoal = goal
        const resolver = options.contextResolver ?? this.contextResolver
        if (resolver) {
            const ctxText = await resolveContext(resolver, {query: goal})
            if (ctxText) {
                effectiveGoal = `## Retrieved Context\n${ctxText}\n\n## Goal\n${goal}`
            }
        }

        while (steps.length < max) {
            if (signal?.aborted) {
                return {
                    ok: false,
                    finalText: '',
                    steps,
                    totalSteps: steps.length,
                    haltReason: 'aborted',
                    error: 'Execution aborted by signal.',
                }
            }

            const stepResult = await this.step(effectiveGoal, steps, options.context, options.askOptions)
            steps.push(stepResult.record)

            if (this.onStep) {
                try {
                    await this.onStep(stepResult.record)
                } catch {
                    // Life cycle callback error should not crash the actor loop
                }
            }

            if (stepResult.error) {
                return {
                    ok: false,
                    finalText: '',
                    steps,
                    totalSteps: steps.length,
                    haltReason: 'error',
                    error: stepResult.error,
                }
            }

            if (stepResult.isDone) {
                const finalText = stepResult.record.finalAnswer ?? ''
                let output: T | undefined

                if (options.schema && finalText) {
                    const parsed = parseStructuredJsonResult(finalText, options.schema)
                    if (parsed.ok) {
                        output = parsed.data
                    } else {
                        const repair = await this.asker.json(
                            `Extract and format the required structured JSON based on the goal and observations.\n\nGoal: ${effectiveGoal}\n\nObservations/Answer:\n${finalText}`,
                            options.schema,
                            options.askOptions,
                        )
                        if (repair.ok && repair.data)
                            output = repair.data
                    }
                }

                return {
                    ok: true,
                    output,
                    finalText,
                    steps,
                    totalSteps: steps.length,
                    haltReason: 'completed',
                }
            }
        }

        return {
            ok: false,
            finalText: '',
            steps,
            totalSteps: steps.length,
            haltReason: 'max_steps_exceeded',
            error: `Exceeded maximum step budget of ${max} steps without reaching a final answer.`,
        }
    }

    private renderToolCatalog(): string {
        const tools = [...this.tools.values()]
        if (tools.length === 0)
            return 'No tools available.'

        return tools.map(t => {
            const converted = zodToJsonSchema(t.parameters)
            let schemaJson: Record<string, unknown> = {type: 'object'}
            if (converted.ok && typeof converted.schema === 'object' && converted.schema !== null) {
                const {$schema, additionalProperties, ...rest} = converted.schema as Record<string, unknown>
                schemaJson = rest
            }
            return `### Tool: ${t.name}\nDescription: ${t.description}\nParameters JSON Schema:\n${JSON.stringify(schemaJson, null, 2)}`
        }).join('\n\n')
    }

    private buildSystemPrompt(catalog: string): string {
        const userCustom = this.system ? `${this.system}\n\n` : ''
        return `${userCustom}You are an autonomous acting agent equipped with tools to accomplish the user's goal.

## Available Tools
${catalog}

## Operational Rules
1. Reason carefully in the "thought" field before taking action.
2. To gather info or modify state, set action="tool_call" and specify toolCalls with concrete runtime parameter values (e.g. { "callId": "1", "name": "tool_name", "parameters": { "paramName": "actual_value" } }).
3. NEVER put JSON schema definitions, type names, or JSON pointers (like "#/...") in "parameters". Always provide the actual runtime values.
4. When the goal is accomplished or you have the answer, IMMEDIATELY choose action="final_answer" and formulate your response in "finalAnswer". Do NOT invoke notification/messaging tools to tell the user the answer.
5. Always produce output strictly matching the required JSON format.`
    }

    private buildTurnPrompt(goal: string, history: ActorStepRecord[], currentStep: number): string {
        const lines: string[] = [`## Goal\n${goal}`]

        if (history.length > 0) {
            lines.push('\n## Prior Action History')
            for (const item of history) {
                lines.push(`\n### Step ${item.step}`)
                lines.push(`Thought: ${item.thought}`)
                lines.push(`Action: ${item.action}`)
                if (item.toolCalls.length > 0) {
                    lines.push('Tool Invocations:')
                    for (let i = 0; i < item.toolCalls.length; i += 1) {
                        const call = item.toolCalls[i]
                        if (!call)
                            continue
                        const res = item.toolResults[i]
                        const resStr = res ? (res.isError ? `ERROR: ${res.error}` : JSON.stringify(res.result)) : 'pending'
                        lines.push(`- ${call.toolName}(${JSON.stringify(call.parameters)}) -> Result: ${resStr}`)
                    }
                }
            }
        }

        lines.push(`\n## Current Turn: Step ${currentStep}`)
        lines.push('Analyze the goal and any prior observations, then determine the next toolCalls or finalAnswer.')
        return lines.join('\n')
    }
}
