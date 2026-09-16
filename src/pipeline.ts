import {z, type ZodType} from 'zod'
import {LLMActor, type ActorRunResult, type ActorStepRecord, type ToolDefinition} from './actor.ts'
import type {Asker} from './asker.ts'
import type {AskOptions} from './types.ts'

/**
 * Phase 1: Preprocessed user intent and extracted constraints.
 */
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

/**
 * Phase 2: Planned step with dependencies.
 */
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

/**
 * Service Adapter interfaces for pluggability (e.g. from @dharmax/text-compiler or custom heuristics).
 */
export interface IntentPreprocessorAdapter {
    preprocess(goal: string, tools: ToolDefinition[], options?: AskOptions): Promise<PreprocessedIntent>
}

export interface TaskPlannerAdapter {
    plan(intent: PreprocessedIntent, tools: ToolDefinition[], options?: AskOptions): Promise<ExecutionPlan>
}

/**
 * Exception context passed when a pipeline step fails.
 */
export interface PipelineStepException {
    step: PlanStep
    error: string
    stepResult: ActorRunResult
    stepOutputs: Record<string, string>
    intent: PreprocessedIntent
    plan: ExecutionPlan
    attempt: number
}

/**
 * Resolution returned by an exception handler callback to inject wisdom or steer execution.
 */
export type PipelineExceptionResolution =
    | {
          action: 'retry'
          /** Optional corrective guidance / wisdom injected into the step prompt */
          wisdom?: string
          /** Optional tool overrides for the retry */
          assignedTools?: string[]
      }
    | {
          action: 'continue'
          /** Fallback output recorded as step result */
          fallbackOutput: string
      }
    | {
          action: 'skip'
      }
    | {
          action: 'abort'
          /** Optional reason explaining the abort */
          reason?: string
      }

export type PipelineExceptionHandler = (
    exception: PipelineStepException,
) => Promise<PipelineExceptionResolution | void> | PipelineExceptionResolution | void

/**
 * Result of multi-phase pipeline execution.
 */
export interface PipelineRunResult<T = unknown> {
    ok: boolean
    finalText: string
    output?: T
    intent: PreprocessedIntent
    plan: ExecutionPlan
    phaseTraces: Record<string, ActorStepRecord[]>
    stepOutputs: Record<string, string>
    error?: string
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
}

/**
 * Multi-Phase Agent Pipeline:
 * Phase 1: Intent Preprocessing & Constraint Extraction
 * Phase 2: Task Decomposition & Dependency Planning
 * Phase 3: Phased Tool Execution (with Dependency Memory)
 * Phase 4: Constraint Verification & Final Synthesis
 */
export class LLMPipeline {
    private readonly tools = new Map<string, ToolDefinition>()
    private readonly maxStepsPerPhase: number
    private readonly askOptions?: AskOptions
    private readonly preprocessor?: IntentPreprocessorAdapter
    private readonly planner?: TaskPlannerAdapter
    private readonly onPhaseChange?: (phase: string, data?: unknown) => void | Promise<void>
    private readonly onException?: PipelineExceptionHandler
    private readonly autoWisdom: boolean
    private readonly maxStepRetries: number
    private readonly throwOnError: boolean

    constructor(
        private readonly asker: Asker,
        options: PipelineOptions = {},
    ) {
        this.maxStepsPerPhase = options.maxStepsPerPhase ?? 4
        this.askOptions = options.askOptions
        this.preprocessor = options.preprocessor
        this.planner = options.planner
        this.onPhaseChange = options.onPhaseChange
        this.onException = options.onException
        this.autoWisdom = Boolean(options.autoWisdom)
        this.maxStepRetries = options.maxStepRetries ?? 2
        this.throwOnError = Boolean(options.throwOnError)

        for (const tool of options.tools ?? [])
            this.tools.set(tool.name, tool)
    }

    registerTool(tool: ToolDefinition): this {
        this.tools.set(tool.name, tool)
        return this
    }

    getTools(): ToolDefinition[] {
        return [...this.tools.values()]
    }

    /**
     * Phase 1: Preprocess raw intent and extract explicit constraints.
     */
    async preprocess(goal: string, options?: AskOptions): Promise<PreprocessedIntent> {
        await this.onPhaseChange?.('preprocess', {goal})

        if (this.preprocessor) {
            return this.preprocessor.preprocess(goal, this.getTools(), options)
        }

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

        if (res.ok && res.data)
            return res.data

        return {
            normalizedGoal: goal,
            constraints: [],
            relevantTools: [...this.tools.keys()],
            suggestedPhases: ['execution'],
        }
    }

    /**
     * Phase 2: Decompose goal into an ordered execution plan with dependencies.
     */
    async plan(intent: PreprocessedIntent, options?: AskOptions): Promise<ExecutionPlan> {
        await this.onPhaseChange?.('plan', {intent})

        if (this.planner) {
            return this.planner.plan(intent, this.getTools(), options)
        }

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

        if (res.ok && res.data && res.data.steps.length > 0)
            return res.data

        return {
            strategy: 'Direct execution',
            steps: [{
                id: 'step_1',
                description: intent.normalizedGoal,
                assignedTools: intent.relevantTools,
            }],
        }
    }

    /**
     * Complete multi-phase execution loop.
     */
    async run<T = unknown>(
        rawGoal: string,
        options: {
            schema?: ZodType<T>
            askOptions?: AskOptions
            signal?: AbortSignal
            onException?: PipelineExceptionHandler
            autoWisdom?: boolean
            maxStepRetries?: number
            throwOnError?: boolean
        } = {},
    ): Promise<PipelineRunResult<T>> {
        const throwOnError = options.throwOnError ?? this.throwOnError

        // 1. Preprocess
        const intent = await this.preprocess(rawGoal, options.askOptions)
        if (options.signal?.aborted) {
            return this.makeAbortResult(intent, {strategy: 'aborted', steps: []})
        }

        // 2. Plan
        const plan = await this.plan(intent, options.askOptions)
        if (options.signal?.aborted) {
            return this.makeAbortResult(intent, plan)
        }

        // 3. Phased Execution (Happy Path with Exception Wisdom)
        await this.onPhaseChange?.('execute', {plan})
        const stepOutputs: Record<string, string> = {}
        const phaseTraces: Record<string, ActorStepRecord[]> = {}

        for (const step of plan.steps) {
            if (options.signal?.aborted) {
                return this.makeAbortResult(intent, plan, phaseTraces, stepOutputs)
            }

            await this.onPhaseChange?.('step_start', {step})

            // Gather dependencies data
            let prereqContext = ''
            if (step.dependsOn && step.dependsOn.length > 0) {
                const deps = step.dependsOn
                    .filter(id => stepOutputs[id])
                    .map(id => `[Result of ${id}]: ${stepOutputs[id]}`)
                    .join('\n')
                if (deps) prereqContext = `\nPrerequisite Context:\n${deps}\n`
            }

            // Equip scoped tools (or all tools if none assigned)
            const scopedTools = step.assignedTools.length > 0
                ? [...this.tools.values()].filter(t => step.assignedTools.includes(t.name))
                : [...this.tools.values()]

            const actor = new LLMActor(this.asker, {
                tools: scopedTools.length > 0 ? scopedTools : [...this.tools.values()],
                maxSteps: this.maxStepsPerPhase,
                askOptions: {
                    ...this.askOptions,
                    ...options.askOptions,
                },
            })

            const subGoal = `${step.description}${prereqContext}`
            let stepResult = await actor.run(subGoal, {
                signal: options.signal,
            })

            let attempts = 1
            const maxRetries = options.maxStepRetries ?? this.maxStepRetries
            const exceptionHandler = options.onException ?? this.onException
            const autoWisdom = options.autoWisdom ?? this.autoWisdom

            const isStepException = (res: ActorRunResult) => {
                if (!res.ok || res.haltReason !== 'completed') return true
                const toolResults = res.steps.flatMap(s => s.toolResults)
                if (toolResults.length > 0 && toolResults.every(r => r.isError)) return true
                return false
            }

            const getStepError = (res: ActorRunResult) => {
                if (res.error) return res.error
                const toolResults = res.steps.flatMap(s => s.toolResults)
                const lastError = toolResults.findLast(r => r.isError)?.error
                return lastError || `Execution halted (${res.haltReason})`
            }

            // When reality diverges: Handle Exception with Wisdom Callback
            while (isStepException(stepResult)) {
                const stepError = getStepError(stepResult)
                const exception: PipelineStepException = {
                    step,
                    error: stepError,
                    stepResult,
                    stepOutputs,
                    intent,
                    plan,
                    attempt: attempts,
                }

                let resolution: PipelineExceptionResolution | undefined

                if (exceptionHandler) {
                    const resolved = await exceptionHandler(exception)
                    if (resolved) resolution = resolved
                } else if (autoWisdom && attempts <= maxRetries) {
                    // Auto-critic generates corrective wisdom
                    const lastStep = stepResult.steps[stepResult.steps.length - 1]
                    const criticPrompt = `The agent encountered a failure while executing this sub-goal:
Goal: ${step.description}
Prerequisites: ${prereqContext || 'None'}
Error: ${stepError}
Last Observation: ${JSON.stringify(lastStep?.toolResults ?? {})}

Provide a single concise corrective instruction ("wisdom") for how to format parameters or call tools correctly on retry.`
                    const critic = await this.asker.ask(criticPrompt, {
                        ...this.askOptions,
                        ...options.askOptions,
                        system: 'You are an execution critic. Output only the concrete corrective instruction.',
                        temperature: 0.2,
                    })
                    if (critic.ok && critic.text) {
                        resolution = {action: 'retry', wisdom: critic.text.trim()}
                    }
                }

                // If no wisdom provided or explicit abort, terminate with clear explanation
                if (!resolution || resolution.action === 'abort') {
                    const errorMsg = resolution?.reason || `Step ${step.id} failed: ${stepResult.error}`
                    phaseTraces[step.id] = stepResult.steps
                    stepOutputs[step.id] = `Failed: ${errorMsg}`
                    if (throwOnError) {
                        throw new Error(errorMsg)
                    }
                    return {
                        ok: false,
                        finalText: stepResult.finalText,
                        intent,
                        plan,
                        phaseTraces,
                        stepOutputs,
                        error: errorMsg,
                    }
                }

                if (resolution.action === 'skip') {
                    stepOutputs[step.id] = 'Skipped by exception handler'
                    phaseTraces[step.id] = stepResult.steps
                    break
                }

                if (resolution.action === 'continue') {
                    stepOutputs[step.id] = resolution.fallbackOutput
                    phaseTraces[step.id] = stepResult.steps
                    break
                }

                if (resolution.action === 'retry') {
                    attempts += 1
                    if (attempts > maxRetries + 1) {
                        const errorMsg = `Step ${step.id} failed after ${attempts - 1} retry attempts: ${stepResult.error}`
                        phaseTraces[step.id] = stepResult.steps
                        stepOutputs[step.id] = `Failed: ${errorMsg}`
                        if (throwOnError) {
                            throw new Error(errorMsg)
                        }
                        return {
                            ok: false,
                            finalText: stepResult.finalText,
                            intent,
                            plan,
                            phaseTraces,
                            stepOutputs,
                            error: errorMsg,
                        }
                    }

                    const correctiveContext = resolution.wisdom
                        ? `\nCorrective Guidance / Wisdom:\n${resolution.wisdom}\n`
                        : ''
                    const retryGoal = `${step.description}${prereqContext}${correctiveContext}`

                    const retryTools = resolution.assignedTools && resolution.assignedTools.length > 0
                        ? [...this.tools.values()].filter(t => resolution.assignedTools!.includes(t.name))
                        : scopedTools

                    const retryActor = new LLMActor(this.asker, {
                        tools: retryTools.length > 0 ? retryTools : [...this.tools.values()],
                        maxSteps: this.maxStepsPerPhase,
                        askOptions: {
                            ...this.askOptions,
                            ...options.askOptions,
                        },
                    })

                    stepResult = await retryActor.run(retryGoal, {signal: options.signal})
                    phaseTraces[`${step.id}_retry_${attempts - 1}`] = stepResult.steps
                }
            }

            if (!isStepException(stepResult)) {
                phaseTraces[step.id] = stepResult.steps
                stepOutputs[step.id] = stepResult.finalText || 'Completed'
            }

            await this.onPhaseChange?.('step_end', {step, result: stepResult})
        }

        // 4. Synthesis & Verification
        await this.onPhaseChange?.('verify', {stepOutputs})
        const synthesisPrompt = `Original Goal: ${rawGoal}
Constraints: ${intent.constraints.join(', ') || 'None'}

Execution Trace and Results:
${Object.entries(stepOutputs).map(([id, text]) => `### ${id}\n${text}`).join('\n\n')}

Synthesize the final, verified response to the user's original goal, ensuring all requirements are fulfilled.`

        if (options.schema) {
            const finalJson = await this.asker.json(synthesisPrompt, options.schema, {
                ...this.askOptions,
                ...options.askOptions,
            })
            if (throwOnError && !finalJson.ok) {
                throw new Error(finalJson.failure?.message || 'Pipeline synthesis failed schema validation')
            }
            return {
                ok: finalJson.ok,
                finalText: finalJson.text,
                output: finalJson.data,
                intent,
                plan,
                phaseTraces,
                stepOutputs,
                error: finalJson.failure?.message,
            }
        }

        const finalAsk = await this.asker.ask(synthesisPrompt, {
            ...this.askOptions,
            ...options.askOptions,
        })

        if (throwOnError && !finalAsk.ok) {
            throw new Error(finalAsk.failure?.message || 'Pipeline synthesis failed')
        }

        return {
            ok: finalAsk.ok,
            finalText: finalAsk.text,
            intent,
            plan,
            phaseTraces,
            stepOutputs,
            error: finalAsk.failure?.message,
        }
    }

    private makeAbortResult<T>(
        intent: PreprocessedIntent,
        plan: ExecutionPlan,
        phaseTraces: Record<string, ActorStepRecord[]> = {},
        stepOutputs: Record<string, string> = {},
    ): PipelineRunResult<T> {
        return {
            ok: false,
            finalText: '',
            intent,
            plan,
            phaseTraces,
            stepOutputs,
            error: 'Pipeline execution aborted by signal.',
        }
    }
}
