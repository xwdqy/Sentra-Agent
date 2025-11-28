import fs from 'fs';
import { createLogger } from '../utils/logger.js';
import { buildAgentPresetXml, formatPresetJsonAsPlainText } from '../utils/jsonToSentraXmlConverter.js';
import { savePresetCacheForTeaching } from '../utils/presetTextToJsonConverter.js';
import { maybeTeachPreset } from './PresetTeachingManager.js';

const logger = createLogger('PresetTeachingTrigger');

// 预设教导更新队列：串行执行，避免并发覆盖同一份预设
let presetTeachingQueue = Promise.resolve();

function enqueuePresetTeachingTask(taskFn) {
  const nextTask = presetTeachingQueue.then(() => taskFn());
  // 确保队列链本身不会因为单个任务失败而中断
  presetTeachingQueue = nextTask.catch((err) => {
    logger.debug('PresetTeachingTrigger: 队列任务执行失败', { err: String(err) });
  });
  return nextTask;
}

export async function triggerPresetTeachingIfNeededCore(options = {}) {
  const {
    agent,
    historyManager,
    groupId,
    chatType,
    userId,
    userContent,
    assistantContent,
    getPresetSnapshot,
    applyPresetUpdate
  } = options;

  const enabled = (process.env.AGENT_PRESET_TEACHING_ENABLED || 'false') === 'true';
  if (!enabled) return null;
  if (!agent || typeof agent.chat !== 'function') return null;
  if (!historyManager || !groupId) return null;
  if (typeof getPresetSnapshot !== 'function') return null;

  const initialState = getPresetSnapshot();
  if (!initialState || !initialState.json || typeof initialState.json !== 'object') {
    return null;
  }

  const userPart =
    typeof userContent === 'string'
      ? userContent
      : userContent
      ? JSON.stringify(userContent)
      : '';
  const assistantPart =
    typeof assistantContent === 'string'
      ? assistantContent
      : assistantContent
      ? JSON.stringify(assistantContent)
      : '';

  let recentContextText = '';
  try {
    const ctxPairs = parseInt(process.env.AGENT_PRESET_TEACHING_CONTEXT_PAIRS || '0', 10) || 0;
    if (
      ctxPairs > 0 &&
      historyManager &&
      typeof historyManager.getConversationHistoryForContext === 'function'
    ) {
      const recentHistory =
        historyManager.getConversationHistoryForContext(groupId, {
          recentPairs: ctxPairs
        }) || [];

      if (Array.isArray(recentHistory) && recentHistory.length > 0) {
        const lines = recentHistory.map((h, idx) => {
          const role = h.role || (idx % 2 === 0 ? 'user' : 'assistant');
          const content =
            typeof h.content === 'string' ? h.content : JSON.stringify(h.content);
          return `[${role}] ${content}`;
        });
        recentContextText = lines.join('\n\n');
      }
    }
  } catch (e) {
    logger.debug('PresetTeachingTrigger: 构造最近上下文失败，将仅使用本轮对话', {
      err: String(e)
    });
  }

  const conversationParts = [
    '本轮用户输入（含上下文 XML 等内部结构，仅供内部教导分析使用）：',
    userPart || '(empty)',
    '',
    '本轮助手输出：',
    assistantPart || '(empty)'
  ];

  if (recentContextText) {
    conversationParts.push('', '最近若干轮对话上下文（仅供教导判断使用）：', recentContextText);
  }

  const conversationText = conversationParts.join('\n');

  // 将实际教导与预设写回逻辑排入串行队列中执行，避免高并发下互相覆盖
  return enqueuePresetTeachingTask(async () => {
    const state = typeof getPresetSnapshot === 'function' ? getPresetSnapshot() : null;
    const presetSnapshot = state && state.json;
    if (!presetSnapshot || typeof presetSnapshot !== 'object') {
      logger.debug('PresetTeachingTrigger: 队列执行时预设为空，跳过教导', { groupId });
      return null;
    }

    try {
      const updated = await maybeTeachPreset({
        agent,
        userId,
        groupId,
        chatType,
        presetJson: presetSnapshot,
        conversationText
      });

      if (!updated || typeof updated !== 'object') {
        return null;
      }

      // 默认的更新逻辑：若调用方未提供 applyPresetUpdate，则在此处直接写回文件和缓存
      if (typeof applyPresetUpdate === 'function') {
        try {
          await applyPresetUpdate(updated, state);
        } catch (e) {
          logger.debug('PresetTeachingTrigger: applyPresetUpdate 失败', {
            groupId,
            err: String(e)
          });
        }
      } else {
        const updatedJson = updated;
        const updatedXml = buildAgentPresetXml(updatedJson) || '';
        const updatedPlainText = formatPresetJsonAsPlainText(updatedJson) || '';

        const srcPath = state?.sourcePath || '';
        const srcFile = (state?.sourceFileName || '').toLowerCase();
        if (srcPath && srcFile.endsWith('.json')) {
          try {
            fs.writeFileSync(srcPath, JSON.stringify(updatedJson, null, 2), 'utf8');
            logger.info(`PresetTeachingTrigger: 已写回 JSON 预设文件 ${state?.sourceFileName}`);
          } catch (e) {
            logger.warn('PresetTeachingTrigger: 写回 JSON 预设文件失败', { err: String(e) });
          }
        }

        try {
          const raw = typeof state?.rawText === 'string' ? state.rawText : '';
          if (raw && raw.trim()) {
            savePresetCacheForTeaching(updatedJson, raw, state?.sourceFileName || '');
          }
        } catch (e) {
          logger.debug('PresetTeachingTrigger: 写入预设缓存失败', { err: String(e) });
        }

        // 返回也包含衍生字段，供调用方选择是否同步本地状态
        return {
          json: updatedJson,
          xml: updatedXml,
          plainText: updatedPlainText
        };
      }

      return { json: updated };
    } catch (e) {
      logger.debug('PresetTeachingTrigger: 异步教导流程失败(队列任务)', {
        groupId,
        err: String(e)
      });
      throw e;
    }
  });
}
