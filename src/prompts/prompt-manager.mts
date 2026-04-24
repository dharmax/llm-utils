import { PromptTemplate } from '../types.mjs';

export interface PromptVariables {
  [key: string]: string | number | boolean | any;
}

/**
 * Abstract interface for template loading.
 */
export interface FileSystemAdapter {
  readTemplate(name: string): Promise<string>;
}

export class PromptManager {
  private fs: FileSystemAdapter;

  constructor(fs: FileSystemAdapter) {
    this.fs = fs;
  }

  /**
   * Loads and parses a template.
   */
  async load(name: string): Promise<PromptTemplate> {
    const raw = await this.fs.readTemplate(name);
    return this.parse(raw);
  }

  /**
   * Parses a raw markdown template, extracting JSON frontmatter and stripping comments.
   * Logic ported from filesystem.mjs.
   */
  parse(raw: string): PromptTemplate {
    let manifest = {};
    let content = raw;

    // Extract JSON frontmatter: ---json ... ---
    const frontmatterMatch = raw.match(/^---\s*json\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
    if (frontmatterMatch) {
      try {
        manifest = JSON.parse(frontmatterMatch[1]);
        content = raw.slice(frontmatterMatch[0].length);
      } catch (e) {
        console.warn('[prompt-manager] Failed to parse JSON frontmatter');
      }
    }

    // Strip comments: <!-- anything -->
    content = content.replace(/<!--[\s\S]*?-->/g, '').trim();

    return { content, manifest };
  }

  /**
   * Renders a template by injecting variables into {{placeholders}}.
   * Logic ported from filesystem.mjs.
   */
  render(content: string, variables: PromptVariables = {}): string {
    let rendered = content;
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{[ \\t]*${key}[ \\t]*\\}\\}`, 'g');
      rendered = rendered.replace(regex, String(value ?? ''));
    }
    return rendered;
  }
}
