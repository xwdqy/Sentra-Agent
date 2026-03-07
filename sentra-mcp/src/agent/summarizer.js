import { config, getStageModel, getStageProvider, getStageTimeoutMs } from '../config/index.js';
import logger from '../logger/index.js';
import { HistoryStore } from '../history/store.js';
import { chatCompletion } from '../openai/client.js';
import { loadPrompt, renderTemplate, composeSystem, pickLocalizedPrompt } from './prompts/loader.js';
import { getPreThought } from './stages/prethought.js';
import { clip } from '../utils/text.js';
import { parseFunctionCalls, buildFunctionCallInstruction, buildFCPolicy } from '../utils/fc.js';
import { truncateTextByTokens } from '../utils/tokenizer.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function clipSummaryTextByTokens(value, maxTokens, suffix = '...') {
  const text = String(value ?? '');
  const limit = Number(maxTokens);
  if (!Number.isFinite(limit) || limit <= 0) return text;
  return truncateTextByTokens(text, {
    maxTokens: Math.max(1, Math.floor(limit)),
    model: getStageModel('summary'),
    suffix
  }).text;
}

function buildToolEvidence(history = []) {
  const items = history
    .filter((h) => h && h.type === 'tool_result')
    .map((h) => {
      const aiName = String(h.aiName || '').trim();
      if (!aiName) return null;
      const ok = h?.result?.success === true;
      const code = String(h?.result?.code || '').trim();
      const argsPreview = (() => {
        try {
          const raw = JSON.stringify(h.args || {});
          return clipSummaryTextByTokens(raw, Number(config.truncation?.summary?.toolArgsPreviewMaxTokens ?? 64), '...');
        } catch {
          return '';
        }
      })();
      const artifactRefs = Array.isArray(h?.result?.artifacts)
        ? h.result.artifacts.slice(0, 8).map((a) => ({
          uuid: String(a?.uuid || a?.artifactId || ''),
          path: String(a?.path || ''),
          role: String(a?.role || ''),
          type: String(a?.type || ''),
          hash: String(a?.hash || ''),
        }))
        : [];
      return {
        aiName,
        success: ok,
        code,
        argsPreview,
        artifactRefs,
        ts: Number.isFinite(Number(h.ts)) ? Number(h.ts) : 0,
      };
    })
    .filter(Boolean);
  return items.slice(-20);
}

function buildFeedbackEvidence(history = []) {
  const batches = history.filter((h) => h && h.type === 'assistant_response_batch');
  const out = [];
  for (const b of batches) {
    const responses = Array.isArray(b?.responses) ? b.responses : [];
    for (const r of responses) {
      const phase = String(r?.phase || 'unknown').trim() || 'unknown';
      const content = String(r?.content || '').trim();
      if (!content) continue;
      const excerpt = clipSummaryTextByTokens(content, Number(config.truncation?.summary?.feedbackExcerptMaxTokens ?? 72), '...');
      out.push({
        phase,
        excerpt,
        delivered: r?.delivered === true,
        noReply: r?.noReply === true,
        ts: Number.isFinite(Number(r?.ts)) ? Number(r.ts) : 0,
      });
    }
  }
  return out.slice(-20);
}

function logSummaryFcPreview({ attempt, provider, model, content, calls }) {
  const count = Array.isArray(calls) ? calls.length : 0;
  const providerInfo = { baseURL: provider?.baseURL, model };
  if (count > 0) {
    logger.info('FC summary parsed output', {
      label: 'SUMMARY',
      attempt,
      provider: providerInfo,
      count,
      firstCallName: String(calls?.[0]?.name || ''),
      firstCallPreview: clip(calls?.[0]),
      length: String(content || '').length
    });
    return;
  }
  logger.warn('FC summary parse failed, fallback raw preview', {
    label: 'SUMMARY',
    attempt,
    provider: providerInfo,
    count: 0,
    rawPreview: clip(String(content)),
    length: String(content || '').length
  });
}

function escapeXmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildToolEvidenceLines(toolEvidence = []) {
  const lines = (Array.isArray(toolEvidence) ? toolEvidence : [])
    .map((t, i) => `${i + 1}. ${t.aiName} success=${t.success ? 'true' : 'false'} code=${t.code || 'OK'} args=${t.argsPreview || '{}'}`)
    .filter(Boolean);
  return lines.length ? lines : ['(none)'];
}

function buildFeedbackEvidenceLines(feedbackEvidence = []) {
  const lines = (Array.isArray(feedbackEvidence) ? feedbackEvidence : [])
    .map((f, i) => `${i + 1}. phase=${f.phase} delivered=${f.delivered ? 'true' : 'false'} excerpt=${f.excerpt}`)
    .filter(Boolean);
  return lines.length ? lines : ['(none)'];
}

function normalizeEvidenceLines(raw, fallback = [], maxItems = 20) {
  const items = (Array.isArray(raw) ? raw : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, maxItems);
  if (items.length) return items;
  const fb = (Array.isArray(fallback) ? fallback : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, maxItems);
  return fb.length ? fb : ['(none)'];
}

function normalizeStringArray(raw, maxItems = 20) {
  return (Array.isArray(raw) ? raw : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeTimelineItems(raw, maxItems = 16) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (!item) continue;
    if (typeof item === 'string') {
      const event = String(item).trim();
      if (!event) continue;
      out.push({ event });
    } else if (typeof item === 'object') {
      const event = String(item.event || item.detail || item.summary || '').trim();
      if (!event) continue;
      out.push({
        index: Number.isFinite(Number(item.index)) ? Math.floor(Number(item.index)) : undefined,
        stepId: String(item.stepId || '').trim(),
        aiName: String(item.aiName || '').trim(),
        status: String(item.status || '').trim(),
        event
      });
    }
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeIssueItems(raw, maxItems = 16) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    if (!item) continue;
    if (typeof item === 'string') {
      const reason = String(item).trim();
      if (!reason) continue;
      out.push({ reason });
    } else if (typeof item === 'object') {
      const reason = String(item.reason || item.issue || item.problem || '').trim();
      if (!reason) continue;
      out.push({
        stepId: String(item.stepId || '').trim(),
        aiName: String(item.aiName || '').trim(),
        severity: String(item.severity || '').trim(),
        reason,
        impact: String(item.impact || '').trim()
      });
    }
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeCompletion(raw, fallbackSuccess = true) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const status = String(src.status || '').trim();
  const completionLevel = String(src.completionLevel || '').trim();
  const note = String(src.note || '').trim();
  const goalMet = Object.prototype.hasOwnProperty.call(src, 'goalMet')
    ? src.goalMet === true
    : !!fallbackSuccess;
  return { status, completionLevel, goalMet, note };
}

function renderSummaryDiagnosticsXml({
  success = true,
  completion = null,
  eventTimeline = [],
  issues = [],
  unresolvedItems = [],
  nextActions = []
} = {}) {
  const completionObj = normalizeCompletion(completion, success);
  const timeline = normalizeTimelineItems(eventTimeline);
  const problemItems = normalizeIssueItems(issues);
  const unresolved = normalizeStringArray(unresolvedItems, 20);
  const actions = normalizeStringArray(nextActions, 20);

  if (!timeline.length && !problemItems.length && !unresolved.length && !actions.length && !completionObj.status && !completionObj.note && !completionObj.completionLevel) {
    return '';
  }

  const lines = [];
  lines.push('<summary_diagnostics>');
  lines.push(
    `  <completion success="${success ? 'true' : 'false'}" goal_met="${completionObj.goalMet ? 'true' : 'false'}" status="${escapeXmlText(completionObj.status || '')}" level="${escapeXmlText(completionObj.completionLevel || '')}">${escapeXmlText(completionObj.note || '')}</completion>`
  );
  lines.push('  <event_timeline>');
  if (!timeline.length) {
    lines.push('    <event index="0">(none)</event>');
  } else {
    timeline.forEach((ev, i) => {
      lines.push(
        `    <event index="${i + 1}" step_id="${escapeXmlText(ev.stepId || '')}" ai_name="${escapeXmlText(ev.aiName || '')}" status="${escapeXmlText(ev.status || '')}">${escapeXmlText(ev.event || '')}</event>`
      );
    });
  }
  lines.push('  </event_timeline>');
  lines.push('  <issues>');
  if (!problemItems.length) {
    lines.push('    <issue index="0">(none)</issue>');
  } else {
    problemItems.forEach((issue, i) => {
      lines.push(
        `    <issue index="${i + 1}" step_id="${escapeXmlText(issue.stepId || '')}" ai_name="${escapeXmlText(issue.aiName || '')}" severity="${escapeXmlText(issue.severity || '')}" impact="${escapeXmlText(issue.impact || '')}">${escapeXmlText(issue.reason || '')}</issue>`
      );
    });
  }
  lines.push('  </issues>');
  lines.push('  <unresolved_items>');
  if (!unresolved.length) {
    lines.push('    <item index="0">(none)</item>');
  } else {
    unresolved.forEach((item, i) => lines.push(`    <item index="${i + 1}">${escapeXmlText(item)}</item>`));
  }
  lines.push('  </unresolved_items>');
  lines.push('  <next_actions>');
  if (!actions.length) {
    lines.push('    <item index="0">(none)</item>');
  } else {
    actions.forEach((item, i) => lines.push(`    <item index="${i + 1}">${escapeXmlText(item)}</item>`));
  }
  lines.push('  </next_actions>');
  lines.push('</summary_diagnostics>');
  return lines.join('\n');
}

function renderRuntimeEvidenceXml(toolEvidence = [], feedbackEvidence = []) {
  const toolNodes = toolEvidence.length
    ? toolEvidence.map((t, i) => [
      `    <tool index="${i + 1}">`,
      `      <ai_name>${escapeXmlText(t.aiName)}</ai_name>`,
      `      <success>${t.success ? 'true' : 'false'}</success>`,
      `      <code>${escapeXmlText(t.code || 'OK')}</code>`,
      `      <args_preview>${escapeXmlText(t.argsPreview || '{}')}</args_preview>`,
      `      <artifact_count>${Array.isArray(t.artifactRefs) ? t.artifactRefs.length : 0}</artifact_count>`,
      ...(Array.isArray(t.artifactRefs) && t.artifactRefs.length
        ? [
          '      <artifacts>',
          ...t.artifactRefs.map((a, j) =>
            `        <artifact index="${j + 1}" uuid="${escapeXmlText(a.uuid)}" path="${escapeXmlText(a.path)}" role="${escapeXmlText(a.role)}" type="${escapeXmlText(a.type)}" hash="${escapeXmlText(a.hash)}" />`
          ),
          '      </artifacts>',
        ]
        : []),
      (Number.isFinite(Number(t.ts)) && Number(t.ts) > 0 ? `      <ts>${Math.floor(Number(t.ts))}</ts>` : ''),
      '    </tool>',
    ].filter(Boolean).join('\n'))
    : ['    <tool index="0"><ai_name>(none)</ai_name></tool>'];

  const feedbackNodes = feedbackEvidence.length
    ? feedbackEvidence.map((f, i) => [
      `    <feedback index="${i + 1}">`,
      `      <phase>${escapeXmlText(f.phase || 'unknown')}</phase>`,
      `      <delivered>${f.delivered ? 'true' : 'false'}</delivered>`,
      `      <no_reply>${f.noReply ? 'true' : 'false'}</no_reply>`,
      `      <excerpt>${escapeXmlText(f.excerpt || '')}</excerpt>`,
      (Number.isFinite(Number(f.ts)) && Number(f.ts) > 0 ? `      <ts>${Math.floor(Number(f.ts))}</ts>` : ''),
      '    </feedback>',
    ].filter(Boolean).join('\n'))
    : ['    <feedback index="0"><phase>none</phase><excerpt>(none)</excerpt></feedback>'];

  return [
    '<runtime_evidence>',
    '  <tool_evidence>',
    ...toolNodes,
    '  </tool_evidence>',
    '  <feedback_evidence>',
    ...feedbackNodes,
    '  </feedback_evidence>',
    '</runtime_evidence>',
  ].join('\n');
}

function renderEvidenceUsedXml(toolEvidenceLines = [], feedbackEvidenceLines = []) {
  const toolNodes = normalizeEvidenceLines(toolEvidenceLines).map((line, i) => `    <item index="${i + 1}">${escapeXmlText(line)}</item>`);
  const feedbackNodes = normalizeEvidenceLines(feedbackEvidenceLines).map((line, i) => `    <item index="${i + 1}">${escapeXmlText(line)}</item>`);
  return [
    '<summary_evidence>',
    '  <tool_evidence>',
    ...toolNodes,
    '  </tool_evidence>',
    '  <feedback_evidence>',
    ...feedbackNodes,
    '  </feedback_evidence>',
    '</summary_evidence>',
  ].join('\n');
}

export async function summarizeToolHistory(runId, objective = '', context = {}) {
  try {
    const history = await HistoryStore.list(runId, 0, -1);
    const toolEvidence = buildToolEvidence(history);
    const feedbackEvidence = buildFeedbackEvidence(history);
    const runtimeEvidenceXml = renderRuntimeEvidenceXml(toolEvidence, feedbackEvidence);
    const fallbackToolEvidenceLines = buildToolEvidenceLines(toolEvidence);
    const fallbackFeedbackEvidenceLines = buildFeedbackEvidenceLines(feedbackEvidence);

    const fsPrompt = await loadPrompt('final_summary');
    const overlays = (context?.promptOverlays || context?.overlays || {});
    const overlayGlobal = overlays.global?.system || overlays.global || '';
    const overlaySum = overlays.final_summary?.system || overlays.final_summary || overlays.summary?.system || overlays.summary || '';
    const sys = composeSystem(fsPrompt.system, [overlayGlobal, overlaySum].filter(Boolean).join('\n\n'));

    let preThought = '';
    if (config.flags.summaryUsePreThought) {
      preThought = await getPreThought(objective || 'Summarize tool execution and outputs', [], []);
    }

    const baseMsgs = [
      { role: 'system', content: sys },
      { role: 'user', content: renderTemplate(fsPrompt.user_goal, { objective: objective || 'Summarize tool execution and outputs' }) },
      ...(config.flags.summaryUsePreThought
        ? [{ role: 'assistant', content: renderTemplate(fsPrompt.assistant_thought || 'pre-thought:\n{{preThought}}', { preThought }) }]
        : []),
      { role: 'user', content: fsPrompt.user_history_intro },
      { role: 'assistant', content: JSON.stringify({ runId, history }) },
      { role: 'assistant', content: `RUNTIME_EVIDENCE_XML:\n${runtimeEvidenceXml}` },
      {
        role: 'user',
        content: 'In final_summary output, toolEvidence and feedbackEvidence are mandatory string arrays. Each entry must cite concrete evidence from RUNTIME_EVIDENCE_XML. Strongly include eventTimeline, issues, completion, unresolvedItems, nextActions so downstream can diagnose what happened. In FC mode, return one <sentra-tools> block only.'
      },
      { role: 'user', content: fsPrompt.user_request }
    ];

    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const schemaPath = path.resolve(__dirname, './tools/internal/final_summary.schema.json');
    let summarySchema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] };
    try {
      const rawSchema = await fs.readFile(schemaPath, 'utf-8');
      summarySchema = JSON.parse(rawSchema);
    } catch {}

    const policy = await buildFCPolicy();
    const instr = await buildFunctionCallInstruction({ name: 'final_summary', parameters: summarySchema, locale: 'en' });

    const fc = config.fcLlm || {};
    const omit = !(Number.isFinite(fc.maxTokens) && fc.maxTokens > 0);
    const maxRetries = Math.max(1, Number(fc.summaryMaxRetries ?? 1));
    const temperature = Number.isFinite(config.fcLlm?.summaryTemperature) ? config.fcLlm.summaryTemperature : (Number.isFinite(fc.temperature) ? Math.min(0.3, fc.temperature) : 0.1);
    const top_p = Number.isFinite(config.fcLlm?.summaryTopP) ? config.fcLlm.summaryTopP : undefined;

    let summaryText = '';
    let summaryTaskSuccess = true;
    let summaryFailedSteps = [];
    let summaryHighlights = [];
    let summaryEventTimeline = [];
    let summaryIssues = [];
    let summaryCompletion = null;
    let summaryUnresolvedItems = [];
    let summaryNextActions = [];
    let summaryToolEvidence = fallbackToolEvidenceLines;
    let summaryFeedbackEvidence = fallbackFeedbackEvidenceLines;
    let lastContent = '';
    let lastError = null;
    let actualAttempts = 0;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      actualAttempts = attempt;
      let reinforce = '';
      if (attempt > 1) {
        try {
          const pr = await loadPrompt('fc_reinforce_summary');
          const tpl = pickLocalizedPrompt(pr, 'en');
          reinforce = renderTemplate(tpl, { attempt: String(attempt), max_retries: String(maxRetries) });
        } catch {}
      }

      const messages = [...baseMsgs, { role: 'user', content: [reinforce, policy, instr].filter(Boolean).join('\n\n') }];
      const provider = getStageProvider('summary');
      const summaryModel = getStageModel('summary');
      const res = await chatCompletion({
        messages,
        temperature,
        top_p,
        timeoutMs: getStageTimeoutMs('summary'),
        apiKey: provider.apiKey,
        baseURL: provider.baseURL,
        model: summaryModel,
        ...(omit ? { omitMaxTokens: true } : { max_tokens: fc.maxTokens })
      });

      const content = res?.choices?.[0]?.message?.content || '';
      lastContent = content;
      const calls = parseFunctionCalls(String(content), {});
      logSummaryFcPreview({ attempt, provider, model: summaryModel, content, calls });

      if (calls.length === 0) {
        lastError = `attempt ${attempt}: no parseable final_summary call`;
        continue;
      }

      const call = calls.find((c) => String(c.name) === 'final_summary') || calls[0];
      if (!call || call.name !== 'final_summary') {
        lastError = `attempt ${attempt}: wrong tool name ${String(call?.name || '')}`;
        continue;
      }

      try {
        const args = call?.arguments || {};
        if (!Object.prototype.hasOwnProperty.call(args, 'success')) {
          lastError = `attempt ${attempt}: missing success`;
          continue;
        }
        if (typeof args.summary !== 'string' || !args.summary.trim()) {
          lastError = `attempt ${attempt}: invalid summary`;
          continue;
        }
        if (!Object.prototype.hasOwnProperty.call(args, 'toolEvidence') || !Object.prototype.hasOwnProperty.call(args, 'feedbackEvidence')) {
          lastError = `attempt ${attempt}: missing toolEvidence/feedbackEvidence`;
          continue;
        }
        if (!Array.isArray(args.toolEvidence) || !Array.isArray(args.feedbackEvidence)) {
          lastError = `attempt ${attempt}: toolEvidence/feedbackEvidence must be arrays`;
          continue;
        }

        summaryText = args.summary.trim();
        summaryTaskSuccess = Boolean(args.success);
        summaryFailedSteps = Array.isArray(args.failedSteps) ? args.failedSteps : [];
        summaryHighlights = normalizeStringArray(args.highlights, 20);
        summaryEventTimeline = normalizeTimelineItems(args.eventTimeline, 20);
        summaryIssues = normalizeIssueItems(args.issues, 20);
        summaryCompletion = normalizeCompletion(args.completion, summaryTaskSuccess);
        summaryUnresolvedItems = normalizeStringArray(args.unresolvedItems, 20);
        summaryNextActions = normalizeStringArray(args.nextActions, 20);
        summaryToolEvidence = normalizeEvidenceLines(args.toolEvidence, fallbackToolEvidenceLines);
        summaryFeedbackEvidence = normalizeEvidenceLines(args.feedbackEvidence, fallbackFeedbackEvidenceLines);
        lastError = null;
        break;
      } catch (e) {
        lastError = `attempt ${attempt}: parse arguments failed - ${String(e)}`;
      }
    }

    if (summaryText) {
      const summaryDiagnosticsXml = renderSummaryDiagnosticsXml({
        success: summaryTaskSuccess,
        completion: summaryCompletion,
        eventTimeline: summaryEventTimeline,
        issues: summaryIssues,
        unresolvedItems: summaryUnresolvedItems,
        nextActions: summaryNextActions
      });
      const summaryEvidenceXml = renderEvidenceUsedXml(summaryToolEvidence, summaryFeedbackEvidence);
      const summaryStr = [String(summaryText).trim(), summaryDiagnosticsXml, summaryEvidenceXml].filter(Boolean).join('\n\n');

      await HistoryStore.setSummary(runId, summaryStr);
      if (config.flags.enableVerboseSteps) {
        logger.info('Summary generated', {
          label: 'SUMMARY',
          attempts: actualAttempts,
          taskSuccess: summaryTaskSuccess,
          failedStepsCount: summaryFailedSteps.length,
          summaryPreview: clip(summaryStr, 200)
        });
      }

      return {
        success: true,
        summary: summaryStr,
        taskSuccess: summaryTaskSuccess,
        failedSteps: summaryFailedSteps,
        highlights: summaryHighlights,
        eventTimeline: summaryEventTimeline,
        issues: summaryIssues,
        completion: summaryCompletion,
        unresolvedItems: summaryUnresolvedItems,
        nextActions: summaryNextActions,
        toolEvidence: summaryToolEvidence,
        feedbackEvidence: summaryFeedbackEvidence,
        attempts: actualAttempts
      };
    }

    const raw = String(lastContent || '');
    const rawSlice = clipSummaryTextByTokens(raw, Number(config.truncation?.summary?.rawOutputMaxTokens ?? 1000), '\n...[truncated]');
    const errorMsg = lastError || 'Failed to parse valid summary output';

    logger.warn?.('Summary generation failed', {
      label: 'SUMMARY',
      attempts: actualAttempts,
      error: errorMsg,
      contentRaw: rawSlice
    });

    const fallbackSummary = [
      'Summary generation failed, fallback to runtime evidence.',
      renderEvidenceUsedXml(fallbackToolEvidenceLines, fallbackFeedbackEvidenceLines)
    ].join('\n\n');
    await HistoryStore.setSummary(runId, fallbackSummary);

    return {
      success: false,
      summary: fallbackSummary,
      error: errorMsg,
      attempts: actualAttempts,
      lastContent: rawSlice
    };
  } catch (e) {
    logger.error('Summary stage exception', { label: 'SUMMARY', runId, error: String(e) });
    return {
      success: false,
      summary: '',
      error: `Summary stage exception: ${String(e)}`,
      attempts: 0
    };
  }
}

export default { summarizeToolHistory };

