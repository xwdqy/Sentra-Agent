import { HistoryStore } from '../../history/store.js';
import { clip } from '../../utils/text.js';
import { formatSentraToolCall, formatSentraResult } from '../../utils/fc.js';

/**
 * 格式化 reason 数组为字符串（用于显示）
 * - 数组：用 '; ' 连接
 * - 其他：返回空字符串
 */
function formatReason(reason) {
  if (Array.isArray(reason) && reason.length > 0) {
    return reason.join('; ');
  }
  return '';
}

// 中文：构造“工具对话式上下文”，把所有已完成的步骤整理成一问一答：
// user: 现在该使用 <aiName> 了
// assistant: 参数(JSON): {...}\n结果(JSON): {...}

// 中文：返回可直接拼接到 user 消息末尾的依赖文本（而不是单独的 assistant 轮次），以保持 user/assistant 交替结构
/**
 * @param {Object} options
 * @param {string} options.runId - Run ID
 * @param {Array<string>} options.dependsOnStepIds - Dependency stepIds
 * @param {boolean} options.useFC - Use Sentra XML format (FC mode)
 */
export async function buildDependentContextText(runId, dependsOnStepIds = [], useFC = false) {
  if (!Array.isArray(dependsOnStepIds) || dependsOnStepIds.length === 0) return '';
  try {
    const raw = Array.from(new Set(dependsOnStepIds));
    const ids = raw
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter(Boolean);
    if (ids.length === 0) return '';
    const history = await HistoryStore.list(runId, 0, -1);
    const plan = await HistoryStore.getPlan(runId);
    // 取每个 stepId 的“最新” tool_result
    const lastByStepId = new Map();
    for (const h of history) {
      if (h.type !== 'tool_result') continue;
      if (typeof h.stepId === 'string' && h.stepId.trim()) {
        lastByStepId.set(h.stepId.trim(), h);
      }
    }
    const items = [];
    for (const sid of ids) {
      const h = lastByStepId.get(sid);
      if (!h) continue;
      const idx = Number(h.plannedStepIndex);
      const r = (Number.isFinite(idx) && plan?.steps && plan.steps[idx]) ? plan.steps[idx].reason : '';
      items.push({ idx, h, reason: r });
    }
    if (!items.length) return '';

    // FC 模式：使用 Sentra XML 格式（返回完整的上游参数与结果，避免信息丢失）
    if (useFC) {
      const xmlResults = items.map(({ idx, h, reason }) =>
        formatSentraResult({
          stepIndex: idx, // XML 中仍使用 step 属性
          stepId: h?.stepId,
          aiName: h.aiName,
          reason,
          args: h.args,
          result: h.result
        })
      ).join('\n\n');
      return `${xmlResults}`;
    }
    
    // 默认：JSON 格式
    const jsonItems = items.map(({ idx, h, reason }) => ({
      plannedStepIndex: idx,
      stepId: h?.stepId,
      aiName: h.aiName,
      reason: clip(reason),
      argsPreview: clip(h.args),
      resultPreview: clip(h.result?.data ?? h.result),
    }));
    return `\n依赖结果(JSON):\n${JSON.stringify(jsonItems, null, 2)}`;
  } catch {
    return '';
  }
}
/**
 * Build tool dialogue messages
 * @param {string} runId - Run ID
 * @param {number} upToStepIndex - Up to step index
 * @param {boolean} useFC - Use Sentra XML format (FC mode)
 * @param {boolean} includeCurrentStep - 重试模式：包含当前步骤的失败历史（默认 false）
 */
export async function buildToolDialogueMessages(runId, upToStepIndex, useFC = false, includeCurrentStep = false) {
  try {
    const history = await HistoryStore.list(runId, 0, -1);
    const plan = await HistoryStore.getPlan(runId);
    
    // 🔧 修复并发问题：只包含依赖链上的步骤，避免并发分支污染
    const currentStep = plan?.steps?.[upToStepIndex];
    const dependsOnStepIds = Array.isArray(currentStep?.dependsOnStepIds) ? currentStep.dependsOnStepIds : [];
    
    // 构建依赖链（包括间接依赖）
    const dependencyChain = new Set();
    const planStepIdToIdx = new Map((plan?.steps || []).map((s, idx) => [typeof s?.stepId === 'string' ? s.stepId : '', idx]).filter(([k]) => k));
    const addDependencies = (stepIdx) => {
      if (dependencyChain.has(stepIdx)) return;
      dependencyChain.add(stepIdx);
      const step = plan?.steps?.[stepIdx];
      const deps = Array.isArray(step?.dependsOnStepIds) ? step.dependsOnStepIds : [];
      for (const sid of deps) {
        const k = typeof sid === 'string' ? sid.trim() : '';
        const idx = planStepIdToIdx.get(k);
        if (Number.isFinite(idx) && idx >= 0 && idx < upToStepIndex) {
          addDependencies(idx);
        }
      }
    };
    dependsOnStepIds.forEach((sid) => {
      const k = typeof sid === 'string' ? sid.trim() : '';
      const idx = planStepIdToIdx.get(k);
      if (Number.isFinite(idx) && idx >= 0 && idx < upToStepIndex) {
        addDependencies(idx);
      }
    });
    
    // 选择策略：
    // - 若声明了 dependsOnStepIds（dependencyChain 非空），仅包含依赖链上的“最新”步骤历史
    // - 若未声明 dependsOnStepIds（dependencyChain 为空），回退到包含所有之前步骤（idx < upToStepIndex）的“最新”历史
    // 先构建每个索引的“最新” tool_result 映射
    const lastByIndex = new Map();
    for (const h of history) {
      if (h.type !== 'tool_result') continue;
      const idx = Number(h.plannedStepIndex);
      if (!Number.isFinite(idx)) continue;
      lastByIndex.set(idx, h);
    }
    const allowed = new Set();
    for (let i = 0; i < upToStepIndex; i++) {
      if (dependencyChain.size > 0) {
        if (dependencyChain.has(i)) allowed.add(i);
      } else {
        allowed.add(i);
      }
    }
    // includeCurrentStep=true 时，允许加入当前索引（用于重试上下文）
    if (includeCurrentStep && Number.isFinite(upToStepIndex)) allowed.add(upToStepIndex);
    const orderedIdx = Array.from(allowed).sort((a, b) => a - b);
    const prev = [];
    for (const idx of orderedIdx) {
      const h = lastByIndex.get(idx);
      if (h) prev.push(h);
    }
    
    const msgs = [];
    for (const h of prev) {
      const aiName = h.aiName;
      const reasonRaw = plan?.steps?.[Number(h.plannedStepIndex)]?.reason;
      const reason = formatReason(reasonRaw);
      const plannedStepIndex = Number(h.plannedStepIndex);
      
      // FC 模式：使用 Sentra XML 格式（仅输出 XML，不再添加非 XML 的用户提示行）
      if (useFC) {
        // 工具调用 XML
        const toolCallXml = formatSentraToolCall(aiName, h.args);
        // 工具结果 XML
        const resultXml = formatSentraResult({
          stepIndex: plannedStepIndex,  // XML 中仍使用 step 属性
          stepId: h?.stepId,
          aiName,
          reason: reasonRaw,
          args: h.args,
          result: h.result
        });
        msgs.push({ role: 'assistant', content: `${toolCallXml}\n\n${resultXml}` });
      } else {
        // 默认：JSON 格式
        const argsPreview = clip(h.args);
        const resultPreview = clip(h.result?.data ?? h.result);
        msgs.push({ role: 'user', content: `现在该使用 ${aiName} 了。原因: ${reason || '(未提供)'}` });
        msgs.push({ role: 'assistant', content: [
          `参数(JSON): ${argsPreview}`,
          `结果(JSON): ${resultPreview}`
        ].join('\n') });
      }
    }
    return msgs;
  } catch (e) {
    // 不要中断主流程
    return [];
  }
}

// 中文：将 dependsOnStepIds 指定的上游步骤结果，整理为一个“依赖结果(JSON)”的 assistant 消息，便于参数生成阶段作为证据使用
export async function buildDependentContextMessages(runId, dependsOnStepIds = []) {
  if (!Array.isArray(dependsOnStepIds) || dependsOnStepIds.length === 0) return [];
  try {
    const ids = Array.from(new Set(dependsOnStepIds.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)));
    if (ids.length === 0) return [];
    const history = await HistoryStore.list(runId, 0, -1);
    const lastByStepId = new Map();
    for (const h of history) {
      if (h.type !== 'tool_result') continue;
      if (typeof h.stepId === 'string' && h.stepId.trim()) {
        lastByStepId.set(h.stepId.trim(), h);
      }
    }
    const items = [];
    for (const sid of ids) {
      const h = lastByStepId.get(sid);
      if (!h) continue;
      items.push({
        stepId: sid,
        plannedStepIndex: Number(h.plannedStepIndex),
        aiName: h.aiName,
        argsPreview: clip(h.args),
        resultPreview: clip(h.result?.data ?? h.result),
      });
    }
    if (!items.length) return [];
    const content = `依赖结果(JSON):\n${JSON.stringify(items, null, 2)}`;
    return [{ role: 'assistant', content }];
  } catch {
    return [];
  }
}

export default { buildToolDialogueMessages };
