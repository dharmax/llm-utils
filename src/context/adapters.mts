import { ContextBlock, ContextManager } from './context-manager.mjs';
import { ContextItem, ContextRequest, ContextResult, PromptContextManager } from './protocol.mjs';
import { renderContextItems } from './render.mjs';

export function contextBlocksToItems(blocks: ContextBlock[]): ContextItem[] {
  return blocks.map(block => ({
    id: block.id,
    kind: 'note',
    title: block.title,
    content: block.body,
    source: block.category,
    metadata: {
      category: block.category,
      tags: block.tags
    }
  }));
}

export class LegacyContextManagerAdapter implements PromptContextManager {
  constructor(private legacyManager: ContextManager) {}

  async resolve(request: ContextRequest): Promise<ContextResult> {
    const blocks = await this.legacyManager.getRelevantBlocks(request.query, request.categories ?? []);
    const items = contextBlocksToItems(blocks);

    return {
      items,
      rendered: renderContextItems(items, request.output?.format ?? 'markdown'),
      diagnostics: {
        strategy: 'legacy-context-manager',
        budget: {
          requested: request.maxTokens
        }
      }
    };
  }
}

export function isPromptContextManager(value: unknown): value is PromptContextManager {
  return !!value && typeof value === 'object' && typeof (value as PromptContextManager).resolve === 'function';
}

export function isLegacyContextManager(value: unknown): value is ContextManager {
  return !!value && typeof value === 'object' && typeof (value as ContextManager).getRelevantBlocks === 'function';
}
