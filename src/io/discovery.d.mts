import { ProviderState } from '../types.mjs';
export interface DiscoveryOptions {
    forceRefresh?: boolean;
    cacheTtlMs?: number;
}
/**
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
    static refreshQuotaState(options: any): Promise<any>;
}
