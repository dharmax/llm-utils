# @dharmax/llm-utils

`@dharmax/llm-utils` is a small TypeScript toolkit for building LLM-powered command-line and service workflows with a stable set of primitives:

- `Asker` for request execution
- `CompletionEngine` for provider adapter dispatch
- `ModelRouter` for lightweight model selection
- `PromptEngine` for multi-part prompt templates
- `LLMSession` for short conversational state and usage tracking
- `ProviderDiscovery` for normalizing configured providers

It is designed to be usable by both humans and AI agents:

- Humans get a compact library with explicit types and small building blocks.
- Agents get predictable entry points, deterministic template loading, and a simple adapter registration model.

## What This Package Is

This package is not an all-in-one framework. It is a thin orchestration layer that helps you:

- represent providers and models consistently
- route tasks to a suitable model
- render prompt templates from reusable files or sources
- execute requests through pluggable adapters
- keep lightweight session history and metrics

## What This Package Is Not

- It is not a full agent runtime.
- It is not a workflow database.
- It does not manage prompt storage for you.
- It does not auto-install provider SDKs.
- It does not currently include a deep integration test suite against live provider APIs.

## Installation

```bash
npm install @dharmax/llm-utils
```

## Core Concepts

### Providers and Adapters

A provider is a logical backend such as OpenAI, Anthropic, Google, Ollama, or a custom internal service.

`CompletionEngine` dispatches generation calls to registered adapters. Built-in adapters are registered for:

- `openai`
- `anthropic`
- `google`
- `ollama`

You can also register your own adapter:

```ts
import { CompletionEngine } from '@dharmax/llm-utils';

CompletionEngine.registerAdapter({
  id: 'mock',
  async generate(options) {
    return {
      text: `Echo: ${options.prompt}`,
      ok: true,
      model: {
        providerId: 'mock',
        modelId: options.modelId
      }
    };
  }
});
```

### Provider State

`Asker` can be constructed from normalized provider state:

```ts
import { Asker } from '@dharmax/llm-utils';

const asker = new Asker({
  providerState: {
    providers: {
      openai: {
        id: 'openai',
        available: true,
        apiKey: process.env.OPENAI_API_KEY,
        models: [
          {
            id: 'gpt-4o-mini',
            providerId: 'openai',
            quality: 'high',
            capabilities: {
              logic: 0.8,
              strategy: 0.7,
              prose: 0.8,
              data: 0.7
            }
          }
        ]
      }
    },
    routingPolicy: {},
    knowledge: {}
  }
});
```

### Prompt Templates

`PromptEngine` loads two parts per prompt name:

- `<name>.system`
- `<name>.prompt`

Each part can optionally start with JSON frontmatter:

```md
--- json
{"taskType":"code-generation","format":"json"}
---
```

The prompt body supports `{{ variable }}` placeholders.

## Usage

### 1. Direct Request Execution

```ts
import { Asker } from '@dharmax/llm-utils';

const result = await asker.ask('Summarize this file', 'summarization', {
  system: 'Return a concise answer.'
});

if (!result.ok) {
  throw new Error(result.error);
}

console.log(result.text);
```

### 2. Template-Driven Execution

The recommended path is a pluggable context manager implementation package. `@dharmax/llm-utils` owns the protocol and prompt integration; a separate package owns retrieval, budgeting, and compression policy.

```ts
import { Asker, PromptEngine } from '@dharmax/llm-utils';
import { HeuristicContextManager } from '@dharmax/context-manager';

const promptEngine = new PromptEngine(templateSource);
const contextManager = new HeuristicContextManager(contextStore, {
  defaultMaxTokens: 500
});

const asker = new Asker(
  providerConfigs,
  taskTypes,
  contextManager,
  promptEngine
);
```

For local development in this repo, the sibling package lives at `../context-manager`.

The legacy constructor remains supported for template workflows that still use the block-oriented `ContextManager`:

```ts
import {
  Asker,
  ContextManager,
  PromptEngine
} from '@dharmax/llm-utils';

const promptEngine = new PromptEngine(templateSource);
const contextManager = new ContextManager(contextStore);

const asker = new Asker(
  providerConfigs,
  taskTypes,
  contextManager,
  promptEngine
);

await asker.refreshMapping(availableModels);

const result = await asker.prompt('draft-response', {}, {
  inputText: 'Explain the architecture',
  taskType: 'architecture'
});
```

### 3. Session-Based Execution

`LLMSession` adds short history retention, compressed managed context, and usage metrics:

```ts
import { LLMSession } from '@dharmax/llm-utils';

const session = new LLMSession(asker, { project: 'demo' });
const result = await session.prompt('reply', { inputText: 'What changed?' });

console.log(result.text);
console.log(session.getContext());
```

### 4. Discovery

`ProviderDiscovery` normalizes configured providers and probes Ollama:

```ts
import { ProviderDiscovery } from '@dharmax/llm-utils';

const providerState = await ProviderDiscovery.discover(
  {
    providers: {
      ollama: { host: '127.0.0.1:11434' },
      openai: { apiKey: process.env.OPENAI_API_KEY }
    }
  },
  {
    models: {
      openai: [{ id: 'gpt-4o-mini', providerId: 'openai' }]
    }
  }
);
```

## Public API

Main exports:

- `Asker`
- `CompletionEngine`
- `ContextResult`, `ContextRequest`, and `PromptContextManager`
- `LegacyContextManagerAdapter`
- `ContextCompressor`
- `ContextManager`
- `LLMSession`
- `MetricsEngine`
- `ModelRouter`
- `PromptEngine`
- `ProviderDiscovery`
- built-in adapters such as `OpenAIAdapter` and `OllamaProvider`
- all core TypeScript types from `types.mjs`

## Development

Build:

```bash
npm run build
```

Test:

```bash
npm test
```

The test suite exercises the built package in `dist/`, not only the source files. That helps catch packaging and export regressions.

## Current Limitations

- The built-in `ContextManager` remains a legacy block-oriented API for compatibility.
- The default external context package is still heuristic rather than semantic.
- Prompt template manifests are JSON-frontmatter only.
- The package currently uses minimal fake-free unit coverage rather than live provider integration tests.
- `LLMSession` keeps a short in-memory history and is not persistence-backed.

## Repository Hygiene

Local workflow and editor artifacts are intentionally ignored:

- `.ai-workflow/`
- `.codex`
- `.idea/`
- `epics.md`
- `kanban.md`

## License

MIT
