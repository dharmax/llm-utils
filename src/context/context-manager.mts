export interface ContextBlock {
  id: string;
  category: string;
  tags: string[];
  title: string;
  body: string;
}

/**
 * Abstract interface for context storage (SQL, Vector, etc.).
 */
export interface ContextStore {
  query(text: string, categories: string[]): Promise<ContextBlock[]>;
  add(block: ContextBlock): Promise<void>;
  list(): Promise<ContextBlock[]>;
}

export class ContextManager {
  private store: ContextStore;

  constructor(store: ContextStore) {
    this.store = store;
  }

  /**
   * Retrieves relevant blocks based on input text and categories.
   * Logic ported from guidelines.mjs.
   */
  async getRelevantBlocks(inputText: string, categories: string[] = []): Promise<ContextBlock[]> {
    const lowerInput = inputText.toLowerCase();
    const blocks = await this.store.query(inputText, categories);

    return blocks
      .map(block => {
        let score = 0;
        
        // Tag match = high priority
        for (const tag of block.tags) {
          if (tag && lowerInput.includes(tag.toLowerCase())) score += 10;
        }

        // Title match = medium priority
        if (lowerInput.includes(block.title.toLowerCase())) score += 5;

        return { block, score };
      })
      .filter(res => res.score > 0 || categories.length > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(res => res.block);
  }

  async addBlock(block: ContextBlock) {
    await this.store.add(block);
  }
}
