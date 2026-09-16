# @dharmax/llm-utils

Ultra-lean, strictly typed TypeScript primitives for LLM execution, automatic structured JSON with auto-repair, dynamic model routing, local LLM support (Ollama / OpenAI-compatible), prompt templates, context injection, autonomous tool execution (`LLMActor`), multi-turn sessions, and telemetry metrics.

```
Zero-Config Setup  →  1-Line Asks  →  Typed JSON (Zod)  →  Autonomous Acting  →  Modern Bun Native
```

---

## Highlights

* **Pure Modern Bun**: Built natively for Bun. Direct execution from `.ts` TypeScript source via the `"bun"` export condition with zero bundle or compilation overhead.
* **First-Class Local LLM Support**: Native Ollama provider with `/api/chat`, host auto-detection (`OLLAMA_HOST` / `LOCAL_LLM_URL`), model discovery via `/api/tags`, and `preferLocal` routing to run 100% offline & private.
* **OpenAI-Compatible Local Servers**: Seamlessly connects to vLLM, LM Studio, LocalAI, or llama.cpp servers via custom `baseUrl`.
* **Zero-Ceremony Setup**: Automatically reads `OPENAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_HOST`, and `LOCAL_LLM_URL` from `process.env`.
* **Automatic Typed JSON (`asker.json()`)**: Injects provider-native schema, strips markdown fences, repairs malformed JSON with `jsonrepair` (crucial for small local models like 3B/7B), and returns inferred `data: z.infer<typeof schema>`.
* **Autonomous Acting & Tool Execution (`LLMActor`)**: Bounded think-act-observe loops with strongly typed Zod parameter schemas, execution sandboxing, step-by-step control, and lifecycle hooks.
* **Dynamic Multi-Tier Routing**: Route by task alias (`code`, `fast`, `reasoning`, `creative`, `local`), direct provider target (`'openai/gpt-4o'`), bare model name (`'llama3.2'`, `'deepseek-r1'`, `'qwen2.5-coder'`), or custom routing hooks.
* **Fatal-Provider Circuit Breaker**: Prevents redundant network calls after fatal failures (e.g., quota exhaustion, invalid auth).
* **Multi-Turn Sessions (`LLMSession`)**: Stateful conversation tracking with sliding history and metrics.
* **Telemetry & Event Broadcasting (`LlmMetrics`)**: Measure latency, token usage, and costs with optional [`@dharmax/pubsub`](../pubsub) event broadcasting.

---

## Installation

```sh
bun add @dharmax/llm-utils zod
```

---

## Quick Reference / API Cheat Sheet

| Primitive | Primary Methods | Description |
| :--- | :--- | :--- |
| **`Asker`** | `ask(prompt, opts)`<br>`json(prompt, schema, opts)`<br>`local(prompt, opts)`<br>`prompt(name, vars, opts)`<br>`promptJson(name, vars, schema, opts)` | Unified LLM client with provider routing, schema validation, and template support. |
| **`LLMActor`** | `run(goal, opts)`<br>`step(goal, history, ctx, opts)`<br>`registerTool(tool)` | Autonomous tool execution loop (Think-Act-Observe) with error boundaries and budget control. |
| **`LLMPipeline`** | `run(goal, opts)`<br>`preprocess(goal)`<br>`plan(intent)` | Native multi-phase orchestrator (Preprocess → Plan → Scoped Act → Verify). |
| **`LLMSession`** | `ask(prompt, opts)`<br>`prompt(name, vars, opts)`<br>`clear()` | Stateful multi-turn conversation wrapper with sliding history. |
| **`PromptEngine`** | `load(name)`<br>`render(template, vars)` | Multipart prompt template engine with YAML/JSON frontmatter and dot-notation paths. |
| **`FileTemplateSource`** | `load(name)` | Filesystem template loader for `.prompt`, `.md`, and `.txt` files. |
| **`LlmMetrics`** | `record(event)`<br>`totals()`<br>`query(filter)` | Token accounting, latency tracking, pricing calculations, and PubSub event emission. |
| **`ProviderDiscovery`** | `discoverOllama(url?)` | Auto-detects local Ollama instance and enumerates installed models. |
| **`ModelRouter`** | `resolve(target, opts)` | Maps task classes, bare model names, and provider targets to endpoints. |

---

## Environment Variables

| Variable | Provider / Purpose | Default / Fallback |
| :--- | :--- | :--- |
| `OPENAI_API_KEY` | OpenAI (`gpt-4o`, `o3-mini`, etc.) | None (disabled if unset) |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Google Gemini (`gemini-2.0-flash`, `gemini-2.5-pro`, etc.) | None (disabled if unset) |
| `ANTHROPIC_API_KEY` | Anthropic Claude (`claude-3-7-sonnet`, etc.) | None (disabled if unset) |
| `OLLAMA_HOST` / `LOCAL_LLM_URL` | Local Ollama / Local LLM Base URL | `http://127.0.0.1:11434` |

---

## Bun & Node Native Usage

In **Bun**, `@dharmax/llm-utils` runs directly from its native `.ts` TypeScript source via the `"bun"` export condition:

```ts
import { Asker } from '@dharmax/llm-utils'

const asker = new Asker()
const res = await asker.ask('Hello from Bun!')

if (res.ok) {
    console.log(res.text)
    console.log(`Used ${res.usage.totalTokens} tokens via ${res.providerId}/${res.modelId}`)
}
```

Run directly:
```sh
bun run index.ts
```


---

## Core Execution: `Asker`

### 1. Plain Text Asks

```ts
import { Asker } from '@dharmax/llm-utils'

const asker = new Asker()

// Direct execution with default router
const res = await asker.ask('Explain ACID transactions in 2 sentences.')
console.log(res.text)

// Override model or task classification
const codeRes = await asker.ask('Write TypeScript debounce', { task: 'code' })
const exactRes = await asker.ask('Analyze log trace', { model: 'openai/gpt-4o' })
```

### 2. Typed Structured JSON (`asker.json()`)

`asker.json()` combines three safety nets:
1. Translates Zod schemas to provider-native JSON Schemas (supported across OpenAI, Google, Anthropic, Ollama).
2. Strips markdown fences (` ```json `).
3. Automatically repairs syntax defects with `jsonrepair` before Zod parsing (vital for 3B–8B local models).

```ts
import { Asker, z } from '@dharmax/llm-utils'

const asker = new Asker()

const SentimentSchema = z.object({
    sentiment: z.enum(['positive', 'neutral', 'negative']),
    confidence: z.number().min(0).max(1),
    keyPhrases: z.array(z.string()),
})

const result = await asker.json('The delivery arrived on time and works great!', SentimentSchema)

if (result.ok && result.data) {
    // result.data is strictly typed: { sentiment: "positive" | "neutral" | "negative", confidence: number, keyPhrases: string[] }
    console.log(result.data.sentiment)   // "positive"
    console.log(result.data.confidence)  // 0.95
} else {
    console.error(result.failure?.message)
}
```

### 3. Local LLM Execution (`asker.local()`)

Execute completely offline against local Ollama models:

```ts
import { Asker } from '@dharmax/llm-utils'

const asker = new Asker()

// Automatically targets local Ollama (llama3.2 by default)
const res = await asker.local('Summarize this private diff.')
console.log(res.text)

// Pass bare open-source model names; automatically routes to local Ollama:
await asker.ask('Write quicksort in Rust', { model: 'qwen2.5-coder:7b' })
await asker.ask('Explain query plan', { model: 'deepseek-r1:8b' })
await asker.ask('Summarize text', { model: 'mistral' })
```

### 4. Custom Local Endpoints (LM Studio / vLLM / llama.cpp)

Connect any OpenAI-compatible local server:

```ts
import { Asker } from '@dharmax/llm-utils'

const asker = new Asker({
    providers: {
        lmstudio: {
            id: 'lmstudio',
            baseUrl: 'http://127.0.0.1:1234/v1',
            available: true,
        },
    },
})

const res = await asker.ask('Hello from local server', { model: 'lmstudio/local-model' })
```

### 5. Multi-Tier Task Routing

Target high-level task aliases rather than hardcoding model names:

```ts
await asker.ask('Build an LRU cache', { task: 'code' })        // openai/gpt-4o
await asker.ask('Quick spellcheck', { task: 'fast' })         // google/gemini-2.0-flash
await asker.ask('Complex logic puzzle', { task: 'reasoning' }) // openai/o3-mini
await asker.ask('Creative story', { task: 'creative' })       // anthropic/claude-3-7-sonnet
await asker.ask('Local privacy task', { task: 'local' })       // ollama/llama3.2
```

Configure custom routers or target models when instantiating `Asker`:

```ts
const asker = new Asker({
    routes: {
        code: 'google/gemini-2.5-pro',
        fast: 'ollama/qwen2.5-coder:7b',
    },
    preferLocal: true, // Auto-routes to local Ollama when available
})
```

---

## Autonomous Acting: `LLMActor`

`LLMActor` is a lightweight, abstract execution wrapper for tool augmentation and function calling. It orchestrates a Think-Act-Observe cycle without heavy framework bloat.

### 1. Defining Tools & Running an Autonomous Loop

```ts
import { Asker, LLMActor, z } from '@dharmax/llm-utils'

const asker = new Asker()

const actor = new LLMActor(asker, {
    maxSteps: 5,
    tools: [
        {
            name: 'get_weather',
            description: 'Fetch current weather temperature and condition for a given city',
            parameters: z.object({
                city: z.string().describe('Target city name'),
            }),
            execute: async ({ city }) => {
                return { city, temperatureC: 22, condition: 'Sunny' }
            },
        },
        {
            name: 'send_notification',
            description: 'Send a push notification to user device',
            parameters: z.object({
                message: z.string().describe('Notification text to display'),
            }),
            execute: async ({ message }) => {
                console.log(`[Notification] ${message}`)
                return { delivered: true }
            },
        },
    ],
})

// Autonomous run to completion
const result = await actor.run('Check weather in Tokyo and notify the user if sunny.')

if (result.ok) {
    console.log(result.finalText)
    console.log(`Completed in ${result.totalSteps} steps`)
}
```

### 2. Step-by-Step Control (Interactive UIs & Human Gates)

For stepped execution, approval workflows, or interactive agent interfaces, use `actor.step()`:

```ts
import { LLMActor, type ActorStepRecord } from '@dharmax/llm-utils'

const history: ActorStepRecord[] = []

// Turn 1
const turn1 = await actor.step('Execute diagnostic inspection', history)
history.push(turn1.record)

if (turn1.record.action === 'tool_call') {
    console.log('Model invoked tools:', turn1.record.toolCalls)
    console.log('Tool observations:', turn1.record.toolResults)
}

// Turn 2
const turn2 = await actor.step('Execute diagnostic inspection', history)
if (turn2.isDone) {
    console.log('Final resolution:', turn2.record.finalAnswer)
}
```

### 3. Concrete Desktop Example

Check [`examples/tools-actor.ts`](examples/tools-actor.ts) for a runnable demonstration equipped with:
* `run_linux_command`: Shell process execution with timeout bounds
* `popup_message`: Desktop notifications via `zenity` / `notify-send`
* `web_search`: DuckDuckGo / SearXNG search integration
* `tts`: Speech synthesis via `spd-say`

Run it instantly with Bun:
```sh
bun examples/tools-actor.ts
```

### 4. Interactive REPL CLI

Test natural language prompts, RAG, and autonomous tool augmentation interactively with your live local Ollama model or cloud models:

```sh
# Start interactive REPL
bun run repl
# or
bun run cli

# Single-shot goal execution with real-time tool logs
bun run cli "What is the git status in this repository? Use run_linux_command."
bun run cli "Calculate (45 * 12) / 3 using eval_math and tell me the result."
```

During interactive sessions, the REPL supports slash commands:
* `/tools` — View all equipped tools and parameter schemas
* `/models` — Inspect auto-detected local Ollama models
* `/clear` — Clear terminal screen
* `exit` — Exit REPL

---

## Multi-Phase Agent Pipelines: `LLMPipeline`

When prompts involve multiple dependent tasks, complex workflows, or strict constraints, monolithic ReAct loops can suffer from attention dilution on 7B models. `LLMPipeline` breaks the problem into **4 discrete, verified phases**:

```
User Prompt ──→ 1. Preprocess ──→ 2. Plan ──→ 3. Scoped Execution ──→ 4. Verify & Synthesize
```

1. **Phase 1: Preprocess (Intent & Constraints)**: Clarifies goal, identifies constraints, and **prunes the tool catalog** to only the tools relevant for this goal.
2. **Phase 2: Plan (Decomposition & Dependencies)**: Decomposes the goal into an ordered checklist of sub-tasks with explicit `dependsOn` relationships.
3. **Phase 3: Scoped Execution**: Runs each step in an isolated `LLMActor` turn, injecting prerequisite outputs into the next step's memory context.
4. **Phase 4: Synthesis & Verification**: Verifies all constraints were satisfied and produces the final answer (or validated typed Zod data).

### Basic Usage

```ts
import { Asker, LLMPipeline, z } from '@dharmax/llm-utils'

const asker = new Asker()
const pipeline = new LLMPipeline(asker, {
    tools: [
        {
            name: 'get_client_status',
            description: 'Returns client subscription tier and credits',
            parameters: z.object({ clientId: z.string() }),
            execute: ({ clientId }) => ({ clientId, tier: 'enterprise', credits: 450 }),
        },
        {
            name: 'calculate_discount',
            description: 'Calculates renewal discount based on tier and credits',
            parameters: z.object({ credits: z.number() }),
            execute: ({ credits }) => ({ discountPercent: credits > 400 ? 20 : 10 }),
        },
    ],
    onPhaseChange: (phase, data) => console.log(`[Phase: ${phase}]`),
})

const result = await pipeline.run(
    'Check status for client "c_123" with get_client_status, then calculate their discount using calculate_discount. State both tier and discount.'
)

if (result.ok) {
    console.log(result.finalText)
    console.log('Execution Plan:', result.plan.steps)
}
```

### Pluggable Architecture (Service Adapter Pattern)

`LLMPipeline` accepts optional custom adapters for preprocessing and planning:

```ts
const pipeline = new LLMPipeline(asker, {
    tools,
    preprocessor: myCustomPreprocessor, // implements IntentPreprocessorAdapter
    planner: myCustomPlanner,           // implements TaskPlannerAdapter
})
```

### Happy Path + Exception Wisdom Interceptor

Rather than managing bloated Finite State Machine (FSM) graphs, `LLMPipeline` executes the straightforward **Happy Path** by default. When reality diverges (tool authentication error, missing parameter, budget exceeded), an optional `onException` callback intercepts the failure to inject contextual **Wisdom** or fallback data:

```ts
const pipeline = new LLMPipeline(asker, {
    tools,
    maxStepRetries: 2,
    throwOnError: true, // Throws descriptive Error on unhandled abort
    onException: (exc) => {
        console.warn(`Step ${exc.step.id} failed (attempt ${exc.attempt}):`, exc.error)

        // 1. Inject Wisdom to self-correct on retry:
        if (exc.error.includes('Unauthorized')) {
            return {
                action: 'retry',
                wisdom: 'Authentication required. Call get_server_metrics with apiToken "SECRET_123".',
            }
        }

        // 2. Or provide fallback data and continue happy path:
        if (exc.step.id === 'fetch_cached_stats') {
            return { action: 'continue', fallbackOutput: 'default_stats_baseline' }
        }

        // 3. Or skip non-critical steps:
        if (exc.step.id === 'send_slack_ping') {
            return { action: 'skip' }
        }

        // 4. Or fail fast:
        return { action: 'abort', reason: 'Security violation' }
    },
})
```

---

## Prompt Templates: `PromptEngine`

### 1. Template Files with Frontmatter

Create templates as `.prompt`, `.md`, or `.txt` files:

```markdown
---
system: You are a principal database administrator.
task: reasoning
temperature: 0.2
---
Analyze this slow query log for {{ database.name }}:
{{ queryLog }}

<!-- Hidden comment stripped during rendering -->
Suggest up to {{ maxSuggestions }} indexes.
```

### 2. Loading from Filesystem (`promptsDir`)

Pass `promptsDir` directly to `Asker`:

```ts
import { Asker } from '@dharmax/llm-utils'

const asker = new Asker({
    promptsDir: new URL('./prompts', import.meta.url),
})

// Automatically loads './prompts/db-review.prompt', parses frontmatter, renders variables, and executes:
const result = await asker.prompt('db-review', {
    database: { name: 'analytics_prod' },
    queryLog: 'SELECT * FROM events WHERE user_id = 42 ORDER BY created_at DESC;',
    maxSuggestions: 3,
})

console.log(result.text)
```

### 3. Typed JSON with Prompt Templates (`asker.promptJson()`)

```ts
import { Asker, z } from '@dharmax/llm-utils'

const asker = new Asker({ promptsDir: './prompts' })

const RecommendationSchema = z.object({
    suggestedIndexes: z.array(z.string()),
    estimatedSpeedup: z.string(),
    risks: z.array(z.string()),
})

const result = await asker.promptJson('db-review', {
    database: { name: 'analytics_prod' },
    queryLog: '...',
    maxSuggestions: 3,
}, RecommendationSchema)

if (result.ok && result.data) {
    console.log(result.data.suggestedIndexes)
}
```

---

## Context Injection & RAG Protocol

`@dharmax/llm-utils` defines a pure abstract contract for context resolution (`ContextResolver`), delegating retrieval to specialized packages like [`@dharmax/context-manager`](../context-manager):

```ts
import { Asker, type ContextResolver } from '@dharmax/llm-utils'

// Functional or class-based resolver
const resolver: ContextResolver = async (req) => {
    return {
        items: [
            { source: 'schema.sql', content: 'CREATE TABLE users (id INT, email TEXT);' },
        ],
    }
}

const asker = new Asker({ contextResolver: resolver })

// Injects resolved context automatically into prompt:
const res = await asker.ask('How is email stored in the users table?', {
    context: { query: 'users table definition' },
})
```

---

## Multi-Turn Session Memory: `LLMSession`

`LLMSession` maintains sliding conversation history across turns:

```ts
import { Asker, LLMSession } from '@dharmax/llm-utils'

const asker = new Asker()
const session = new LLMSession(asker, { maxHistoryTurns: 10 })

await session.ask('My workspace directory is /home/user/app.')
const res = await session.ask('What was my workspace path?')

console.log(res.text) // "Your workspace path is /home/user/app."
console.log(session.history) // Inspect accumulated turn records
```

---

## Telemetry & Metrics: `LlmMetrics`

Track request latency, token consumption, pricing, and stream telemetry over PubSub:

```ts
import { LlmMetrics, createMetricsPubSub } from '@dharmax/llm-utils'

const bus = createMetricsPubSub('llm-telemetry')

bus.on('metrics:recorded', (_event, metric) => {
    console.log(`[Telemetry] ${metric.providerId}/${metric.modelId}: ${metric.latencyMs}ms, ${metric.totalTokens} tokens`)
})

const metrics = new LlmMetrics(undefined, { bus })

metrics.record({
    timestamp: new Date().toISOString(),
    providerId: 'openai',
    modelId: 'gpt-4o',
    promptTokens: 120,
    completionTokens: 45,
    latencyMs: 410,
    success: true,
})

console.log(metrics.totals())
// { calls: 1, successes: 1, failures: 0, promptTokens: 120, completionTokens: 45, totalTokens: 165, avgLatencyMs: 410, ... }
```

---

## Public Exports

```ts
// Core Clients
export { Asker } from '@dharmax/llm-utils'
export { LLMActor } from '@dharmax/llm-utils'
export { LLMSession } from '@dharmax/llm-utils'

// Types & Schemas
export { z } from '@dharmax/llm-utils'
export type {
    GenerationResult,
    GenerationFailure,
    ModelTarget,
    AskOptions,
    ProviderConfig,
    ProviderAdapter,
    ResponseFormat,
    ToolDefinition,
    ToolInvocation,
    ToolExecutionResult,
    ActorStepRecord,
    ActorRunResult,
    ActorRunOptions,
    ContextResolver,
    ContextRequest,
    ContextResult,
    LlmMetricEvent,
    MetricsQuery,
    AggregateMetrics,
} from '@dharmax/llm-utils'

// Utilities & Engines
export {
    CompletionEngine,
    ModelRouter,
    PromptEngine,
    FileTemplateSource,
    ProviderCircuit,
    LlmMetrics,
    InMemoryMetricsStore,
    createMetricsPubSub,
    calculateUsageCost,
    parseStructuredJson,
    parseStructuredJsonResult,
    zodToJsonSchema,
    resolveResponseFormat,
    ProviderDiscovery,
} from '@dharmax/llm-utils'
```

---

## Development & Verification

```sh
bun test           # Runs all 43 tests via bun:test (under 250ms)
bun run typecheck  # Strict TypeScript check (tsc --noEmit)
bun run build      # Bundles neutral ESM and emits .d.ts declarations
```

---

## Modular Ecosystem

`@dharmax/llm-utils` is designed as a foundational layer in the `@dharmax` AI engineering ecosystem. See [docs/ecosystem.md](docs/ecosystem.md) for full architectural patterns:

* [`@dharmax/context-manager`](../context-manager) — RAG indexing, semantic search, token budgeting.
* [`@dharmax/block-patcher`](../block-patcher) — Precise LLM-generated code edits via search/replace blocks.
* [`@dharmax/codebase-parser`](../codebase-parser) — Multi-language AST parsing (TS, Python, Rust, Go, etc.).
* [`@dharmax/text-compiler`](../text-compiler) — JIT compilation from natural language into executable state machines.
* [`@dharmax/pubsub`](../pubsub) — Zero-overhead pubsub messaging.

---

## License

MIT © [dharmax](https://github.com/dharmax)
