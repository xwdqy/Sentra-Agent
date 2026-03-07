import { config } from '../../config/index.js';

export function normalizeReason(reason) {
  if (Array.isArray(reason)) {
    return reason.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim());
  }
  return [];
}

export function isResultOk(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.success === false) return false;
  if (result.success === true) return true;
  const code = String(result.code || '').toUpperCase();
  if (!code) return true;
  return code === 'OK' || code === 'SUCCESS';
}

export function applyDisplayIndex(steps) {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s && typeof s === 'object') {
      s.displayIndex = i + 1;
    }
  }
}

export function buildStepIdIndexMap(steps) {
  return new Map(
    (steps || [])
      .map((s, idx) => [typeof s?.stepId === 'string' ? s.stepId : '', idx])
      .filter(([k]) => k)
  );
}

export function sanitizeDependsOnStepIds(step, steps) {
  const m = buildStepIdIndexMap(steps);
  const ids = Array.isArray(step?.dependsOnStepIds) ? step.dependsOnStepIds : [];
  const cleaned = ids.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).filter((x) => m.has(x));
  const uniq = Array.from(new Set(cleaned));
  step.dependsOnStepIds = uniq.length ? uniq : undefined;
}

export function computeDependsOnIndicesFromStep({ step, steps, selfIndex }) {
  const m = buildStepIdIndexMap(steps);
  const out = [];
  if (Array.isArray(step?.dependsOnStepIds) && step.dependsOnStepIds.length) {
    for (const sid of step.dependsOnStepIds) {
      const idx = m.get(sid);
      if (Number.isInteger(idx) && idx >= 0 && idx !== selfIndex) out.push(idx);
    }
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

export function canTargetPending(targetIdx, currentIdx) {
  return Number.isFinite(targetIdx) && targetIdx > currentIdx;
}

export function buildDependencyChain(steps, sourceIndices) {
  const result = new Set(sourceIndices);
  const total = steps.length;
  const stepIdToIdx = new Map(
    (steps || [])
      .map((s, idx) => [typeof s?.stepId === 'string' ? s.stepId : '', idx])
      .filter(([k]) => k)
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < total; i++) {
      if (result.has(i)) continue;
      const step = steps[i];
      const depsIds = Array.isArray(step?.dependsOnStepIds) ? step.dependsOnStepIds : [];
      const depsIdx = depsIds
        .map((sid) => (typeof sid === 'string' ? stepIdToIdx.get(sid.trim()) : undefined))
        .filter((x) => Number.isInteger(x));
      if (depsIdx.some((d) => result.has(d))) {
        result.add(i);
        changed = true;
      }
    }
  }
  return result;
}

export function formatReason(reason) {
  if (Array.isArray(reason) && reason.length > 0) {
    return reason.join('; ');
  }
  return '';
}

export function isImmediateScheduleAllowed(aiName) {
  if (!aiName) return false;
  const schedCfg = config.schedule || {};
  const allow = Array.isArray(schedCfg.immediateAllowlist)
    ? schedCfg.immediateAllowlist
    : (schedCfg.immediateAllowlist ? [schedCfg.immediateAllowlist] : []);
  const deny = Array.isArray(schedCfg.immediateDenylist)
    ? schedCfg.immediateDenylist
    : (schedCfg.immediateDenylist ? [schedCfg.immediateDenylist] : []);

  if (deny.includes(aiName)) return false;
  if (allow.length === 0) return false;
  return allow.includes(aiName);
}

export function sanitizeContextForLog(context) {
  if (!context || typeof context !== 'object') return context;
  const { promptOverlays, overlays, ...rest } = context;
  const sanitized = { ...rest };
  if (promptOverlays || overlays) {
    sanitized.promptOverlays = '<omitted>';
  }
  return sanitized;
}

export function buildExecutionGroupingState({ steps = [], finished = new Set() } = {}) {
  const safeSteps = Array.isArray(steps) ? steps : [];
  const total = safeSteps.length;
  const depsArr = safeSteps.map((step, idx) => computeDependsOnIndicesFromStep({ step, steps: safeSteps, selfIndex: idx }));
  const revDepsArr = Array.from({ length: total }, () => []);
  for (let i = 0; i < total; i++) {
    for (const d of depsArr[i]) revDepsArr[d].push(i);
  }

  const undirected = Array.from({ length: total }, () => new Set());
  for (let i = 0; i < total; i++) {
    for (const d of depsArr[i]) {
      undirected[i].add(d);
      undirected[d].add(i);
    }
  }

  // Initial grouping by weakly connected components.
  const componentOf = new Array(total).fill(null);
  const components = [];
  for (let i = 0; i < total; i++) {
    if (componentOf[i] !== null) continue;
    const cid = components.length;
    const nodes = [];
    const q = [i];
    componentOf[i] = cid;
    while (q.length) {
      const u = q.shift();
      nodes.push(u);
      for (const v of undirected[u]) {
        if (componentOf[v] === null) {
          componentOf[v] = cid;
          q.push(v);
        }
      }
    }
    components.push(nodes);
  }

  // Compute transitive dependencies (ancestor closure) once for all steps.
  const ancestorMemo = new Map();
  const visiting = new Set();
  const getAncestors = (idx) => {
    if (ancestorMemo.has(idx)) return ancestorMemo.get(idx);
    if (visiting.has(idx)) return new Set();
    visiting.add(idx);
    const out = new Set();
    for (const d of depsArr[idx] || []) {
      out.add(d);
      const sub = getAncestors(d);
      for (const x of sub) out.add(x);
    }
    visiting.delete(idx);
    ancestorMemo.set(idx, out);
    return out;
  };
  for (let i = 0; i < total; i++) getAncestors(i);

  // Feedback grouping refinement:
  // If a node depends on all other nodes in its component (transitively),
  // treat it as an aggregation sink and isolate it into its own feedback group.
  const provisionalGroupNodes = [];
  for (const compNodes of components) {
    if (!Array.isArray(compNodes) || compNodes.length <= 1) {
      provisionalGroupNodes.push(Array.isArray(compNodes) ? [...compNodes] : []);
      continue;
    }
    const compSet = new Set(compNodes);
    const remain = [];
    const isolated = [];
    for (const node of compNodes) {
      const ancestors = ancestorMemo.get(node) || new Set();
      let covered = 0;
      for (const n of compSet) {
        if (n === node) continue;
        if (ancestors.has(n)) covered += 1;
      }
      if (covered === compNodes.length - 1) {
        isolated.push(node);
      } else {
        remain.push(node);
      }
    }
    if (remain.length > 0) provisionalGroupNodes.push(remain);
    for (const node of isolated) {
      provisionalGroupNodes.push([node]);
    }
  }

  const provisionalGroupOf = new Array(total).fill(null);
  for (let gid = 0; gid < provisionalGroupNodes.length; gid++) {
    for (const n of provisionalGroupNodes[gid] || []) {
      provisionalGroupOf[n] = gid;
    }
  }

  // Build group DAG and topologically reorder groups so flush order remains valid
  // even after isolating aggregation sinks.
  const groupIndeg = new Array(provisionalGroupNodes.length).fill(0);
  const groupOut = Array.from({ length: provisionalGroupNodes.length }, () => new Set());
  for (let i = 0; i < total; i++) {
    const gi = provisionalGroupOf[i];
    for (const d of depsArr[i] || []) {
      const gd = provisionalGroupOf[d];
      if (gi === null || gd === null || gi === gd) continue;
      if (!groupOut[gd].has(gi)) {
        groupOut[gd].add(gi);
        groupIndeg[gi] += 1;
      }
    }
  }

  const ready = [];
  for (let g = 0; g < provisionalGroupNodes.length; g++) {
    if (groupIndeg[g] === 0) ready.push(g);
  }
  ready.sort((a, b) => a - b);
  const topoGroups = [];
  while (ready.length > 0) {
    const g = ready.shift();
    topoGroups.push(g);
    for (const nxt of groupOut[g]) {
      groupIndeg[nxt] -= 1;
      if (groupIndeg[nxt] === 0) {
        ready.push(nxt);
      }
    }
    ready.sort((a, b) => a - b);
  }
  // Fallback for unexpected cycles (should not happen in DAG deps).
  if (topoGroups.length !== provisionalGroupNodes.length) {
    const seen = new Set(topoGroups);
    for (let g = 0; g < provisionalGroupNodes.length; g++) {
      if (!seen.has(g)) topoGroups.push(g);
    }
  }

  const groupOf = new Array(total).fill(null);
  const groups = topoGroups.map((oldGid, newGid) => {
    const nodes = (provisionalGroupNodes[oldGid] || []).slice().sort((a, b) => a - b);
    for (const n of nodes) groupOf[n] = newGid;
    return { id: newGid, nodes, flushed: false };
  });

  const groupPending = new Map(groups.map((g) => {
    const remaining = (g.nodes || []).filter((idx) => !finished.has(idx)).length;
    return [g.id, remaining];
  }));

  return {
    total,
    depsArr,
    revDepsArr,
    groupOf,
    groups,
    groupPending,
    nextGroupToFlush: 0
  };
}

export function buildGroupTopoOrder({ gid, groups, depsArr, revDepsArr } = {}) {
  const nodes = groups?.[gid]?.nodes || [];
  const inSet = new Set(nodes);
  const indeg = new Map();
  for (const u of nodes) indeg.set(u, 0);
  for (const u of nodes) {
    for (const d of depsArr?.[u] || []) {
      if (inSet.has(d)) indeg.set(u, indeg.get(u) + 1);
    }
  }
  const q = nodes.filter((u) => indeg.get(u) === 0).sort((a, b) => a - b);
  const out = [];
  while (q.length) {
    const u = q.shift();
    out.push(u);
    for (const v of revDepsArr?.[u] || []) {
      if (inSet.has(v)) {
        indeg.set(v, indeg.get(v) - 1);
        if (indeg.get(v) === 0) {
          q.push(v);
          q.sort((a, b) => a - b);
        }
      }
    }
  }
  if (out.length !== nodes.length) {
    const seen = new Set(out);
    const remain = nodes.filter((x) => !seen.has(x)).sort((a, b) => a - b);
    return out.concat(remain);
  }
  return out;
}

export function buildDependsNoteForStep({ stepIndex, steps, depsArr, revDepsArr } = {}) {
  const depOnIdx = depsArr?.[stepIndex] || [];
  const depByIdx = revDepsArr?.[stepIndex] || [];
  const depOn = depOnIdx
    .map((idx) => ({ idx, stepId: steps?.[idx]?.stepId, displayIndex: steps?.[idx]?.displayIndex }))
    .filter((x) => typeof x.stepId === 'string' && x.stepId);
  const depBy = depByIdx
    .map((idx) => ({ idx, stepId: steps?.[idx]?.stepId, displayIndex: steps?.[idx]?.displayIndex }))
    .filter((x) => typeof x.stepId === 'string' && x.stepId);
  if (depOn.length === 0 && depBy.length === 0) return 'no dependencies';
  const parts = [];
  if (depOn.length) parts.push('depends on: ' + depOn.map((x) => `${x.stepId}(#${x.displayIndex ?? (x.idx + 1)})`).join(', '));
  if (depBy.length) parts.push('depended by: ' + depBy.map((x) => `${x.stepId}(#${x.displayIndex ?? (x.idx + 1)})`).join(', '));
  return parts.join('; ');
}

export function buildDependsOnStepIdsForStep({ stepIndex, steps } = {}) {
  const ids = Array.isArray(steps?.[stepIndex]?.dependsOnStepIds) ? steps[stepIndex].dependsOnStepIds : [];
  return ids.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
}

export function buildDependedByStepIdsForStep({ stepIndex, steps, revDepsArr } = {}) {
  const idxs = revDepsArr?.[stepIndex] || [];
  return idxs
    .map((j) => steps?.[j]?.stepId)
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim());
}
