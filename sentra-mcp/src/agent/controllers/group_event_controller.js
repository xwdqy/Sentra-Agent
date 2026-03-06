export function createGroupEventCoordinator({
  runId,
  emitRunEvent,
  canEmitLiveEvents,
  canFlushBufferedEvents,
  getGroupOf,
  getGroups,
  getGroupPending,
  getNextGroupToFlush,
  setNextGroupToFlush,
  getTopoOrderForGroup,
  getStepIdForIndex
}) {
  const groupBuffers = new Map();
  const groupArgsBuffers = new Map();
  const isolatedResultBuffers = new Map();
  let finalResultEmitted = false;

  const resolveGroup = (gid) => {
    const groups = Array.isArray(getGroups?.()) ? getGroups() : [];
    return groups.find((x) => x && x.id === gid);
  };

  const buildOrderStepIds = (order) => order.map((idx) => getStepIdForIndex(idx));

  const flushGroupIfReady = (gid, { finalHint, force } = {}) => {
    if (gid === null || gid === undefined) return false;
    const g = resolveGroup(gid);
    if (!g || g.flushed) return false;
    if (!canFlushBufferedEvents()) {
      groupBuffers.delete(gid);
      groupArgsBuffers.delete(gid);
      g.flushed = true;
      return false;
    }
    const groupPending = getGroupPending();
    const left = groupPending.get(gid) || 0;
    if (!force && left > 0) return false;
    const order = getTopoOrderForGroup(gid);
    const orderStepIds = buildOrderStepIds(order);
    const buf = groupBuffers.get(gid) || new Map();
    const bufArgs = groupArgsBuffers.get(gid) || new Map();

    const argsItems = [];
    for (const idx of order) {
      const a = bufArgs.get(idx);
      if (a) argsItems.push(a);
    }
    if (argsItems.length > 0) {
      const argsGroupEvent = {
        type: 'args_group',
        groupId: gid,
        groupSize: (g.nodes?.length || 0),
        orderStepIds,
        items: argsItems,
      };
      emitRunEvent(runId, argsGroupEvent);
    }

    const resultEvents = [];
    for (const idx of order) {
      const ev = buf.get(idx);
      if (ev) resultEvents.push(ev);
    }
    if (resultEvents.length > 0) {
      const shouldFinal = !!finalHint && !finalResultEmitted;
      const resultGroupEvent = {
        type: 'tool_result_group',
        groupId: gid,
        groupSize: (g.nodes?.length || 0),
        orderStepIds,
        events: resultEvents,
        resultStream: true,
        resultStatus: shouldFinal ? 'final' : 'progress',
        groupFlushed: true,
      };
      emitRunEvent(runId, resultGroupEvent);
      if (shouldFinal) finalResultEmitted = true;
    }

    groupBuffers.delete(gid);
    groupArgsBuffers.delete(gid);
    g.flushed = true;
    return true;
  };

  const flushReadyGroupsInOrder = ({ force = false, finalGroupId = null } = {}) => {
    while (getNextGroupToFlush() < getGroups().length) {
      const g = getGroups()[getNextGroupToFlush()];
      if (!g) break;
      const gid = g.id;
      const left = getGroupPending().get(gid) || 0;
      if (!force && left > 0) break;
      const shouldMarkFinal = finalGroupId !== null && finalGroupId !== undefined && gid === finalGroupId;
      const flushed = flushGroupIfReady(gid, { finalHint: shouldMarkFinal, force: true });
      if (!flushed) break;
      setNextGroupToFlush(getNextGroupToFlush() + 1);
    }
  };

  const flushIsolatedResultIfAny = (plannedStepIndex, finalHint) => {
    try {
      const ev = isolatedResultBuffers.get(plannedStepIndex);
      if (!ev) return;
      if (!canEmitLiveEvents()) {
        isolatedResultBuffers.delete(plannedStepIndex);
        return;
      }
      const shouldFinal = !!finalHint && !finalResultEmitted;
      emitRunEvent(runId, {
        ...ev,
        resultStream: true,
        resultStatus: shouldFinal ? 'final' : 'progress'
      });
      if (shouldFinal) finalResultEmitted = true;
      isolatedResultBuffers.delete(plannedStepIndex);
    } catch { }
  };

  const emitToolResultGrouped = (ev, plannedStepIndex) => {
    if (!canEmitLiveEvents()) return;
    const gid = getGroupOf()?.[plannedStepIndex];
    if (gid === null || gid === undefined) {
      isolatedResultBuffers.set(plannedStepIndex, ev);
      return;
    }
    if (!groupBuffers.has(gid)) groupBuffers.set(gid, new Map());
    groupBuffers.get(gid).set(plannedStepIndex, ev);
  };

  const emitArgsGrouped = (argsEv, plannedStepIndex) => {
    if (!canEmitLiveEvents()) return;
    const gid = getGroupOf()?.[plannedStepIndex];
    if (gid === null || gid === undefined) {
      emitRunEvent(runId, argsEv);
      return;
    }
    if (!groupArgsBuffers.has(gid)) groupArgsBuffers.set(gid, new Map());
    groupArgsBuffers.get(gid).set(plannedStepIndex, argsEv);
  };

  const forceFlushAllBuffersAsSingleEvents = () => {
    if (!canFlushBufferedEvents()) return;
    for (const [, buf] of groupArgsBuffers.entries()) {
      for (const [, ev] of buf.entries()) {
        emitRunEvent(runId, ev);
      }
    }
    for (const [, buf] of groupBuffers.entries()) {
      for (const [, ev] of buf.entries()) {
        emitRunEvent(runId, ev);
      }
    }
    groupArgsBuffers.clear();
    groupBuffers.clear();
  };

  const flushAllOnCancel = () => {
    if (!canFlushBufferedEvents()) return;
    try {
      for (const [, ev] of isolatedResultBuffers.entries()) {
        try {
          emitRunEvent(runId, { ...ev, resultStream: true, resultStatus: 'progress' });
        } catch { }
      }
      isolatedResultBuffers.clear();
    } catch { }
    try {
      flushReadyGroupsInOrder({ force: true, finalGroupId: null });
    } catch { }
  };

  const decrementGroupPendingAndMaybeFlush = (plannedStepIndex, { isFinalStep = false } = {}) => {
    const gid = getGroupOf()?.[plannedStepIndex];
    const groupPending = getGroupPending();
    const groups = getGroups();
    if (gid === null || gid === undefined || !groupPending.has(gid)) return;
    groupPending.set(gid, Math.max(0, (groupPending.get(gid) || 0) - 1));
    const finalGid = isFinalStep && groups.length ? groups[groups.length - 1].id : null;
    flushReadyGroupsInOrder({ force: false, finalGroupId: finalGid });
  };

  const resetOnGroupingRebuild = () => {
    groupArgsBuffers.clear();
    groupBuffers.clear();
  };

  return {
    flushIsolatedResultIfAny,
    emitToolResultGrouped,
    emitArgsGrouped,
    flushReadyGroupsInOrder,
    flushAllOnCancel,
    forceFlushAllBuffersAsSingleEvents,
    decrementGroupPendingAndMaybeFlush,
    resetOnGroupingRebuild
  };
}
