import { FastifyInstance } from 'fastify';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

type Role = 'user' | 'assistant' | 'system' | 'error';

interface ChatMessageMeta {
  projectRefs?: Array<{ path: string; name: string }>;
  localFiles?: Array<{ name: string; size: number }>;
}

interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  meta?: ChatMessageMeta;
}

interface ConversationState {
  draft?: string;
  cursor?: { start: number; end: number };
  titleLocked?: boolean;
}

interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  state?: ConversationState;
}

function projectRoot(): string {
  return resolve(process.cwd(), process.env.SENTRA_ROOT || '..');
}

function cacheRoot(): string {
  return resolve(projectRoot(), '.cache', 'deepwiki');
}

function conversationsDir(): string {
  return join(cacheRoot(), 'conversations');
}

function ensureDirs() {
  const root = cacheRoot();
  const convDir = conversationsDir();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  if (!existsSync(convDir)) mkdirSync(convDir, { recursive: true });
}

function safeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(id);
}

function conversationPath(id: string): string {
  return join(conversationsDir(), `${id}.json`);
}

function readConversation(id: string): Conversation | null {
  if (!safeId(id)) return null;
  const fp = conversationPath(id);
  if (!existsSync(fp)) return null;
  try {
    const raw = readFileSync(fp, 'utf-8');
    return JSON.parse(raw) as Conversation;
  } catch {
    return null;
  }
}

function writeConversation(conv: Conversation) {
  ensureDirs();
  const fp = conversationPath(conv.id);
  writeFileSync(fp, JSON.stringify(conv, null, 2), 'utf-8');
}

function listConversations(): Array<Pick<Conversation, 'id' | 'title' | 'createdAt' | 'updatedAt'>> {
  ensureDirs();
  const dir = conversationsDir();
  const files = readdirSync(dir);
  const items: Array<Pick<Conversation, 'id' | 'title' | 'createdAt' | 'updatedAt'>> = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const fp = join(dir, f);
    try {
      if (!statSync(fp).isFile()) continue;
      const raw = readFileSync(fp, 'utf-8');
      const conv = JSON.parse(raw) as Conversation;
      if (!conv?.id) continue;
      items.push({
        id: conv.id,
        title: conv.title || '新对话',
        createdAt: conv.createdAt || 0,
        updatedAt: conv.updatedAt || 0,
      });
    } catch {
      continue;
    }
  }
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return items;
}

export async function deepWikiRoutes(fastify: FastifyInstance) {
  fastify.get('/api/deepwiki/conversations', async (_request, reply) => {
    try {
      fastify.log.info({ cacheRoot: cacheRoot() }, '[DeepWiki] list conversations');
      return reply.send({ conversations: listConversations() });
    } catch (e) {
      return reply.code(500).send({ error: 'Failed to list conversations' });
    }
  });

  fastify.post<{ Body: { id: string; title?: string } }>('/api/deepwiki/conversations', async (request, reply) => {
    const { id, title } = (request.body || {}) as any;
    if (!id || typeof id !== 'string' || !safeId(id)) {
      return reply.code(400).send({ error: 'Invalid id' });
    }

    const now = Date.now();
    const conv: Conversation = {
      id,
      title: typeof title === 'string' && title.trim() ? title.trim() : '新对话',
      createdAt: now,
      updatedAt: now,
      messages: [],
      state: { draft: '', cursor: { start: 0, end: 0 } },
    };

    writeConversation(conv);
    fastify.log.info({ id: conv.id, path: conversationPath(conv.id) }, '[DeepWiki] created conversation');
    return reply.send({ conversation: conv });
  });

  fastify.get<{ Params: { id: string } }>('/api/deepwiki/conversations/:id', async (request, reply) => {
    const { id } = request.params;
    if (!safeId(id)) return reply.code(400).send({ error: 'Invalid id' });
    const conv = readConversation(id);
    if (!conv) return reply.code(404).send({ error: 'Conversation not found' });
    return reply.send({ conversation: conv });
  });

  fastify.put<{ Params: { id: string }; Body: Partial<Conversation> }>('/api/deepwiki/conversations/:id', async (request, reply) => {
    const { id } = request.params;
    if (!safeId(id)) return reply.code(400).send({ error: 'Invalid id' });
    const existing = readConversation(id);
    if (!existing) return reply.code(404).send({ error: 'Conversation not found' });

    const body = (request.body || {}) as Partial<Conversation>;

    const next: Conversation = {
      ...existing,
      title: typeof body.title === 'string' ? body.title : existing.title,
      messages: Array.isArray(body.messages) ? (body.messages as any) : existing.messages,
      state: body.state ? (body.state as any) : existing.state,
      updatedAt: Date.now(),
    };

    writeConversation(next);
    fastify.log.info({ id: next.id, path: conversationPath(next.id), updatedAt: next.updatedAt }, '[DeepWiki] updated conversation');
    return reply.send({ conversation: next });
  });

  fastify.delete<{ Params: { id: string } }>('/api/deepwiki/conversations/:id', async (request, reply) => {
    const { id } = request.params;
    if (!safeId(id)) return reply.code(400).send({ error: 'Invalid id' });
    const fp = conversationPath(id);
    if (!existsSync(fp)) return reply.code(404).send({ error: 'Conversation not found' });
    try {
      unlinkSync(fp);
    } catch {
      try {
        rmSync(fp, { force: true });
      } catch {
        return reply.code(500).send({ error: 'Failed to delete conversation' });
      }
    }
    fastify.log.info({ id, path: fp }, '[DeepWiki] deleted conversation');
    return reply.send({ success: true });
  });
}
