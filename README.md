# @dharmax/llm-utils

Ultra-lean, strictly typed TypeScript primitives for LLM execution, automatic structured JSON, dynamic routing, local LLM support (Ollama / OpenAI-compatible), prompt templates, context injection, and metrics.

```
Zero-Config Setup  →  1-Line Asks  →  Typed JSON (Zod)  →  Local LLM First  →  100% Reliable
```

---

## Highlights & Local LLM Support

* **First-Class Local LLM Support**: Native Ollama provider with `/api/chat`, host auto-detection (`OLLAMA_HOST` / `LOCAL_LLM_URL`), model discovery via `/api/tags`, and `preferLocal` routing to run 100% offline & private.
* **OpenAI-Compatible Local Servers**: Seamlessly connect to vLLM, LM Studio, LocalAI, or llama.cpp servers via custom `baseUrl`.
* **Zero-Ceremony Setup**: Automatically reads `OPENAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_HOST`, and `LOCAL_LLM_URL` from `process.env`.
* **Automatic Typed JSON (`asker.json()`)**: Injects provider-native schema, strips markdown fences, repairs malformed JSON with `jsonrepair` (crucial for small local models like 3B/7B), and returns inferred `data: z.infer<typeof schema>`.
* **Dynamic Multi-Tier Routing**: Route by task alias (`code`, `fast`, `reasoning`, `local`), direct provider target (`'openai/gpt-4o'`), bare model name (`'llama3.2'`, `'deepseek-r1'`, `'qwen2.5-coder'`), or custom routing hooks.
* **Fatal-Provider Circuit Breaker**: Prevents redundant calls after fatal failures (e.g., quota or auth exhaustion).
* **Plug-and-Play Extensibility**: Standard interfaces for [`@dharmax/context-manager`](../context-manager), [`@dharmax/pubsub`](../pubsub), and custom storage sinks.

---

## Installation

```sh
npm install @dharmax/llm-utils zod
```

---

## Local LLM Workflows

### 1. Direct Local Asks (`asker.local()`)

Execute offline prompts directly on your local Ollama instance:

```ts
import { Asker } from '@dharmax/llm-utils'

const asker = new Asker()

// Automatically routes to local Ollama (llama3.2 by default)
const result = await asker.local('Summarize this private document.')
console.log(result.text)
```

### 2. Bare Local Model Recognition

Specify any open model name directly without provider prefixes:

```ts
// Automatically routed to Ollama:
await asker.ask('Write Python quicksort', { model: 'qwen2.5-coder:7b' })
await asker.ask('Analyze query plan', { model: 'deepseek-r1:8b' })
await asker.ask('Explain rust lifetimes', { model: 'phi4' })
```

### 3. Local Structured JSON (with automatic repair)

Smaller local models (3B / 7B) often produce minor JSON syntax defects. `@dharmax/llm-utils` automatically extracts markdown code blocks and repairs malformed output locally with `jsonrepair` before running strict Zod validation:

```ts
import { Asker, z } from '@dharmax/llm-utils'

const asker = new Asker()

const schema = z.object({
    sentiment: z.enum(['positive', 'neutral', 'negative']),
    confidence: z.number().min(0).max(1),
})

const result = await asker.json('Analyze customer feedback: Great product!', schema, {
    model: 'llama3.2:3b',
})

if (result.ok && result.data) {
    console.log(result.data.sentiment) // "positive"
}
```

### 4. Custom Local Endpoints (LM Studio / vLLM / llama.cpp)

```ts
const asker = new Asker({
    providers: {
        lmstudio: {
            id: 'lmstudio',
            baseUrl: 'http://127.0.0.1:1234/v1',
            available: true,
        },
    },
})

await asker.ask('Hello from local server', { model: 'lmstudio/local-model' })
```

---

## Cloud Providers & Routing

### Direct Remote Generation

```ts
import { Asker, z } from '@dharmax/llm-utils'

const asker = new Asker()

// 1. Direct ask:
const result = await asker.ask('Hello world')

// 2. Routed by task:
const code = await asker.ask('Write an LRU cache in TypeScript', { task: 'code' })

// 3. Exact remote override:
const claude = await asker.ask('Creative story', { model: 'anthropic/claude-3-7-sonnet' })
```

#### Default Task Routes:
* `code` &rarr; `openai/gpt-4o`
* `fast` &rarr; `google/gemini-2.0-flash`
* `reasoning` &rarr; `openai/o3-mini`
* `creative` &rarr; `anthropic/claude-3-7-sonnet`
* `local` &rarr; `ollama/llama3.2`

---

## Prompt Templates & Context Injection

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

## Multi-Turn Session Memory

```ts
import { Asker, LLMSession } from '@dharmax/llm-utils'

const asker = new Asker()
const session = new LLMSession(asker)

await session.ask('My name is Alice.')
const response = await session.ask('What is my name?')

console.log(response.text) // "Your name is Alice."
```

---

## Metrics & PubSub Event Broadcasting

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
export { parseStructuredJson, parseStructuredJsonResult, zodToJsonSchema, ProviderDiscovery } from '@dharmax/llm-utils'
```

---

## Development & Testing

```sh
npm run build      # Bundles with esbuild and emits declaration files
npm run typecheck  # Strict TypeScript check
npm test           # Executes test suite (25 tests)
npm run check      # Typecheck + tests
```

---

## License

MIT © [dharmax](https://github.com/dharmax)
