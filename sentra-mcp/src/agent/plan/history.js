import { HistoryStore } from '../../history/store.js';
import { clip } from '../../utils/text.js';
import { formatSentraResult } from '../../utils/fc.js';

function formatReason(reason) {
  if (Array.isArray(reason) && reason.length > 0) return reason.join('; ');
  return '';
}

export async function buildDependentContextText(runId, dependsOnStepIds = [], useFC = false) {
  if (!Array.isArray(dependsOnStepIds) || dependsOnStepIds.length === 0) return '';
  try {
    const ids = Array.from(new Set(
      dependsOnStepIds
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter(Boolean)
    ));
    if (ids.length === 0) return '';

    const history = await HistoryStore.list(runId, 0, -1);
    const plan = await HistoryStore.getPlan(runId);

    const lastByStepId = new Map();
    for (const h of history) {
      if (h?.type !== 'tool_result') continue;
      const sid = typeof h?.stepId === 'string' ? h.stepId.trim() : '';
      if (!sid) continue;
      lastByStepId.set(sid, h);
    }

    const items = [];
    for (const sid of ids) {
      const h = lastByStepId.get(sid);
      if (!h) continue;
      const idx = Number(h.plannedStepIndex);
      const reason = (Number.isFinite(idx) && Array.isArray(plan?.steps) && plan.steps[idx])
        ? plan.steps[idx].reason
        : '';
      items.push({ idx, h, reason });
    }
    if (!items.length) return '';

    if (useFC) {
      return items
        .map(({ idx, h, reason }) => formatSentraResult({
          stepIndex: idx,
          stepId: h?.stepId,
          aiName: h.aiName,
          reason,
          args: h.args,
          result: h.result,
          includeResultData: true,
        }))
        .join('\n\n');
    }

    const jsonItems = items.map(({ idx, h, reason }) => ({
      plannedStepIndex: idx,
      stepId: h?.stepId,
      aiName: h.aiName,
      reason: clip(formatReason(reason)),
      argsPreview: clip(h.args),
      resultPreview: clip(h.result?.data ?? h.result),
    }));

    return `\n依赖结果(JSON):\n${JSON.stringify(jsonItems, null, 2)}`;
  } catch {
    return '';
  }
}

export async function buildDependentContextMessages(runId, dependsOnStepIds = []) {
  if (!Array.isArray(dependsOnStepIds) || dependsOnStepIds.length === 0) return [];
  try {
    const ids = Array.from(new Set(
      dependsOnStepIds
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter(Boolean)
    ));
    if (ids.length === 0) return [];

    const history = await HistoryStore.list(runId, 0, -1);
    const lastByStepId = new Map();
    for (const h of history) {
      if (h?.type !== 'tool_result') continue;
      const sid = typeof h?.stepId === 'string' ? h.stepId.trim() : '';
      if (!sid) continue;
      lastByStepId.set(sid, h);
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

    return [{ role: 'assistant', content: `依赖结果(JSON):\n${JSON.stringify(items, null, 2)}` }];
  } catch {
    return [];
  }
}

export default { buildDependentContextText, buildDependentContextMessages };
