import { config, getStageTimeoutMs } from '../../config/index.js';
import { chatCompletion } from '../../openai/client.js';
import { manifestToBulletedText } from '../plan/manifest.js';
import { loadPrompt, renderTemplate, composeSystem } from '../prompts/loader.js';
import { compactMessages, normalizeConversation } from '../utils/messages.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolDef } from '../tools/loader.js';
import logger from '../../logger/index.js';

const JUDGE_MAX_TOOL_NAMES = 12;

function normalizeToolNames(value, allowedSet) {
  const src = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of src) {
    const name = String(item || '').trim();
    if (!name || seen.has(name)) continue;
    if (allowedSet && allowedSet.size > 0 && !allowedSet.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= JUDGE_MAX_TOOL_NAMES) break;
  }
  return out;
}

export async function judgeToolNecessity(objective, manifest, conversation, context = {}) {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const allowedToolNames = Array.from(
      new Set((Array.isArray(manifest) ? manifest : []).map((m) => m?.aiName).filter(Boolean))
    );
    const allowedToolSet = new Set(allowedToolNames);
    const toolDef = await loadToolDef({
      baseDir: __dirname,
      toolPath: '../tools/internal/emit_decision.tool.json',
      schemaPath: '../tools/internal/emit_decision.schema.json',
      mutateSchema: (schema) => {
        const items = schema?.properties?.tool_names?.items;
        if (items && allowedToolNames.length > 0) {
          items.enum = allowedToolNames;
        }
      },
      fallbackTool: {
        type: 'function',
        function: {
          name: 'emit_decision',
          description: 'Tool gate stage: emit a compact shortlist of tool aiNames only.',
          parameters: {
            type: 'object',
            properties: {
              need_tools: { type: 'boolean' },
              tool_names: { type: 'array', items: { type: 'string' } }
            },
            required: ['tool_names'],
            additionalProperties: true
          }
        }
      },
      fallbackSchema: {
        type: 'object',
        properties: {
          need_tools: { type: 'boolean' },
          tool_names: { type: 'array', items: { type: 'string' } }
        },
        required: ['tool_names'],
        additionalProperties: true
      },
    });
    const tools = [toolDef];

    const jp = await loadPrompt('judge');
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlayJud = overlays.judge?.system || overlays.judge || '';
    const baseSystem = composeSystem(jp.system, [overlayGlobal, overlayJud].filter(Boolean).join('\n\n'));
    const manifestBullet = manifestToBulletedText(manifest);
    const systemContent = [
      baseSystem,
      jp.concurrency_hint || '',
      jp.manifest_intro,
      manifestBullet,
    ].filter(Boolean).join('\n');

    const conv = normalizeConversation(conversation);
    const msgs = compactMessages([
      { role: 'system', content: systemContent },
      ...conv,
      { role: 'user', content: renderTemplate(jp.user_goal, { objective }) },
    ]);

    const useOmit = Number(config?.judge?.maxTokens ?? -1) <= 0;
    const timeoutMs = Math.max(0, Number(config?.judge?.raceTimeoutMs ?? 12000));
    const models = Array.isArray(config?.judge?.models) && config.judge.models.length
      ? config.judge.models
      : [config.judge.model];

    const withTimeout = (p, ms) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('judge_timeout')), ms);
      p.then((v) => { clearTimeout(t); resolve(v); })
        .catch((err) => { clearTimeout(t); reject(err); });
    });

    const attemptOnce = async (modelName) => {
      const res = await chatCompletion({
        messages: msgs,
        tools,
        tool_choice: { type: 'function', function: { name: 'emit_decision' } },
        omitMaxTokens: useOmit,
        max_tokens: useOmit ? undefined : Number(config.judge.maxTokens),
        temperature: Number(config.judge.temperature ?? 0.1),
        timeoutMs: getStageTimeoutMs('judge'),
        apiKey: config.judge.apiKey,
        baseURL: config.judge.baseURL,
        model: modelName,
      });
      const call = res?.choices?.[0]?.message?.tool_calls?.[0];
      const parsed = call?.function?.arguments ? JSON.parse(call.function.arguments) : null;
      if (!parsed) throw new Error('judge_parse_failed');

      const toolNames = normalizeToolNames(parsed.tool_names, allowedToolSet);
      const forceNeedTools = context?.forceNeedTools === true;
      const parsedNeed = typeof parsed.need_tools === 'boolean' ? parsed.need_tools : null;
      const need = forceNeedTools ? true : (parsedNeed === null ? toolNames.length > 0 : parsedNeed === true);
      const summary = String(parsed.summary || '').trim() || String(objective || '').trim();
      logger.info?.('Judge result', {
        label: 'JUDGE',
        model: modelName,
        need,
        toolNamesCount: toolNames.length
      });
      return { need, summary, toolNames, ok: true };
    };

    if (models.length === 1) {
      try {
        const attemptPromise = attemptOnce(models[0]);
        const result = timeoutMs > 0 ? await withTimeout(attemptPromise, timeoutMs) : await attemptPromise;
        if (result && result.ok) return result;
      } catch (e) {
        logger.warn?.('Judge model failed', { label: 'JUDGE', model: models[0], error: String(e) });
      }
      return { need: false, summary: 'judge_stage_failed', toolNames: [], ok: false };
    }

    const tasks = models.map((modelName) => (async () => {
      try {
        const attemptPromise = attemptOnce(modelName);
        return timeoutMs > 0 ? await withTimeout(attemptPromise, timeoutMs) : await attemptPromise;
      } catch (e) {
        logger.warn?.('Judge model failed (parallel)', { label: 'JUDGE', model: modelName, error: String(e) });
        throw e;
      }
    })());

    try {
      const first = await Promise.any(tasks);
      if (first && first.ok) return first;
    } catch (e) {
      logger.error?.('Judge all models failed', { label: 'JUDGE', error: String(e) });
    }

    return { need: false, summary: 'judge_stage_failed', toolNames: [], ok: false };
  } catch (e) {
    return { need: false, summary: 'judge_stage_failed', toolNames: [], ok: false };
  }
}
