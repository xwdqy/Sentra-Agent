import { FastifyInstance } from 'fastify';
import { scanAllConfigs } from '../utils/configScanner';
import { writeEnvFile } from '../utils/envParser';
import { join, resolve } from 'path';
import { copyFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { EnvVariable } from '../types';
import { getRuntimeConfig, getRuntimeConfigVersion, reloadRuntimeConfigFromEnvFile, onRuntimeConfigChange, getCurrentConfigVersion, getCurrentConfig } from '../utils/runtimeConfig.ts';

function getRootDir(): string {
  return resolve(process.cwd(), process.env.SENTRA_ROOT || '..');
}

// Track active SSE connections for config changes
const configConnections = new Set<any>();
let lastBroadcastVersion = 0;

// Broadcast config changes to all connected clients
function broadcastConfigChange() {
  const cfg = getCurrentConfig();
  const ver = getCurrentConfigVersion();

  // Avoid duplicate broadcasts for same version
  if (ver <= lastBroadcastVersion) return;
  lastBroadcastVersion = ver;

  const data = `data: ${JSON.stringify({ version: ver, config: cfg })}\n\n`;
  for (const conn of configConnections) {
    try {
      conn.write(data);
    } catch {
      configConnections.delete(conn);
    }
  }
}

// Listen for config changes from runtimeConfig - use once to avoid duplicate listeners
let configChangeHandlerSet = false;
function setupConfigChangeListener() {
  if (configChangeHandlerSet) return;
  configChangeHandlerSet = true;
  onRuntimeConfigChange(() => {
    broadcastConfigChange();
  });
}

// Initialize listener once
setupConfigChangeListener();

export async function configRoutes(fastify: FastifyInstance) {
  // SSE endpoint for config changes - no more polling needed!
  fastify.get('/api/configs/stream', async (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial config
    const cfg = getRuntimeConfig();
    const ver = getRuntimeConfigVersion();
    reply.raw.write(`data: ${JSON.stringify({ version: ver, config: cfg })}\n\n`);

    // Register connection
    const connection = reply.raw;
    configConnections.add(connection);

    // Cleanup on close
    request.raw.on('close', () => {
      configConnections.delete(connection);
    });
  });

  fastify.get('/api/configs/runtime', async () => {
    const cfg = getRuntimeConfig();
    return { version: getRuntimeConfigVersion(), config: cfg };
  });

  // 获取所有配置
  fastify.get('/api/configs', async (_request, reply) => {
    try {
      const configs = scanAllConfigs();
      return configs;
    } catch (error) {
      reply.code(500).send({
        error: 'Failed to scan configurations',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 保存模块配置
  fastify.post<{
    Body: { moduleName: string; variables: EnvVariable[] };
  }>('/api/configs/module', async (request, reply) => {
    try {
      const { moduleName, variables } = request.body;

      if (!moduleName || !variables) {
        return reply.code(400).send({ error: 'Missing moduleName or variables' });
      }

      const modulePath = join(getRootDir(), moduleName);
      if (!existsSync(modulePath)) {
        return reply.code(404).send({ error: 'Module not found', message: `Module directory not found: ${moduleName}` });
      }
      const envPath = join(modulePath, '.env');

      try {
        writeEnvFile(envPath, variables);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(400).send({ error: 'Invalid configuration', message: msg });
      }

      try {
        if (moduleName === 'sentra-config-ui' || moduleName === '.') {
          reloadRuntimeConfigFromEnvFile();
        }
      } catch {
      }

      return { success: true, message: `Configuration saved for ${moduleName}` };
    } catch (error) {
      reply.code(500).send({
        error: 'Failed to save configuration',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 保存插件配置
  fastify.post<{
    Body: { pluginName: string; variables: EnvVariable[] };
  }>('/api/configs/plugin', async (request, reply) => {
    try {
      const { pluginName, variables } = request.body;

      if (!pluginName || !variables) {
        return reply.code(400).send({ error: 'Missing pluginName or variables' });
      }

      const pluginPath = join(getRootDir(), 'sentra-mcp', 'plugins', pluginName);
      if (!existsSync(pluginPath)) {
        return reply.code(404).send({ error: 'Plugin not found', message: `Plugin directory not found: ${pluginName}` });
      }
      const envPath = join(pluginPath, '.env');

      try {
        writeEnvFile(envPath, variables);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.code(400).send({ error: 'Invalid configuration', message: msg });
      }

      try {
        // plugin .env changes do not affect sentra-config-ui runtime config
      } catch {
      }

      return { success: true, message: `Configuration saved for plugin ${pluginName}` };
    } catch (error) {
      reply.code(500).send({
        error: 'Failed to save plugin configuration',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // 恢复默认配置
  fastify.post<{
    Body: { moduleName?: string; pluginName?: string };
  }>('/api/configs/restore', async (request, reply) => {
    try {
      const { moduleName, pluginName } = request.body;

      if (!moduleName && !pluginName) {
        return reply.code(400).send({ error: 'Missing moduleName or pluginName' });
      }

      let targetPath = '';
      if (moduleName) {
        targetPath = join(getRootDir(), moduleName);
      } else if (pluginName) {
        targetPath = join(getRootDir(), 'sentra-mcp', 'plugins', pluginName);
      }

      const envPath = join(targetPath, '.env');
      const examplePath = join(targetPath, '.env.example');

      if (!existsSync(examplePath)) {
        return reply.code(404).send({ error: '.env.example not found' });
      }

      copyFileSync(examplePath, envPath);

      try {
        // If restoring sentra-config-ui env, apply immediately.
        if (moduleName === 'sentra-config-ui' || moduleName === '.') {
          reloadRuntimeConfigFromEnvFile();
        }
      } catch {
      }

      return { success: true, message: 'Configuration restored from .env.example' };
    } catch (error) {
      reply.code(500).send({
        error: 'Failed to restore configuration',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  fastify.get<{
    Querystring: { pluginName: string };
  }>('/api/configs/plugin-skill', async (request, reply) => {
    try {
      const pluginName = String((request.query as any)?.pluginName || '').trim();
      if (!pluginName) return reply.code(400).send({ error: 'Missing pluginName' });

      const pluginPath = join(getRootDir(), 'sentra-mcp', 'plugins', pluginName);
      const skillPath = join(pluginPath, 'skill.md');
      if (!existsSync(skillPath)) {
        return reply.code(404).send({ error: 'skill.md not found' });
      }
      const content = readFileSync(skillPath, 'utf-8');
      return { success: true, pluginName, content };
    } catch (error) {
      reply.code(500).send({
        error: 'Failed to read plugin skill',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  fastify.post<{
    Body: { pluginName: string; content: string };
  }>('/api/configs/plugin-skill', async (request, reply) => {
    try {
      const pluginName = String((request.body as any)?.pluginName || '').trim();
      const content = (request.body as any)?.content;
      if (!pluginName) return reply.code(400).send({ error: 'Missing pluginName' });
      if (typeof content !== 'string') return reply.code(400).send({ error: 'Missing content' });

      const pluginPath = join(getRootDir(), 'sentra-mcp', 'plugins', pluginName);
      const skillPath = join(pluginPath, 'skill.md');
      writeFileSync(skillPath, content, 'utf-8');
      return { success: true, message: `Skill saved for plugin ${pluginName}` };
    } catch (error) {
      reply.code(500).send({
        error: 'Failed to save plugin skill',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  fastify.post<{
    Body: { pluginName: string };
  }>('/api/configs/plugin-skill/restore', async (request, reply) => {
    try {
      const pluginName = String((request.body as any)?.pluginName || '').trim();
      if (!pluginName) return reply.code(400).send({ error: 'Missing pluginName' });

      const pluginPath = join(getRootDir(), 'sentra-mcp', 'plugins', pluginName);
      const skillPath = join(pluginPath, 'skill.md');
      if (existsSync(skillPath)) {
        try {
          unlinkSync(skillPath);
        } catch {
          // ignore
        }
      }
      return { success: true, message: 'Skill restored to default (skill.md removed)' };
    } catch (error) {
      reply.code(500).send({
        error: 'Failed to restore plugin skill',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
