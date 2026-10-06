import type {ZodType} from 'zod'
import {z} from 'zod'
import type {Asker} from './asker.ts'
import {type ContextResolver, resolveContext} from './context.ts'
import {parseStructuredJsonResult, zodToJsonSchema} from './structured-json.ts'
import type {AskOptions} from './types.ts'
import {childMetricsContext, emitMetric, type MetricsContext, type MetricsSink} from './metrics.ts'

/** Explicit user refusal/cancellation. Ordinary execution failures throw Error. */
export class ToolAbortError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ToolAbortError'
    }
}

/** Return only successful operations; throw failures, or ToolAbortError to halt the run. */
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
    recoveredMissingTool?: boolean
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

export interface ActorIssue {
    kind: 'llm' | 'tool' | 'abort' | 'budget'
    message: string
    step?: number
    source?: string
    retryable?: boolean
}

export interface ActorRunResult<T = unknown> {
    ok: boolean
    output?: T
    finalText: string
    steps: ActorStepRecord[]
    totalSteps: number
    haltReason: ActorHaltReason
    error?: string
    issues: ActorIssue[]
}

export interface ActorOptions {
    tools?: ToolDefinition[]
    maxSteps?: number
    /** Hard guard against accidentally serializing a global capability universe into one prompt. */
    maxToolCatalogChars?: number
    system?: string
    askOptions?: AskOptions
    onStep?: (record: ActorStepRecord) => void | Promise<void>
    contextResolver?: ContextResolver
    onMissingTool?: (
        toolName: string,
        parameters: Record<string, unknown>,
        context?: unknown
    ) => Promise<ToolExecutionResult | ToolDefinition | undefined> | ToolExecutionResult | ToolDefinition | undefined
}

export interface ActorRunOptions<T = unknown> {
    /** Exact tool surface for this run. When omitted, the actor's registered tools are used. */
    tools?: readonly ToolDefinition[]
    maxSteps?: number
    schema?: ZodType<T>
    signal?: AbortSignal
    context?: unknown
    askOptions?: AskOptions
    contextResolver?: ContextResolver
    onStep?: (record: ActorStepRecord) => void | Promise<void>
    onMissingTool?: (
        toolName: string,
        parameters: Record<string, unknown>,
        context?: unknown
    ) => Promise<ToolExecutionResult | ToolDefinition | undefined> | ToolExecutionResult | ToolDefinition | undefined
    metrics?: MetricsContext
    metricsSink?: MetricsSink
}

export interface ActorStepResult {
    record: ActorStepRecord
    isDone: boolean
    error?: string
    aborted?: boolean
    issue?: ActorIssue
}

export function createActorDecisionSchema(registeredToolNames: string[] = []): z.ZodType<ActorDecision> {
    const base = z.object({
        thought: z.string().describe('Reasoning on the current situation and required action'),
        action: z.enum(['tool_call', 'final_answer']).describe('Choose tool_call to execute tools, or final_answer if goal is achieved'),
        toolCalls: z.array(z.object({
            callId: z.string().optional().describe('Unique identifier for this call (e.g. call_1)'),
            id: z.string().optional().describe('Alias for callId'),
            name: registeredToolNames.length > 0
                ? z.enum(registeredToolNames as [string, ...string[]]).describe(`Name of the registered tool to invoke (must be one of: ${registeredToolNames.join(', ')})`)
                : z.string().describe('Name of the tool to invoke'),
            parameters: z.record(z.string(), z.unknown()).describe('Tool arguments as key-value pairs'),
        })).optional().default([]),
        finalAnswer: z.string().optional().describe('Final textual answer or summary to present when action is final_answer'),
    })

    if (registeredToolNames.length === 0)
        return base

    return base.superRefine((data, ctx) => {
        if (data.action === 'tool_call') {
            for (let i = 0; i < (data.toolCalls?.length ?? 0); i += 1) {
                const call = data.toolCalls?.[i]
                if (call && !registeredToolNames.includes(call.name)) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        message: `Tool "${call.name}" is not registered. Registered tools: ${registeredToolNames.join(', ')}`,
                        path: ['toolCalls', i, 'name'],
                    })
                }
            }
        }
    })
}

export const ActorDecisionSchema = createActorDecisionSchema()

export type ActorDecision = {
    thought: string
    action: 'tool_call' | 'final_answer'
    toolCalls?: Array<{
        callId?: string
        id?: string
        name: string
        parameters: Record<string, unknown>
    }>
    finalAnswer?: string
}

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
                } else if (values.length === 0) {
                    delete normalized[key]
                }
            }
        }
    }
    return normalized
}

export class LLMActor {
    private readonly tools = new Map<string, ToolDefinition>()
    private readonly maxSteps: number
    private readonly maxToolCatalogChars: number
    private readonly system?: string
    private readonly defaultAskOptions?: AskOptions
    private readonly onStep?: (record: ActorStepRecord) => void | Promise<void>
    private readonly contextResolver?: ContextResolver
    private readonly onMissingTool?: (
        toolName: string,
        parameters: Record<string, unknown>,
        context?: unknown
    ) => Promise<ToolExecutionResult | ToolDefinition | undefined> | ToolExecutionResult | ToolDefinition | undefined

    constructor(
        private readonly asker: Asker,
        options: ActorOptions = {},
    ) {
        this.maxSteps = options.maxSteps ?? 5
        this.maxToolCatalogChars = options.maxToolCatalogChars ?? 32_000
        this.system = options.system
        this.defaultAskOptions = options.askOptions
        this.onStep = options.onStep
        this.contextResolver = options.contextResolver
        this.onMissingTool = options.onMissingTool

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
        return this.executeStep(goal, history, context, overrideOptions, this.tools, false)
    }

    private async executeStep(
        goal: string,
        history: ActorStepRecord[],
        context: unknown,
        overrideOptions: AskOptions | undefined,
        tools: Map<string, ToolDefinition>,
        runLocalTools: boolean,
        onMissingTool?: (
            toolName: string,
            parameters: Record<string, unknown>,
            context?: unknown
        ) => Promise<ToolExecutionResult | ToolDefinition | undefined> | ToolExecutionResult | ToolDefinition | undefined,
    ): Promise<ActorStepResult> {
        const stepNumber = history.length + 1
        const catalog = this.renderToolCatalog(tools)
        if (catalog.length > this.maxToolCatalogChars) {
            throw new Error(
                `Tool catalog too large (${catalog.length} chars > ${this.maxToolCatalogChars}). ` +
                'Select a smaller run-local tool surface before invoking LLMActor.',
            )
        }
        const registeredToolNames = [...tools.keys()]
        const missingToolHandler = runLocalTools ? onMissingTool : (this.onMissingTool ?? onMissingTool)
        const systemPrompt = this.buildSystemPrompt(catalog, Boolean(missingToolHandler))

        const conversationPrompt = this.buildTurnPrompt(goal, history, stepNumber)

        const {schema: _s1, ...defaultOpts} = this.defaultAskOptions ?? {}
        const {schema: _s2, ...overrideOpts} = overrideOptions ?? {}

        const decisionSchema = missingToolHandler
            ? createActorDecisionSchema([])
            : createActorDecisionSchema(registeredToolNames)

        const askOptions: Omit<AskOptions<ActorDecision>, 'schema'> = {
            maxRetries: 2,
            ...defaultOpts,
            ...overrideOpts,
            system: overrideOptions?.system ?? systemPrompt,
        }

        const res = await this.asker.json(conversationPrompt, decisionSchema, askOptions)
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
                issue: {
                    kind: 'llm',
                    message: errorMsg,
                    step: stepNumber,
                    source: res.failure?.kind,
                    retryable: res.failure?.retryable,
                },
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
        let abortError: string | undefined

        for (const call of toolCalls) {
            let tool = tools.get(call.toolName)
            let recoveredMissingTool = false
            if (!tool && missingToolHandler) {
                try {
                    const fallback = await missingToolHandler(call.toolName, call.parameters, context)
                    if (fallback) {
                        if ('isError' in fallback && typeof fallback.isError === 'boolean') {
                            toolResults.push({...fallback as ToolExecutionResult, recoveredMissingTool: !fallback.isError})
                            continue
                        }
                        if ('execute' in fallback && typeof (fallback as any).execute === 'function') {
                            tool = fallback as ToolDefinition
                            recoveredMissingTool = true
                            if (runLocalTools) {
                                tools.set(tool.name, tool)
                            } else {
                                this.registerTool(tool)
                            }
                        }
                    }
                } catch (err) {
                    toolResults.push({
                        callId: call.callId,
                        toolName: call.toolName,
                        isError: true,
                        error: `Error in onMissingTool handler for "${call.toolName}": ${err instanceof Error ? err.message : String(err)}`,
                    })
                    if (err instanceof ToolAbortError) { abortError = err.message; break }
                    continue
                }
            }

            if (!tool) {
                toolResults.push({
                    callId: call.callId,
                    toolName: call.toolName,
                    isError: true,
                    error: runLocalTools
                        ? `Tool "${call.toolName}" is not available for this run. Available tools: ${[...tools.keys()].join(', ')}`
                        : `Tool "${call.toolName}" is not registered. Available tools: ${[...tools.keys()].join(', ')}`,
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
                    ...(recoveredMissingTool ? {recoveredMissingTool: true} : {}),
                })
            } catch (err) {
                toolResults.push({
                    callId: call.callId,
                    toolName: call.toolName,
                    isError: true,
                    error: err instanceof Error ? err.message : String(err),
                })
                if (err instanceof ToolAbortError) { abortError = err.message; break }
            }
        }

        const record: ActorStepRecord = {
            step: stepNumber,
            thought: decision.thought,
            action: 'tool_call',
            toolCalls,
            toolResults,
        }

        return abortError !== undefined
            ? {record, isDone: true, error: abortError, aborted: true}
            : {record, isDone: false}
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
        const issues: ActorIssue[] = []
        const signal = options.signal
        const started = performance.now()
        const parentMetrics = options.metrics ?? options.askOptions?.metrics
        const runMetrics = parentMetrics ? childMetricsContext(parentMetrics) : undefined
        const metricsSink = options.metricsSink ?? options.askOptions?.metricsSink
        const runAskOptions: AskOptions | undefined = (options.askOptions || runMetrics || metricsSink || signal)
            ? {
                ...options.askOptions,
                ...(signal ? {signal} : {}),
                ...(runMetrics ? {metrics: runMetrics} : {}),
                ...(metricsSink ? {metricsSink} : {}),
            }
            : undefined

        const finish = (result: Omit<ActorRunResult<T>, 'issues'>): ActorRunResult<T> => {
            const toolResults = steps.flatMap(step => step.toolResults)
            emitMetric(metricsSink, {
                kind: 'actor',
                timestamp: new Date().toISOString(),
                latencyMs: performance.now() - started,
                success: result.ok,
                error: result.error,
                steps: result.totalSteps,
                toolCalls: steps.reduce((sum, step) => sum + step.toolCalls.length, 0),
                toolFailures: toolResults.filter(item => item.isError).length,
                missingToolRecoveries: toolResults.filter(item => item.recoveredMissingTool).length,
                haltReason: result.haltReason,
                traceId: runMetrics?.traceId,
                spanId: runMetrics?.spanId,
                parentSpanId: runMetrics?.parentSpanId,
                taskClass: runMetrics?.taskClass,
                tags: runMetrics?.tags,
            })
            return {...result, issues: [...issues]}
        }
        const runLocalTools = options.tools !== undefined
        const tools = runLocalTools
            ? new Map(options.tools!.map(tool => [tool.name, tool] as const))
            : this.tools

        // Auto-inject RAG context if contextResolver is provided
        let effectiveGoal = goal
        const resolver = options.contextResolver ?? this.contextResolver
        if (resolver) {
            if (signal?.aborted) {
                issues.push({kind: 'abort', message: 'Execution aborted by signal.'})
                return finish({
                    ok: false,
                    finalText: '',
                    steps,
                    totalSteps: 0,
                    haltReason: 'aborted',
                    error: 'Execution aborted by signal.',
                })
            }
            const ctxText = await resolveContext(resolver, {query: goal})
            if (signal?.aborted) {
                issues.push({kind: 'abort', message: 'Execution aborted by signal.'})
                return finish({
                    ok: false,
                    finalText: '',
                    steps,
                    totalSteps: 0,
                    haltReason: 'aborted',
                    error: 'Execution aborted by signal.',
                })
            }
            if (ctxText) {
                effectiveGoal = `## Retrieved Context\n${ctxText}\n\n## Goal\n${goal}`
            }
        }

        while (steps.length < max) {
            if (signal?.aborted) {
                issues.push({kind: 'abort', message: 'Execution aborted by signal.', step: steps.length || undefined})
                return finish({
                    ok: false,
                    finalText: '',
                    steps,
                    totalSteps: steps.length,
                    haltReason: 'aborted',
                    error: 'Execution aborted by signal.',
                })
            }

            const stepResult = await this.executeStep(
                effectiveGoal,
                steps,
                options.context,
                runAskOptions,
                tools,
                runLocalTools,
                options.onMissingTool,
            )
            steps.push(stepResult.record)
            if (stepResult.issue) issues.push(stepResult.issue)
            for (const toolResult of stepResult.record.toolResults) {
                if (toolResult.isError) {
                    issues.push({
                        kind: 'tool',
                        message: toolResult.error ?? 'Tool execution failed.',
                        step: stepResult.record.step,
                        source: toolResult.toolName,
                    })
                }
            }

            const onStep = options.onStep ?? this.onStep
            if (onStep) {
                try {
                    await onStep(stepResult.record)
                } catch {
                    // Life cycle callback error should not crash the actor loop
                }
            }

            if (signal?.aborted) {
                issues.push({kind: 'abort', message: 'Execution aborted by signal.', step: stepResult.record.step})
                return finish({
                    ok: false,
                    finalText: '',
                    steps,
                    totalSteps: steps.length,
                    haltReason: 'aborted',
                    error: 'Execution aborted by signal.',
                })
            }

            if (stepResult.error !== undefined) {
                return finish({
                    ok: false,
                    finalText: '',
                    steps,
                    totalSteps: steps.length,
                    haltReason: stepResult.aborted ? 'aborted' : 'error',
                    error: stepResult.error,
                })
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
                            runAskOptions,
                        )
                        if (signal?.aborted) {
                            issues.push({kind: 'abort', message: 'Execution aborted by signal.', step: stepResult.record.step})
                            return finish({
                                ok: false,
                                finalText: '',
                                steps,
                                totalSteps: steps.length,
                                haltReason: 'aborted',
                                error: 'Execution aborted by signal.',
                            })
                        }
                        if (repair.ok && repair.data)
                            output = repair.data
                    }
                }

                return finish({
                    ok: true,
                    output,
                    finalText,
                    steps,
                    totalSteps: steps.length,
                    haltReason: 'completed',
                })
            }
        }

        const budgetError = `Exceeded maximum step budget of ${max} steps without reaching a final answer.`
        issues.push({kind: 'budget', message: budgetError, step: steps.length})
        return finish({
            ok: false,
            finalText: '',
            steps,
            totalSteps: steps.length,
            haltReason: 'max_steps_exceeded',
            error: budgetError,
        })
    }

    private renderToolCatalog(toolMap: ReadonlyMap<string, ToolDefinition>): string {
        const tools = [...toolMap.values()]
        if (tools.length === 0)
            return 'No tools available.'

        return tools.map(t => {
            const converted = zodToJsonSchema(t.parameters)
            let schemaJson: Record<string, unknown> = {type: 'object'}
            if (converted.ok && typeof converted.schema === 'object' && converted.schema !== null) {
                const {$schema, additionalProperties, ...rest} = converted.schema as Record<string, unknown>
                schemaJson = rest
            }
            return `### Tool: ${t.name}\nDescription: ${t.description}\nParameters JSON Schema: ${JSON.stringify(schemaJson)}`
        }).join('\n\n')
    }

    private buildSystemPrompt(catalog: string, canRecoverMissingTool: boolean): string {
        const userCustom = this.system ? `${this.system}\n\n` : ''
        const toolRule = canRecoverMissingTool
            ? 'Use the explicitly declared tools whenever possible. If the goal clearly requires a capability that is absent, you may request that one missing capability by a concise functional name; the runtime will attempt bounded semantic recovery.'
            : 'Only invoke tools explicitly declared in Available Tools above. Never invent or guess tool names.'
        return `${userCustom}You are an autonomous acting agent equipped with tools to accomplish the user's goal.

## Available Tools
${catalog}

## Operational Rules
1. Reason carefully in the "thought" field before taking action.
2. To gather info or modify state, set action="tool_call" and specify toolCalls with concrete runtime parameter values (e.g. { "callId": "1", "name": "tool_name", "parameters": { "paramName": "actual_value" } }).
3. ${toolRule}
4. A tool error or failure is an observation to reason from, NOT proof that the goal is impossible. When a tool fails or reports invalid arguments:
   - Repair invalid parameters or inputs;
   - Choose an alternative registered tool or capability;
   - Or trigger discovery if available.
   Never surrender or claim inability merely because an initial tool call failed or encountered an error while alternative tools or approaches remain.
5. NEVER put JSON schema definitions, type names, or JSON pointers (like "#/...") in "parameters". Always provide the actual runtime values.
6. When the goal is accomplished or you have the answer, choose action="final_answer" and formulate your response in "finalAnswer". Do NOT invoke notification/messaging tools to tell the user the answer.
7. Always produce output strictly matching the required JSON format.`
    }

    private buildTurnPrompt(goal: string, history: ActorStepRecord[], currentStep: number): string {
        const lines: string[] = [`## Goal\n${goal}`]
        let lastStepHadError = false

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

            const lastItem = history[history.length - 1]
            lastStepHadError = lastItem?.toolResults.some(r => r.isError) ?? false
        }

        lines.push(`\n## Current Turn: Step ${currentStep}`)
        if (lastStepHadError) {
            lines.push('⚠️ RECOVERY / REPLANNING TURN: The previous step encountered tool errors or invalid inputs.')
            lines.push('Do NOT conclude the goal is impossible. Re-evaluate available registered tools, repair arguments, choose an alternative tool, or use discovery to achieve the goal.')
        } else {
            lines.push('Analyze the goal and any prior observations, then determine the next toolCalls or finalAnswer.')
        }
        return lines.join('\n')
    }
}
