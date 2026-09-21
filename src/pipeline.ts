import {z, type ZodType} from 'zod'
import {LLMActor, type ActorRunResult, type ActorStepRecord, type ToolDefinition} from './actor.ts'
import type {Asker} from './asker.ts'
import type {AskOptions} from './types.ts'

/** Phase 1: Preprocessed user intent and extracted constraints. */
export interface PreprocessedIntent {
    normalizedGoal: string
    domain?: string
    constraints: string[]
    relevantTools: string[]
    suggestedPhases: string[]
}

export const PreprocessedIntentSchema = z.object({
    normalizedGoal: z.string().describe('Clear, unambiguous restatement of the user goal'),
    domain: z.string().optional().describe('Problem domain (e.g. filesystem, math, api, system)'),
    constraints: z.array(z.string()).default([]).describe('List of explicit constraints and requirements'),
    relevantTools: z.array(z.string()).default([]).describe('Names of tools likely needed for this goal'),
    suggestedPhases: z.array(z.string()).default([]).describe('Logical stages required to complete the task'),
})

/** Phase 2: Planned step with dependencies. */
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
    strategy: z.string().describe('High-level architectural approach to accomplish the goal'),
    steps: z.array(z.object({
        id: z.string().describe('Unique step identifier (e.g. step_1, step_2)'),
        description: z.string().describe('Specific, actionable sub-task to execute'),
        assignedTools: z.array(z.string()).default([]).describe('Tool names to use in this step'),
        dependsOn: z.array(z.string()).optional().describe('Step IDs that must complete before this step'),
    })).describe('Ordered list of steps to execute'),
})

/** Service Adapter interfaces for pluggability. */
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

/** Existing exception handler remains unchanged. */
export type PipelineExceptionResolution =
    | {action: 'retry'; wisdom?: string; assignedTools?: string[]}
    | {action: 'continue'; fallbackOutput: string}
    | {action: 'skip'}
    | {action: 'abort'; reason?: string}

export type PipelineExceptionHandler = (
    exception: PipelineStepException,
) => Promise<PipelineExceptionResolution | void> | PipelineExceptionResolution | void

/** Actual stage executions, including repeated visits; unlike stepOutputs, this is chronological. */
export interface StageExecution {
    stepId: string
    result: ActorRunResult
    output: string
    outcome: 'completed' | 'skipped' | 'continued'
}

/** Only the host's callback chooses branches. These decisions never confer tool permissions. */
export type PipelineTransition =
    | {action: 'next'}
    | {action: 'goto'; stepId: string}
    | {action: 'retry'; wisdom?: string}
    | {action: 'abort'; reason?: string}

export interface PipelineTransitionContext {
    step: PlanStep
    result: ActorRunResult
    /** This stage's actual outcome, not merely the actor's text. */
    outcome: StageExecution['outcome']
    history: ReadonlyArray<Readonly<StageExecution>>
    stepOutputs: Readonly<Record<string, string>>
    intent: PreprocessedIntent
    plan: ExecutionPlan
}

export type PipelineTransitionHandler = (
    context: PipelineTransitionContext,
) => PipelineTransition | void | Promise<PipelineTransition | void>

export interface PipelineRunResult<T = unknown> {
    ok: boolean
    finalText: string
    output?: T
    intent: PreprocessedIntent
    plan: ExecutionPlan
    phaseTraces: Record<string, ActorStepRecord[]>
    stepOutputs: Record<string, string>
    error?: string
    /** Present when conditional execution is enabled. */
    executionHistory?: StageExecution[]
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
    /** Optional. With no callback the original sequential behavior is retained. */
    onTransition?: PipelineTransitionHandler
    /** Total stage visits (including loops and transition retries) when onTransition is used. */
    maxStageExecutions?: number
}

/** Preprocess -> Plan -> Scoped LLMActors -> Synthesize; optional conditional transitions. */
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
    private readonly onTransition?: PipelineTransitionHandler
    private readonly maxStageExecutions?: number

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
        this.onTransition = options.onTransition
        this.maxStageExecutions = options.maxStageExecutions
        for (const tool of options.tools ?? []) this.tools.set(tool.name, tool)
    }

    registerTool(tool: ToolDefinition): this {
        this.tools.set(tool.name, tool)
        return this
    }

    getTools(): ToolDefinition[] {
        return [...this.tools.values()]
    }

    async preprocess(goal: string, options?: AskOptions): Promise<PreprocessedIntent> {
        await this.onPhaseChange?.('preprocess', {goal})
        if (this.preprocessor) return this.preprocessor.preprocess(goal, this.getTools(), options)

        const toolCatalog = [...this.tools.values()].map(t => `- ${t.name}: ${t.description}`).join('\n')
        const prompt = `Analyze this user goal and extract clear operational constraints and tool requirements.

Available Tools:
${toolCatalog || 'None'}

Goal:
${goal}`
        const res = await this.asker.json(prompt, PreprocessedIntentSchema, {
            ...this.askOptions,
            ...options,
            system: 'You are an intent preprocessor. Clarify goals, extract constraints, and determine needed tools.',
        })
        if (res.ok && res.data) return res.data
        return {normalizedGoal: goal, constraints: [], relevantTools: [...this.tools.keys()], suggestedPhases: ['execution']}
    }

    async plan(intent: PreprocessedIntent, options?: AskOptions): Promise<ExecutionPlan> {
        await this.onPhaseChange?.('plan', {intent})
        if (this.planner) return this.planner.plan(intent, this.getTools(), options)

        const toolCatalog = [...this.tools.values()].map(t => `- ${t.name}: ${t.description}`).join('\n')
        const prompt = `Decompose this normalized goal into a concise, ordered plan of sequential or dependent sub-tasks.

Normalized Goal: ${intent.normalizedGoal}
Constraints: ${intent.constraints.join(', ') || 'None'}
Available Tools:
${toolCatalog}

Output an ordered execution plan with step IDs and dependencies.`
        const res = await this.asker.json(prompt, ExecutionPlanSchema, {
            ...this.askOptions,
            ...options,
            system: 'You are a task planner. Create clean, atomic, minimal execution steps with step IDs (step_1, step_2).',
        })
        if (res.ok && res.data && res.data.steps.length > 0) return res.data
        return {strategy: 'Direct execution', steps: [{id: 'step_1', description: intent.normalizedGoal, assignedTools: intent.relevantTools}]}
    }

    async run<T = unknown>(rawGoal: string, options: {
        schema?: ZodType<T>
        askOptions?: AskOptions
        signal?: AbortSignal
        onException?: PipelineExceptionHandler
        autoWisdom?: boolean
        maxStepRetries?: number
        throwOnError?: boolean
        onTransition?: PipelineTransitionHandler
        maxStageExecutions?: number
    } = {}): Promise<PipelineRunResult<T>> {
        const throwOnError = options.throwOnError ?? this.throwOnError
        const intent = await this.preprocess(rawGoal, options.askOptions)
        if (options.signal?.aborted) return this.makeAbortResult(intent, {strategy: 'aborted', steps: []})
        const plan = await this.plan(intent, options.askOptions)
        if (options.signal?.aborted) return this.makeAbortResult(intent, plan)

        const transition = options.onTransition ?? this.onTransition
        const budget = options.maxStageExecutions ?? this.maxStageExecutions ?? Math.max(16, plan.steps.length * 4)
        const stepIndices = transition ? new Map(plan.steps.map((step, index) => [step.id, index])) : undefined
        const stepOutputs: Record<string, string> = {}
        const phaseTraces: Record<string, ActorStepRecord[]> = {}
        const history: StageExecution[] = []
        const completed = new Set<string>()
        let executions = 0
        let transitionRetries = 0
        let retryWisdom = ''
        const fail = (reason: string): PipelineRunResult<T> => {
            if (throwOnError) throw new Error(reason)
            return {ok: false, finalText: '', intent, plan, phaseTraces, stepOutputs,
                executionHistory: transition ? [...history] : undefined, error: reason}
        }

        if (transition) {
            if (!Number.isSafeInteger(budget) || budget < 1) return fail('maxStageExecutions must be a positive integer')
            if (!plan.steps.length) return fail('Branching plan contains no stages')
            if (stepIndices!.size !== plan.steps.length) return fail('Branching plan contains duplicate stage IDs')
        }
        await this.onPhaseChange?.('execute', {plan})

        // The index changes only on an explicit callback transition; increment remains native to for.
        for (let i = 0; i < plan.steps.length; i++) {
            if (options.signal?.aborted) return this.makeAbortResult(intent, plan, phaseTraces, stepOutputs)
            const step = plan.steps[i]!
            if (transition) {
                if (++executions > budget) return fail(`Stage execution budget exceeded (${budget})`)
                const missing = (step.dependsOn ?? []).filter(id => !completed.has(id))
                if (missing.length) return fail(`Stage ${step.id} has unsatisfied dependencies: ${missing.join(', ')}`)
            }
            await this.onPhaseChange?.('step_start', {step})

            let prereqContext = ''
            if (step.dependsOn?.length) {
                const deps = step.dependsOn.filter(id => stepOutputs[id])
                    .map(id => `[Result of ${id}]: ${stepOutputs[id]}`).join('\n')
                if (deps) prereqContext = `\nPrerequisite Context:\n${deps}\n`
            }
            // A backward jump invalidates completed results; never inject stale previous-stage context.
            const previous = transition ? history.at(-1) : undefined
            if (previous?.outcome === 'completed' && completed.has(previous.stepId) &&
                !(step.dependsOn ?? []).includes(previous.stepId))
                prereqContext += `\nPrevious Stage (${previous.stepId}): ${previous.output}\n`

            const scopedTools = step.assignedTools.length > 0
                ? [...this.tools.values()].filter(t => step.assignedTools.includes(t.name))
                : [...this.tools.values()]
            if (step.assignedTools.some(name => !this.tools.has(name)))
                return fail(`Stage ${step.id} refers to unavailable tools`)
            const makeActor = (tools: ToolDefinition[]) => new LLMActor(this.asker, {
                tools, maxSteps: this.maxStepsPerPhase,
                askOptions: {...this.askOptions, ...options.askOptions},
            })
            let stepResult = await makeActor(scopedTools).run(
                `${step.description}${prereqContext}${retryWisdom ? `\nCorrective Guidance / Wisdom:\n${retryWisdom}\n` : ''}`,
                {signal: options.signal},
            )
            retryWisdom = ''
            let attempts = 1
            const maxRetries = options.maxStepRetries ?? this.maxStepRetries
            const exceptionHandler = options.onException ?? this.onException
            const autoWisdom = options.autoWisdom ?? this.autoWisdom
            let outcome: StageExecution['outcome'] = 'completed'

            const isStepException = (res: ActorRunResult) => {
                if (!res.ok || res.haltReason !== 'completed') return true
                const toolResults = res.steps.flatMap(s => s.toolResults)
                return toolResults.length > 0 && toolResults.every(r => r.isError)
            }
            const getStepError = (res: ActorRunResult) => {
                if (res.error) return res.error
                const toolResults = res.steps.flatMap(s => s.toolResults)
                return toolResults.findLast(r => r.isError)?.error || `Execution halted (${res.haltReason})`
            }

            while (isStepException(stepResult)) {
                if (options.signal?.aborted) return this.makeAbortResult(intent, plan, phaseTraces, stepOutputs)
                const stepError = getStepError(stepResult)
                const exception: PipelineStepException = {
                    step, error: stepError, stepResult, stepOutputs, intent, plan, attempt: attempts,
                }
                let resolution: PipelineExceptionResolution | undefined
                if (exceptionHandler) {
                    const resolved = await exceptionHandler(exception)
                    if (resolved) resolution = resolved
                } else if (autoWisdom && attempts <= maxRetries) {
                    const lastStep = stepResult.steps[stepResult.steps.length - 1]
                    const criticPrompt = `The agent encountered a failure while executing this sub-goal:
Goal: ${step.description}
Prerequisites: ${prereqContext || 'None'}
Error: ${stepError}
Last Observation: ${JSON.stringify(lastStep?.toolResults ?? {})}

Provide a single concise corrective instruction ("wisdom") for how to format parameters or call tools correctly on retry.`
                    const critic = await this.asker.ask(criticPrompt, {
                        ...this.askOptions, ...options.askOptions,
                        system: 'You are an execution critic. Output only the concrete corrective instruction.',
                        temperature: 0.2,
                    })
                    if (critic.ok && critic.text) resolution = {action: 'retry', wisdom: critic.text.trim()}
                }
                if (!resolution || resolution.action === 'abort') {
                    const errorMsg = resolution?.reason || `Step ${step.id} failed: ${stepError}`
                    phaseTraces[step.id] = stepResult.steps
                    stepOutputs[step.id] = `Failed: ${errorMsg}`
                    if (throwOnError) throw new Error(errorMsg)
                    return {ok: false, finalText: stepResult.finalText, intent, plan,
                        phaseTraces, stepOutputs, error: errorMsg,
                        executionHistory: transition ? [...history] : undefined}
                }
                if (resolution.action === 'skip') {
                    stepOutputs[step.id] = 'Skipped by exception handler'
                    phaseTraces[step.id] = stepResult.steps
                    outcome = 'skipped'
                    break
                }
                if (resolution.action === 'continue') {
                    stepOutputs[step.id] = resolution.fallbackOutput
                    phaseTraces[step.id] = stepResult.steps
                    outcome = 'continued'
                    break
                }
                if (resolution.action === 'retry') {
                    attempts += 1
                    if (attempts > maxRetries + 1) return fail(`Step ${step.id} failed after ${attempts - 1} retry attempts: ${stepError}`)
                    const correctiveContext = resolution.wisdom
                        ? `\nCorrective Guidance / Wisdom:\n${resolution.wisdom}\n` : ''
                    const retryTools = resolution.assignedTools?.length
                        ? [...this.tools.values()].filter(t => resolution.assignedTools!.includes(t.name))
                        : scopedTools
                    if (resolution.assignedTools?.some(name => !this.tools.has(name)))
                        return fail(`Retry for ${step.id} refers to unavailable tools`)
                    stepResult = await makeActor(retryTools).run(`${step.description}${prereqContext}${correctiveContext}`, {signal: options.signal})
                    phaseTraces[`${step.id}_retry_${attempts - 1}`] = stepResult.steps
                }
            }

            if (outcome === 'completed' && !isStepException(stepResult)) {
                phaseTraces[step.id] = stepResult.steps
                stepOutputs[step.id] = stepResult.finalText || 'Completed'
                completed.add(step.id)
            }
            if (transition) history.push({stepId: step.id, result: stepResult,
                output: stepOutputs[step.id] ?? '', outcome})
            await this.onPhaseChange?.('step_end', {step, result: stepResult})

            if (!transition) continue
            if (options.signal?.aborted) return this.makeAbortResult(intent, plan, phaseTraces, stepOutputs)
            let decision: PipelineTransition | void
            try {
                decision = await transition({step, result: stepResult, outcome,
                    history: history.slice(), stepOutputs: {...stepOutputs}, intent, plan})
            } catch (error) {
                return fail(`Transition callback failed: ${error instanceof Error ? error.message : String(error)}`)
            }
            // Substituted or skipped work requires an explicit host decision to proceed.
            if (outcome !== 'completed' && !decision)
                return fail(`Transition must explicitly resolve ${outcome} stage ${step.id}`)
            switch (decision?.action) {
                case undefined:
                case 'next':
                    transitionRetries = 0
                    break
                case 'abort':
                    return fail(decision.reason || `Transition aborted after ${step.id}`)
                case 'retry':
                    if (++transitionRetries > maxRetries) return fail(`Transition retries exhausted for ${step.id}`)
                    delete stepOutputs[step.id]
                    completed.delete(step.id)
                    retryWisdom = decision.wisdom ?? ''
                    i--
                    break
                case 'goto': {
                    transitionRetries = 0
                    const target = stepIndices!.get(decision.stepId)
                    if (target === undefined) return fail(`Unknown transition target: ${decision.stepId}`)
                    if (target <= i) {
                        // Each loop iteration starts fresh from its target; history retains earlier observations.
                        for (let j = target; j < plan.steps.length; j++) {
                            delete stepOutputs[plan.steps[j]!.id]
                            completed.delete(plan.steps[j]!.id)
                        }
                    }
                    const missing = (plan.steps[target]!.dependsOn ?? []).filter(id => !completed.has(id))
                    if (missing.length) return fail(`Transition to ${decision.stepId} has unsatisfied dependencies: ${missing.join(', ')}`)
                    i = target - 1 // for increments to exactly target
                    break
                }
                default:
                    return fail(`Invalid transition decision after ${step.id}`)
            }
        }

        await this.onPhaseChange?.('verify', {stepOutputs})
        const synthesisPrompt = `Original Goal: ${rawGoal}
Constraints: ${intent.constraints.join(', ') || 'None'}

Execution Trace and Results:
${Object.entries(stepOutputs).map(([id, text]) => `### ${id}\n${text}`).join('\n\n')}

Synthesize the final, verified response to the user's original goal, ensuring all requirements are fulfilled.`
        if (options.schema) {
            const finalJson = await this.asker.json(synthesisPrompt, options.schema, {
                ...this.askOptions, ...options.askOptions,
            })
            if (throwOnError && !finalJson.ok) throw new Error(finalJson.failure?.message || 'Pipeline synthesis failed schema validation')
            return {ok: finalJson.ok, finalText: finalJson.text, output: finalJson.data,
                intent, plan, phaseTraces, stepOutputs, error: finalJson.failure?.message,
                executionHistory: transition ? [...history] : undefined}
        }
        const finalAsk = await this.asker.ask(synthesisPrompt, {...this.askOptions, ...options.askOptions})
        if (throwOnError && !finalAsk.ok) throw new Error(finalAsk.failure?.message || 'Pipeline synthesis failed')
        return {ok: finalAsk.ok, finalText: finalAsk.text, intent, plan, phaseTraces,
            stepOutputs, error: finalAsk.failure?.message,
            executionHistory: transition ? [...history] : undefined}
    }

    private makeAbortResult<T>(intent: PreprocessedIntent, plan: ExecutionPlan,
        phaseTraces: Record<string, ActorStepRecord[]> = {},
        stepOutputs: Record<string, string> = {}): PipelineRunResult<T> {
        return {ok: false, finalText: '', intent, plan, phaseTraces, stepOutputs,
            error: 'Pipeline execution aborted by signal.'}
    }
}
