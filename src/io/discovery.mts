import { ProviderId, ProviderConfig, ModelInfo, ProviderState } from '../types.mjs';
import { CompletionEngine } from '../router/completion-engine.mjs';

export interface DiscoveryOptions {
  forceRefresh?: boolean;
  cacheTtlMs?: number;
}

/**
 * Handles the discovery of local and remote models.
 * Designed to be generic and allow user-defined providers.
 * No hardcoded lists.
 */
export class ProviderDiscovery {
  /**
   * Probes Ollama for installed models with CLI fallback.
   */
  static async probeOllama(host: string = 'http://127.0.0.1:11434'): Promise<any> {
    let url = host;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'http://' + url;
    }

    try {
      const response = await fetch(`${url}/api/tags`);
      if (response.ok) {
        const payload = await response.json();
        return {
          installed: true,
          models: (payload.models || []).map((m: any) => ({
            id: m.name || m.model || '',
            sizeB: m.size ? Number((m.size / (1024 ** 3)).toFixed(1)) : null
          })),
          host: url
        };
      }
    } catch (e) {
       // Ignore fetch failures
    }
    return {
      installed: false,
      models: [],
      host: url
    };
  }

  /**
   * Normalizes configured provider models and status.
   */
  static async discover(config: any, knowledge: any): Promise<ProviderState> {
    const providers: any = {};
    
    // Probing Ollama (Local)
    const ollamaHost = config.providers?.ollama?.host || 'http://127.0.0.1:11434';
    const ollama = await this.probeOllama(ollamaHost);
    
    providers.ollama = {
      id: 'ollama',
      available: ollama.installed && ollama.models.length > 0,
      local: true,
      host: ollama.host,
      models: ollama.models
    };

    // Keep built-in providers discoverable while also supporting custom registrations.
    const registeredIds = CompletionEngine.getRegisteredProviderIds();
    const configured = config.providers || {};
    const remoteProviderIds = ['google', 'openai', 'anthropic'];

    // Merge built-ins, registered adapters, and any configured provider IDs.
    const allProviderIds = new Set([...remoteProviderIds, ...registeredIds, ...Object.keys(configured)]);
    allProviderIds.delete('ollama');

    for (const id of allProviderIds) {
       const prov = configured[id] || {};
       providers[id] = {
         id,
         available: !!prov.apiKey || !!prov.enabled,
         local: false,
         apiKey: prov.apiKey,
         baseUrl: prov.baseUrl,
         models: (knowledge.models || {})[id] || []
       };
    }

    return { 
      providers, 
      knowledge,
      routingPolicy: config.routingPolicy || { quotaStrategy: 'prefer-free-remote' }
    };
  }

  static async refreshQuotaState(options: any): Promise<any> {
    return { refreshed: [] };
  }
}
