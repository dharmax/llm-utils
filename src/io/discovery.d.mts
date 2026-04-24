import { ProviderState } from '../types.mjs';
export interface DiscoveryOptions {
    forceRefresh?: boolean;
    cacheTtlMs?: number;
}
/**
 * Plucked from core/services/providers.mjs
 * Handles the discovery of local and remote models.
 */
export declare class ProviderDiscovery {
    /**
     * Probes Ollama for installed models with CLI fallback.
     */
    static probeOllama(host?: string): Promise<any>;
    /**
     * Normalizes configured provider models and status.
     */
    static discover(config: any, knowledge: any): Promise<ProviderState>;
    /**
     * High-fidelity maintenance logic ported from providers.mjs
     */
    static refreshQuotaState(options: any): Promise<any>;
}
