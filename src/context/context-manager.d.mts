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
export declare class ContextManager {
    private store;
    constructor(store: ContextStore);
    /**
     * Retrieves relevant blocks based on input text and categories.
     * Logic ported from guidelines.mjs.
     */
    getRelevantBlocks(inputText: string, categories?: string[]): Promise<ContextBlock[]>;
    addBlock(block: ContextBlock): Promise<void>;
}
