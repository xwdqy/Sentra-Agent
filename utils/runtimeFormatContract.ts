import type { ExpectedOutput } from '../src/types.js';
import {
  buildSentraRootDirectiveFromContract,
  buildSentraSkillsHintsFromContract,
  getSentraToolsContract,
  normalizeExpectedOutputToFormatContract
} from './sentraToolsContractEngine.js';

type RuntimeFormatFixContract = {
  title: string;
  objective: string;
  allowTools: boolean;
  constraints: string[];
  rules: string[];
  outputSpec: Record<string, unknown>;
  fewSteps: Array<Record<string, unknown>>;
};

function toRuntimeFormatFixContract(expectedOutput: ExpectedOutput | string): RuntimeFormatFixContract {
  const contractId = normalizeExpectedOutputToFormatContract(expectedOutput);
  const contract = getSentraToolsContract(contractId);
  return {
    title: contract.title,
    objective: contract.objective,
    allowTools: contract.allowTools,
    constraints: Array.isArray(contract.constraints) ? contract.constraints : [],
    rules: Array.isArray(contract.rules) ? contract.rules : [],
    outputSpec: contract.outputSpec && typeof contract.outputSpec === 'object'
      ? { ...contract.outputSpec }
      : {},
    fewSteps: Array.isArray(contract.fewSteps) ? contract.fewSteps.map((x) => ({ ...x })) : []
  };
}

export function getRuntimeFormatFixContract(expectedOutput: ExpectedOutput | string = 'sentra_message'): RuntimeFormatFixContract {
  return toRuntimeFormatFixContract(expectedOutput);
}

export function buildFormatFixRootDirectiveFromContract({
  expectedOutput = 'sentra_message',
  lastErrorReason,
  candidateOutput,
  scope = 'single_turn'
}: {
  expectedOutput?: ExpectedOutput | string;
  lastErrorReason?: string;
  candidateOutput?: string;
  scope?: string;
} = {}): string {
  const contractId = normalizeExpectedOutputToFormatContract(expectedOutput);
  const args: {
    contractId: string;
    idPrefix: string;
    scope: string;
    lastErrorReason?: string;
    candidateOutput?: string;
  } = {
    contractId,
    idPrefix: 'format_fix',
    scope
  };
  if (typeof lastErrorReason === 'string') args.lastErrorReason = lastErrorReason;
  if (typeof candidateOutput === 'string') args.candidateOutput = candidateOutput;
  return buildSentraRootDirectiveFromContract(args);
}

export function buildFormatFixSkillHintsFromContract({
  expectedOutput = 'sentra_message',
  lastErrorReason = ''
}: {
  expectedOutput?: ExpectedOutput | string;
  lastErrorReason?: string;
} = {}): string {
  const contractId = normalizeExpectedOutputToFormatContract(expectedOutput);
  return buildSentraSkillsHintsFromContract({
    contractId,
    lastErrorReason
  });
}
