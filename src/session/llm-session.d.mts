import { Asker } from '../asker.mjs';
import { GenerationResult, SessionContext } from '../types.mjs';
export declare class LLMSession {
    private asker;
    private toolkit;
    private context;
    private metrics;
    constructor(asker: Asker, toolkit?: any, initialContext?: SessionContext);
    /**
     * High-fidelity interaction with Grounding Loop and Metrics.
     */
    prompt(templateName: string, data: any): Promise<GenerationResult>;
    private runPreflightStep;
    getContext(): SessionContext;
}
