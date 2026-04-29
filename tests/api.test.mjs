import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Asker,
  CompletionEngine,
  ContextManager,
  LLMSession,
  ModelRouter,
  PromptEngine,
  ProviderDiscovery
} from '../dist/index.mjs';
import { HeuristicContextManager } from '../../context-manager/dist/index.mjs';

class MemoryTemplateSource {
  constructor(entries) {
    this.entries = entries;
  }

  async fetch(name) {
    return this.entries[name] ?? '';
  }
}

class MemoryContextStore {
  constructor(blocks = []) {
    this.blocks = blocks;
  }

  async query() {
    return this.blocks;
  }

  async add(block) {
    this.blocks.push(block);
  }

  async list() {
    return [...this.blocks];
  }

  async delete(id) {
    this.blocks = this.blocks.filter(block => block.id !== id);
  }
}

function registerEchoAdapter(id) {
  CompletionEngine.registerAdapter({
    id,
    async generate(options) {
      return {
        text: `adapter:${id}|model:${options.modelId}|prompt:${options.prompt}|system:${options.system ?? ''}`,
        ok: true,
        usage: {
          promptTokens: 3,
          completionTokens: 5,
          totalTokens: 8,
          available: true
        },
        model: {
          providerId: id,
          modelId: options.modelId
        },
        raw: { echoed: true }
      };
    }
  });
}

test('PromptEngine loads multipart templates, parses JSON frontmatter, and renders variables', async () => {
  const engine = new PromptEngine(new MemoryTemplateSource({
    'greeting.system': '--- json\n{"format":"json"}\n---\nSystem rules',
    'greeting.prompt': 'Hello {{ name }}<!-- hidden -->'
  }));

  const loaded = await engine.load('greeting');

  assert.equal(loaded.content, 'Hello {{ name }}');
  assert.equal(loaded.manifest.system, 'System rules');
  assert.equal(loaded.manifest.format, 'json');
  assert.equal(engine.render(loaded.content, { name: 'Ada' }), 'Hello Ada');
});

test('Asker supports providerState constructor and routes requests through registered adapters', async () => {
  const providerId = 'unit-provider-state';
  registerEchoAdapter(providerId);

  const asker = new Asker({
    providerState: {
      providers: {
        [providerId]: {
          id: providerId,
          available: true,
          models: [
            {
              id: 'model-1',
              providerId,
              quality: 'high',
              capabilities: { logic: 0.9, strategy: 0.7 }
            }
          ]
        }
      },
      routingPolicy: {},
      knowledge: {}
    }
  });

  const result = await asker.ask('ping', 'code-generation', { system: 'be terse' });

  assert.equal(result.ok, true);
  assert.equal(result.text.includes('prompt:ping'), true);
  assert.equal(result.response, result.text);
  assert.deepEqual(result.model, { providerId, modelId: 'model-1' });
});

test('Asker legacy constructor keeps prompt injection behavior', async () => {
  const providerId = 'unit-legacy';
  registerEchoAdapter(providerId);

  const promptEngine = new PromptEngine(new MemoryTemplateSource({
    'draft.system': '--- json\n{"taskType":"code-generation","inject":[{"type":"context_blocks","key":"context","categories":["docs"]}]}\n---\nStay grounded',
    'draft.prompt': 'Question: {{ inputText }}\nContext:\n{{ context }}'
  }));

  const contextManager = new ContextManager(new MemoryContextStore([
    {
      id: 'ctx-1',
      category: 'docs',
      tags: ['routing'],
      title: 'Routing Notes',
      body: 'Prefer the strongest available model for logic-heavy work.'
    }
  ]));

  const asker = new Asker(
    [{ id: providerId, available: true }],
    [
      {
        id: 'code-generation',
        shortName: 'code',
        description: 'Code generation',
        weights: { logic: 0.8, strategy: 0.2 }
      }
    ],
    contextManager,
    promptEngine
  );

  await asker.refreshMapping([
    {
      id: 'legacy-model',
      providerId,
      quality: 'high',
      capabilities: { logic: 0.95, strategy: 0.8 }
    }
  ]);

  const result = await asker.prompt('draft', {}, {
    inputText: 'Explain routing',
    context: '',
    taskType: 'code-generation'
  });

  assert.equal(result.ok, true);
  assert.equal(result.text.includes('Question: Explain routing'), true);
  assert.equal(result.text.includes('Routing Notes'), true);
  assert.equal(result.text.includes('Stay grounded'), true);
});

test('Asker accepts a protocol-based context manager from the external package', async () => {
  const providerId = 'unit-protocol';
  registerEchoAdapter(providerId);

  const promptEngine = new PromptEngine(new MemoryTemplateSource({
    'draft.system': '--- json\n{"taskType":"code-generation","inject":[{"type":"context_blocks","key":"context","categories":["docs"],"maxTokens":80,"maxItems":1}]}\n---\nStay grounded',
    'draft.prompt': 'Question: {{ inputText }}\nContext:\n{{ context }}'
  }));

  const contextManager = new HeuristicContextManager(new MemoryContextStore([
    {
      id: 'ctx-1',
      category: 'docs',
      tags: ['routing'],
      title: 'Routing Notes',
      body: 'Prefer the strongest available model for logic-heavy work.'
    },
    {
      id: 'ctx-2',
      category: 'docs',
      tags: ['storage'],
      title: 'Storage Notes',
      body: 'Separate the protocol from the implementation package.'
    }
  ]));

  const asker = new Asker(
    [{ id: providerId, available: true }],
    [
      {
        id: 'code-generation',
        shortName: 'code',
        description: 'Code generation',
        weights: { logic: 0.8, strategy: 0.2 }
      }
    ],
    contextManager,
    promptEngine
  );

  await asker.refreshMapping([
    {
      id: 'protocol-model',
      providerId,
      quality: 'high',
      capabilities: { logic: 0.95, strategy: 0.8 }
    }
  ]);

  const result = await asker.prompt('draft', {}, {
    inputText: 'Explain routing',
    context: '',
    taskType: 'code-generation'
  });

  assert.equal(result.ok, true);
  assert.equal(result.text.includes('Routing Notes'), true);
  assert.equal(result.text.includes('Storage Notes'), false);
});

test('LLMSession records history and metrics across successful turns', async () => {
  const providerId = 'unit-session';
  registerEchoAdapter(providerId);

  const promptEngine = new PromptEngine(new MemoryTemplateSource({
    'reply.system': '--- json\n{"taskType":"default"}\n---\nRespond helpfully',
    'reply.prompt': 'User said: {{ inputText }}'
  }));

  const asker = new Asker({
    providerState: {
      providers: {
        [providerId]: {
          id: providerId,
          available: true,
          models: [
            {
              id: 'session-model',
              providerId,
              quality: 'medium',
              capabilities: { logic: 0.7, strategy: 0.7, prose: 0.8, data: 0.5 }
            }
          ]
        }
      },
      routingPolicy: {},
      knowledge: {}
    },
    promptEngine
  });

  const session = new LLMSession(asker, { assistantName: 'Helper' });
  const result = await session.prompt('reply', { inputText: 'Hello there' });
  const context = session.getContext();

  assert.equal(result.ok, true);
  assert.equal(typeof result.latencyMs, 'number');
  assert.equal(context.history.length, 2);
  assert.equal(context.history[0].content, 'Hello there');
  assert.equal(context.metrics.totalTokens, 8);
});

test('ProviderDiscovery keeps built-in providers visible and normalizes ollama host', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        models: [
          { name: 'phi4', size: 2 * 1024 ** 3 }
        ]
      };
    }
  });

  try {
    const state = await ProviderDiscovery.discover(
      {
        providers: {
          ollama: { host: '127.0.0.1:11434' },
          openai: { apiKey: 'test-key' }
        }
      },
      {
        models: {
          openai: [{ id: 'gpt-test', providerId: 'openai' }]
        }
      }
    );

    assert.equal(state.providers.ollama.host, 'http://127.0.0.1:11434');
    assert.equal(state.providers.ollama.available, true);
    assert.equal(state.providers.openai.available, true);
    assert.equal(Array.isArray(state.providers.google.models), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ModelRouter.route prefers highest fit candidate and can prefer local models', () => {
  const remote = { id: 'remote', providerId: 'openai', fitScore: 60, local: false };
  const local = { id: 'local', providerId: 'ollama', fitScore: 55, local: true };

  assert.equal(ModelRouter.route([remote, local]).id, 'remote');
  assert.equal(ModelRouter.route([remote, local], { preferLocal: true }).id, 'local');
});
