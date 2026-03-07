function toText(value) {
  return String(value ?? '').trim();
}

export const EVAL_NEXT_ACTION = Object.freeze({
  perfect: 'perfect',
  supplement: 'supplement',
  replan: 'replan'
});

const ACTION_SET = new Set(Object.values(EVAL_NEXT_ACTION));

const COMPLETION_LEVEL_TO_ACTION = Object.freeze({
  perfect: EVAL_NEXT_ACTION.perfect,
  partial: EVAL_NEXT_ACTION.supplement,
  poor: EVAL_NEXT_ACTION.replan
});

export function normalizeEvalAction(evalObj = {}, fallback = EVAL_NEXT_ACTION.replan) {
  const success = evalObj?.success === true;
  const incomplete = evalObj?.incomplete === true;
  const reconcileWithOutcome = (candidate) => {
    const action = toText(candidate).toLowerCase();
    if (!ACTION_SET.has(action)) return '';
    if (success && !incomplete) return EVAL_NEXT_ACTION.perfect;
    if (success && incomplete && action === EVAL_NEXT_ACTION.perfect) return EVAL_NEXT_ACTION.supplement;
    if (!success && action === EVAL_NEXT_ACTION.perfect) return EVAL_NEXT_ACTION.replan;
    return action;
  };

  const action = toText(evalObj?.nextAction).toLowerCase();
  if (ACTION_SET.has(action)) return reconcileWithOutcome(action);

  const level = toText(evalObj?.completionLevel).toLowerCase();
  if (COMPLETION_LEVEL_TO_ACTION[level]) {
    return reconcileWithOutcome(COMPLETION_LEVEL_TO_ACTION[level]);
  }

  if (success && !incomplete) return EVAL_NEXT_ACTION.perfect;
  if (success && incomplete) return EVAL_NEXT_ACTION.supplement;

  const fallbackAction = toText(fallback).toLowerCase();
  if (ACTION_SET.has(fallbackAction)) return reconcileWithOutcome(fallbackAction);
  return reconcileWithOutcome(EVAL_NEXT_ACTION.replan);
}

export default {
  EVAL_NEXT_ACTION,
  normalizeEvalAction
};
