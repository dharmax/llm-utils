# Optional pipeline transitions

`LLMPipeline` remains linear by default. Set `onTransition` only when a task needs conditional stage scheduling. Its callback runs **after a successfully resolved stage**; ordinary tool/actor failures still use the existing `onException` callback.

```ts
const pipeline = new LLMPipeline(asker, {
  tools,
  onException: recoverUnexpectedFailure,
  maxStageExecutions: 20,
  onTransition: ({step, result, history}) => {
    // Interpret real tool observations, not the actor's final prose alone.
    switch (step.id) {
      case 'inspect':
        switch (classifyObservedPressure(result)) {
          case 'memory': return {action: 'goto', stepId: 'inspect_memory'}
          case 'cpu': return {action: 'goto', stepId: 'inspect_cpu'}
          default: return {action: 'goto', stepId: 'collect_more'}
        }
      case 'inspect_memory':
      case 'inspect_cpu':
      case 'collect_more':
        return {action: 'goto', stepId: 'report'}
      case 'report':
        if (!taskRequirementsSatisfied(history))
          return {action: 'abort', reason: 'Required observations are missing'}
        return {action: 'next'}
    }
  },
})
```

The transition decision is `next` (or `undefined`, preserving the sequential default), `goto` (an existing stage ID), `retry` (current stage, optionally with corrective wisdom) or `abort`. A conventional indexed `for` loop and a `switch` perform scheduling. There is no generated code or separate state-machine runtime.

The optional callback sees the actor's complete `result` (including tool observations), chronological `history` (preserved across loops), the current output snapshot, intent and plan. The normal `stepOutputs` and `phaseTraces` remain compatible but contain the latest execution for a repeated step. The next actor sees its declared dependency outputs and, in transition mode, the immediately preceding completed stage's summary.

When transitions are enabled, destinations must exist, IDs must be unique, declared prerequisites must have succeeded, backward jumps invalidate results from the target onward, and a total execution budget prevents infinite loops. A rejected apparent completion can return `retry`, which counts against retry and stage budgets. Each re-execution is a fresh tool invocation: applications must prevent automatic repetition of potentially mutating commands whose effects are uncertain.

**Limits:** the callback schedules only stages already present in the plan. It cannot amend the user's requirements, confer authorization, or prove completion by itself. An application's callback must verify the outcome and choose `abort` or `retry` rather than silently accepting a model's claim. `onException` remains responsible for actual failures; a skipped/fallback stage is not treated as a successfully completed prerequisite in transition mode. For branch joins, declare only prerequisites common to every possible incoming path.
