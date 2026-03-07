import { ActionLearnerRuntime, buildTeacherSample } from './actionLearner/runtime.js';
import { ACTION_LABELS, type ActionLabel } from './actionLearner/types.js';

type ChatType = 'private' | 'group';

type SimCase = {
  text: string;
  truth: ActionLabel;
  chatType: ChatType;
  isMentioned: boolean;
  activeTaskCount: number;
  isFollowupAfterBotReply: boolean;
};

type TeacherDecision = {
  action: ActionLabel;
  confidence: number;
  reasonCode: string;
};

type EvalMetrics = {
  accuracy: number;
  total: number;
  byLabel: Record<ActionLabel, { hit: number; total: number }>;
  confusion: Record<ActionLabel, Record<ActionLabel, number>>;
  localAcceptRate: number;
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

function randomPick<T>(arr: T[], rand: () => number): T {
  if (!arr.length) throw new Error('empty array');
  const i = Math.floor(rand() * arr.length);
  return arr[Math.max(0, Math.min(arr.length - 1, i))] as T;
}

function randomInt(min: number, max: number, rand: () => number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(rand() * (hi - lo + 1));
}

const SLOT = {
  taskZh: ['开会', '写周报', '喝水', '发邮件', '背单词', '洗衣服', '交作业'],
  taskEn: ['join meeting', 'send email', 'drink water', 'stretch', 'submit report'],
  greet: ['在吗', '在干嘛', '还在线吗', 'hello', 'yo', 'ping'],
  actionZh: ['帮我总结一下这段话', '帮我翻译这句话', '帮我列个清单', '帮我写一段回复'],
  actionEn: ['can you summarize this', 'translate this line', 'draft a short reply'],
  silentZh: ['哈哈', '好的收到', '嗯嗯', 'ok', '收到'],
  shortZh: ['在?', '你在吗', '回个1', '在不在', 'hello?']
};

const SLOT_HOLDOUT = {
  taskZh: ['打卡', '复盘', '记账', '出门', '收快递', '买菜'],
  taskEn: ['clock in', 'review notes', 'pay bill', 'leave home'],
  greet: ['喂', '还在不在', '有人吗', 'hey there'],
  actionZh: ['帮我润色一下这句话', '给我拟一个标题', '帮我改写成更口语化'],
  actionEn: ['rewrite this naturally', 'give me a concise title'],
  silentZh: ['哈哈哈行', '嗯知道了', 'okok', '明白'],
  shortZh: ['在不', '回一下', '还醒着吗', 'online?']
};

const HOLDOUT_CHALLENGE: SimCase[] = [
  { text: '晚点叫我一下', truth: 'delay', chatType: 'private', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: false },
  { text: '等会提醒我拿快递', truth: 'delay', chatType: 'private', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: false },
  { text: '有空吗，帮我改下这句话', truth: 'action', chatType: 'private', isMentioned: false, activeTaskCount: 1, isFollowupAfterBotReply: true },
  { text: '在？顺便帮我看这个报错', truth: 'action', chatType: 'group', isMentioned: false, activeTaskCount: 1, isFollowupAfterBotReply: true },
  { text: '嗯嗯收到', truth: 'silent', chatType: 'group', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: true },
  { text: '行的哈哈', truth: 'silent', chatType: 'group', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: false },
  { text: '你在不在呀', truth: 'short', chatType: 'private', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: true },
  { text: '喂喂', truth: 'short', chatType: 'group', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: false },
  { text: 'later ping me', truth: 'delay', chatType: 'private', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: false },
  { text: 'help rewrite this quickly', truth: 'action', chatType: 'private', isMentioned: false, activeTaskCount: 1, isFollowupAfterBotReply: false },
  { text: 'ok got it', truth: 'silent', chatType: 'group', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: false },
  { text: 'you there?', truth: 'short', chatType: 'private', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: true }
];

function pickSlot(variant: 'train' | 'holdout') {
  return variant === 'holdout' ? SLOT_HOLDOUT : SLOT;
}

function buildCase(action: ActionLabel, rand: () => number, variant: 'train' | 'holdout'): SimCase {
  const slot = pickSlot(variant);
  if (action === 'delay') {
    const zh = randomPick([true, false], rand);
    if (zh) {
      const n = randomInt(1, 20, rand);
      const unit = randomPick(['分钟', '小时'], rand);
      const tail = randomPick(
        variant === 'holdout'
          ? ['过后提醒我', '到点叫我', '之后记得喊我']
          : ['后提醒我', '之后提醒我', '后记得叫我'],
        rand
      );
      return {
        text: `${n}${unit}${tail}${randomPick(slot.taskZh, rand)}`,
        truth: 'delay',
        chatType: randomPick(['private', 'group'], rand),
        isMentioned: false,
        activeTaskCount: randomInt(0, 1, rand),
        isFollowupAfterBotReply: false
      };
    }
    const n = randomInt(2, 30, rand);
    return {
      text:
        variant === 'holdout'
          ? `in ${n} mins remind me to ${randomPick(slot.taskEn, rand)}`
          : `remind me in ${n} minutes to ${randomPick(slot.taskEn, rand)}`,
      truth: 'delay',
      chatType: 'private',
      isMentioned: false,
      activeTaskCount: 0,
      isFollowupAfterBotReply: false
    };
  }

  if (action === 'action') {
    const useAt = rand() < 0.5;
    const zh = rand() < 0.6;
    const text = zh ? randomPick(slot.actionZh, rand) : randomPick(slot.actionEn, rand);
    return {
      text: useAt ? `@机器人 ${text}` : text,
      truth: 'action',
      chatType: useAt ? 'group' : randomPick(['private', 'group'], rand),
      isMentioned: useAt,
      activeTaskCount: randomInt(0, 2, rand),
      isFollowupAfterBotReply: rand() < 0.2
    };
  }

  if (action === 'short') {
    const text = rand() < 0.5 ? randomPick(slot.shortZh, rand) : randomPick(slot.greet, rand);
    return {
      text,
      truth: 'short',
      chatType: randomPick(['private', 'group'], rand),
      isMentioned: false,
      activeTaskCount: randomInt(0, 1, rand),
      isFollowupAfterBotReply: rand() < 0.4
    };
  }

  return {
    text: randomPick(slot.silentZh, rand),
    truth: 'silent',
    chatType: 'group',
    isMentioned: false,
    activeTaskCount: randomInt(0, 1, rand),
    isFollowupAfterBotReply: rand() < 0.5
  };
}

function sampleTruthAction(rand: () => number): ActionLabel {
  const p = rand();
  if (p < 0.30) return 'silent';
  if (p < 0.52) return 'short';
  if (p < 0.82) return 'action';
  return 'delay';
}

function confuseAction(truth: ActionLabel, rand: () => number): ActionLabel {
  const map: Record<ActionLabel, ActionLabel[]> = {
    silent: ['short', 'action'],
    short: ['silent', 'action'],
    action: ['short', 'delay'],
    delay: ['action', 'short']
  };
  return randomPick(map[truth], rand);
}

function mockTeacher(caseItem: SimCase, rand: () => number): TeacherDecision {
  const baseAcc = caseItem.truth === 'delay' ? 0.9 : caseItem.truth === 'action' ? 0.88 : 0.85;
  const noisyPenalty = caseItem.isFollowupAfterBotReply ? 0.03 : 0;
  const mentionBoost = caseItem.isMentioned ? 0.04 : 0;
  const acc = Math.max(0.55, Math.min(0.97, baseAcc - noisyPenalty + mentionBoost));
  const correct = rand() < acc;
  const action = correct ? caseItem.truth : confuseAction(caseItem.truth, rand);
  const confidence = correct
    ? 0.75 + rand() * 0.24
    : 0.35 + rand() * 0.34;
  return {
    action,
    confidence: Math.max(0.01, Math.min(0.99, confidence)),
    reasonCode: `mock_llm_${action}`
  };
}

function initConfusion(): Record<ActionLabel, Record<ActionLabel, number>> {
  const out = {} as Record<ActionLabel, Record<ActionLabel, number>>;
  for (const t of ACTION_LABELS) {
    out[t] = { silent: 0, short: 0, action: 0, delay: 0 };
  }
  return out;
}

function evaluate(runtime: ActionLearnerRuntime, cases: SimCase[]): EvalMetrics {
  let hit = 0;
  let accepted = 0;
  const byLabel = {
    silent: { hit: 0, total: 0 },
    short: { hit: 0, total: 0 },
    action: { hit: 0, total: 0 },
    delay: { hit: 0, total: 0 }
  } as Record<ActionLabel, { hit: number; total: number }>;
  const confusion = initConfusion();

  for (const item of cases) {
    const pred = runtime.predict({
      text: item.text,
      chatType: item.chatType,
      isMentioned: item.isMentioned,
      activeTaskCount: item.activeTaskCount,
      isFollowupAfterBotReply: item.isFollowupAfterBotReply
    });
    if (pred.acceptedByLocal) accepted += 1;
    byLabel[item.truth].total += 1;
    confusion[item.truth][pred.action] += 1;
    if (pred.action === item.truth) {
      hit += 1;
      byLabel[item.truth].hit += 1;
    }
  }

  return {
    accuracy: cases.length > 0 ? hit / cases.length : 0,
    total: cases.length,
    byLabel,
    confusion,
    localAcceptRate: cases.length > 0 ? accepted / cases.length : 0
  };
}

function printMetrics(title: string, metrics: EvalMetrics): void {
  console.log(`\n=== ${title} ===`);
  console.log(`samples=${metrics.total} accuracy=${metrics.accuracy.toFixed(3)} local_accept=${metrics.localAcceptRate.toFixed(3)}`);
  for (const label of ACTION_LABELS) {
    const row = metrics.byLabel[label];
    const acc = row.total > 0 ? row.hit / row.total : 0;
    console.log(`  ${label}: ${row.hit}/${row.total} (${acc.toFixed(3)})`);
  }
  console.log('  confusion:');
  for (const truth of ACTION_LABELS) {
    const row = metrics.confusion[truth];
    console.log(
      `    truth=${truth} -> silent:${row.silent} short:${row.short} action:${row.action} delay:${row.delay}`
    );
  }
}

function buildDataset(size: number, seed: number): SimCase[] {
  const rand = mulberry32(seed);
  const out: SimCase[] = [];
  for (let i = 0; i < size; i++) {
    out.push(buildCase(sampleTruthAction(rand), rand, 'train'));
  }
  return out;
}

function buildHoldoutDataset(size: number, seed: number): SimCase[] {
  const rand = mulberry32(seed);
  const out: SimCase[] = [];
  for (let i = 0; i < size; i++) {
    if (rand() < 0.4) {
      const hard = randomPick(HOLDOUT_CHALLENGE, rand);
      out.push({ ...hard });
      continue;
    }
    out.push(buildCase(sampleTruthAction(rand), rand, 'holdout'));
  }
  return out;
}

function simulateStreamTraining(runtime: ActionLearnerRuntime, size: number, seed: number): void {
  const rand = mulberry32(seed);
  let localAccept = 0;
  let localCorrect = 0;

  for (let i = 0; i < size; i++) {
    const item = buildCase(sampleTruthAction(rand), rand, 'train');
    const pred = runtime.predict({
      text: item.text,
      chatType: item.chatType,
      isMentioned: item.isMentioned,
      activeTaskCount: item.activeTaskCount,
      isFollowupAfterBotReply: item.isFollowupAfterBotReply
    });
    if (pred.acceptedByLocal) {
      localAccept += 1;
      if (pred.action === item.truth) localCorrect += 1;
    }

    const teacher = mockTeacher(item, rand);
    const sample = buildTeacherSample({
      conversationId: `${item.chatType}_sim`,
      text: item.text,
      chatType: item.chatType,
      isMentioned: item.isMentioned,
      activeTaskCount: item.activeTaskCount,
      isFollowupAfterBotReply: item.isFollowupAfterBotReply,
      teacher: {
        source: 'llm_reply_gate_decision',
        action: teacher.action,
        confidence: teacher.confidence,
        reasonCode: teacher.reasonCode
      }
    });
    sample.outcome = {
      hasQuickFollowup: item.truth !== 'silent' && teacher.action === 'silent',
      isUserSatisfied: teacher.action === item.truth
    };
    runtime.learnFromSample(sample);

    if ((i + 1) % 500 === 0) {
      const acceptRate = localAccept / (i + 1);
      const acceptAcc = localAccept > 0 ? localCorrect / localAccept : 0;
      console.log(
        `[train] seen=${i + 1} trained=${runtime.trainedCount()} local_accept=${acceptRate.toFixed(3)} accept_acc=${acceptAcc.toFixed(3)}`
      );
    }
  }
}

function showExamples(runtime: ActionLearnerRuntime, title: string, texts: string[]): void {
  console.log(`\n--- ${title} ---`);
  for (const text of texts) {
    const pred = runtime.predict({
      text,
      chatType: 'private',
      isMentioned: false,
      activeTaskCount: 0,
      isFollowupAfterBotReply: false
    });
    const p = pred.prediction.probabilities;
    console.log(
      `${text} => ${pred.action} conf=${pred.prediction.confidence.toFixed(3)} m=${pred.prediction.margin.toFixed(3)} [s=${p.silent.toFixed(3)} sh=${p.short.toFixed(3)} a=${p.action.toFixed(3)} d=${p.delay.toFixed(3)}]`
    );
  }
}

function thresholdSweep(runtime: ActionLearnerRuntime, cases: SimCase[]): void {
  const confGrid = [0.55, 0.6, 0.65, 0.7, 0.75];
  const marginGrid = [0.05, 0.1, 0.15, 0.2, 0.25];
  console.log('\n=== threshold sweep (local takeover) ===');
  for (const conf of confGrid) {
    for (const margin of marginGrid) {
      let accepted = 0;
      let acceptedHit = 0;
      for (const item of cases) {
        const pred = runtime.predict({
          text: item.text,
          chatType: item.chatType,
          isMentioned: item.isMentioned,
          activeTaskCount: item.activeTaskCount,
          isFollowupAfterBotReply: item.isFollowupAfterBotReply
        });
        const take = pred.prediction.confidence >= conf && pred.prediction.margin >= margin;
        if (!take) continue;
        accepted += 1;
        if (pred.action === item.truth) acceptedHit += 1;
      }
      const takeRate = cases.length > 0 ? accepted / cases.length : 0;
      const takeAcc = accepted > 0 ? acceptedHit / accepted : 0;
      console.log(
        `  conf>=${conf.toFixed(2)} margin>=${margin.toFixed(2)} take=${takeRate.toFixed(3)} take_acc=${takeAcc.toFixed(3)}`
      );
    }
  }
}

function runConcreteCases(runtime: ActionLearnerRuntime): void {
  const cases: SimCase[] = [
    { text: '5分钟后提醒我交周报', truth: 'delay', chatType: 'private', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: false },
    { text: '等会提醒我去取快递', truth: 'delay', chatType: 'private', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: false },
    { text: '你在吗', truth: 'short', chatType: 'private', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: true },
    { text: '在不在呀', truth: 'short', chatType: 'group', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: true },
    { text: '@机器人 帮我总结一下会议纪要', truth: 'action', chatType: 'group', isMentioned: true, activeTaskCount: 1, isFollowupAfterBotReply: false },
    { text: '帮我把这段英文改成口语化', truth: 'action', chatType: 'private', isMentioned: false, activeTaskCount: 1, isFollowupAfterBotReply: false },
    { text: '哈哈好的收到', truth: 'silent', chatType: 'group', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: false },
    { text: 'ok got it', truth: 'silent', chatType: 'group', isMentioned: false, activeTaskCount: 0, isFollowupAfterBotReply: false }
  ];

  console.log('\n=== concrete cases ===');
  for (const c of cases) {
    const pred = runtime.predict({
      text: c.text,
      chatType: c.chatType,
      isMentioned: c.isMentioned,
      activeTaskCount: c.activeTaskCount,
      isFollowupAfterBotReply: c.isFollowupAfterBotReply
    });
    const p = pred.prediction.probabilities;
    console.log(
      `text="${c.text}" truth=${c.truth} pred=${pred.action} accept=${pred.acceptedByLocal} reason=${pred.reasonCode} conf=${pred.prediction.confidence.toFixed(3)} margin=${pred.prediction.margin.toFixed(3)} [s=${p.silent.toFixed(3)} sh=${p.short.toFixed(3)} a=${p.action.toFixed(3)} d=${p.delay.toFixed(3)}]`
    );
  }
}

function readCliNumberArg(name: string, fallback: number): number {
  const target = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(target));
  if (!hit) return fallback;
  const value = Number(hit.slice(target.length));
  return Number.isFinite(value) ? value : fallback;
}

function main(): void {
  const trainSizeRaw = readCliNumberArg('train-size', 3000);
  const evalSizeRaw = readCliNumberArg('eval-size', 1200);
  const trainSeedRaw = readCliNumberArg('train-seed', 20260226);
  const evalSeedRaw = readCliNumberArg('eval-seed', 20260227);
  const trainSize = Number.isFinite(trainSizeRaw) ? Math.max(200, Math.floor(trainSizeRaw)) : 3000;
  const evalSize = Number.isFinite(evalSizeRaw) ? Math.max(200, Math.floor(evalSizeRaw)) : 1200;
  const trainSeed = Number.isFinite(trainSeedRaw) ? Math.floor(trainSeedRaw) : 20260226;
  const evalSeed = Number.isFinite(evalSeedRaw) ? Math.floor(evalSeedRaw) : 20260227;

  const baseline = new ActionLearnerRuntime({
    dim: 8192,
    softmaxTemperature: 0.9,
    localAcceptConfidence: 0.72,
    localAcceptMargin: 0.18
  });
  const trained = new ActionLearnerRuntime({
    dim: 8192,
    softmaxTemperature: 0.9,
    localAcceptConfidence: 0.72,
    localAcceptMargin: 0.18
  });

  const probeTexts = [
    '3分钟后提醒我开会',
    '过会提醒我交作业',
    '你在吗',
    '帮我总结一下这段内容',
    '哈哈哈',
    'later remind me to join meeting'
  ];

  showExamples(baseline, 'before training', probeTexts);

  console.log(`\n[sim] train_size=${trainSize} eval_size=${evalSize} train_seed=${trainSeed} eval_seed=${evalSeed}`);
  simulateStreamTraining(trained, trainSize, trainSeed);

  showExamples(trained, 'after stream training', probeTexts);

  const evalSet = buildHoldoutDataset(evalSize, evalSeed);
  const baseMetrics = evaluate(baseline, evalSet);
  const trainedMetrics = evaluate(trained, evalSet);

  printMetrics('baseline', baseMetrics);
  printMetrics('trained', trainedMetrics);
  runConcreteCases(trained);
  thresholdSweep(trained, evalSet);
  console.log(`\ntrained_samples=${trained.trainedCount()}`);
}

main();
