import { Asker } from '../asker.mjs';
import { InteractionTurn, GenerationResult, SessionContext } from '../types.mjs';
import { ContextCompressor } from '../context/compressor.mjs';
import { MetricsEngine } from '../logic/metrics.mjs';

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

  /**
   * High-fidelity interaction with Grounding Loop and Metrics.
   */
  async prompt(templateName: string, data: any): Promise<GenerationResult> {
    const promptEngine = this.asker.getPromptEngine();
    const { manifest } = await promptEngine.load(templateName);

    // 1. Pre-flight Grounding
    if (manifest.preflight) {
      for (const step of manifest.preflight) {
        await this.runPreflightStep(step, data);
      }
    }

    // 2. Continuous Condensation
    this.context.managedContext = ContextCompressor.densify(this.context.history);

    // 3. Main Turn
    const enrichedData = {
      ...data,
      ...this.toolkit,
      history: this.context.history,
      managedContext: this.context.managedContext
    };

    const startTime = Date.now();
    const result = await this.asker.prompt(templateName, this.toolkit, enrichedData);
    const latencyMs = Date.now() - startTime;

    // 4. Record Metrics
    if (result.ok) {
      this.metrics.record(result, latencyMs);
      this.context.metrics = this.metrics.getReport();
      
      // Update History
      this.context.history.push({ role: 'user', content: data.inputText || 'Prompt' });
      this.context.history.push({ role: 'ai', content: result.text });
      
      if (this.context.history.length > 20) {
        this.context.history = this.context.history.slice(-20);
      }
    }

    return {
      ...result,
      latencyMs
    };
  }

  private async runPreflightStep(step: any, data: any) {
    console.log(`[session] Running preflight grounding: ${step.type}`);
  }

  getContext(): SessionContext {
    return this.context;
  }
}
