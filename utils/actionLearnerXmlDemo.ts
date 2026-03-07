import { ActionLearnerRuntime, buildTeacherSample } from './actionLearner/runtime.js';

const BOT_NAME = 'shiyu';

function main(): void {
  const runtime = new ActionLearnerRuntime({
    dim: 4096,
    localAcceptConfidence: 0.7,
    localAcceptMargin: 0.18
  });

  const xmlDelay = [
    '<sentra-input>',
    '  <current_messages>',
    '    <sentra-message>',
    '      <chat_type>private</chat_type>',
    '      <user_id>2166683295</user_id>',
    `      <sender_name>${BOT_NAME}</sender_name>`,
    '      <message>',
    `        <segment index="1"><type>text</type><data><text>${BOT_NAME}, remind me to join meeting in 5 minutes</text></data></segment>`,
    '      </message>',
    '    </sentra-message>',
    '  </current_messages>',
    '</sentra-input>'
  ].join('\n');

  const xmlShort = [
    '<sentra-input>',
    '  <current_messages>',
    '    <sentra-message>',
    '      <chat_type>private</chat_type>',
    '      <user_id>2166683295</user_id>',
    `      <sender_name>${BOT_NAME}</sender_name>`,
    '      <message>',
    `        <segment index="1"><type>text</type><data><text>${BOT_NAME}, are you there?</text></data></segment>`,
    '      </message>',
    '    </sentra-message>',
    '  </current_messages>',
    '</sentra-input>'
  ].join('\n');

  const delaySample = buildTeacherSample({
    conversationId: 'private_2166683295',
    text: '',
    rawContent: xmlDelay,
    botNames: [BOT_NAME],
    chatType: 'private',
    isMentioned: false,
    activeTaskCount: 0,
    isFollowupAfterBotReply: false,
    teacher: {
      source: 'llm_reply_gate_decision',
      action: 'delay',
      confidence: 0.95,
      reasonCode: 'llm_delay'
    }
  });

  const shortSample = buildTeacherSample({
    conversationId: 'private_2166683295',
    text: '',
    rawContent: xmlShort,
    botNames: [BOT_NAME],
    chatType: 'private',
    isMentioned: false,
    activeTaskCount: 0,
    isFollowupAfterBotReply: false,
    teacher: {
      source: 'llm_reply_gate_decision',
      action: 'short',
      confidence: 0.95,
      reasonCode: 'llm_short'
    }
  });

  runtime.learnFromSample(delaySample);
  runtime.learnFromSample(shortSample);

  const pred1 = runtime.predict({
    text: `${BOT_NAME}, remind me in 3 minutes to send the report`,
    chatType: 'private',
    isMentioned: false,
    activeTaskCount: 0,
    isFollowupAfterBotReply: false
  });
  const pred2 = runtime.predict({
    text: `${BOT_NAME}, are you online`,
    chatType: 'private',
    isMentioned: false,
    activeTaskCount: 0,
    isFollowupAfterBotReply: false
  });

  console.log('delaySample.text=', delaySample.text);
  console.log('delaySample.payload.format=', delaySample.payload?.format);
  console.log('delaySample.payload.preview=', String(delaySample.payload?.canonicalContent || '').slice(0, 180));
  console.log('predict(delay)=', pred1.action, pred1.prediction.probabilities);
  console.log('predict(short)=', pred2.action, pred2.prediction.probabilities);
}

main();

