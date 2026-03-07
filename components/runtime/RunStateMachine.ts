export type ChildRunTerminalState = 'succeeded' | 'failed' | '';
export type ChildRunStateName = 'planned' | 'running' | 'succeeded' | 'failed' | 'finalized';
export type OrchestratorRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

type ChildTransition = {
  from: string;
  to: string;
  ts: number;
  reasonCode: string;
  resultCode: string;
};

export type ChildStepStateRecord = {
  runId: string;
  stepId: string;
  state: ChildRunStateName;
  terminalState: ChildRunTerminalState;
  reasonCode: string;
  resultCode: string;
  note: string;
  startedAt: number;
  finishedAt: number;
  updatedAt: number;
  transitions: ChildTransition[];
};

export type ChildRunStateRecord = {
  status: string;
  reasonCode: string;
  note: string;
  updatedAt: number;
};

export type OrchestratorOutcome = {
  status: OrchestratorRunStatus;
  reasonCode: string;
  note: string;
};

type SetChildOutcomeParams = {
  runId: string;
  status?: string;
  reasonCode?: string;
  note?: string;
  resultCode?: string;
};

function nowMs(): number {
  return Date.now();
}

function toText(value: unknown): string {
  return String(value ?? '').trim();
}

function pushTransition(
  list: ChildTransition[],
  row: ChildTransition,
  maxItems = 16
): ChildTransition[] {
  const next = Array.isArray(list) ? list.slice() : [];
  next.push(row);
  if (next.length <= maxItems) return next;
  return next.slice(next.length - maxItems);
}

function resolveTerminalState(statusRaw: unknown): ChildRunTerminalState {
  const status = toText(statusRaw).toLowerCase();
  if (status === 'completed') return 'succeeded';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  return 'failed';
}

export class RunStateMachine {
  private readonly orchestratorRunId: string;
  private outcome: OrchestratorOutcome;
  private readonly childRunIds: Set<string>;
  private readonly childStepStateByRun: Map<string, ChildStepStateRecord>;
  private readonly childRunStateByRun: Map<string, ChildRunStateRecord>;

  constructor(params: {
    orchestratorRunId: string;
    initialStatus?: OrchestratorRunStatus;
    initialReasonCode?: string;
    initialNote?: string;
  }) {
    this.orchestratorRunId = toText(params?.orchestratorRunId);
    this.outcome = {
      status: params?.initialStatus || 'running',
      reasonCode: toText(params?.initialReasonCode),
      note: toText(params?.initialNote)
    };
    this.childRunIds = new Set<string>();
    this.childStepStateByRun = new Map<string, ChildStepStateRecord>();
    this.childRunStateByRun = new Map<string, ChildRunStateRecord>();
  }

  setOutcome(params: {
    status?: string;
    reasonCode?: string;
    note?: string;
  }): OrchestratorOutcome {
    const statusRaw = toText(params?.status).toLowerCase();
    if (statusRaw === 'running' || statusRaw === 'completed' || statusRaw === 'failed' || statusRaw === 'cancelled') {
      this.outcome.status = statusRaw as OrchestratorRunStatus;
    }
    const reasonCode = toText(params?.reasonCode);
    if (reasonCode) this.outcome.reasonCode = reasonCode;
    const note = toText(params?.note);
    if (note) this.outcome.note = note;
    return this.getOutcome();
  }

  getOutcome(): OrchestratorOutcome {
    return {
      status: this.outcome.status,
      reasonCode: this.outcome.reasonCode,
      note: this.outcome.note
    };
  }

  startChildRun(runIdLike: unknown): void {
    const runId = toText(runIdLike);
    if (!runId || runId === this.orchestratorRunId) return;
    this.childRunIds.add(runId);
    const now = nowMs();
    const prev = this.childStepStateByRun.get(runId);
    if (prev) {
      if (String(prev.state || '').toLowerCase() === 'running') return;
      const from = toText(prev.state || 'planned') || 'planned';
      const transitions = pushTransition(prev.transitions, {
        from,
        to: 'running',
        ts: now,
        reasonCode: toText(prev.reasonCode),
        resultCode: toText(prev.resultCode)
      });
      this.childStepStateByRun.set(runId, {
        ...prev,
        state: 'running',
        updatedAt: now,
        transitions
      });
      return;
    }
    this.childStepStateByRun.set(runId, {
      runId,
      stepId: `child_${runId}`,
      state: 'running',
      terminalState: '',
      reasonCode: 'child_run_started',
      resultCode: '',
      note: '',
      startedAt: now,
      finishedAt: 0,
      updatedAt: now,
      transitions: [{
        from: 'planned',
        to: 'running',
        ts: now,
        reasonCode: 'child_run_started',
        resultCode: ''
      }]
    });
  }

  setChildOutcome(params: SetChildOutcomeParams): void {
    const runId = toText(params?.runId);
    if (!runId || runId === this.orchestratorRunId) return;
    this.startChildRun(runId);
    const status = toText(params?.status).toLowerCase() || 'completed';
    const reasonCode = toText(params?.reasonCode);
    const note = toText(params?.note);
    const resultCode = toText(params?.resultCode);
    this.childRunStateByRun.set(runId, {
      status,
      reasonCode,
      note,
      updatedAt: nowMs()
    });

    const now = nowMs();
    const prev = this.childStepStateByRun.get(runId);
    const prevState = toText(prev?.state || 'running') || 'running';
    const terminalState = resolveTerminalState(status);
    const transitions1 = pushTransition(Array.isArray(prev?.transitions) ? prev!.transitions : [], {
      from: prevState,
      to: terminalState,
      ts: now,
      reasonCode,
      resultCode
    });
    const transitions2 = pushTransition(transitions1, {
      from: terminalState,
      to: 'finalized',
      ts: now,
      reasonCode: reasonCode ? `${reasonCode}_finalized` : 'child_run_finalized',
      resultCode
    });

    this.childStepStateByRun.set(runId, {
      runId,
      stepId: toText(prev?.stepId || `child_${runId}`),
      state: 'finalized',
      terminalState,
      reasonCode,
      resultCode,
      note,
      startedAt: Number.isFinite(Number(prev?.startedAt)) ? Number(prev?.startedAt) : now,
      finishedAt: now,
      updatedAt: now,
      transitions: transitions2
    });
  }

  listChildRunIds(): string[] {
    return Array.from(this.childRunIds.values());
  }

  listChildStepStates(): ChildStepStateRecord[] {
    const out: ChildStepStateRecord[] = [];
    for (const runId of this.listChildRunIds()) {
      const row = this.childStepStateByRun.get(runId);
      if (!row) {
        out.push({
          runId,
          stepId: `child_${runId}`,
          state: 'running',
          terminalState: '',
          reasonCode: '',
          resultCode: '',
          note: '',
          startedAt: 0,
          finishedAt: 0,
          updatedAt: 0,
          transitions: []
        });
        continue;
      }
      out.push({
        ...row,
        transitions: Array.isArray(row.transitions) ? row.transitions.slice(-8) : []
      });
    }
    return out;
  }

  listChildRunStates(): Array<{ runId: string; status: string; reasonCode: string; note: string; updatedAt: number; }> {
    const out: Array<{ runId: string; status: string; reasonCode: string; note: string; updatedAt: number; }> = [];
    for (const runId of this.listChildRunIds()) {
      const row = this.childRunStateByRun.get(runId);
      out.push({
        runId,
        status: toText(row?.status || 'unknown'),
        reasonCode: toText(row?.reasonCode),
        note: toText(row?.note),
        updatedAt: Number.isFinite(Number(row?.updatedAt)) ? Number(row?.updatedAt) : 0
      });
    }
    return out;
  }

  countChildStepStates(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of this.listChildStepStates()) {
      const key = toText(row.state || 'unknown') || 'unknown';
      counts[key] = Number(counts[key] || 0) + 1;
    }
    return counts;
  }

  countChildRunStatus(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of this.listChildRunStates()) {
      const key = toText(row.status || 'unknown') || 'unknown';
      counts[key] = Number(counts[key] || 0) + 1;
    }
    return counts;
  }
}

export default {
  RunStateMachine
};
