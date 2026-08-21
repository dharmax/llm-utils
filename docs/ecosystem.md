# Ecosystem & Companion Packages

`@dharmax/llm-utils` is designed to be the central, ultra-lean execution engine in a modular AI-engineering architecture. It connects seamlessly with specialized sibling packages:

```
                                  ┌──────────────────────────┐
                                  │   @dharmax/llm-utils     │
                                  │  (Core Execution Engine) │
                                  └────────────┬─────────────┘
                                               │
       ┌──────────────────┬────────────────────┼───────────────────┬──────────────────┐
       ▼                  ▼                    ▼                   ▼                  ▼
┌──────────────┐   ┌──────────────┐    ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│ context-     │   │ block-       │    │ codebase-     │   │ text-         │   │ pubsub        │
│ manager      │   │ patcher      │    │ parser        │   │ compiler      │   │               │
│ (Memory & RAG│   │ (Surgical    │    │ (AST Symbol & │   │ (Natural Lang │   │ (Telemetry &  │
│ Resolution)  │   │ Code Diffs)  │    │ Fact Ingestion│   │ State Machine)│   │ Event Stream) │
└──────────────┘   └──────────────┘    └───────────────┘   └───────────────┘   └───────────────┘
```

---

## 1. `@dharmax/context-manager` — Context & Memory Engine

Provides hierarchical memory, token budgeting, and dynamic relevance retrieval.

### Integration Pattern:
```ts
import { PromptContextManager } from '@dharmax/context-manager'
import { Asker } from '@dharmax/llm-utils'

const contextManager = new PromptContextManager({ /* ... */ })
const asker = new Asker({
    // Direct drop-in context resolver
    context: async (req) => contextManager.resolveContext(req),
})

// Automatically queries contextManager and populates {{ context }} in templates
const result = await asker.prompt('refactor-component', {
    inputText: 'Refactor UserService to use connection pooling',
})
```

---

## 2. `@dharmax/block-patcher` — Surgical Code Editing Engine

Parses LLM `SEARCH/REPLACE` blocks and applies multi-file surgical code updates to disk with exact and indentation-flexible matching.

### Integration Pattern:
```ts
import { applyPatchToFile, parsePatch } from '@dharmax/block-patcher'
import { Asker } from '@dharmax/llm-utils'

const asker = new Asker()

const prompt = `
Update src/config.ts to enable SSL:
Output only SEARCH/REPLACE blocks like:
<<<< SEARCH
ssl: false
====
ssl: true
>>>>
`

const response = await asker.ask(prompt, { task: 'code' })

if (response.ok) {
    // Parse and apply directly to disk
    const result = await applyPatchToFile('src/config.ts', response.text)
    console.log('Applied:', result.allApplied)
}
```

---

## 3. `@dharmax/codebase-parser` — Multi-Language Code Context Ingestion

Extracts symbols, exported functions, classes, type declarations, imports, and `# TODO` / `// NOTE` comments across TypeScript, Python, Rust, Go, Shell, Vue, and Riot.

### Integration Pattern:
```ts
import { parseIndexedFile } from '@dharmax/codebase-parser'
import { Asker } from '@dharmax/llm-utils'

// Ingest source files
const astData = parseIndexedFile({
    filePath: 'src/engine.rs',
    content: rustSourceCode,
})

// Feed structured facts and symbols directly into the LLM
const asker = new Asker()
const review = await asker.json('Analyze code symbols for architectural soundness', ArchitectureSchema, {
    task: 'code',
    system: `Target Symbols:\n${JSON.stringify(astData.symbols, null, 2)}`,
})
```

---

## 4. `@dharmax/text-compiler` — Natural Language to State Machines

Compiles high-level prompt instructions into deterministic, suspendable JavaScript state machines with checkpoint snapshots.

### Integration Pattern:
```ts
import { Asker } from '@dharmax/llm-utils'
import { compileText } from '@dharmax/text-compiler'

const asker = new Asker()

// text-compiler delegates LLM generation to llm-utils
const workflow = await compileText('Fetch metrics, if latency > 500ms alert on-call', toolkit, services)

// Run deterministic state machine
const result = await workflow.execute(ctx)
```

---

## 5. `@dharmax/pubsub` — Real-Time Telemetry & Token Tracking

Broadcasts LLM execution metrics, latencies, costs, and circuit breaker events across processes or to UI dashboards.

### Integration Pattern:
```ts
import { createMetricsPubSub, LlmMetrics } from '@dharmax/llm-utils'

const bus = createMetricsPubSub('Production LLM Monitor')
const metrics = new LlmMetrics(undefined, { bus })

bus.on('metrics:recorded', (_event, metric) => {
    console.log(`[LLM Call] ${metric.providerId}/${metric.modelId} - ${metric.latencyMs}ms ($${metric.costUsd})`)
})

bus.on('circuit:open', (_event, { providerId }) => {
    console.error(`[ALERT] Provider circuit tripped for: ${providerId}`)
})
```
