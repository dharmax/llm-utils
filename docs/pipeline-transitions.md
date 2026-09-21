# Optional pipeline transitions

`LLMPipeline` remains linear by default. Set `onTransition` only when a task needs conditional stage scheduling. The callback runs after **each resolved stage**, including stages skipped or substituted through `onException`. Unhandled tool/actor failures still use `onException` and terminate normally if unrecovered.

```ts
const pipeline = new LLMPipeline(asker, {
  tools,
  onException: recoverUnexpectedFailure,
  maxStageExecutions: 20,
  onTransition: ({step, result, history, outcome}) => {
    if (outcome !== 'completed')
      return {action: 'abort', reason: 'Required inspection did not complete'}

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

Transitions are `next` (or `undefined` on a successfully completed stage), `goto` to an existing stage ID, `retry` the current stage with optional corrective wisdom, and `abort`. A conventional indexed `for` loop and `switch` perform scheduling; there is no second workflow engine.

The callback sees the actor's complete `result`, actual stage `outcome`, chronological `history` retained across loops, current output snapshot, intent and plan. Existing `stepOutputs` and `phaseTraces` remain compatible but represent the latest execution of repeated stages. The next actor receives declared dependencies and the preceding *still-valid* completed stage's summary.

In transition mode, IDs must be unique, destinations registered, declared prerequisites successfully completed, backward jumps invalidate outputs from their target onward, and a total stage-execution budget bounds loops. Skipped or substituted stages require an explicit transition decision; they never automatically satisfy declared prerequisites. A rejected apparent completion can return `retry`, subject to retry and stage budgets.

**Application responsibilities:** the callback chooses only among planned stages. It cannot amend user requirements, confer authorization, or independently prove success. Verify observations and final task obligations before accepting completion. Re-executions are fresh tool invocations; the host must prohibit automatic repetition of potentially mutating operations with uncertain effects. For branch joins, declare only prerequisites common to each incoming path. The original `onException` remains responsible for unexpected failures.
