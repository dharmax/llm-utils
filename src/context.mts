export type ContextHistoryRole = 'user' | 'ai' | 'system' | string;

export interface ContextHistoryItem {
  role: ContextHistoryRole;
  content: string;
}

export interface ContextRequest {
  query: string;
  taskType?: string;
  maxTokens?: number;
  maxItems?: number;
  categories?: string[];
  history?: ContextHistoryItem[];
  hints?: {
    filePaths?: string[];
    symbolNames?: string[];
    sources?: string[];
    preferDense?: boolean;
  };
  output?: {
    mode?: 'rendered' | 'items' | 'both';
    format?: 'markdown' | 'plain';
  };
}

export type ContextItemKind =
  | 'guideline'
  | 'knowledge'
  | 'history'
  | 'file'
  | 'symbol'
  | 'note'
  | 'custom';

export interface ContextItem {
  id: string;
  kind: ContextItemKind;
  title: string;
  content: string;
  score?: number;
  source?: string;
  src?: string;
  metadata?: Record<string, unknown>;
  rationale?: string[];
}

export interface ContextDiagnostics {
  strategy: string;
  budget?: {
    requested?: number;
    used?: number;
  };
  excluded?: Array<{ id: string; reason: string }>;
  warnings?: string[];
}

export interface ContextResult {
  rendered?: string;
  items?: ContextItem[];
  diagnostics?: ContextDiagnostics;
}

export interface PromptContextManager {
  resolve(request: ContextRequest): Promise<ContextResult>;
}

export interface ContextBlock {
  id: string;
  category: string;
  tags: string[];
  title: string;
  body: string;
}

export interface ContextStore {
  query(text: string, categories: string[]): Promise<ContextBlock[]>;
  add(block: ContextBlock): Promise<void>;
  list(): Promise<ContextBlock[]>;
}

export class ContextManager {
  constructor(private store: ContextStore) {}

  async getRelevantBlocks(inputText: string, categories: string[] = []): Promise<ContextBlock[]> {
    const lowerInput = inputText.toLowerCase();
    const blocks = await this.store.query(inputText, categories);

    return blocks
      .map((block) => ({
        block,
        score:
          block.tags.reduce((score, tag) => score + (tag && lowerInput.includes(tag.toLowerCase()) ? 10 : 0), 0) +
          (lowerInput.includes(block.title.toLowerCase()) ? 5 : 0)
      }))
      .filter(({ score }) => score > 0 || categories.length > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10)
      .map(({ block }) => block);
  }

  async addBlock(block: ContextBlock): Promise<void> {
    await this.store.add(block);
  }
}

export function contextBlocksToItems(blocks: ContextBlock[]): ContextItem[] {
  return blocks.map((block) => ({
    id: block.id,
    kind: 'knowledge',
    title: block.title,
    content: block.body,
    metadata: {
      category: block.category,
      tags: block.tags
    }
  }));
}

export class LegacyContextManagerAdapter implements PromptContextManager {
  constructor(private manager: ContextManager) {}

  async resolve(request: ContextRequest): Promise<ContextResult> {
    const blocks = await this.manager.getRelevantBlocks(request.query, request.categories ?? []);
    const items = contextBlocksToItems(blocks).slice(0, request.maxItems ?? blocks.length);
    return {
      items,
      rendered: renderContextItems(items, request.output?.format ?? 'markdown'),
      diagnostics: {
        strategy: 'legacy-context-manager'
      }
    };
  }
}

export function isPromptContextManager(value: unknown): value is PromptContextManager {
  return Boolean(value && typeof (value as PromptContextManager).resolve === 'function');
}

export function isLegacyContextManager(value: unknown): value is ContextManager {
  return Boolean(value && typeof (value as ContextManager).getRelevantBlocks === 'function');
}

export function renderContextItems(items: ContextItem[], format: 'markdown' | 'plain' = 'markdown'): string {
  if (format === 'plain') {
    return items.map((item) => `${item.title}\n${item.content}`).join('\n\n');
  }
  return items.map((item) => `### ${item.title}\n${item.content}`).join('\n\n');
}

export function renderContextResult(result: ContextResult, format: 'markdown' | 'plain' = 'markdown'): string {
  if (result.rendered) return result.rendered;
  return renderContextItems(result.items ?? [], format);
}

export class ContextCompressor {
  static compress(text: string, maxWords: number = 300): string {
    if (!text) return '';
    const cleaned = text
      .replace(/as an AI language model/gi, '')
      .replace(/I am an AI assistant/gi, '')
      .replace(/In this context/gi, '')
      .replace(/\n\s*\n/g, '\n')
      .trim();

    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length <= maxWords) return cleaned;
    return `${words.slice(0, maxWords).join(' ')}\n... [compressed]`;
  }

  static densify(history: Array<{ role: string; content: string }>): string {
    return history.map((turn) => `[${turn.role.toUpperCase()}] ${this.compress(turn.content, 50)}`).join('\n');
  }
}
