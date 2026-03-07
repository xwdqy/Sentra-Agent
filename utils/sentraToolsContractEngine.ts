import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { escapeXml } from './xmlUtils.js';
import type { ExpectedOutput } from '../src/types.js';

type SentraToolsContract = {
  title: string;
  type: string;
  phase: string;
  expectedOutput: string;
  allowTools: boolean;
  objective: string;
  outputInstruction: string;
  constraints: string[];
  rules: string[];
  outputSpec: Record<string, unknown>;
  fewSteps: Array<Record<string, unknown>>;
};

type SentraToolsContractsDoc = {
  version: string;
  contracts: Record<string, SentraToolsContract>;
};

type BuildRootDirectiveParams = {
  contractId: string;
  idPrefix?: string;
  scope?: string;
  phaseOverride?: string;
  objectiveOverride?: string;
  expectedOutputOverride?: string;
  lastErrorReason?: string;
  candidateOutput?: string;
  extraFields?: Record<string, string>;
  extraBlocks?: string[];
};

const CONTRACT_FILE = path.resolve(process.cwd(), 'sentra-prompts', 'prompts', 'sentra_tools_contracts.json');

const FALLBACK_CONTRACT: SentraToolsContract = {
  title: 'Sentra Tools Contract',
  type: 'generic',
  phase: 'Runtime',
  expectedOutput: 'sentra_tools',
  allowTools: true,
  objective: 'Output a valid sentra-tools block.',
  outputInstruction: 'Output exactly one <sentra-tools> block and nothing else.',
  constraints: ['Output exactly one top-level <sentra-tools> block and nothing else.'],
  rules: ['Use legal invoke/parameter XML structure only.'],
  outputSpec: {
    rootTag: 'sentra-tools'
  },
  fewSteps: []
};

let cacheDoc: SentraToolsContractsDoc | null = null;

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((x) => String(x || '').trim())
    .filter(Boolean);
}

function normalizeContract(raw: unknown): SentraToolsContract {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const title = String(obj.title || FALLBACK_CONTRACT.title).trim() || FALLBACK_CONTRACT.title;
  const type = String(obj.type || FALLBACK_CONTRACT.type).trim() || FALLBACK_CONTRACT.type;
  const phase = String(obj.phase || FALLBACK_CONTRACT.phase).trim() || FALLBACK_CONTRACT.phase;
  const expectedOutput = String(obj.expectedOutput || FALLBACK_CONTRACT.expectedOutput).trim() || FALLBACK_CONTRACT.expectedOutput;
  const allowTools = typeof obj.allowTools === 'boolean' ? obj.allowTools : FALLBACK_CONTRACT.allowTools;
  const objective = String(obj.objective || FALLBACK_CONTRACT.objective).trim() || FALLBACK_CONTRACT.objective;
  const outputInstruction = String(obj.outputInstruction || FALLBACK_CONTRACT.outputInstruction).trim() || FALLBACK_CONTRACT.outputInstruction;
  const constraints = normalizeStringArray(obj.constraints);
  const rules = normalizeStringArray(obj.rules);
  const outputSpec = obj.outputSpec && typeof obj.outputSpec === 'object'
    ? { ...(obj.outputSpec as Record<string, unknown>) }
    : { ...(FALLBACK_CONTRACT.outputSpec || {}) };
  const fewSteps = Array.isArray(obj.fewSteps)
    ? obj.fewSteps.filter((x) => x && typeof x === 'object').map((x) => ({ ...(x as Record<string, unknown>) }))
    : [];

  return {
    title,
    type,
    phase,
    expectedOutput,
    allowTools,
    objective,
    outputInstruction,
    constraints: constraints.length > 0 ? constraints : [...FALLBACK_CONTRACT.constraints],
    rules: rules.length > 0 ? rules : [...FALLBACK_CONTRACT.rules],
    outputSpec,
    fewSteps
  };
}

function loadDoc(): SentraToolsContractsDoc {
  if (cacheDoc) return cacheDoc;
  try {
    if (!fs.existsSync(CONTRACT_FILE)) {
      cacheDoc = { version: 'fallback', contracts: { fallback: { ...FALLBACK_CONTRACT } } };
      return cacheDoc;
    }
    const raw = fs.readFileSync(CONTRACT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SentraToolsContractsDoc>;
    const sourceContracts = parsed?.contracts && typeof parsed.contracts === 'object'
      ? parsed.contracts as Record<string, unknown>
      : {};
    const normalizedContracts: Record<string, SentraToolsContract> = {};
    for (const [key, value] of Object.entries(sourceContracts)) {
      const id = String(key || '').trim();
      if (!id) continue;
      normalizedContracts[id] = normalizeContract(value);
    }
    if (!normalizedContracts.fallback) {
      normalizedContracts.fallback = { ...FALLBACK_CONTRACT };
    }
    cacheDoc = {
      version: String(parsed?.version || 'unknown'),
      contracts: normalizedContracts
    };
    return cacheDoc;
  } catch {
    cacheDoc = { version: 'fallback', contracts: { fallback: { ...FALLBACK_CONTRACT } } };
    return cacheDoc;
  }
}

function safeContractId(raw: unknown): string {
  const s = String(raw || '').trim();
  return s || 'fallback';
}

export function getSentraToolsContract(contractId: string): SentraToolsContract {
  const id = safeContractId(contractId);
  const doc = loadDoc();
  return doc.contracts[id] || doc.contracts.fallback || FALLBACK_CONTRACT;
}

export function normalizeExpectedOutputToFormatContract(expectedOutput: ExpectedOutput | string = 'sentra_message'): string {
  const eo = String(expectedOutput || 'sentra_message').trim().toLowerCase();
  if (eo === 'reply_gate_decision_tools') return 'format_fix_reply_gate_decision_tools';
  if (eo === 'override_intent_decision_tools') return 'format_fix_override_intent_decision_tools';
  if (eo === 'sentra_tools') return 'format_fix_sentra_tools';
  if (eo === 'sentra_tools_or_message') return 'format_fix_sentra_tools_or_message';
  return 'format_fix_sentra_message';
}

export function buildSentraRootDirectiveFromContract(params: BuildRootDirectiveParams): string {
  const {
    contractId,
    idPrefix = 'contract',
    scope = 'single_turn',
    phaseOverride,
    objectiveOverride,
    expectedOutputOverride,
    lastErrorReason,
    candidateOutput,
    extraFields,
    extraBlocks
  } = params;
  const contract = getSentraToolsContract(contractId);
  const expectedOutput = String(expectedOutputOverride || contract.expectedOutput || '').trim();
  const phase = String(phaseOverride || contract.phase || 'Runtime').trim();
  const objective = String(objectiveOverride || contract.objective || '').trim();
  const reason = String(lastErrorReason || '').trim();
  const candidate = String(candidateOutput || '').trim();
  const outputSpecJson = JSON.stringify(contract.outputSpec || {}, null, 2);
  const fewStepsJson = JSON.stringify(contract.fewSteps || [], null, 2);

  const lines: string[] = [
    '<sentra-root-directive>',
    `  <id>${escapeXml(`${idPrefix}_${randomUUID()}`)}</id>`,
    `  <type>${escapeXml(contract.type || 'generic')}</type>`,
    `  <scope>${escapeXml(scope)}</scope>`,
    `  <phase>${escapeXml(phase)}</phase>`,
    objective ? `  <objective>${escapeXml(objective)}</objective>` : '',
    expectedOutput ? `  <expected_output>${escapeXml(expectedOutput)}</expected_output>` : '',
    `  <allow_tools>${contract.allowTools ? 'true' : 'false'}</allow_tools>`,
    reason ? `  <last_error>${escapeXml(reason)}</last_error>` : '',
    candidate
      ? [
        '  <candidate_output>',
        `    ${escapeXml(candidate)}`,
        '  </candidate_output>'
      ].join('\n')
      : ''
  ];

  if (extraFields && typeof extraFields === 'object') {
    for (const [k, v] of Object.entries(extraFields)) {
      const tag = String(k || '').trim();
      if (!tag) continue;
      lines.push(`  <${tag}>${escapeXml(String(v || ''))}</${tag}>`);
    }
  }
  if (Array.isArray(extraBlocks) && extraBlocks.length > 0) {
    for (const block of extraBlocks) {
      const text = String(block || '').trim();
      if (!text) continue;
      lines.push(text);
    }
  }

  lines.push(
    '  <output_contract_json>',
    `    ${escapeXml(outputSpecJson)}`,
    '  </output_contract_json>',
    '  <few_steps_json>',
    `    ${escapeXml(fewStepsJson)}`,
    '  </few_steps_json>',
    '  <constraints>'
  );
  for (const item of contract.constraints) {
    lines.push(`    <item>${escapeXml(String(item || ''))}</item>`);
  }
  lines.push('  </constraints>', '</sentra-root-directive>');
  return lines.filter(Boolean).join('\n');
}

export function buildSentraSkillsHintsFromContract({
  contractId,
  lastErrorReason
}: {
  contractId: string;
  lastErrorReason?: string;
}): string {
  const contract = getSentraToolsContract(contractId);
  const reason = String(lastErrorReason || '').trim();
  const lines: string[] = [
    '<sentra-skills>',
    '  <sentra-skill>',
    `    <id>contract_${escapeXml(safeContractId(contractId))}</id>`,
    `    <title>${escapeXml(contract.title)}</title>`,
    ...contract.rules.map((rule) => `    <rule>${escapeXml(String(rule || ''))}</rule>`),
    '  </sentra-skill>'
  ];
  if (reason) {
    lines.push(
      '  <sentra-skill>',
      '    <id>contract_failure_trace</id>',
      '    <title>Failure Trace</title>',
      `    <rule>${escapeXml(reason)}</rule>`,
      '  </sentra-skill>'
    );
  }
  lines.push('</sentra-skills>');
  return lines.join('\n');
}

export function buildSentraContractPolicyText(contractId: string): string {
  const contract = getSentraToolsContract(contractId);
  const outputSpecJson = JSON.stringify(contract.outputSpec || {}, null, 2);
  const lines: string[] = [
    `Contract: ${contract.title}`,
    `Expected output: ${contract.expectedOutput}`,
    `Output instruction: ${contract.outputInstruction}`,
    'Constraints:'
  ];
  for (const item of contract.constraints) {
    lines.push(`- ${item}`);
  }
  if (contract.rules.length > 0) {
    lines.push('Rules:');
    for (const rule of contract.rules) {
      lines.push(`- ${rule}`);
    }
  }
  lines.push('Output spec (JSON):', outputSpecJson);
  return lines.join('\n');
}

export function getSentraContractOutputInstruction(contractId: string): string {
  const contract = getSentraToolsContract(contractId);
  return String(contract.outputInstruction || '').trim();
}

function getContractOutputSpec(contractId: string): Record<string, unknown> {
  const contract = getSentraToolsContract(contractId);
  return contract.outputSpec && typeof contract.outputSpec === 'object'
    ? contract.outputSpec as Record<string, unknown>
    : {};
}

export function getSentraContractRequiredInvokeName(contractId: string, fallback = ''): string {
  const outputSpec = getContractOutputSpec(contractId);
  const requiredInvoke = outputSpec.requiredInvoke && typeof outputSpec.requiredInvoke === 'object'
    ? outputSpec.requiredInvoke as Record<string, unknown>
    : {};
  const raw = String(requiredInvoke.name || '').trim();
  if (raw) return raw;
  return String(fallback || '').trim();
}

export function getSentraContractParameterEnum(
  contractId: string,
  parameterName: string,
  fallback: string[] = []
): string[] {
  const outputSpec = getContractOutputSpec(contractId);
  const enums = outputSpec.parameterEnums && typeof outputSpec.parameterEnums === 'object'
    ? outputSpec.parameterEnums as Record<string, unknown>
    : {};
  const key = String(parameterName || '').trim();
  const value = enums[key];
  if (Array.isArray(value)) {
    const items = value.map((x) => String(x || '').trim()).filter(Boolean);
    if (items.length > 0) return items;
  }
  if (value && typeof value === 'object') {
    const values = (value as Record<string, unknown>).values;
    if (Array.isArray(values)) {
      const items = values.map((x) => String(x || '').trim()).filter(Boolean);
      if (items.length > 0) return items;
    }
  }
  return Array.isArray(fallback)
    ? fallback.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
}
