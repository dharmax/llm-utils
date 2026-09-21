import {z, type ZodType} from 'zod'
import {LLMActor, type ActorRunResult, type ActorStepRecord, type ToolDefinition} from './actor.ts'
import type {Asker} from './asker.ts'
import type {AskOptions} from './types.ts'

export interface PreprocessedIntent {
    normalizedGoal: string
    domain?: string
    constraints: string[]
    relevantTools: string[]
    suggestedPhases: string[]
}

export const PreprocessedIntentSchema = z.object({
    normalizedGoal: z.string().min(1),
    domain: z.string().optional(),
    constraints: z.array(z.string()).default([]),
    relevantTools: z.array(z.string()).default([]),
    suggestedPhases: z.array(z.string()).default([]),
})

export interface PlanStep {
    id: string
    description: string
    assignedTools: string[]
    dependsOn?: string[]
}

export interface ExecutionPlan {
    strategy: string
    steps: PlanStep[]
}

export const ExecutionPlanSchema = z.object({
    strategy: z.string(),
    steps: z.array(z.object({
        id: z.string().min(1),
        description: z.string().min(1),
        assignedTools: z.array(z.string()).default([]),
        dependsOn: z.array(z.string()).optional(),
    })),
})

export interface IntentPreprocessorAdapter {
    preprocess(goal: string, tools: ToolDefinition[], options?: AskOptions): Promise<PreprocessedIntent>
}

export interface TaskPlannerAdapter {
    plan(intent: PreprocessedIntent, tools: ToolDefinition[], options?: AskOptions): Promise<ExecutionPlan>
}

export interface PipelineStepException {
    step: PlanStep
    error: string
    stepResult: ActorRunResult
    stepOutputs: Record<string, string>
    intent: PreprocessedIntent
    plan: ExecutionPlan
    attempt: number
}

export type PipelineExceptionResolution =
    | {action: 'retry'; wisdom?: string; assignedTools?: string[]}
    | {action: 'continue'; fallbackOutput: string}
    | {action: 'skip'}
    | {action: 'abort'; reason?: string}

export type PipelineExceptionHandler = (
    exception: PipelineStepException,
) => Promise<PipelineExceptionResolution | void> | PipelineExceptionResolution | void

/** Optional domain-level gate. A model's final_answer is a proposal, not verification. */
export interface StageValidationContext {
    goal: string
    step: PlanStep
    intent: PreprocessedIntent
    plan: ExecutionPlan
    result: ActorRunResult
    stepOutputs: Readonly<Record<string, string>>
}

export type StageValidationResult = {ok: true} | {ok: false; reason: string}
export type StageValidator = (context: StageValidationContext) => Promise<StageValidationResult> | StageValidationResult

export interface PipelineRunResult<T = unknown> {
    ok: boolean
    finalText: string
    output?: T
    intent: PreprocessedIntent
    plan: ExecutionPlan
    phaseTraces: Record<string, ActorStepRecord[]>
    stepOutputs: Record<string, string>
    error?: string
    /** In verified mode a substituted or skipped stage cannot become verified success. */
    verification?: 'verified' | 'partial' | 'unverified'
}

export interface PipelineOptions {
    tools?: ToolDefinition[]
    maxStepsPerPhase?: number
    askOptions?: AskOptions
    preprocessor?: IntentPreprocessorAdapter
    planner?: TaskPlannerAdapter
    onPhaseChange?: (phase: string, data?: unknown) => void | Promise<void>
    onException?: PipelineExceptionHandler
    autoWisdom?: boolean
    maxStepRetries?: number
    throwOnError?: boolean
    /** Enables fail-closed preprocessing, dependency/tool validation and honest partial results. */
    verified?: boolean
    stageValidator?: StageValidator
}

/** The existing preprocess -> plan -> scoped LLMActor -> verify lifecycle. */
export class LLMPipeline {
    private readonly tools = new Map<string, ToolDefinition>()
    private readonly maxStepsPerPhase: number
    private readonly askOptions?: AskOptions
    private readonly preprocessor?: IntentPreprocessorAdapter
    private readonly planner?: TaskPlannerAdapter
    private readonly onPhaseChange?: PipelineOptions['onPhaseChange']
    private readonly onException?: PipelineExceptionHandler
    private readonly autoWisdom: boolean
    private readonly maxStepRetries: number
    private readonly throwOnError: boolean
    private readonly verified: boolean
    private readonly stageValidator?: StageValidator

    constructor(private readonly asker: Asker, options: PipelineOptions = {}) {
        this.maxStepsPerPhase = options.maxStepsPerPhase ?? 4
        this.askOptions = options.askOptions
        this.preprocessor = options.preprocessor
        this.planner = options.planner
        this.onPhaseChange = options.onPhaseChange
        this.onException = options.onException
        this.autoWisdom = Boolean(options.autoWisdom)
        this.maxStepRetries = options.maxStepRetries ?? 2
        this.throwOnError = Boolean(options.throwOnError)
        this.verified = Boolean(options.verified)
        this.stageValidator = options.stageValidator
        for (const tool of options.tools ?? []) this.registerTool(tool)
    }

    registerTool(tool: ToolDefinition): this { this.tools.set(tool.name, tool); return this }
    getTools(): ToolDefinition[] { return [...this.tools.values()] }

    async preprocess(goal: string, options?: AskOptions): Promise<PreprocessedIntent> {
        await this.onPhaseChange?.('preprocess', {goal})
        if (this.preprocessor) return PreprocessedIntentSchema.parse(await this.preprocessor.preprocess(goal, this.getTools(), options))
        const catalog = this.getTools().map(t => `- ${t.name}: ${t.description}`).join('\n')
        const res = await this.asker.json(`Analyze this user goal and extract clear operational constraints and tool requirements.\nAvailable Tools:\n${catalog || 'None'}\nGoal:\n${goal}`, PreprocessedIntentSchema, {
            ...this.askOptions, ...options,
            system: 'You are an intent preprocessor. Preserve the original goal and EVERY explicit prohibition and requested outcome. Extract needed tools.',
        })
        if (res.ok && res.data) return res.data
        if (this.verified) throw new Error(`Intent preprocessing failed: ${res.failure?.message ?? 'No valid result'}`)
        return {normalizedGoal: goal, constraints: [], relevantTools: [...this.tools.keys()], suggestedPhases: ['execution']}
    }

    async plan(intent: PreprocessedIntent, options?: AskOptions): Promise<ExecutionPlan> {
        await this.onPhaseChange?.('plan', {intent})
        if (this.planner) return ExecutionPlanSchema.parse(await this.planner.plan(intent, this.getTools(), options))
        const catalog = this.getTools().map(t => `- ${t.name}: ${t.description}`).join('\n')
        const res = await this.asker.json(`Decompose this normalized goal into a concise, ordered plan of sequential or dependent sub-tasks.\nNormalized Goal: ${intent.normalizedGoal}\nConstraints: ${intent.constraints.join(', ') || 'None'}\nAvailable Tools:\n${catalog}\nOutput an ordered execution plan with step IDs and dependencies.`, ExecutionPlanSchema, {
            ...this.askOptions, ...options,
            system: 'You are a task planner. Create clean, atomic, minimal execution steps with step IDs (step_1, step_2).',
        })
        if (res.ok && res.data && res.data.steps.length > 0) return res.data
        if (this.verified) throw new Error(`Planning failed: ${res.failure?.message ?? 'No executable plan'}`)
        return {strategy: 'Direct execution', steps: [{id: 'step_1', description: intent.normalizedGoal, assignedTools: intent.relevantTools}]}
    }

    private validatePlan(plan: ExecutionPlan): void {
        if (plan.steps.length === 0) throw new Error('Plan contains no stages')
        const previous = new Set<string>()
        for (const step of plan.steps) {
            if (previous.has(step.id)) throw new Error(`Duplicate stage: ${step.id}`)
            for (const dependency of step.dependsOn ?? []) {
                if (!previous.has(dependency)) throw new Error(`Missing or out-of-order dependency ${dependency} for ${step.id}`)
            }
            for (const name of step.assignedTools) {
                if (!this.tools.has(name)) throw new Error(`Unregistered tool ${name} in ${step.id}`)
            }
            if (this.tools.size > 0 && step.assignedTools.length === 0)
                throw new Error(`Stage ${step.id} has no explicit tool scope`)
            previous.add(step.id)
        }
    }

    private abort<T>(intent: PreprocessedIntent, plan: ExecutionPlan, error: string,
        traces: Record<string, ActorStepRecord[]> = {}, outputs: Record<string, string> = {}, finalText = ''): PipelineRunResult<T> {
        if (this.throwOnError) throw new Error(error)
        return {ok: false, finalText, intent, plan, phaseTraces: traces, stepOutputs: outputs, error, verification: 'unverified'}
    }

    async run<T = unknown>(rawGoal: string, options: {
        schema?: ZodType<T>
        askOptions?: AskOptions
        signal?: AbortSignal
        onException?: PipelineExceptionHandler
        autoWisdom?: boolean
        maxStepRetries?: number
        throwOnError?: boolean
        stageValidator?: StageValidator
    } = {}): Promise<PipelineRunResult<T>> {
        const throwOnError = options.throwOnError ?? this.throwOnError
        const emptyIntent = {normalizedGoal: rawGoal, constraints: [], relevantTools: [], suggestedPhases: []}
        const emptyPlan = {strategy: 'not established', steps: []}
        let intent: PreprocessedIntent
        let plan: ExecutionPlan
        try {
            intent = await this.preprocess(rawGoal, options.askOptions)
            if (options.signal?.aborted) return this.abort(emptyIntent, emptyPlan, 'Execution aborted by signal.')
            plan = await this.plan(intent, options.askOptions)
            if (this.verified) this.validatePlan(plan)
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            if (throwOnError) throw error
            return this.abort(emptyIntent, emptyPlan, reason)
        }
        if (options.signal?.aborted) return this.abort(intent, plan, 'Execution aborted by signal.')
        await this.onPhaseChange?.('execute', {plan})
        const stepOutputs: Record<string, string> = {}
        const phaseTraces: Record<string, ActorStepRecord[]> = {}
        let partial = false

        for (const step of plan.steps) {
            if (options.signal?.aborted) return this.abort(intent, plan, 'Execution aborted by signal.', phaseTraces, stepOutputs)
            await this.onPhaseChange?.('step_start', {step})
            const prereqContext = (step.dependsOn ?? []).filter(id => stepOutputs[id]).map(id => `[Result of ${id}]: ${stepOutputs[id]}`).join('\n')
            const scoped = step.assignedTools.length > 0
                ? this.getTools().filter(tool => step.assignedTools.includes(tool.name))
                : this.getTools()
            const execute = async (wisdom = '', tools = scoped) => {
                const actor = new LLMActor(this.asker, {
                    tools,
                    maxSteps: this.maxStepsPerPhase,
                    askOptions: {...this.askOptions, ...options.askOptions},
                })
                const prompt = `${step.description}${prereqContext ? `\nPrerequisite Context:\n${prereqContext}` : ''}${wisdom ? `\nCorrective Guidance / Wisdom:\n${wisdom}` : ''}`
                return actor.run(prompt, {signal: options.signal})
            }
            let result = await execute()
            let attempts = 1
            const retries = options.maxStepRetries ?? this.maxStepRetries
            const validator = options.stageValidator ?? this.stageValidator
            const exceptionHandler = options.onException ?? this.onException
            let recovered = false
            while (true) {
                if (options.signal?.aborted) return this.abort(intent, plan, 'Execution aborted by signal.', phaseTraces, stepOutputs)
                const results = result.steps.flatMap(item => item.toolResults)
                const failedTools = this.verified ? results.some(item => item.isError) : results.length > 0 && results.every(item => item.isError)
                let error = result.error ?? (!result.ok || result.haltReason !== 'completed' ? `Execution halted (${result.haltReason})` : '')
                if (!error && failedTools) error = results.find(item => item.isError)?.error || 'Tool failed'
                if (!error && validator) {
                    try {
                        const decision = await validator({goal: rawGoal, step, intent, plan, result, stepOutputs})
                        if (!decision.ok) error = decision.reason
                    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure) }
                }
                if (!error) break
                const exception: PipelineStepException = {step, error, stepResult: result, stepOutputs, intent, plan, attempt: attempts}
                let resolution = await exceptionHandler?.(exception)
                if (!resolution && (options.autoWisdom ?? this.autoWisdom) && attempts <= retries) {
                    const critic = await this.asker.ask(`The agent failed to accomplish: ${step.description}\nError: ${error}\nGive one corrective tool-use instruction.`, {
                        ...this.askOptions, ...options.askOptions, system: 'Output only a concrete corrective instruction', temperature: 0.2,
                    })
                    if (critic.ok && critic.text) resolution = {action: 'retry', wisdom: critic.text.trim()}
                }
                if (!resolution || resolution.action === 'abort') {
                    phaseTraces[step.id] = result.steps
                    stepOutputs[step.id] = `Failed: ${error}`
                    const reason = resolution?.reason || `Step ${step.id} failed: ${error}`
                    if (throwOnError) throw new Error(reason)
                    return this.abort(intent, plan, reason, phaseTraces, stepOutputs)
                }
                if (resolution.action === 'skip' || resolution.action === 'continue') {
                    stepOutputs[step.id] = resolution.action === 'skip' ? 'Skipped by exception handler' : resolution.fallbackOutput
                    phaseTraces[step.id] = result.steps
                    if (this.verified) partial = true
                    recovered = true
                    break
                }
                attempts += 1
                if (attempts > retries + 1) {
                    const reason = `Step ${step.id} failed after ${attempts - 1} attempts: ${error}`
                    if (throwOnError) throw new Error(reason)
                    return this.abort(intent, plan, reason, phaseTraces, stepOutputs)
                }
                const retryTools = resolution.assignedTools?.length
                    ? this.getTools().filter(tool => resolution.assignedTools!.includes(tool.name))
                    : scoped
                if (this.verified && (retryTools.length === 0 && this.tools.size > 0 ||
                    resolution.assignedTools?.some(name => !step.assignedTools.includes(name)))) {
                    return this.abort(intent, plan, `Retry attempted to expand or lose tool scope in ${step.id}`, phaseTraces, stepOutputs)
                }
                result = await execute(resolution.wisdom ?? '', retryTools)
                phaseTraces[`${step.id}_retry_${attempts - 1}`] = result.steps
            }
            if (!recovered) {
                phaseTraces[step.id] = result.steps
                stepOutputs[step.id] = result.finalText || 'Completed'
            }
            await this.onPhaseChange?.('step_end', {step, result})
        }

        await this.onPhaseChange?.('verify', {stepOutputs})
        if (partial) return this.abort(intent, plan, 'One or more stages were skipped or replaced with unverified fallback output.', phaseTraces, stepOutputs)
        const prompt = `Original Goal: ${rawGoal}\nConstraints: ${intent.constraints.join(', ') || 'None'}\n\nExecution Trace and Results:\n${Object.entries(stepOutputs).map(([id, text]) => `### ${id}\n${text}`).join('\n\n')}\n\nSynthesize the final, verified response to the user's original goal, ensuring all requirements are fulfilled.`
        if (options.schema) {
            const answer = await this.asker.json(prompt, options.schema, {...this.askOptions, ...options.askOptions})
            if (!answer.ok && throwOnError) throw new Error(answer.failure?.message || 'Synthesis failed')
            return {ok: answer.ok, finalText: answer.text, output: answer.data, intent, plan, phaseTraces, stepOutputs,
                error: answer.failure?.message, verification: this.verified ? 'verified' : 'unverified'}
        }
        const answer = await this.asker.ask(prompt, {...this.askOptions, ...options.askOptions})
        if (!answer.ok && throwOnError) throw new Error(answer.failure?.message || 'Synthesis failed')
        return {ok: answer.ok, finalText: answer.text, intent, plan, phaseTraces, stepOutputs,
            error: answer.failure?.message, verification: this.verified ? 'verified' : 'unverified'}
    }
}
