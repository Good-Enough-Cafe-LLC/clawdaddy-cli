// ─── Shared Types ────────────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant';

export interface PairedHost {
  id: string;
  pairingCode: string;
  connected: boolean;
  lastConnected: string | null;
  connectedAt: string | null;
}

export interface ConnectionState {
  status: 'idle' | 'connecting' | 'connected' | 'error';
  activeHostId: string | null;
  switchboardConnected: boolean;
  error: string | null;
}

export interface PendingRequest {
  onToken?: (token: string) => void;
  onDone?: (stats: any) => void;
  onError?: (err: string) => void;
  onCommandResult?: (result: any) => void;
  inputTokens?: number;
}