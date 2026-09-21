# Optional pipeline transitions

`LLMPipeline` remains linear by default. Set `onTransition` only for conditional stage scheduling. The callback runs after each resolved stage, including a stage skipped or substituted through `onException`; an unrecovered failure still aborts via the existing exception path.

The callback receives the **complete plan** (IDs, descriptions, tool assignments, and dependencies). For a ready-to-use list of currently valid destinations, use `availableTransitionTargets(context)`: it returns `{id, description}[]` and excludes stages with unsatisfied prerequisites, including those invalidated by a backward jump. The original `plan.steps` remains available when explaining why a stage is blocked. The pipeline independently validates every `goto`; the helper is for discovery, not authorization.

```ts
import {LLMPipeline, availableTransitionTargets} from '@dharmax/llm-utils'

const pipeline = new LLMPipeline(asker, {
  tools,
  onException: recoverUnexpectedFailure,
  maxStageExecutions: 20,
  onTransition: context => {
    const {step, result, history, outcome} = context
    const targets = availableTransitionTargets(context)
    const goto = (id: string) => {
      if (!targets.some(target => target.id === id))
        return {action: 'abort' as const, reason: `Stage ${id} is not reachable`}
      return {action: 'goto' as const, stepId: id}
    }
    if (outcome !== 'completed')
      return {action: 'abort', reason: 'Required inspection did not complete'}

    switch (step.id) {
      case 'inspect':
        if (!observedRequiredData(result))
          return {action: 'retry', wisdom: 'Gather the missing observations'}
        switch (classifyObservedPressure(result)) {
          case 'memory': return goto('inspect_memory')
          case 'cpu': return goto('inspect_cpu')
          default: return goto('collect_more')
        }
      case 'inspect_memory':
      case 'inspect_cpu':
      case 'collect_more':
        return goto('report')
      case 'report':
        if (!taskRequirementsSatisfied(history))
          return {action: 'abort', reason: 'Required observations are missing'}
        return {action: 'next'}
    }
  },
})
```

## Execution semantics

A `while` loop owns an explicit cursor; a `switch` is its sole transition mechanism. `next` (or `undefined` after success) increments the cursor, `goto` assigns the validated destination index, `retry` leaves the cursor unchanged and optionally supplies wisdom, and `abort` stops execution. There is no automatic increment, `i--`, `target - 1`, generated JavaScript, or second workflow engine. Without `onTransition`, the existing linear happy path and `onException` API remain supported.

The callback receives the original goal, the actor's full result (including tool observations), the actual outcome, chronological execution history, current outputs, intent and plan. `stepOutputs` and `phaseTraces` retain the latest execution for each stage; `executionHistory` retains every visit, including invalidated loop iterations. An actor receives declared dependency outputs and the last still-valid stage's summary.

In transition mode, IDs and dependencies must exist; destinations must satisfy prerequisites; revisiting a stage invalidates its previous results and downstream outputs. A bounded stage-execution budget prevents infinite loops, and retries have a separate bound. An unresolved skipped or substituted stage cannot yield successful synthesis—even if the callback explicitly advances. An apparent `final_answer` without observations can be rejected with `retry`.

**Limits:** transitions choose only among already planned stages. They do not authorize tools, amend user requirements, establish that every original requirement was met, or make repeated side effects safe. The calling application must enforce those policies; branch joins should declare prerequisites common to every incoming path.
