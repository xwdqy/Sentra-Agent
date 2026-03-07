import { config, getStageModel, getStageProvider, getStageTimeoutMs } from '../../config/index.js';
import { chatCompletion } from '../../openai/client.js';
import { manifestToXmlToolsCatalog } from '../plan/manifest.js';
import { loadPrompt, renderTemplate, composeSystem } from '../prompts/loader.js';
import { compactMessages, normalizeConversation } from '../utils/messages.js';
import { parseFunctionCalls, buildFunctionCallInstruction, buildFCPolicy } from '../../utils/fc.js';
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

export async function judgeToolNecessityFC(objective, manifest, conversation, context = {}) {
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

    let jp;
    try {
      jp = await loadPrompt('judge_fc');
    } catch {
      jp = await loadPrompt('judge');
    }

    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlayJud = overlays.judge?.system || overlays.judge || '';
    const baseSystem = composeSystem(jp.system, [overlayGlobal, overlayJud].filter(Boolean).join('\n\n'));
    const manifestXml = manifestToXmlToolsCatalog(Array.isArray(manifest) ? manifest : []);
    const policy = await buildFCPolicy({ locale: 'en' });
    const fcInstruction = await buildFunctionCallInstruction({
      name: 'emit_decision',
      parameters: toolDef.function?.parameters || { type: 'object', properties: {} },
      locale: 'en'
    });

    const systemContent = [
      baseSystem,
      jp.concurrency_hint || '',
      jp.manifest_intro,
      manifestXml,
      policy,
      fcInstruction,
    ].filter(Boolean).join('\n');

    const conv = normalizeConversation(conversation);
    const userGoal = renderTemplate(jp.user_goal, { objective });
    const msgs = compactMessages([
      { role: 'system', content: systemContent },
      ...conv,
      { role: 'user', content: userGoal },
    ]);

    logger.debug?.('Judge FC context ready', {
      label: 'JUDGE',
      toolCount: Array.isArray(manifest) ? manifest.length : 0,
      conversationLength: conv.length,
      objectivePreview: String(objective || '').slice(0, 200),
      mode: context?.forceNeedTools === true ? 'forced' : 'normal'
    });

    const defaultModel = getStageModel('judge');
    const models = Array.isArray(config?.fcLlm?.judgeModels) && config.fcLlm.judgeModels.length
      ? config.fcLlm.judgeModels
      : [defaultModel];

    const useOmit = Number(config?.fcLlm?.maxTokens ?? -1) <= 0;
    const timeoutMs = Math.max(0, Number(config?.judge?.raceTimeoutMs ?? 12000));
    const withTimeout = (p, ms) => new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('judge_timeout')), ms);
      p.then((v) => { clearTimeout(t); resolve(v); })
        .catch((err) => { clearTimeout(t); reject(err); });
    });

    const provider = getStageProvider('judge');
    const attemptOnce = async (modelName) => {
      const res = await chatCompletion({
        messages: msgs,
        omitMaxTokens: useOmit,
        max_tokens: useOmit ? undefined : Number(config.fcLlm.maxTokens),
        temperature: Number(config.fcLlm.temperature ?? 0.2),
        timeoutMs: getStageTimeoutMs('judge'),
        apiKey: provider.apiKey,
        baseURL: provider.baseURL,
        model: modelName,
      });
      const content = res?.choices?.[0]?.message?.content || '';
      const calls = parseFunctionCalls(String(content), {});
      const call = calls.find((c) => String(c.name) === 'emit_decision') || calls[0];
      const parsed = call?.arguments || null;
      if (!parsed) throw new Error('judge_fc_parse_failed');

      const toolNames = normalizeToolNames(parsed.tool_names, allowedToolSet);
      const forceNeedTools = context?.forceNeedTools === true;
      const parsedNeed = typeof parsed.need_tools === 'boolean' ? parsed.need_tools : null;
      const need = forceNeedTools ? true : (parsedNeed === null ? toolNames.length > 0 : parsedNeed === true);
      const summary = String(parsed.summary || '').trim() || String(objective || '').trim();

      logger.info?.('Judge result (FC)', {
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
        logger.warn?.('Judge FC model failed', { label: 'JUDGE', model: models[0], error: String(e) });
      }
      return { need: false, summary: 'judge_stage_failed', toolNames: [], ok: false };
    }

    const tasks = models.map((modelName) => (async () => {
      try {
        const attemptPromise = attemptOnce(modelName);
        return timeoutMs > 0 ? await withTimeout(attemptPromise, timeoutMs) : await attemptPromise;
      } catch (e) {
        logger.warn?.('Judge FC model failed (parallel)', { label: 'JUDGE', model: modelName, error: String(e) });
        throw e;
      }
    })());

    try {
      const first = await Promise.any(tasks);
      if (first && first.ok) return first;
    } catch (e) {
      logger.error?.('Judge FC all models failed', { label: 'JUDGE', error: String(e) });
    }

    return { need: false, summary: 'judge_stage_failed', toolNames: [], ok: false };
  } catch (e) {
    logger.error?.('Judge FC stage exception', { label: 'JUDGE', error: String(e) });
    return { need: false, summary: 'judge_stage_failed', toolNames: [], ok: false };
  }
}
