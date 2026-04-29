import { ContextBlock } from '../context/context-manager.mjs';

/**
 * Superb Abstraction for Context Storage.
 * Hides whether it is SQLite, Vector DB, or In-memory.
 */
export interface StorageBackend {
  query(text: string, categories: string[]): Promise<ContextBlock[]>;
  store(block: ContextBlock): Promise<void>;
  list(): Promise<ContextBlock[]>;
  delete(id: string): Promise<void>;
}

/**
 * Superb Abstraction for Prompt Libraries.
 * Hides whether it is Local Filesystem or Web API.
 */
export interface TemplateSource {
  fetch(name: string): Promise<string>;
  load?(name: string): Promise<string>; // Compatibility alias
}
