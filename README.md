# @dharmax/llm-utils

Small TypeScript primitives for LLM-powered tools:

- `Asker` executes direct or template-backed requests.
- `CompletionEngine` owns and dispatches provider adapters per client instance.
- Provider failures preserve kind, HTTP status, provider code, retryability, and fatality.
- `parseStructuredJson` extracts, repairs, and validates model JSON.
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

`CompletionEngine` has no static registry. Separate instances cannot leak custom
adapters or test state into each other.

## Structured JSON

```ts
import {parseStructuredJson} from '@dharmax/llm-utils'

const data = parseStructuredJson(rawReply, 'book analysis', zodSchema)
```

The parser accepts direct JSON, fenced JSON, embedded objects/arrays, and
deterministically repairable JSON-shaped text. It does not turn arbitrary prose
into a valid JSON string. The schema only needs a `safeParse()` method, so the
package does not force a validation library on consumers.

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
- structured responses: `parseStructuredJson`, `StructuredJsonError`
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
