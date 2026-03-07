import { randomUUID } from 'crypto';
import { ActionLearnerRuntime, buildTeacherSample } from './actionLearner/runtime.js';
import { ACTION_LABELS, type ActionLabel } from './actionLearner/types.js';

type ChatType = 'private' | 'group';

type EvalCase = {
  label: ActionLabel;
  text: string;
  chatType: ChatType;
  payloadXml: string;
};

type EvalMetrics = {
  accuracy: number;
  total: number;
  actionPrecision: number;
  actionRecall: number;
  confusion: Record<ActionLabel, Record<ActionLabel, number>>;
};

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: T[], rand: () => number): T {
  const i = Math.floor(rand() * arr.length);
  return arr[Math.max(0, Math.min(arr.length - 1, i))] as T;
}

function escapeXml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sampleLabel(rand: () => number): ActionLabel {
  const p = rand();
  if (p < 0.3) return 'silent';
  if (p < 0.45) return 'short';
  if (p < 0.9) return 'action';
  return 'delay';
}

function buildActionExtraSegment(rand: () => number, chatType: ChatType): string {
  const templates: Array<() => string> = [
    () => '<segment index="2"><type>at</type><data><qq>2166683295</qq></data></segment>',
    () => '<segment index="2"><type>reply</type><data><id>1324505401</id></data></segment>',
    () => '<segment index="2"><type>image</type><data><file>/tmp/demo.png</file></data></segment>',
    () => '<segment index="2"><type>file</type><data><file>/tmp/demo.zip</file></data></segment>',
    () => '<segment index="2"><type>video</type><data><file>/tmp/demo.mp4</file></data></segment>',
    () => '<segment index="2"><type>audio</type><data><file>/tmp/demo.mp3</file></data></segment>',
    () => '<segment index="2"><type>record</type><data><file>/tmp/demo.amr</file></data></segment>',
    () => '<segment index="2"><type>music</type><data><type>163</type><id>2076427057</id></data></segment>',
    () => chatType === 'group'
      ? '<segment index="2"><type>poke</type><data><group_id>1002812301</group_id><user_id>2166683295</user_id></data></segment>'
      : '<segment index="2"><type>poke</type><data><user_id>2166683295</user_id></data></segment>',
    () => '<segment index="2"><type>location</type><data><lat>39.9</lat><lon>116.4</lon><title>beijing</title></data></segment>',
    () => '<segment index="2"><type>json</type><data><value>{&quot;kind&quot;:&quot;card&quot;}</value></data></segment>',
    () => '<segment index="2"><type>share</type><data><url>https://example.com/a</url><title>demo</title></data></segment>'
  ];
  return pick(templates, rand)();
}

function buildPayloadXml(label: ActionLabel, text: string, chatType: ChatType, rand: () => number): string {
  const routeNode = chatType === 'group'
    ? '<group_id>1002812301</group_id>'
    : '<user_id>2166683295</user_id>';
  let extra = '';
  if (label === 'action') {
    extra = buildActionExtraSegment(rand, chatType);
  }
  return [
    '<sentra-input>',
    '  <current_messages>',
    '    <sentra-message>',
    `      <chat_type>${chatType}</chat_type>`,
    `      ${routeNode}`,
    '      <sender_id>2166683295</sender_id>',
    '      <message>',
    `        <segment index="1"><type>text</type><data><text>${escapeXml(text)}</text></data></segment>`,
    extra ? `        ${extra}` : '',
    '      </message>',
    '    </sentra-message>',
    '  </current_messages>',
    '</sentra-input>'
  ].filter(Boolean).join('\n');
}

function buildCase(rand: () => number): EvalCase {
  const label = sampleLabel(rand);
  const chatType: ChatType = rand() < 0.75 ? 'group' : 'private';
  let text = 'ok';
  if (label === 'short') {
    text = pick(['you there', 'online?', 'ping'], rand);
  } else if (label === 'delay') {
    text = pick(['remind me in 5 minutes', 'later remind me'], rand);
  } else if (label === 'silent') {
    text = pick(['ok', 'got it', 'haha'], rand);
  } else if (label === 'action') {
    // Keep action text intentionally ambiguous; payload carries structural signal.
    text = pick(['ok', 'got it', 'fine'], rand);
  }
  return {
    label,
    text,
    chatType,
    payloadXml: buildPayloadXml(label, text, chatType, rand)
  };
}

function buildConfusion(): Record<ActionLabel, Record<ActionLabel, number>> {
  const out = {} as Record<ActionLabel, Record<ActionLabel, number>>;
  for (const truth of ACTION_LABELS) {
    out[truth] = { silent: 0, short: 0, action: 0, delay: 0 };
  }
  return out;
}

function evaluate(
  runtime: ActionLearnerRuntime,
  dataset: EvalCase[],
  withPayload: boolean
): EvalMetrics {
  let hit = 0;
  let actionTP = 0;
  let actionFP = 0;
  let actionFN = 0;
  const confusion = buildConfusion();

  for (const row of dataset) {
    const pred = runtime.predict({
      text: row.text,
      chatType: row.chatType,
      isMentioned: false,
      activeTaskCount: 0,
      isFollowupAfterBotReply: false,
      ...(withPayload
        ? {
            payload: {
              format: 'sentra_input_xml' as const,
              canonicalContent: row.payloadXml,
              placeholder: '__BOT_NAME__'
            }
          }
        : {})
    });
    const p = pred.action;
    confusion[row.label][p] += 1;
    if (p === row.label) hit += 1;
    if (p === 'action' && row.label === 'action') actionTP += 1;
    if (p === 'action' && row.label !== 'action') actionFP += 1;
    if (p !== 'action' && row.label === 'action') actionFN += 1;
  }

  const precision = actionTP + actionFP > 0 ? actionTP / (actionTP + actionFP) : 0;
  const recall = actionTP + actionFN > 0 ? actionTP / (actionTP + actionFN) : 0;

  return {
    accuracy: dataset.length > 0 ? hit / dataset.length : 0,
    total: dataset.length,
    actionPrecision: precision,
    actionRecall: recall,
    confusion
  };
}

function train(runtime: ActionLearnerRuntime, dataset: EvalCase[], withPayload: boolean): void {
  for (const row of dataset) {
    const sample = buildTeacherSample({
      conversationId: `${row.chatType}_${randomUUID()}`,
      text: row.text,
      chatType: row.chatType,
      isMentioned: false,
      activeTaskCount: 0,
      isFollowupAfterBotReply: false,
      teacher: {
        source: 'llm_reply_gate_decision',
        action: row.label,
        confidence: 0.95
      }
    });
    if (withPayload) {
      sample.payload = {
        format: 'sentra_input_xml',
        canonicalContent: row.payloadXml,
        placeholder: '__BOT_NAME__'
      };
    }
    runtime.learnFromSample(sample);
  }
}

function printMetrics(title: string, metrics: EvalMetrics): void {
  console.log(`\n=== ${title} ===`);
  console.log(`samples=${metrics.total} accuracy=${metrics.accuracy.toFixed(3)} action_precision=${metrics.actionPrecision.toFixed(3)} action_recall=${metrics.actionRecall.toFixed(3)}`);
  for (const truth of ACTION_LABELS) {
    const row = metrics.confusion[truth];
    console.log(`truth=${truth} -> silent:${row.silent} short:${row.short} action:${row.action} delay:${row.delay}`);
  }
}

function main(): void {
  const trainSeed = 2026022601;
  const evalSeed = 2026022602;
  const trainSize = 4000;
  const evalSize = 1200;

  const trainRand = mulberry32(trainSeed);
  const evalRand = mulberry32(evalSeed);
  const trainSet: EvalCase[] = [];
  const evalSet: EvalCase[] = [];
  for (let i = 0; i < trainSize; i++) trainSet.push(buildCase(trainRand));
  for (let i = 0; i < evalSize; i++) evalSet.push(buildCase(evalRand));

  const rtTextOnly = new ActionLearnerRuntime({
    dim: 8192,
    localAcceptConfidence: 0.72,
    localAcceptMargin: 0.18
  });
  const rtWithPayload = new ActionLearnerRuntime({
    dim: 8192,
    localAcceptConfidence: 0.72,
    localAcceptMargin: 0.18
  });

  train(rtTextOnly, trainSet, false);
  train(rtWithPayload, trainSet, true);

  const mTextOnly = evaluate(rtTextOnly, evalSet, false);
  const mWithPayload = evaluate(rtWithPayload, evalSet, true);
  printMetrics('text_only', mTextOnly);
  printMetrics('with_payload_struct_features', mWithPayload);

  console.log('\n=== delta ===');
  console.log(`accuracy_delta=${(mWithPayload.accuracy - mTextOnly.accuracy).toFixed(3)}`);
  console.log(`action_precision_delta=${(mWithPayload.actionPrecision - mTextOnly.actionPrecision).toFixed(3)}`);
  console.log(`action_recall_delta=${(mWithPayload.actionRecall - mTextOnly.actionRecall).toFixed(3)}`);
}

main();

