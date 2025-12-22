import { getAuthHeaders } from './api';

type Role = 'user' | 'assistant' | 'system' | 'error';

export interface ProjectFileRef {
  path: string;
  name: string;
}

export interface ChatMessageMeta {
  projectRefs?: ProjectFileRef[];
  localFiles?: Array<{ name: string; size: number }>;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  meta?: ChatMessageMeta;
}

export interface ConversationState {
  draft?: string;
  cursor?: { start: number; end: number };
  titleLocked?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  state?: ConversationState;
}

export async function listConversations(): Promise<Array<Pick<Conversation, 'id' | 'title' | 'createdAt' | 'updatedAt'>>> {
  const headers = getAuthHeaders();
  const res = await fetch('/api/deepwiki/conversations', { headers });
  if (!res.ok) throw new Error('Failed to list conversations');
  const data = await res.json();
  return data.conversations || [];
}

export async function createConversation(id: string, title?: string): Promise<Conversation> {
  const headers = getAuthHeaders();
  const res = await fetch('/api/deepwiki/conversations', {
    method: 'POST',
    headers,
    body: JSON.stringify({ id, title }),
  });
  if (!res.ok) throw new Error('Failed to create conversation');
  const data = await res.json();
  return data.conversation as Conversation;
}

export async function getConversation(id: string): Promise<Conversation> {
  const headers = getAuthHeaders();
  const res = await fetch(`/api/deepwiki/conversations/${encodeURIComponent(id)}`, { headers });
  if (!res.ok) throw new Error('Failed to load conversation');
  const data = await res.json();
  return data.conversation as Conversation;
}

export async function updateConversation(id: string, patch: Partial<Conversation>): Promise<Conversation> {
  const headers = getAuthHeaders();
  const res = await fetch(`/api/deepwiki/conversations/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('Failed to update conversation');
  const data = await res.json();
  return data.conversation as Conversation;
}

export async function deleteConversation(id: string): Promise<void> {
  const headers = getAuthHeaders();
  const res = await fetch(`/api/deepwiki/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers,
  });
  if (!res.ok) throw new Error('Failed to delete conversation');
}
