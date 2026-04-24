/**
 * Superb Context Compression logic.
 * Orchestrates between semantic logic and the lean-ctx CLI.
 */
export declare class ContextCompressor {
    /**
     * High-density semantic compression.
     */
    static compress(text: string, maxWords?: number): string;
    /**
     * Pattern-based compression using lean-ctx CLI.
     * Gold logic ported from lean-ctx.mjs.
     */
    static patternCompress(text: string): Promise<string>;
    static densify(history: any[]): string;
}
