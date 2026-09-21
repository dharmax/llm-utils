import type {PipelineTransitionContext, PlanStep} from './pipeline.ts'

/** A currently reachable stage, with enough context to choose it without parsing IDs. */
export type TransitionTarget = Pick<PlanStep, 'id' | 'description'>

/**
 * Return stages that a `goto` can enter now. A visit to an earlier or already
 * visited stage invalidates its results and every later result, so prerequisites
 * must have completed *before* the destination in the plan.
 *
 * `plan.steps` remains available on the callback for inspecting blocked stages.
 * This helper does not authorize tool execution or certify task completion.
 */
export function availableTransitionTargets(context: PipelineTransitionContext): TransitionTarget[] {
    const indices = new Map(context.plan.steps.map((step, index) => [step.id, index]))
    const latest = new Map(context.history.map(visit => [visit.stepId, visit.outcome]))
    return context.plan.steps.flatMap((step, index) => {
        const ready = (step.dependsOn ?? []).every(dependency => {
            const dependencyIndex = indices.get(dependency)
            return dependencyIndex !== undefined && dependencyIndex < index
                && latest.get(dependency) === 'completed'
                && Object.prototype.hasOwnProperty.call(context.stepOutputs, dependency)
        })
        return ready ? [{id: step.id, description: step.description}] : []
    })
}
