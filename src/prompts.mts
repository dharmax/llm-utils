import { PromptTemplate } from './types.mjs';

export interface TemplateSource {
  fetch?(name: string): Promise<string>;
  load?(name: string): Promise<string>;
}

export class PromptEngine {
  constructor(private source: TemplateSource = {}) {}

  async load(name: string): Promise<PromptTemplate> {
    const load = this.source.fetch ?? this.source.load ?? (async () => '');
    const system = this.parse(await load.call(this.source, `${name}.system`).catch(() => ''));
    const prompt = this.parse(await load.call(this.source, `${name}.prompt`).catch(() => ''));

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

    let manifest: Record<string, any> = {};
    let content = raw;
    const match = raw.match(/^---\s*json\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);

    if (match) {
      try {
        manifest = JSON.parse(match[1]);
        content = raw.slice(match[0].length);
      } catch {
        manifest = {};
      }
    }

    return {
      content: content.replace(/<!--[\s\S]*?-->/g, '').trim(),
      manifest
    };
  }

  render(template: string, variables: Record<string, any> = {}): string {
    let rendered = template;
    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\{\\{[ \\t]*${escapeRegExp(key)}[ \\t]*\\}\\}`, 'g');
      rendered = rendered.replace(pattern, String(value ?? ''));
    }
    return rendered;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
