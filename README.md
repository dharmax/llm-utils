# @dharmax/llm-utils

Small TypeScript primitives for LLM-powered tools:

- `Asker` executes direct or template-backed requests.
- `CompletionEngine` owns and dispatches provider adapters per client instance.
- Provider failures preserve kind, HTTP status, provider code, retryability, and fatality.
- `requestStructuredJson` executes one substantive request, then performs local
  extraction/repair/validation and optional bounded corrective requests.
- `ModelRouter` scores and selects models.
- `PromptEngine` loads `.system` and `.prompt` template parts.
- `ContextManager` and `PromptContextManager` support lightweight prompt injection.
- `LLMSession` keeps short in-memory history and metrics.
- `LlmMetrics` aggregates usage, latency, failures, and cost.
- `ProviderDiscovery` normalizes configured providers and probes Ollama.

This is not an agent runtime, workflow database, prompt repository, or provider SDK installer.

## Install

```sh
npm install @dharmax/llm-utils
```

## Direct Request

```ts
import {Asker, CompletionEngine} from '@dharmax/llm-utils'

const completion = new CompletionEngine([]).registerAdapter({
    id: 'mock',
    async generate(options) {
        return {
            text: `Echo: ${options.prompt}`,
            ok: true,
            model: {providerId: 'mock', modelId: options.modelId},
        }
    },
})

const asker = new Asker({
    providerState: {
        providers: {
            mock: {
                id: 'mock',
                available: true,
                models: [{id: 'mock-1', providerId: 'mock', quality: 'medium'}],
            },
        },
    },
    completion,
})

const result = await asker.ask('Summarize this file', 'summarization')
console.log(result.text)
```

Use `asker.askExact(prompt, {providerId, modelId})` or
`asker.promptExact(templateName, data, {providerId, modelId})` when an
application—not the router—owns model selection.

`CompletionEngine` has no static registry. Separate instances cannot leak custom
adapters or test state into each other.

The package ships its TypeScript source as its type entrypoint and Bun runtime
entrypoint; Node uses the built ESM bundle. Exact Git dependencies therefore work
without lifecycle scripts or committed build artifacts.

## Structured JSON

```ts
import {requestStructuredJson, z} from '@dharmax/llm-utils'

const schema = z.object({summary: z.string()})
const result = await requestStructuredJson({
    label: 'book analysis',
    schema,
    execute: request => asker.promptExact(
        'book-analysis',
        input,
        target,
        {format: request.responseFormat},
    ),
})
if (!result.ok)
    throw new Error(result.message)
console.log(result.data)
```

The package owns Zod 4 and re-exports `z`. It converts safely representable Zod
schemas to provider JSON Schema, accepts an explicit provider-schema override,
and falls back to generic JSON mode while retaining full local Zod validation
for transforms, preprocessors, custom refinements, and other semantic checks.

The parser accepts object or array roots from direct JSON, fenced JSON, or
surrounding prose. Candidate extraction is balanced and quote-aware; it rejects
scalars and arbitrary prose. When a schema is supplied, every deterministic
candidate is considered until one validates.

See [docs/structured-output.md](docs/structured-output.md) for provider mapping,
fallback, diagnostics, checkpoint validation, and correction semantics.

## Fatal-provider circuit

`ProviderCircuit` wraps requests and opens only when a typed provider failure is
marked `fatal`. Later calls return a typed failure without contacting that
provider. Create one circuit per client or application run; no state is global.

## Templates And Context

`PromptEngine` loads two optional parts per template name:

- `<name>.system`
- `<name>.prompt`

Each part can start with JSON frontmatter:

```text
--- json
{"taskType":"code-generation","format":"json"}
---
System or prompt body with {{ variables }}.
```

For context injection, pass either the built-in `ContextManager` or any object implementing:

```ts
interface PromptContextManager {
  resolve(request: ContextRequest): Promise<ContextResult>;
}
```

## Metrics

```ts
import { LlmMetrics, InMemoryMetricsStore } from '@dharmax/llm-utils';

const metrics = new LlmMetrics(new InMemoryMetricsStore());
metrics.record({
  timestamp: new Date().toISOString(),
  providerId: 'openai',
  modelId: 'gpt-4o-mini',
  promptTokens: 10,
  completionTokens: 20,
  latencyMs: 500,
  success: true
});

console.log(metrics.totals());
```

## Public API

The root export intentionally contains the package capabilities without exposing the old directory structure:

- request/session: `Asker`, `LLMSession`
- completion/adapters: `CompletionEngine`, typed `LlmFailure`, `OpenAIAdapter`, `AnthropicAdapter`, `GoogleAdapter`, `OllamaProvider`
- structured responses: `z`, `zodToJsonSchema`, `resolveStructuredOutput`,
  `requestStructuredJson`, `parseStructuredJsonResult`,
  `parseStructuredJson`, `validateStructuredValue`, `StructuredJsonError`
- request lifecycle: `ProviderCircuit`
- routing: `ModelRouter`, `RouterHeuristics`
- prompts/context: `PromptEngine`, `ContextManager`, `ContextCompressor`
- metrics: `LlmMetrics`, `MetricsEngine`, `InMemoryMetricsStore`
- discovery/system: `ProviderDiscovery`, `SystemProbe`
- public types from the same root entry

## Development

```sh
npm run build
npm test
```
