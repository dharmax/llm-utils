import { ContextItem, ContextResult } from './protocol.mjs';

export function renderContextItems(items: ContextItem[], format: 'markdown' | 'plain' = 'markdown'): string {
  if (!items.length) return '';

  if (format === 'plain') {
    return items
      .map(item => `${item.title}\n${item.content}`.trim())
      .join('\n\n');
  }

  return items
    .map(item => `### ${item.title}\n${item.content}`.trim())
    .join('\n\n');
}

export function renderContextResult(result: ContextResult, format: 'markdown' | 'plain' = 'markdown'): string {
  if (typeof result.rendered === 'string') return result.rendered;
  return renderContextItems(result.items ?? [], format);
}
