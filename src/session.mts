import { Asker } from './asker.mjs';
import { ContextCompressor } from './context.mjs';
import { MetricsEngine } from './metrics.mjs';
import { GenerationResult, SessionContext } from './types.mjs';

export class LLMSession {
  private context: SessionContext;
  private metrics: MetricsEngine;

  constructor(
    private asker: Asker,
    private toolkit: any = {},
    initialContext?: SessionContext
  ) {
    this.context = initialContext ?? { history: [] };
    this.metrics = new MetricsEngine();
  }

  async prompt(templateName: string, data: any): Promise<GenerationResult> {
    const promptEngine = this.asker.getPromptEngine();
    const { manifest } = await promptEngine.load(templateName);

    for (const step of manifest.preflight ?? []) await this.runPreflightStep(step, data);

    this.context.managedContext = ContextCompressor.densify(this.context.history);
    const enrichedData = {
      ...data,
      ...this.toolkit,
      history: this.context.history,
      managedContext: this.context.managedContext
    };

    const startedAt = Date.now();
    const result = await this.asker.prompt(templateName, this.toolkit, enrichedData);
    const latencyMs = Date.now() - startedAt;

    if (result.ok) {
      this.metrics.record(result, latencyMs);
      this.context.metrics = this.metrics.getReport();
      this.context.history.push({ role: 'user', content: data.inputText ?? 'Prompt' });
      this.context.history.push({ role: 'ai', content: result.text });
      this.context.history = this.context.history.slice(-20);
    }

    return { ...result, latencyMs };
  }

  getContext(): SessionContext {
    return this.context;
  }

  private async runPreflightStep(step: any, data: any): Promise<void> {
    void step;
    void data;
  }
}
