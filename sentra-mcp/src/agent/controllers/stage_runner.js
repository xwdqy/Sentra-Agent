import { config } from '../../config/index.js';
import { judgeToolNecessity } from '../stages/judge.js';
import { judgeToolNecessityFC } from '../stages/judge_fc.js';
import { evaluateRun } from '../stages/evaluate.js';
import { normalizeEvalAction as normalizeEvalActionByPolicy } from './eval_decision_policy.js';

export function normalizeEvalAction(evalObj) {
  return normalizeEvalActionByPolicy(evalObj, 'replan');
}

export async function runJudgeStage({
  objective,
  manifest,
  conversation,
  context = {},
  forceNeedTools = false,
  toolStrategy
}) {
  const preferredRoute = String(
    context?.preferredRoute ?? context?.preferred_route ?? ''
  ).trim().toLowerCase();
  if (forceNeedTools !== true && preferredRoute === 'skills') {
    return {
      need: false,
      summary: 'tool_gate_selected:skills',
      toolNames: [],
      ok: true,
      preferredRoute: 'skills'
    };
  }
  const strategy = String(toolStrategy || config.llm?.toolStrategy || 'auto');
  const judgeFunc = strategy === 'fc' ? judgeToolNecessityFC : judgeToolNecessity;
  const judgeCtx = {
    ...(context && typeof context === 'object' ? context : {}),
    forceNeedTools: forceNeedTools === true
  };
  const judge = await judgeFunc(objective, manifest, conversation, judgeCtx);

  if (forceNeedTools === true) {
    if (!judge || judge.ok === false) {
      return {
        need: true,
        summary: 'forced_need_tools=true;judge_fallback',
        toolNames: [],
        ok: true,
        forced: true
      };
    }
    return {
      ...judge,
      need: true,
      summary: String(judge?.summary || '').trim() || 'forced_need_tools=true',
      ok: true,
      forced: true
    };
  }
  return judge;
}

export async function runPlanStage({
  objective,
  mcpcore,
  context = {},
  conversation,
  runId,
  judge,
  generatePlanFn,
  normalizePlanFn
}) {
  const raw = await generatePlanFn(objective, mcpcore, { ...context, runId, judge }, conversation);
  return typeof normalizePlanFn === 'function' ? normalizePlanFn(raw) : raw;
}

export async function runEvaluateStage({
  objective,
  plan,
  exec,
  runId,
  context = {},
  assistantFeedback
}) {
  const evalContext = (assistantFeedback && typeof assistantFeedback === 'object')
    ? { ...context, assistantFeedback }
    : context;
  return evaluateRun(objective, plan, exec, runId, evalContext);
}
