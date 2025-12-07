import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { configRoutes } from './routes/config';
import { scriptRoutes } from './routes/scripts';
import { presetRoutes } from './routes/presets';
import { fileRoutes } from './routes/files';
import { systemRoutes } from './routes/system.ts';
import { redisRoutes } from './routes/redis';
import { join } from 'path';
import { existsSync } from 'fs';
import dotenv from 'dotenv';
import crypto from 'crypto';

// 加载环境变量
dotenv.config();

const PORT = parseInt(process.env.SERVER_PORT || '7245');
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// SECURITY TOKEN: allow fixed from .env, otherwise generate random on boot
const ENV_TOKEN = (process.env.SECURITY_TOKEN || '').trim();
const SECURITY_TOKEN = ENV_TOKEN || crypto.randomBytes(4).toString('hex').toUpperCase();

const BOOT_TIME = Date.now();

async function start() {
  const fastify = Fastify({
    logger: true,
  });

  // 注册 CORS
  await fastify.register(cors, {
    origin: (() => {
      if (CORS_ORIGIN === '*') return true;
      const parts = CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
      return parts.length > 1 ? parts : parts[0] || false;
    })(),
  });

  // Authentication Middleware
  fastify.addHook('onRequest', async (request, reply) => {
    // Allow static files and verify endpoint without token
    if (
      request.url.startsWith('/api/auth/verify') ||
      request.url.startsWith('/api/health') ||
      !request.url.startsWith('/api')
    ) {
      return;
    }

    let token = request.headers['x-auth-token'];

    // Also check query string for EventSource connections
    if (!token && (request.query as any)?.token) {
      token = (request.query as any).token;
    }

    if (token !== SECURITY_TOKEN) {
      reply.code(401).send({ error: 'Unauthorized: Invalid or missing security token' });
    }
  });

  // Health Check Endpoint
  fastify.get('/api/health', async () => {
    return { status: 'ok', bootTime: BOOT_TIME };
  });

  // Auth Verification Endpoint
  fastify.post('/api/auth/verify', async (request, reply) => {
    const { token } = request.body as { token: string };
    if (token === SECURITY_TOKEN) {
      return { success: true };
    } else {
      reply.code(401).send({ success: false, error: 'Invalid token' });
    }
  });

  // 注册路由
  await fastify.register(configRoutes);
  await fastify.register(scriptRoutes);
  await fastify.register(presetRoutes);
  await fastify.register(fileRoutes);
  await fastify.register(redisRoutes);
  await fastify.register(systemRoutes);

  // 生产环境提供静态文件
  if (process.env.NODE_ENV === 'production') {
    const distPath = join(process.cwd(), 'dist');
    if (existsSync(distPath)) {
      await fastify.register(fastifyStatic, {
        root: distPath,
        prefix: '/',
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
