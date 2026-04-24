export type ProviderId = 'google' | 'openai' | 'anthropic' | 'ollama' | string;

export interface ProviderConfig {
  id: ProviderId;
  apiKey?: string;
  baseUrl?: string;
  host?: string;
  enabled?: boolean;
}

export interface ModelCapabilities {
  logic: number;
  strategy: number;
  prose: number;
  visual: number;
  creative: number;
  data: number;
}

export interface ModelInfo {
  id: string;
  providerId: ProviderId;
  fitScore?: number;
  fitReasons?: string[];
  quality?: 'low' | 'medium' | 'high';
  costTier?: number;
  sizeB?: number | null;
  capabilities?: Partial<ModelCapabilities>;
  local?: boolean;
}

export interface TaskType {
  id: string;
  shortName: string;
  description: string;
  weights: Partial<ModelCapabilities>;
}

export interface InteractionTurn {
  prompt: string;
  system?: string;
  format?: 'text' | 'json';
  modelId?: string;
  providerId?: ProviderId;
  signal?: AbortSignal | null;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  available: boolean;
}

export interface GenerationResult {
  text: string;
  ok: boolean;
  usage?: Usage;
  model: {
    providerId: ProviderId;
    modelId: string;
  };
  error?: string;
  raw?: any;
  latencyMs?: number;
}

export interface SessionContext {
  history: Array<{ role: 'user' | 'ai'; content: string }>;
  managedContext?: string;
  metrics?: any;
}

export interface PromptTemplate {
  content: string;
  manifest: any;
}

export interface SystemStatus {
  ok: boolean;
  details?: string;
  leanCtx?: any;
}

export interface ProviderState {
  providers: Record<string, ProviderConfig>;
  routingPolicy: any;
  knowledge?: any;
}

/**
 * Superb Abstraction for Provider Adapters.
 */
export interface ProviderAdapter {
  id: ProviderId;
  generate(options: GenerateOptions): Promise<GenerationResult>;
}

/**
 * Superb Abstraction for Interaction Providers.
 */
export interface InteractionProvider {
  id: ProviderId;
  generate(turn: InteractionTurn, config: ProviderConfig): Promise<GenerationResult>;
}

export interface GenerateOptions {
  modelId: string;
  prompt: string;
  system?: string;
  config: ProviderConfig;
  format?: 'text' | 'json';
  signal?: AbortSignal | null;
}
