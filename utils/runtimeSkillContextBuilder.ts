import { createRuntimeSkillPromptComposer } from './runtimeSkillPromptComposer.js';
import type {
  RuntimeSkillHint,
  RuntimeSkillMode,
  RuntimeSkillRef
} from './runtimeSkillGuideEngine.js';
import { escapeXml } from './xmlUtils.js';

type RuntimeComposerOptions = {
  maxSkills?: number;
  minConfidence?: number;
  minScore?: number;
  maxUserSignalChars?: number;
  maxToolSignalChars?: number;
};

export type ResultRoundMode = 'single' | 'group';

type RuntimeRoundRootInput = {
  mode: RuntimeSkillMode;
  stage: string;
  userContent: unknown;
  hint?: RuntimeSkillHint;
};

type ResultRoundBundleInput = {
  mode: ResultRoundMode;
  requiredOutputMode: RuntimeSkillMode;
  stage: string;
  resultPayload: unknown;
  baseUserContentApi: unknown;
  baseUserContentSnapshot: unknown;
  hint?: RuntimeSkillHint;
};

function normalizeContentText(value: unknown): string {
  return typeof value === 'string'
    ? value.trim()
    : String(value ?? '').trim();
}

function indentXmlBlock(xml: string, indent = '  '): string {
  const text = String(xml || '').trim();
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}

function appendRootAtBottom(userContent: unknown, rootXml: string): string {
  const base = normalizeContentText(userContent);
  const root = normalizeContentText(rootXml);
  if (!root) return base;
  if (base.includes(root)) return base;
  if (!base) return root;
  return `${base}\n\n${root}`;
}

function buildRuntimeRoundRootXml(stage: string, sentraSkillsXml = ''): string {
  const stageText = String(stage || 'runtime').trim() || 'runtime';
  const skillsBlock = sentraSkillsXml && sentraSkillsXml.trim()
    ? indentXmlBlock(sentraSkillsXml, '  ')
    : [
      '  <sentra-skills>',
      '    <objective>No dynamic skill hints matched for this round.</objective>',
      '  </sentra-skills>'
    ].join('\n');
  return [
    '<root>',
    '  <runtime_round_type>sentra-runtime</runtime_round_type>',
    `  <stage>${escapeXml(stageText)}</stage>`,
    '  <output_contract>follow_system_gate</output_contract>',
    skillsBlock,
    '</root>'
  ].join('\n');
}

function buildResultRoundRootXml(mode: ResultRoundMode, sentraSkillsXml = ''): string {
  const skillsBlock = sentraSkillsXml && sentraSkillsXml.trim()
    ? indentXmlBlock(sentraSkillsXml, '  ')
    : [
      '  <sentra-skills>',
      '    <objective>No dynamic skill hints matched for this result round.</objective>',
      '  </sentra-skills>'
    ].join('\n');
  if (mode === 'group') {
    return [
      '<root>',
      '  <result_round_type>sentra-result-group</result_round_type>',
      '  <output_contract>sentra-message-only</output_contract>',
      '  <consume_order>',
      '    <primary_key>step_group_id</primary_key>',
      '    <secondary_key>order_step_ids</secondary_key>',
      '    <note>step_group_id is an internal execution id, not chat group_id.</note>',
      '  </consume_order>',
      skillsBlock,
      '</root>'
    ].join('\n');
  }
  return [
    '<root>',
    '  <result_round_type>sentra-result</result_round_type>',
    '  <output_contract>sentra-message-only</output_contract>',
    '  <strategy>answer incrementally from current result evidence.</strategy>',
    skillsBlock,
    '</root>'
  ].join('\n');
}

function buildResultRoundBundleInternal(
  resultPayload: unknown,
  mode: ResultRoundMode,
  baseUserContentApi: unknown,
  baseUserContentSnapshot: unknown,
  sentraSkillsXml = ''
): { apiContent: string; snapshotContent: string } {
  const resultPart = normalizeContentText(resultPayload);
  const baseApi = normalizeContentText(baseUserContentApi);
  const baseSnapshot = normalizeContentText(baseUserContentSnapshot);

  const apiMerged = resultPart && baseApi
    ? `${baseApi}\n\n${resultPart}`
    : (baseApi || resultPart);
  const snapshotMerged = resultPart && baseSnapshot
    ? `${baseSnapshot}\n\n${resultPart}`
    : (baseSnapshot || resultPart);

  return {
    apiContent: appendRootAtBottom(apiMerged, buildResultRoundRootXml(mode, sentraSkillsXml)),
    snapshotContent: snapshotMerged
  };
}

export function buildRuntimeSkillRefsSystemAddon(runtimeOptions?: Record<string, unknown>): string {
  const options = runtimeOptions && typeof runtimeOptions === 'object'
    ? runtimeOptions
    : {};
  const dynamicBlockRaw = typeof options.dynamic_skill_block === 'string'
    ? options.dynamic_skill_block.trim()
    : '';
  if (dynamicBlockRaw) {
    return dynamicBlockRaw;
  }

  const refsRaw = Array.isArray(options.dynamic_skill_refs) ? options.dynamic_skill_refs : [];
  if (!refsRaw.length) return '';
  const stage = typeof options.dynamic_skill_stage === 'string'
    ? options.dynamic_skill_stage.trim() || 'runtime'
    : 'runtime';
  const rows = refsRaw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const ref = item as Record<string, unknown>;
      const id = String(ref.id || '').trim();
      if (!id) return null;
      const title = String(ref.title || id).trim() || id;
      const uuid = String(ref.uuid || '').trim();
      const priorityRaw = Number(ref.priority);
      const priority = Number.isFinite(priorityRaw) ? priorityRaw : 1000;
      const confidenceRaw = Number(ref.confidence);
      const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : 0;
      const scoreRaw = Number(ref.score);
      const score = Number.isFinite(scoreRaw) ? scoreRaw : 0;
      const reason = String(ref.reason || '').trim();
      return { id, title, uuid, priority, confidence, score, reason };
    })
    .filter((x): x is {
      id: string;
      title: string;
      uuid: string;
      priority: number;
      confidence: number;
      score: number;
      reason: string;
    } => !!x)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (b.score !== a.score) return b.score - a.score;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.id.localeCompare(b.id);
    });
  if (!rows.length) return '';

  const lines: string[] = [];
  lines.push('## Runtime Skill Refs [ADVISORY]');
  lines.push(`- Stage: ${stage}`);
  lines.push('- Ordered by priority asc, then score desc.');
  lines.push('- Advisory only; core protocol/output gate remains authoritative.');
  lines.push('');
  for (const [i, row] of rows.entries()) {
    lines.push(
      `${i + 1}. ${row.title} (id=${row.id}, uuid=${row.uuid || 'N/A'}, priority=${row.priority}, confidence=${row.confidence.toFixed(2)}, score=${row.score.toFixed(2)})`
    );
    if (row.reason) lines.push(`   trigger: ${row.reason}`);
  }
  return lines.join('\n');
}

export function createRuntimeSkillContextBuilder(options: RuntimeComposerOptions = {}) {
  const composer = createRuntimeSkillPromptComposer(options);

  const getSystemAugment = async (mode: RuntimeSkillMode, hint?: RuntimeSkillHint) =>
    composer.getSystemAugment(mode, hint);
  const getSkillRefs = async (mode: RuntimeSkillMode, hint?: RuntimeSkillHint): Promise<RuntimeSkillRef[]> =>
    composer.getSkillRefs(mode, hint);
  const getSkillRefsXml = async (mode: RuntimeSkillMode, hint?: RuntimeSkillHint): Promise<string> =>
    composer.getSkillRefsXml(mode, hint);

  const appendRuntimeRoundRootAtBottom = async (input: RuntimeRoundRootInput): Promise<string> => {
    const hintWithStage: RuntimeSkillHint = {
      ...(input.hint || {}),
      stage: input.stage
    };
    const refsXml = await getSkillRefsXml(input.mode, hintWithStage);
    const rootXml = buildRuntimeRoundRootXml(input.stage, refsXml);
    return appendRootAtBottom(input.userContent, rootXml);
  };

  const buildResultRoundBundle = async (
    input: ResultRoundBundleInput
  ): Promise<{ apiContent: string; snapshotContent: string }> => {
    const hintWithStage: RuntimeSkillHint = {
      ...(input.hint || {}),
      stage: input.stage
    };
    const refsXml = await getSkillRefsXml(input.requiredOutputMode, hintWithStage);
    return buildResultRoundBundleInternal(
      input.resultPayload,
      input.mode,
      input.baseUserContentApi,
      input.baseUserContentSnapshot,
      refsXml
    );
  };

  return {
    getSystemAugment,
    getSkillRefs,
    getSkillRefsXml,
    appendRuntimeRoundRootAtBottom,
    buildResultRoundBundle
  };
}
