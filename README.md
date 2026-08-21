# @dharmax/llm-utils

Ultra-lean, strictly typed TypeScript primitives for LLM execution, automatic structured JSON, dynamic routing, prompt templates, context injection, and metrics.

```
Zero-Config Setup  →  1-Line Asks  →  Typed JSON (Zod)  →  Dynamic Routing  →  100% Reliable
```

---

## Features

* **Zero-Ceremony Setup**: Automatically reads `OPENAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, and `OLLAMA_HOST` from `process.env`.
* **Automatic Typed JSON (`asker.json()`)**: Injects provider-native schema, strips markdown fences, repairs malformed JSON with `jsonrepair`, and returns inferred `data: z.infer<typeof schema>`.
* **Dynamic Multi-Tier Routing**: Route by task alias (`code`, `fast`, `reasoning`, `local`), direct provider target (`'openai/gpt-4o'`), or custom routing hooks with reliable offline fallback.
* **Fatal-Provider Circuit Breaker**: Prevents redundant calls after fatal failures (e.g., quota or auth exhaustion).
* **Plug-and-Play Extensibility**: Standard interfaces for [`@dharmax/context-manager`](../context-manager), [`@dharmax/pubsub`](../pubsub), and custom storage sinks.
* **Instance-Owned State**: No hidden static singletons; test runs and separate clients never leak state.

---

## Installation

```sh
npm install @dharmax/llm-utils zod
```

---

## Quickstart

### 1. Direct Text Generation

```ts
import { Asker } from '@dharmax/llm-utils'

const asker = new Asker()

const result = await asker.ask('Explain quantum computing in one sentence.')
if (result.ok) {
    console.log(result.text)
    console.log(result.model) // { providerId: 'google', modelId: 'gemini-2.0-flash' }
}
```

---

### 2. Automatic Typed Structured JSON

```ts
import { Asker, z } from '@dharmax/llm-utils'

const asker = new Asker()

const bookSchema = z.object({
    title: z.string(),
    author: z.string(),
    summary: z.string(),
    tags: z.array(z.string()),
})

// Automatically inferred as { title: string; author: string; summary: string; tags: string[] }
const result = await asker.json('Summarize Dune as JSON.', bookSchema)

if (result.ok && result.data) {
    console.log(result.data.title)
    console.log(result.data.tags)
}
```

---

### 3. Model Routing & Exact Overrides

Route by task alias or target specific providers/models directly:

```ts
// 1. Route by task alias:
await asker.ask('Write a fast HTTP server in Go', { task: 'code' })

// 2. Exact provider/model override:
await asker.ask('Hello from Claude', { model: 'anthropic/claude-3-7-sonnet' })

// 3. Local Ollama execution:
await asker.ask('Private summary', { model: 'ollama/llama3.2' })
```

#### Default Task Routes:
* `code` &rarr; `openai/gpt-4o`
* `fast` &rarr; `google/gemini-2.0-flash`
* `reasoning` &rarr; `openai/o3-mini`
* `creative` &rarr; `anthropic/claude-3-7-sonnet`
* `local` &rarr; `ollama/llama3.2`

You can customize task routes during instantiation:

```ts
const asker = new Asker({
    routes: {
        'code': 'anthropic/claude-3-7-sonnet',
        'fast': 'google/gemini-2.0-flash',
    },
})
```

---

### 4. Prompt Templates & Context Injection

`PromptEngine` loads templates with optional JSON frontmatter and renders `{{ variables }}`:

```text
--- json
{"taskType": "code", "system": "You are a principal engineer."}
---
Review this diff for {{ language }}:
{{ context }}
```

Execute template with context:

```ts
const result = await asker.prompt('code-review', {
    language: 'TypeScript',
    inputText: 'function add(a, b) { return a + b }',
}, {
    // Plugs directly into @dharmax/context-manager or any custom resolver
    context: async (req) => `Relevant guideline: Always type parameters.`,
})
```

---

### 5. Multi-Turn Session Memory

```ts
import { Asker, LLMSession } from '@dharmax/llm-utils'

const asker = new Asker()
const session = new LLMSession(asker)

await session.prompt('assistant', { inputText: 'My name is Alice.' })
const response = await session.prompt('assistant', { inputText: 'What is my name?' })

console.log(response.text) // "Your name is Alice."
```

---

### 6. Metrics & PubSub Event Broadcasting

```ts
import { LlmMetrics, createMetricsPubSub } from '@dharmax/llm-utils'

const bus = createMetricsPubSub('My App Metrics')
const metrics = new LlmMetrics(undefined, { bus })

bus.on('metrics:recorded', (_event, metric) => {
    console.log(`[Metric] ${metric.providerId}/${metric.modelId}: ${metric.latencyMs}ms, ${metric.totalTokens} tokens`)
})

metrics.record({
    timestamp: new Date().toISOString(),
    providerId: 'openai',
    modelId: 'gpt-4o',
    promptTokens: 50,
    completionTokens: 25,
    latencyMs: 320,
    success: true,
})

console.log(metrics.totals())
```

---

## Public Exports

```ts
// Core Client
export { Asker } from '@dharmax/llm-utils'

// Types & Schemas
export { z } from '@dharmax/llm-utils'
export type { GenerationResult, ModelTarget, AskOptions, ProviderConfig } from '@dharmax/llm-utils'

// Utilities & Engines
export { CompletionEngine, ModelRouter, PromptEngine, ProviderCircuit, LlmMetrics, LLMSession } from '@dharmax/llm-utils'
export { parseStructuredJson, parseStructuredJsonResult, zodToJsonSchema } from '@dharmax/llm-utils'
```

---

## Development & Testing

```sh
npm run build      # Bundles with esbuild and emits declaration files
npm run typecheck  # Strict TypeScript check
npm test           # Executes test suite (24 tests)
npm run check      # Typecheck + tests
```

---

## License

MIT © [dharmax](https://github.com/dharmax)
