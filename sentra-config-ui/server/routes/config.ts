import { FastifyInstance } from 'fastify';
import { scanAllConfigs } from '../utils/configScanner';
import { writeEnvFile } from '../utils/envParser';
import { join, resolve } from 'path';
import { copyFileSync, existsSync } from 'fs';
import { EnvVariable } from '../types';
import { getRuntimeConfig, getRuntimeConfigVersion, reloadRuntimeConfigFromEnvFile } from '../utils/runtimeConfig.ts';

function getRootDir(): string {
  return resolve(process.cwd(), process.env.SENTRA_ROOT || '..');
}

export async function configRoutes(fastify: FastifyInstance) {
  fastify.get('/api/configs/runtime', async () => {
    try {
      // Best-effort: in case file watcher is delayed.
      reloadRuntimeConfigFromEnvFile();
    } catch {
    }
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
      const envPath = join(modulePath, '.env');

      writeEnvFile(envPath, variables);

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
      const envPath = join(pluginPath, '.env');

      writeEnvFile(envPath, variables);

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
}
