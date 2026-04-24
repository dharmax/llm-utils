import { PromptTemplate } from '../types.mjs';
import { TemplateSource } from '../core/interfaces.mjs';

export class PromptEngine {
  constructor(private source: TemplateSource) {}

  /**
   * Loads both .system.md and .prompt.md parts of a template.
   * Gold logic ported and enhanced from filesystem.mjs.
   */
  async load(name: string): Promise<PromptTemplate> {
    // Porting high-fidelity multi-part template loading
    const systemRaw = await this.source.fetch(`${name}.system`).catch(() => '');
    const promptRaw = await this.source.fetch(`${name}.prompt`).catch(() => '');

    const system = this.parse(systemRaw);
    const prompt = this.parse(promptRaw);

    return {
      content: prompt.content,
      manifest: {
        ...system.manifest,
        ...prompt.manifest,
        system: system.content
      }
    };
  }

  parse(raw: string): PromptTemplate {
    if (!raw) return { content: '', manifest: {} };
    
    let manifest: any = {};
    let content = raw;

    const frontmatterMatch = raw.match(/^---\s*json\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
    if (frontmatterMatch) {
      try {
        manifest = JSON.parse(frontmatterMatch[1]);
        content = raw.slice(frontmatterMatch[0].length);
      } catch (e) {
        console.error('[prompt-engine] JSON parse error:', e);
      }
    }

    content = content.replace(/<!--[\s\S]*?-->/g, '').trim();
    return { content, manifest };
  }

  render(template: string, variables: Record<string, any>): string {
    let rendered = template;
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{[ \\t]*${key}[ \\t]*\\}\\}`, 'g');
      rendered = rendered.replace(regex, String(value ?? ''));
    }
    return rendered;
  }
}
