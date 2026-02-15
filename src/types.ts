export type ExpectedOutput =
  | 'sentra_response'
  | 'sentra_tools'
  | 'sentra_tools_or_response'
  | 'reply_gate_decision_tools'
  | 'override_intent_decision_tools'
  | (string & {});

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface HistoryConversationMessage extends ChatMessage {
  pairId?: string;
  timestamp?: number;
}

export interface FormatCheckInvalid {
  valid: false;
  reason: string;
}

export interface FormatCheckValid {
  valid: true;
  normalized?: string;
  toolsOnly?: boolean;
  rawToolsXml?: string;
}

export type FormatCheckResult = FormatCheckInvalid | FormatCheckValid;

export interface GuardResult {
  ok: boolean;
  normalized: string | null;
  changed: boolean;
  reason?: string;
}

export interface ModelFormatFixParams {
  agent?: {
    chat: (conversations: ChatMessage[], options?: Record<string, unknown>) => Promise<string | null>;
  };
  conversations?: ChatMessage[];
  model?: string;
  timeout?: number;
  groupId?: string;
  expectedOutput?: ExpectedOutput;
  lastErrorReason?: string;
  candidateOutput?: string;
  scope?: string;
}
