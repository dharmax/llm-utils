import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CompletionEngine } from './completion.mjs';
import { ProviderState, SystemStatus } from './types.mjs';

const execFileAsync = promisify(execFile);

export interface DiscoveryOptions {
  forceRefresh?: boolean;
  cacheTtlMs?: number;
}

export class ProviderDiscovery {
  static async probeOllama(host: string = 'http://127.0.0.1:11434'): Promise<{ installed: boolean; models: any[]; host: string }> {
    const url = host.startsWith('http://') || host.startsWith('https://') ? host : `http://${host}`;
    try {
      const response = await fetch(`${url}/api/tags`);
      if (response.ok) {
        const payload = await response.json();
        return {
          installed: true,
          models: (payload.models ?? []).map((model: any) => ({
            id: model.name ?? model.model ?? '',
            sizeB: model.size ? Number((model.size / 1024 ** 3).toFixed(1)) : null,
            providerId: 'ollama',
            local: true
          })),
          host: url
        };
      }
    } catch {
      return { installed: false, models: [], host: url };
    }
    return { installed: false, models: [], host: url };
  }

  static async discover(config: any = {}, knowledge: any = {}): Promise<ProviderState> {
    const configured = config.providers ?? {};
    const ollama = await this.probeOllama(configured.ollama?.host ?? 'http://127.0.0.1:11434');
    const providers: ProviderState['providers'] = {
      ollama: {
        id: 'ollama',
        available: ollama.installed && ollama.models.length > 0,
        local: true,
        host: ollama.host,
        models: ollama.models
      }
    };

    const providerIds = new Set([
      'google',
      'openai',
      'anthropic',
      ...CompletionEngine.getRegisteredProviderIds(),
      ...Object.keys(configured)
    ]);
    providerIds.delete('ollama');

    for (const id of providerIds) {
      const provider = configured[id] ?? {};
      providers[id] = {
        id,
        available: Boolean(provider.apiKey || provider.enabled),
        local: false,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        models: knowledge.models?.[id] ?? provider.models ?? []
      };
    }

    return {
      providers,
      knowledge,
      routingPolicy: config.routingPolicy ?? { quotaStrategy: 'prefer-free-remote' }
    };
  }

  static async refreshQuotaState(_options: any): Promise<{ refreshed: any[] }> {
    return { refreshed: [] };
  }
}

export class SystemProbe {
  static async getStatus(): Promise<SystemStatus> {
    return { ok: true, leanCtx: await this.probeLeanCtx() };
  }

  static leanCtxInstallHint(): string {
    return 'Install the lean-ctx CLI and ensure `lean-ctx` is on PATH, then rerun `ai-workflow doctor`.';
  }

  static leanCtxSetupHint(): string {
    return 'After install, verify with `lean-ctx -c git status` and use `lean-ctx -c <command>` for compressed shell output.';
  }

  private static async probeLeanCtx(): Promise<Record<string, unknown>> {
    try {
      const { stdout } = await execFileAsync('bash', ['-lc', 'command -v lean-ctx'], { maxBuffer: 1024 * 1024 });
      const path = String(stdout ?? '').trim();
      if (!path) return this.missingLeanCtx('lean-ctx not found on PATH');
      return {
        installed: true,
        path,
        version: await this.probeLeanCtxVersion(),
        installHint: this.leanCtxInstallHint(),
        setupHint: this.leanCtxSetupHint()
      };
    } catch (error: any) {
      return this.missingLeanCtx(error?.message ?? String(error));
    }
  }

  private static async probeLeanCtxVersion(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('lean-ctx', ['--version'], { maxBuffer: 1024 * 1024 });
      const text = String(stdout ?? '').trim();
      return text.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] ?? text ?? null;
    } catch {
      return null;
    }
  }

  private static missingLeanCtx(details: string): Record<string, unknown> {
    return {
      installed: false,
      path: null,
      version: null,
      details,
      installHint: this.leanCtxInstallHint(),
      setupHint: this.leanCtxSetupHint()
    };
  }
}
