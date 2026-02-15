export type AgentChatMessage = {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
};

export type AgentChatOptions = {
  apiKey?: string;
  apiBaseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  stream?: boolean;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string | string[];
  expectedOutput?: string;
  onChunk?: (chunk: string) => void;
  onEarlyTerminate?: (event: { reason?: string; partial?: string }) => void;
};

export type AgentConfig = {
  apiKey?: string;
  apiBaseUrl?: string;
  defaultModel?: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
  stream?: boolean;
  envPath?: string;
  maxRetries?: number;
};

export class Agent {
  constructor(config?: AgentConfig);
  chat(messages: AgentChatMessage[], options?: AgentChatOptions | string): Promise<string | null>;
}

export default Agent;
