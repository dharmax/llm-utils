import { PromptTemplate } from '../types.mjs';
import { TemplateSource } from '../core/interfaces.mjs';
export declare class PromptEngine {
    private source;
    constructor(source: TemplateSource);
    /**
     * Loads both .system.md and .prompt.md parts of a template.
     * Gold logic ported and enhanced from filesystem.mjs.
     */
    load(name: string): Promise<PromptTemplate>;
    parse(raw: string): PromptTemplate;
    render(template: string, variables: Record<string, any>): string;
}
