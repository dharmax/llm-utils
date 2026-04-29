export type ContextHistoryRole = 'user' | 'ai' | 'system' | string;

export interface ContextHistoryItem {
  role: ContextHistoryRole;
  content: string;
}

export interface ContextRequest {
  query: string;
  taskType?: string;
  maxTokens?: number;
  maxItems?: number;
  categories?: string[];
  history?: ContextHistoryItem[];
  hints?: {
    filePaths?: string[];
    symbolNames?: string[];
    sources?: string[];
    preferDense?: boolean;
  };
  output?: {
    mode?: 'rendered' | 'items' | 'both';
    format?: 'markdown' | 'plain';
  };
}

export type ContextItemKind =
  | 'guideline'
  | 'knowledge'
  | 'history'
  | 'file'
  | 'symbol'
  | 'note'
  | 'custom';

export interface ContextItem {
  id: string;
  kind: ContextItemKind;
  title: string;
  content: string;
  score?: number;
  source?: string;
  metadata?: Record<string, unknown>;
  rationale?: string[];
}

export interface ContextDiagnostics {
  strategy: string;
  budget?: {
    requested?: number;
    used?: number;
  };
  excluded?: Array<{
    id: string;
    reason: string;
  }>;
  warnings?: string[];
}

export interface ContextResult {
  rendered?: string;
  items?: ContextItem[];
  diagnostics?: ContextDiagnostics;
}

export interface PromptContextManager {
  resolve(request: ContextRequest): Promise<ContextResult>;
}
