import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Superb Context Compression logic.
 * Orchestrates between semantic logic and the lean-ctx CLI.
 */
export class ContextCompressor {
  /**
   * High-density semantic compression.
   */
  static compress(text: string, maxWords: number = 300): string {
    if (!text) return '';
    let result = text
      .replace(/as an AI language model/gi, '')
      .replace(/I am an AI assistant/gi, '')
      .replace(/In this context/gi, '')
      .replace(/\n\s*\n/g, '\n');

    const words = result.split(/\s+/);
    if (words.length <= maxWords) return result.trim();
    return words.slice(0, maxWords).join(' ') + '\n... [compressed]';
  }

  /**
   * Pattern-based compression using lean-ctx CLI.
   * Gold logic ported from lean-ctx.mjs.
   */
  static async patternCompress(text: string): Promise<string> {
    try {
      // Logic from lean-ctx.mjs: use CLI for tool-specific compression
      const { stdout } = await execFileAsync("lean-ctx", ["-c", text], {
        maxBuffer: 1024 * 1024
      });
      return stdout.trim();
    } catch {
      // Fallback to semantic compression if CLI is missing
      return this.compress(text);
    }
  }

  static densify(history: any[]): string {
    return history.map(h => `[${h.role.toUpperCase()}] ${this.compress(h.content, 50)}`).join('\n');
  }
}
