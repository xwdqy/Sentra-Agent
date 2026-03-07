import { ActionLearnerRuntime, buildTeacherSample } from './actionLearner/runtime.js';
import type { ActionLabel } from './actionLearner/types.js';

type DemoCase = {
  text: string;
  label: ActionLabel;
  chatType?: 'private' | 'group';
  isMentioned?: boolean;
};

const TRAIN_CASES: DemoCase[] = [
  { text: '好的收到', label: 'silent', chatType: 'group' },
  { text: '哈哈哈哈', label: 'silent', chatType: 'group' },
  { text: '在吗', label: 'short', chatType: 'private' },
  { text: '在干嘛', label: 'short', chatType: 'private' },
  { text: '帮我总结一下这段话', label: 'action', chatType: 'private' },
  { text: '帮我搜两首安静纯音乐', label: 'action', chatType: 'group', isMentioned: true },
  { text: '5分钟后提醒我开会', label: 'delay', chatType: 'private' },
  { text: '过一会儿提醒我喝水', label: 'delay', chatType: 'private' },
  { text: 'later remind me to stand up', label: 'delay', chatType: 'private' },
  { text: 'can you explain this code', label: 'action', chatType: 'private' },
  { text: 'ok', label: 'silent', chatType: 'group' },
  { text: '收到啦', label: 'silent', chatType: 'group' },
  { text: '1分钟后戳我一下', label: 'delay', chatType: 'private' },
  { text: '你还在吗', label: 'short', chatType: 'private' },
  { text: '@你 帮我看下报错', label: 'action', chatType: 'group', isMentioned: true }
];

const TEST_CASES: DemoCase[] = [
  { text: '3分钟之后提醒我去上班', label: 'delay', chatType: 'private' },
  { text: '待会提醒我交作业', label: 'delay', chatType: 'private' },
  { text: 'yo', label: 'short', chatType: 'private' },
  { text: '在不在', label: 'short', chatType: 'private' },
  { text: '帮我翻译这段英文', label: 'action', chatType: 'private' },
  { text: '哈哈', label: 'silent', chatType: 'group' },
  { text: 'good morning', label: 'short', chatType: 'group' },
  { text: '@机器人 给我两首轻音乐', label: 'action', chatType: 'group', isMentioned: true }
];

function predictOne(runtime: ActionLearnerRuntime, text: string, chatType: 'private' | 'group', isMentioned: boolean) {
  return runtime.predict({
    text,
    chatType,
    isMentioned,
    activeTaskCount: 0,
    isFollowupAfterBotReply: false
  });
}

function train(runtime: ActionLearnerRuntime, samples: DemoCase[], rounds: number): void {
  for (let r = 0; r < rounds; r++) {
    for (const item of samples) {
      const sample = buildTeacherSample({
        conversationId: `demo_${item.chatType || 'private'}`,
        text: item.text,
        chatType: item.chatType || 'private',
        isMentioned: !!item.isMentioned,
        activeTaskCount: 0,
        isFollowupAfterBotReply: false,
        teacher: {
          source: 'llm_reply_gate_decision',
          action: item.label,
          confidence: 0.95
        }
      });
      runtime.learnFromSample(sample);
    }
  }
}

function evaluate(runtime: ActionLearnerRuntime, cases: DemoCase[]): { correct: number; total: number } {
  let correct = 0;
  for (const item of cases) {
    const pred = predictOne(runtime, item.text, item.chatType || 'private', !!item.isMentioned);
    if (pred.action === item.label) correct += 1;
    const probs = pred.prediction.probabilities;
    console.log(
      `[eval] text="${item.text}" expected=${item.label} pred=${pred.action} conf=${probs[pred.action].toFixed(3)} margin=${pred.prediction.margin.toFixed(3)} entropy=${pred.prediction.entropy.toFixed(3)}`
    );
  }
  return { correct, total: cases.length };
}

function showBeforeAfter(runtime: ActionLearnerRuntime, text: string, chatType: 'private' | 'group', isMentioned = false): void {
  const pred = predictOne(runtime, text, chatType, isMentioned);
  const p = pred.prediction.probabilities;
  console.log(
    `[predict] text="${text}" => action=${pred.action} silent=${p.silent.toFixed(3)} short=${p.short.toFixed(3)} action=${p.action.toFixed(3)} delay=${p.delay.toFixed(3)}`
  );
}

function runDemo(): void {
  const runtime = new ActionLearnerRuntime({
    dim: 4096,
    localAcceptConfidence: 0.72,
    localAcceptMargin: 0.18
  });

  console.log('--- before training ---');
  showBeforeAfter(runtime, '3分钟后提醒我开会', 'private');
  showBeforeAfter(runtime, '帮我总结这段内容', 'private');
  showBeforeAfter(runtime, '哈哈', 'group');

  train(runtime, TRAIN_CASES, 20);

  console.log('--- after training ---');
  showBeforeAfter(runtime, '3分钟后提醒我开会', 'private');
  showBeforeAfter(runtime, '帮我总结这段内容', 'private');
  showBeforeAfter(runtime, '哈哈', 'group');

  console.log('--- test set ---');
  const report = evaluate(runtime, TEST_CASES);
  const acc = report.total > 0 ? report.correct / report.total : 0;
  console.log(`accuracy=${acc.toFixed(3)} (${report.correct}/${report.total})`);
  console.log(`trained_samples=${runtime.trainedCount()}`);
}

runDemo();

