import { ok, fail } from '../../src/utils/result.js';

export default async function handler(args = {}) {
  const groupId = typeof args.group_id === 'string' ? args.group_id.trim() : '';
  const content = typeof args.content === 'string' ? args.content.trim() : '';
  const mediaHints = Array.isArray(args.media_hints) ? args.media_hints : undefined;

  if (!groupId) {
    return fail('group_id 是必须的字符串参数', 'INVALID');
  }
  if (!/^\d+$/.test(groupId)) {
    return fail('group_id 必须为纯数字字符串', 'INVALID');
  }
  if (!content) {
    return fail('content 不能为空', 'INVALID');
  }

  return ok({
    action: 'send_group_message',
    mode: 'routing_only',
    can_send_message: false,
    need_user_confirm: false,
    target: { type: 'group', group_id: groupId },
    intent: content,
    media_hints: mediaHints,
    suggested_routing: {
      tag: 'group_id',
      value: groupId,
      xml: `<group_id>${groupId}</group_id>`
    },
    constraints: {
      must_not_invent_ids: true,
      must_use_digits_only_id: true,
      exactly_one_target_tag: true,
      forbidden_in_text: ['[[to=user:...]]', '[CQ:at,qq=...]', 'to=user']
    },
    suggested_next: {
      action: 'compose_sentra_response',
      instruction: 'Write the final user-facing message in <textN>. Include EXACTLY ONE routing target tag (<group_id> only) and do not claim it has been sent unless the platform will actually send it.'
    }
  });
}
