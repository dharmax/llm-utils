# @dharmax/llm-utils

Ultra-lean, strictly typed TypeScript primitives for LLM execution, automatic structured JSON, dynamic routing, local LLM support (Ollama / OpenAI-compatible), prompt templates, context injection, and metrics.

```
Zero-Config Setup  →  1-Line Asks  →  Typed JSON (Zod)  →  Bun & Node Native  →  100% Reliable
```

---

## Highlights

* **Bun-First & Node Compatible**: Ships native TypeScript source under the `"bun"` package export condition for instant zero-bundle execution in Bun, with pre-bundled ESM for Node.
* **First-Class Local LLM Support**: Native Ollama provider with `/api/chat`, host auto-detection (`OLLAMA_HOST` / `LOCAL_LLM_URL`), model discovery via `/api/tags`, and `preferLocal` routing to run 100% offline & private.
* **OpenAI-Compatible Local Servers**: Seamlessly connect to vLLM, LM Studio, LocalAI, or llama.cpp servers via custom `baseUrl`.
* **Zero-Ceremony Setup**: Automatically reads `OPENAI_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, `OLLAMA_HOST`, and `LOCAL_LLM_URL` from `process.env`.
* **Automatic Typed JSON (`asker.json()`)**: Injects provider-native schema, strips markdown fences, repairs malformed JSON with `jsonrepair` (crucial for small local models like 3B/7B), and returns inferred `data: z.infer<typeof schema>`.
* **Dynamic Multi-Tier Routing**: Route by task alias (`code`, `fast`, `reasoning`, `local`), direct provider target (`'openai/gpt-4o'`), bare model name (`'llama3.2'`, `'deepseek-r1'`, `'qwen2.5-coder'`), or custom routing hooks.
* **Fatal-Provider Circuit Breaker**: Prevents redundant calls after fatal failures (e.g., quota or auth exhaustion).
* **Modular Ecosystem Integration**: Standard interfaces for [`@dharmax/context-manager`](../context-manager), [`@dharmax/block-patcher`](../block-patcher), [`@dharmax/codebase-parser`](../codebase-parser), [`@dharmax/text-compiler`](../text-compiler), and [`@dharmax/pubsub`](../pubsub). See [docs/ecosystem.md](docs/ecosystem.md).

---

## Installation

```sh
# npm
npm install @dharmax/llm-utils zod

# bun
bun add @dharmax/llm-utils zod
```

---

## Bun & Node Native Usage

In **Bun**, `@dharmax/llm-utils` runs directly from its `.mts` TypeScript source with zero build artifacts or compilation overhead:

```ts
import { Asker, z } from '@dharmax/llm-utils'

const asker = new Asker()
const result = await asker.ask('Hello from Bun!')
console.log(result.text)
```

Run directly with Bun:
```sh
bun run index.ts
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

## Prompt Templates & File Management

### 1. Template Files with Frontmatter

Templates can be stored as `.prompt`, `.md`, or `.txt` files with YAML or JSON frontmatter:

```markdown
---
system: You are a principal software architect.
taskType: code
---
Review this diff for {{ project.name }}:
{{ diff }}
```

Nested dot-notation paths (`{{ project.owner.name }}`) and comments (`<!-- hidden comment -->`) are supported natively.

### 2. Loading from Filesystem (`promptsDir` & `FileTemplateSource`)

Pass `promptsDir` directly to `Asker` to auto-wire template loading relative to the current module or directory:

```ts
import { Asker } from '@dharmax/llm-utils'

const asker = new Asker({
    promptsDir: new URL('./templates', import.meta.url),
})

// Loads './templates/code-review.prompt' (or .md), renders variables, and executes:
const result = await asker.prompt('code-review', {
    project: { name: 'Semantic Studio' },
    diff: '+const answer = 42;',
})
console.log(result.text)
```

### 3. Standalone `PromptEngine` & `FileTemplateSource`

For rendering or inspection without executing an LLM request:

```ts
import { PromptEngine, FileTemplateSource } from '@dharmax/llm-utils'

const fileSource = new FileTemplateSource(new URL('./templates', import.meta.url))
const engine = new PromptEngine(fileSource)

// 1. Load template & metadata
const { content, manifest } = await engine.load('code-review')
console.log(manifest.system) // "You are a principal software architect."

// 2. Render variables
const rendered = engine.render(content, {
    project: { name: 'Semantic Studio' },
    diff: '+const answer = 42;',
})
```

### 4. Typed JSON with Prompt Templates (`asker.promptJson()`)

Combine template rendering with strict Zod validation and local repair:

```ts
import { Asker, z } from '@dharmax/llm-utils'

const schema = z.object({
    approved: z.boolean(),
    score: z.number().min(0).max(100),
    comments: z.array(z.string()),
})

const result = await asker.promptJson('code-review', {
    project: { name: 'Text Compiler' },
    diff: '+const valid = true;',
}, schema)

if (result.ok && result.data) {
    console.log(result.data.approved, result.data.score)
}
```

### 5. Procedural Prompt Generation (Rant / Combinatorial Fuzzing)

For A/B prompt testing, prompt fuzzing, or synthetic variation generation, you can plug procedural text generators (like [Rant / rantjs](https://github.com/robbestad/Rantjs)) directly into `PromptEngine` via custom loaders:

```ts
import { Asker, PromptEngine } from '@dharmax/llm-utils'
import rant from 'rantjs' // or any procedural generator

const proceduralSource = {
    async load(templateName: string) {
        const rawTemplate = await fetchTemplateString(templateName)
        // e.g. "Write a {short|concise|bulleted} summary of {{ text }}"
        return rant(rawTemplate)
    },
}

const asker = new Asker({
    promptEngine: new PromptEngine(proceduralSource),
})

const result = await asker.prompt('summarize', { text: 'Article content...' })
```

---

## Modular Ecosystem Integrations

`@dharmax/llm-utils` integrates cleanly with the broader companion toolchain. See [docs/ecosystem.md](docs/ecosystem.md) for full architectural guides:

* **[`@dharmax/context-manager`](../context-manager)**: Hierarchical memory, RAG, and token budgeting.
* **[`@dharmax/block-patcher`](../block-patcher)**: Apply LLM-generated `SEARCH/REPLACE` code diffs directly to files.
* **[`@dharmax/codebase-parser`](../codebase-parser)**: Extract AST symbols, imports, and facts from 10+ languages (TS, Python, Rust, Go, Shell, etc.).
* **[`@dharmax/text-compiler`](../text-compiler)**: Compile natural language into deterministic JavaScript state machines.
* **[`@dharmax/pubsub`](../pubsub)**: Real-time telemetry, token metrics, and event broadcasting.

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
export { CompletionEngine, ModelRouter, PromptEngine, FileTemplateSource, ProviderCircuit, LlmMetrics, LLMSession } from '@dharmax/llm-utils'
export { parseStructuredJson, parseStructuredJsonResult, zodToJsonSchema, ProviderDiscovery } from '@dharmax/llm-utils'
```

---

## Development & Testing

```sh
# Node.js
npm run build      # Bundles with esbuild and emits declaration files
npm run typecheck  # Strict TypeScript check
npm test           # Executes test suite (25 tests)
npm run check      # Typecheck + tests

# Bun
bun test           # Runs all tests instantly in native TypeScript mode
```

---

## License

MIT © [dharmax](https://github.com/dharmax)
