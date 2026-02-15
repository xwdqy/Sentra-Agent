import { ok, fail } from '../../src/utils/result.js';

export default async function handler(args = {}) {
  const userId = typeof args.user_id === 'string' ? args.user_id.trim() : '';
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  const mediaHints = Array.isArray(args.media_hints) ? args.media_hints : undefined;

  if (!userId) {
    return fail('user_id 是必须的字符串参数', 'INVALID');
  }
  if (!/^\d+$/.test(userId)) {
    return fail('user_id 必须为纯数字字符串', 'INVALID');
  }
  if (!content) {
    return fail('content 不能为空', 'INVALID');
  }

  return ok({
    action: 'send_private_message',
    mode: 'routing_only',
    can_send_message: false,
    need_user_confirm: false,
    target: { type: 'private', user_id: userId },
    intent: content,
    media_hints: mediaHints,
    suggested_routing: {
      tag: 'user_id',
      value: userId,
      xml: `<user_id>${userId}</user_id>`
    },
    constraints: {
      must_not_invent_ids: true,
      must_use_digits_only_id: true,
      exactly_one_target_tag: true,
      forbidden_in_text: ['[[to=user:...]]', '[CQ:at,qq=...]', 'to=user']
    },
    suggested_next: {
      action: 'compose_sentra_response',
      instruction: 'Write the final user-facing message in <textN>. Include EXACTLY ONE routing target tag (<user_id> only) and do not claim it has been sent unless the platform will actually send it.'
    }
  });
}
