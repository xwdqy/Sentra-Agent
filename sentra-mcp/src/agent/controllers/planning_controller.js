import { newStepId } from '../../utils/stepIds.js';
import { buildConcurrencyOverlay } from '../../bus/runRegistry.js';
import { normalizeRuntimeSignalAction } from './cancellation_controller.js';
import { normalizePlanStep } from './plan_step_controller.js';

export function normalizePlanStepIds(plan) {
  const p = (plan && typeof plan === 'object') ? plan : { steps: [], manifest: [] };
  const steps = Array.isArray(p.steps) ? p.steps : [];
  const manifestByAiName = new Map(
    (Array.isArray(p.manifest) ? p.manifest : [])
      .map((m) => [String(m?.aiName || '').trim(), m])
      .filter(([k]) => !!k)
  );
  const withIds = steps.map((s) => {
    const normalized = normalizePlanStep(s, { defaultExecutor: 'mcp' });
    const sid = (typeof normalized.stepId === 'string' && normalized.stepId.trim()) ? normalized.stepId.trim() : newStepId();
    const tool = manifestByAiName.get(String(normalized.aiName || '').trim()) || null;
    const inheritedCriteria = Array.isArray(tool?.skillDoc?.successCriteria)
      ? tool.skillDoc.successCriteria.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12)
      : [];
    const ownCriteria = Array.isArray(normalized.successCriteria)
      ? normalized.successCriteria.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12)
      : [];
    const successCriteria = ownCriteria.length ? ownCriteria : inheritedCriteria;
    return {
      ...normalized,
      stepId: sid,
      successCriteria: successCriteria.length ? successCriteria : undefined
    };
  });
  const idToIndex = new Map(withIds.map((s, idx) => [s.stepId, idx]));
  const finalSteps = withIds.map((s, idx0) => {
    const depsIdsRaw = Array.isArray(s.dependsOnStepIds) ? s.dependsOnStepIds : [];
    const cleanedIds = depsIdsRaw
      .map((x) => (typeof x === 'string' ? x.trim() : ''))
      .filter(Boolean)
      .filter((x) => idToIndex.has(x))
      .filter((x) => x !== s.stepId);
    const uniq = Array.from(new Set(cleanedIds));
    const displayIndex = Number.isFinite(Number(s.displayIndex)) ? Number(s.displayIndex) : (idx0 + 1);
    return { ...s, displayIndex, dependsOnStepIds: uniq.length ? uniq : undefined };
  });

  return { ...p, steps: finalSteps };
}

export function mergeGlobalOverlay(context, overlayText) {
  if (!overlayText) return context;
  const ctx0 = (context && typeof context === 'object') ? context : {};
  const po0 = (ctx0.promptOverlays && typeof ctx0.promptOverlays === 'object') ? ctx0.promptOverlays : {};
  const existingGlobal = po0.global;
  const existingSystem = (existingGlobal && typeof existingGlobal === 'object')
    ? (existingGlobal.system || '')
    : (existingGlobal ? String(existingGlobal) : '');
  const mergedSystem = [existingSystem, overlayText].filter(Boolean).join('\n\n');
  const nextGlobal = (existingGlobal && typeof existingGlobal === 'object')
    ? { ...existingGlobal, system: mergedSystem }
    : { system: mergedSystem };
  return { ...ctx0, promptOverlays: { ...po0, global: nextGlobal } };
}

export function injectConcurrencyOverlay({ runId, objective, context }) {
  const cid = context?.channelId != null ? String(context.channelId) : '';
  const ik = context?.identityKey != null ? String(context.identityKey) : '';
  if (!cid && !ik) return context;
  const overlay = buildConcurrencyOverlay({ runId, channelId: cid, identityKey: ik, objective });
  return mergeGlobalOverlay(context, overlay);
}

export function buildAdaptiveObjective({ baseObjective, action, evalObj, round }) {
  const summary = String(evalObj?.summary || '').trim();
  const missingGoals = Array.isArray(evalObj?.missingGoals)
    ? evalObj.missingGoals.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 12)
    : [];
  const missingText = missingGoals.length ? `\nMissing goals:\n- ${missingGoals.join('\n- ')}` : '';
  if (action === 'supplement') {
    return `${baseObjective}\n\n[ADAPTIVE ROUND ${round}: SUPPLEMENT]\nContinue from current progress and only add missing work.\n${summary ? `Evaluation summary:\n${summary}\n` : ''}${missingText}\nConstraints:\n1) Reuse finished results, do not repeat completed work.\n2) Focus on missing deliverables only.\n3) Keep plan concise and executable.`;
  }
  return `${baseObjective}\n\n[ADAPTIVE ROUND ${round}: REPLAN]\nCurrent execution quality is poor; rebuild an executable plan from current context.\n${summary ? `Evaluation summary:\n${summary}\n` : ''}${missingText}\nConstraints:\n1) Prioritize objective completion over preserving old steps.\n2) Avoid known failed paths when possible.\n3) Output practical, minimal-risk steps.`;
}

export function buildRuntimeAdaptiveObjective({ baseObjective, runtimeDirective, round }) {
  const action = normalizeRuntimeSignalAction(runtimeDirective?.action) || 'replan';
  const signalMessage = String(runtimeDirective?.message || '').trim();
  const reason = String(runtimeDirective?.reason || '').trim();
  const actionTag = action === 'supplement' ? 'SUPPLEMENT' : 'REPLAN';
  const actionHint = action === 'supplement'
    ? 'Continue from completed work and only fill missing/updated requirements from user follow-up.'
    : 'User intent changed; rebuild the plan from current context using the latest user message as priority.';
  return `${baseObjective}\n\n[RUNTIME ADAPTIVE ROUND ${round}: ${actionTag}]\nLatest user follow-up:\n${signalMessage || '(empty)'}\n${reason ? `Decision reason:\n${reason}\n` : ''}Constraints:\n1) Reuse completed results when still relevant.\n2) Follow the latest user follow-up first.\n3) Keep steps executable and concise.\n4) ${actionHint}`;
}
