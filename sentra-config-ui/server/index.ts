import Fastify from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { configRoutes } from './routes/config';
import { scriptRoutes } from './routes/scripts';
import { presetRoutes } from './routes/presets';
import { worldbookRoutes } from './routes/worldbook';
import { fileRoutes } from './routes/files';
import { deepWikiRoutes } from './routes/deepwiki';
import { systemRoutes } from './routes/system.ts';
import { redisRoutes } from './routes/redis.ts';
import { redisAdminRoutes } from './routes/redisAdmin.ts';
import { llmProvidersRoutes } from './routes/llmProviders.ts';
import { emojiStickersRoutes } from './routes/emojiStickers.ts';
import { terminalExecutorRoutes } from './routes/terminalExecutor.ts';
import { mcpServersRoutes } from './routes/mcpServers.ts';
import { qqSandboxRoutes } from './routes/qqSandbox.ts';
import { join } from 'path';
import { existsSync } from 'fs';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { runDeepwikiSentraXmlAgent, type DeepwikiAgentState } from './deepwikiAgent/agent.ts';
import {
  getRuntimeConfig,
  onRuntimeConfigChange,
  reloadRuntimeConfigFromEnvFile,
  startRuntimeConfigHotReload,
} from './utils/runtimeConfig.ts';

// 加载环境变量
dotenv.config();

// Runtime env hot-reload for this service only (sentra-config-ui/.env)
startRuntimeConfigHotReload();

const PORT = parseInt(process.env.SERVER_PORT || '7245');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// SECURITY TOKEN: allow fixed from .env, otherwise generate random on boot
const ENV_TOKEN = (process.env.SECURITY_TOKEN || '').trim();
let SECURITY_TOKEN = ENV_TOKEN || crypto.randomBytes(4).toString('hex').toUpperCase();

const BOOT_TIME = Date.now();

const DEEPWIKI_AGENT_STATE_TTL_MS = 30 * 60 * 1000;
const deepwikiAgentStateStore = new Map<string, { state: DeepwikiAgentState; ts: number }>();

function cleanupDeepwikiAgentStateStore() {
  const now = Date.now();
  for (const [id, rec] of deepwikiAgentStateStore.entries()) {
    if (!rec || (now - (rec.ts || 0)) > DEEPWIKI_AGENT_STATE_TTL_MS) {
      deepwikiAgentStateStore.delete(id);
    }
  }
}

// Keep SECURITY_TOKEN synced with runtime config (.env hot reload)
onRuntimeConfigChange((cfg) => {
  const nextToken = String(cfg?.securityTokenFromEnv || '').trim();
  if (!nextToken) return;
  if (nextToken !== SECURITY_TOKEN) {
    SECURITY_TOKEN = nextToken;
    process.env.SECURITY_TOKEN = nextToken;
    console.log('\n[Auth] SECURITY_TOKEN reloaded from .env (runtime update).');
  }
});

async function start() {
  const fastify = Fastify({
    logger: true,
    bodyLimit: 20 * 1024 * 1024,
  });

  // 注册 CORS
  await fastify.register(cors, {
    origin: (() => {
      if (CORS_ORIGIN === '*') return true;
      const parts = CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
      return parts.length > 1 ? parts : parts[0] || false;
    })(),
  });

  try {
    await fastify.register(compress, {
      global: true,
      encodings: ['gzip', 'deflate'],
      threshold: 2048,
      customTypes: /^(text\/plain|text\/html)(;|$)/i,
    });
  } catch (err) {
    fastify.log.warn({ err }, '[Compress] Failed to register @fastify/compress (version mismatch?).');
  }

  // Authentication Middleware
  fastify.addHook('onRequest', async (request, reply) => {
    // Allow static files and verify endpoint without token
    if (
      request.url.startsWith('/api/auth/verify') ||
      request.url.startsWith('/api/health') ||
      (!request.url.startsWith('/api') && !request.url.startsWith('/v1'))
    ) {
      return;
    }

    let token = request.headers['x-auth-token'];

    // Also check query string for EventSource connections
    if (!token && (request.query as any)?.token) {
      token = (request.query as any).token;
    }

    if (!token) {
      try {
        const rawUrl = String((request.raw as any)?.url || request.url || '');
        const u = new URL(rawUrl.startsWith('http') ? rawUrl : `http://localhost${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`);
        const t = u.searchParams.get('token');
        if (t) token = t;
      } catch {
      }
    }

    if (token !== SECURITY_TOKEN) {
      return reply.code(401).send({ error: 'Unauthorized: Invalid or missing security token' });
    }
  });

  // Health Check Endpoint
  fastify.get('/api/health', async () => {
    return { status: 'ok', bootTime: BOOT_TIME };
  });

  // Auth Verification Endpoint
  fastify.post('/api/auth/verify', async (request, reply) => {
    // Best-effort: force a reload right now (watcher may have delay).
    reloadRuntimeConfigFromEnvFile();
    try {
      const cfg = getRuntimeConfig();
      const nextToken = String(cfg?.securityTokenFromEnv || '').trim();
      if (nextToken && nextToken !== SECURITY_TOKEN) {
        SECURITY_TOKEN = nextToken;
        process.env.SECURITY_TOKEN = nextToken;
      }
    } catch {
    }
    const { token } = request.body as { token: string };
    if (token === SECURITY_TOKEN) {
      return { success: true };
    } else {
      reply.code(401).send({ success: false, error: 'Invalid token' });
    }
  });

  fastify.post('/v1/chat/completions', async (request, reply) => {
    try {
      const body = (request.body || {}) as any;

      // DeepWiki Sentra-XML Agent mode (independent pipeline)
      if (String(body?.agent_mode || '') === 'deepwiki_sentra_xml') {
        cleanupDeepwikiAgentStateStore();
        const upstreamBase = (process.env.DEEPWIKI_API_BASE_URL || process.env.API_BASE_URL || '').trim();
        const apiKey = (process.env.DEEPWIKI_API_KEY || process.env.API_KEY || '').trim();

        if (!upstreamBase || !apiKey) {
          reply.code(500).send({
            error: 'DeepWiki backend not configured',
            message: 'Missing DEEPWIKI_API_BASE_URL/API_BASE_URL or DEEPWIKI_API_KEY/API_KEY in environment',
          });
          return;
        }

        const AbortCtr = (globalThis as any).AbortController || AbortController;
        const controller = new AbortCtr();
        const abortUpstream = () => {
          try {
            if (!controller.signal.aborted) controller.abort();
          } catch { }
        };

        (reply.raw as any).on('close', abortUpstream);
        (reply.raw as any).on('aborted', abortUpstream);
        (request.raw as any).on('aborted', abortUpstream);

        // isStream declared above

        const agentModel =
          typeof body?.model === 'string' && body.model.trim()
            ? body.model.trim()
            : (process.env.DEEPWIKI_MODEL || process.env.MAIN_AI_MODEL || process.env.MODEL_NAME || '').trim();

        const toolConfirmation = body?.tool_confirmation && typeof body.tool_confirmation === 'object'
          ? {
            required: !!body.tool_confirmation.required,
            confirmed: !!body.tool_confirmation.confirmed,
            toolCalls: Array.isArray(body.tool_confirmation.toolCalls) ? body.tool_confirmation.toolCalls : undefined,
            toolsXml: typeof body.tool_confirmation.toolsXml === 'string' ? body.tool_confirmation.toolsXml : undefined,
          }
          : {
            required: true,
            confirmed: false,
            toolCalls: undefined,
            toolsXml: undefined,
          };

        const incomingStateId = typeof body?.agent_state_id === 'string' ? body.agent_state_id.trim() : '';
        const resumeState = incomingStateId ? deepwikiAgentStateStore.get(incomingStateId)?.state : undefined;

        const agentEvents: any[] = [];

        const isStream = !!body?.stream;

        if (isStream) {
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked',
          });
        }

        const emitEvent = (ev: any) => {
          try {
            agentEvents.push(ev);
          } catch { }

          if (!isStream) return;
          try {
            reply.raw.write(`data: ${JSON.stringify({ dw_event: ev })}\n\n`);
          } catch { }
        };

        const output = await runDeepwikiSentraXmlAgent({
          input: {
            messages: Array.isArray(body?.messages) ? body.messages : [],
            model: agentModel || undefined,
            temperature: typeof body?.temperature === 'number' ? body.temperature : undefined,
            top_p: typeof body?.top_p === 'number' ? body.top_p : undefined,
            max_tokens: typeof body?.max_tokens === 'number' ? body.max_tokens : undefined,
            stream: false,
          },
          upstreamBaseUrl: upstreamBase,
          apiKey,
          signal: controller.signal,
          resumeState,
          toolConfirmation,
          onEvent: emitEvent,
        });

        const finalText = output.finalText || '';
        const agentTrace = (output as any)?.trace;
        const actionRequired = !!(output as any)?.actionRequired;
        const pendingToolCalls = (output as any)?.pendingToolCalls;
        const pendingToolsXml = (output as any)?.pendingToolsXml;
        const agentState = (output as any)?.agentState as DeepwikiAgentState | undefined;

        let outStateId = '';
        if (actionRequired && agentState) {
          outStateId = incomingStateId || `dw_state_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
          deepwikiAgentStateStore.set(outStateId, { state: agentState, ts: Date.now() });
        } else if (incomingStateId) {
          // completed or failed: drop old state
          deepwikiAgentStateStore.delete(incomingStateId);
        }

        if (!isStream) {
          return reply.send({
            id: `deepwiki-agent-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body?.model || 'deepwiki-agent',
            agent_trace: agentTrace,
            agent_events: agentEvents,
            action_required: actionRequired,
            pending_tool_calls: pendingToolCalls,
            pending_tools_xml: pendingToolsXml,
            agent_state_id: outStateId || undefined,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: finalText },
                finish_reason: 'stop',
              },
            ],
          });
        }

        // Stream: emit assistant text chunks (dw_event already emitted progressively during agent run)

        const streamId = `deepwiki-agent-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        const modelName = body?.model || 'deepwiki-agent';

        const text = String(finalText || '');
        const chunkSize = 120;
        const parts: string[] = [];
        for (let i = 0; i < text.length; i += chunkSize) {
          parts.push(text.slice(i, i + chunkSize));
        }
        if (parts.length === 0) parts.push('');

        try {
          for (let i = 0; i < parts.length; i++) {
            const isLast = i === parts.length - 1;
            const delta: any = i === 0 ? { role: 'assistant', content: parts[i] } : { content: parts[i] };

            const chunk: any = {
              id: streamId,
              object: 'chat.completion.chunk',
              created,
              model: modelName,
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: isLast ? 'stop' : null,
                },
              ],
            };

            if (isLast) {
              chunk.agent_trace = agentTrace;
              chunk.agent_events = agentEvents;
              chunk.action_required = actionRequired;
              chunk.pending_tool_calls = pendingToolCalls;
              chunk.pending_tools_xml = pendingToolsXml;
              chunk.agent_state_id = outStateId || undefined;
            }

            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);

            // Yield to flush chunks progressively.
            await new Promise<void>((r) => setImmediate(r));
          }

          reply.raw.write('data: [DONE]\n\n');
        } finally {
          try { reply.raw.end(); } catch { }
        }
        return;
      }

      const upstreamBase = (process.env.DEEPWIKI_API_BASE_URL || process.env.API_BASE_URL || '').trim();
      const apiKey = (process.env.DEEPWIKI_API_KEY || process.env.API_KEY || '').trim();

      if (!upstreamBase || !apiKey) {
        reply.code(500).send({
          error: 'DeepWiki backend not configured',
          message: 'Missing DEEPWIKI_API_BASE_URL/API_BASE_URL or DEEPWIKI_API_KEY/API_KEY in environment',
        });
        return;
      }

      const normalizedBase = upstreamBase.replace(/\/+$/, '');
      const baseWithV1 = /\/v1$/i.test(normalizedBase) ? normalizedBase : `${normalizedBase}/v1`;
      const url = `${baseWithV1}/chat/completions`;

      const upstreamBody: any = { ...body };
      if (!upstreamBody.model || typeof upstreamBody.model !== 'string') {
        const fallbackModel = (process.env.DEEPWIKI_MODEL || process.env.MAIN_AI_MODEL || process.env.MODEL_NAME || '').trim();
        if (fallbackModel) {
          upstreamBody.model = fallbackModel;
        }
      }

      const AbortCtr = (globalThis as any).AbortController || AbortController;
      const controller = new AbortCtr();
      const abortUpstream = () => {
        try {
          if (!controller.signal.aborted) controller.abort();
        } catch { }
      };

      // Only abort upstream when client connection is actually gone.
      // Using request.raw 'close' is too aggressive in some environments.
      (reply.raw as any).on('close', abortUpstream);
      (reply.raw as any).on('aborted', abortUpstream);
      (request.raw as any).on('aborted', abortUpstream);

      const fetchFn: typeof fetch = (globalThis as any).fetch;
      if (!fetchFn) {
        reply.code(500).send({ error: 'DeepWiki backend not available', message: 'global fetch is not defined in this runtime' });
        return;
      }

      const upstreamResponse = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      } as any);

      const isStream = !!upstreamBody.stream;

      if (!isStream) {
        const text = await upstreamResponse.text();
        reply.code(upstreamResponse.status);
        const contentType = upstreamResponse.headers.get('content-type');
        if (contentType) {
          reply.header('content-type', contentType);
        }
        reply.send(text);
        return;
      }

      reply.raw.writeHead(upstreamResponse.status, {
        'Content-Type': upstreamResponse.headers.get('content-type') || 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Transfer-Encoding': 'chunked',
      });

      const bodyStream: any = upstreamResponse.body;
      if (!bodyStream || !bodyStream.getReader) {
        reply.raw.end();
        return;
      }

      const reader = bodyStream.getReader();

      const pump = async () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            try {
              reply.raw.write(Buffer.from(value));
            } catch { }
          }
        }
      };

      try {
        await pump();
      } catch (err) {
        if ((err as any)?.name !== 'AbortError') {
          fastify.log.error({ err }, '[DeepWiki] streaming upstream failed');
        }
      } finally {
        try { reply.raw.end(); } catch { }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        // Client aborted / connection closed; avoid reporting this as an upstream server error.
        try { reply.raw.end(); } catch { }
        return;
      }
      fastify.log.error({ err }, '[DeepWiki] /v1/chat/completions failed');
      reply.code(500).send({
        error: 'DeepWiki upstream error',
        message: err?.message || String(err),
      });
    }
  });

  // 注册路由
  await fastify.register(websocket);
  await fastify.register(configRoutes);
  await fastify.register(scriptRoutes);
  await fastify.register(terminalExecutorRoutes);
  await fastify.register(qqSandboxRoutes);
  await fastify.register(presetRoutes);
  await fastify.register(worldbookRoutes);
  await fastify.register(fileRoutes);
  await fastify.register(deepWikiRoutes);
  await fastify.register(systemRoutes);
  await fastify.register(redisRoutes);
  await fastify.register(redisAdminRoutes);
  await fastify.register(llmProvidersRoutes);
  await fastify.register(emojiStickersRoutes);
  await fastify.register(mcpServersRoutes);

  // 生产环境提供静态文件
  if (process.env.NODE_ENV === 'production') {
    const distPath = join(process.cwd(), 'dist');
    if (existsSync(distPath)) {
      await fastify.register(fastifyStatic, {
        root: distPath,
        prefix: '/',
        preCompressed: true,
        setHeaders: (res, filePath) => {
          const p = String(filePath || '');
          const n = p.replace(/\\/g, '/');
          if (p.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            return;
          }

          const isDistAsset = n.includes('/assets/');
          const isHashed = /[.-][0-9a-f]{8,}\./i.test(n);
          if (isDistAsset && isHashed) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            return;
          }
          res.setHeader('Cache-Control', 'public, max-age=3600');
        },
      });

      fastify.setNotFoundHandler((request, reply) => {
        if (!request.url.startsWith('/api')) {
          reply.sendFile('index.html');
        } else {
          reply.code(404).send({ error: 'Not found' });
        }
      });
    }
  }

  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log('\n' + '='.repeat(50));
    console.log('Sentra Config Webui Server Started');
    console.log('='.repeat(50));
    if (ENV_TOKEN) {
      console.log(`\n🔐 SECURITY TOKEN (from .env): \x1b[32m\x1b[1m${SECURITY_TOKEN}\x1b[0m`);
      console.log('\n[Auth] Using fixed security token from .env (SECURITY_TOKEN).');
    } else {
      console.log(`\n🔐 SECURITY TOKEN (random): \x1b[32m\x1b[1m${SECURITY_TOKEN}\x1b[0m`);
      console.log('\n[Auth] No SECURITY_TOKEN in .env, generated a random token for this session.');
    }
    console.log('\nPlease use this token to log in to the dashboard.\n');
    console.log(`\nSentra 配置管理服务已启动:`);
    console.log(`   - 本地访问:   http://localhost:${PORT}`);
    console.log(`   - 网络访问:   http://0.0.0.0:${PORT}`);
    console.log(`\n   [安全] 访问令牌: ${SECURITY_TOKEN}`);
    console.log(`   请在登录界面输入此令牌以访问系统。\n`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
