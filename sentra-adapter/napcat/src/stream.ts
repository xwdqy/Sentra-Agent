import { WebSocketServer, WebSocket } from 'ws';
import type { MessageEvent, NoticeEvent } from './types/onebot';
import type { SdkInvoke } from './sdk';
import { createLogger } from './logger';
import { ensureLocalFile, isLocalPath } from './utils/fileCache';

const log = createLogger('info');

function formatEventTimeStr(timeSec: number | undefined): string {
  if (!timeSec || !Number.isFinite(timeSec)) return '';
  const d = new Date(timeSec * 1000);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const yyyy = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const HH = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}:${ss}`;
}

/**
 * 格式化的消息结构
 */
export interface FormattedMessage {
  /** 消息ID */
  message_id: number;
  /** 时间戳（秒） */
  time: number;
  /** 时间字符串 */
  time_str: string;
  /** 消息类型：private私聊 | group群聊 */
  type: 'private' | 'group';
  self_id?: number;
  /** 消息摘要（Markdown格式，可视化描述，包含 message_id） */
  summary: string;
  /** 事件自然语言描述（Markdown，自然语言 + 多媒体md） */
  objective?: string;
  /** 发送者QQ号 */
  sender_id: number;
  /** 发送者昵称 */
  sender_name: string;
  /** 发送者群名片（仅群聊） */
  sender_card?: string;
  /** 发送者群角色：owner群主 | admin管理员 | member普通成员（仅群聊） */
  sender_role?: 'owner' | 'admin' | 'member';
  /** 群号（仅群聊） */
  group_id?: number;
  /** 群名称（仅群聊，需异步获取） */
  group_name?: string;
  /** 纯文本内容 */
  text: string;
  /** 消息段数组 */
  segments: Array<{
    type: string;
    data: any;
  }>;
  /** 引用消息详情（如果有） */
  reply?: {
    /** 被引用的消息ID */
    id: number;
    /** 被引用的消息文本 */
    text: string;
    /** 被引用消息的发送者名字 */
    sender_name?: string;
    /** 被引用消息的发送者QQ号 */
    sender_id?: number;
    /** 被引用消息的多媒体 */
    media: {
      images: Array<{ file?: string; url?: string; size?: string | number; filename?: string; path?: string }>;
      videos: Array<{ file?: string; url?: string; size?: string | number; path?: string }>;
      files: Array<{ name?: string; url?: string; size?: string | number; path?: string }>;
      records: Array<{ file?: string; format?: string; path?: string }>;
      forwards: Array<{
        id?: string | number;
        count?: number;
        preview?: string[];
        /** 转发节点详情（如果成功获取） */
        nodes?: Array<{
          sender_id?: number;
          sender_name?: string;
          time?: number;
          message?: any[];
          message_text?: string;
        }>;
      }>;
      cards: Array<{ type: string; title?: string; url?: string; content?: string; image?: string; raw?: any; preview?: string }>;
      faces: Array<{ id?: string; text?: string }>;
    };
  };
  /** 图片列表 */
  images: Array<{ file?: string; url?: string; path?: string; summary?: string }>;
  /** 视频列表 */
  videos: Array<{ file?: string; url?: string; path?: string }>;
  /** 文件列表 */
  files: Array<{ name?: string; url?: string; size?: number | string; file_id?: string; path?: string }>;
  /** 语音列表 */
  records: Array<{ file?: string; url?: string; path?: string; file_size?: string | number }>;
  /** 卡片消息列表 */
  cards: Array<{
    type: 'json' | 'xml' | 'app' | 'share' | string;
    title?: string;
    url?: string;
    content?: string;
    image?: string;
    raw?: any;
    preview?: string;
  }>;
  /** 转发消息列表 */
  forwards: Array<{
    id?: string;
    count?: number;
    preview?: string[];
    /** 转发节点详情（如果成功获取） */
    nodes?: Array<{
      sender_id?: number;
      sender_name?: string;
      time?: number;
      message?: any[];
      message_text?: string;
    }>;
  }>;
  /** 表情列表 */
  faces: Array<{ id?: string | number; text?: string }>;
  /** at列表 */
  at_users: number[];
  /** 是否at全体 */
  at_all: boolean;
  /** 原始事件（可选，调试用） */
  raw?: any;
}

export interface PokeNotice extends FormattedMessage {
  /** 事件类型：戳一戳 */
  event_type: 'poke';
  /** 被戳者 QQ 号 */
  target_id: number;
  /** 被戳者名称（昵称/群名片/QQ 号字符串） */
  target_name?: string;
}

/**
 * 消息流服务
 * 通过WebSocket实时推送格式化后的消息给外部应用
 */
export class MessageStream {
  private wss?: WebSocketServer;
  private clients = new Set<WebSocket>();
  private port: number;
  private includeRaw: boolean;
  private skipAnimatedEmoji: boolean;
  private skipVoice: boolean;
  private getGroupNameFn?: (groupId: number) => Promise<string | undefined>;
  private invoker?: SdkInvoke;
  private rpcRetryEnabled: boolean;
  private rpcRetryIntervalMs: number;
  private rpcRetryMaxAttempts: number;
  private botName?: string;
  private whitelistGroups: Set<number>;
  private whitelistUsers: Set<number>;
  private logFiltered: boolean;

  constructor(options: {
    /** WebSocket服务器端口 */
    port: number;
    /** 是否在推送中包含原始事件数据（调试用） */
    includeRaw?: boolean;
    /** 是否跳过动画表情图片消息 */
    skipAnimatedEmoji?: boolean;
    /** 是否跳过非引用语音消息（默认 true；仅语音且无引用、无文本、无其他段时跳过） */
    skipVoice?: boolean;
    /** 当通过消息流调用 NapCat SDK 失败时，是否启用重试 */
    rpcRetryEnabled?: boolean;
    /** 重试间隔（毫秒），默认 10000ms */
    rpcRetryIntervalMs?: number;
    /** 最大重试次数，默认 60 次 */
    rpcRetryMaxAttempts?: number;
    /** 群白名单（空数组表示不过滤） */
    whitelistGroups?: number[];
    /** 私聊用户白名单（空数组表示不过滤） */
    whitelistUsers?: number[];
    /** 对被过滤事件是否记录日志 */
    logFiltered?: boolean;
  }) {
    this.port = options.port;
    this.includeRaw = options.includeRaw ?? false;
    this.skipAnimatedEmoji = options.skipAnimatedEmoji ?? false;
    this.skipVoice = options.skipVoice ?? true;
    this.rpcRetryEnabled = options.rpcRetryEnabled ?? true;
    this.rpcRetryIntervalMs = options.rpcRetryIntervalMs ?? 10000;
    this.rpcRetryMaxAttempts = options.rpcRetryMaxAttempts ?? 60;
    this.whitelistGroups = new Set(options.whitelistGroups ?? []);
    this.whitelistUsers = new Set(options.whitelistUsers ?? []);
    this.logFiltered = options.logFiltered ?? false;
  }

  private isAllowedGroup(groupId: number | undefined): boolean {
    if (this.whitelistGroups.size === 0) return true;
    if (!groupId) return false;
    return this.whitelistGroups.has(groupId);
  }

  private isAllowedUser(userId: number | undefined): boolean {
    if (this.whitelistUsers.size === 0) return true;
    if (!userId) return false;
    return this.whitelistUsers.has(userId);
  }

  private assertAllowedSdkCall(path: string, args: any[]): void {
    // Send APIs (group)
    if (path === 'send.group' || path === 'send.groupReply' || path === 'send.forwardGroup') {
      const groupId = Number(args?.[0]);
      if (!this.isAllowedGroup(Number.isFinite(groupId) ? groupId : undefined)) {
        throw new Error('group_not_in_whitelist');
      }
      return;
    }

    // Send APIs (private)
    if (path === 'send.private' || path === 'send.privateReply' || path === 'send.forwardPrivate') {
      const userId = Number(args?.[0]);
      if (!this.isAllowedUser(Number.isFinite(userId) ? userId : undefined)) {
        throw new Error('user_not_in_whitelist');
      }
      return;
    }
  }

  private assertAllowedInvoke(action: string, params: any): void {
    const a = String(action || '');
    // group send actions
    if (a === 'send_group_msg' || a === 'send_group_forward_msg') {
      const groupId = Number(params?.group_id);
      if (!this.isAllowedGroup(Number.isFinite(groupId) ? groupId : undefined)) {
        throw new Error('group_not_in_whitelist');
      }
      return;
    }
    // private send actions
    if (a === 'send_private_msg' || a === 'send_private_forward_msg') {
      const userId = Number(params?.user_id);
      if (!this.isAllowedUser(Number.isFinite(userId) ? userId : undefined)) {
        throw new Error('user_not_in_whitelist');
      }
      return;
    }
  }

  private async getBotName(selfId?: number): Promise<string | undefined> {
    if (!selfId || !this.invoker) return undefined;
    if (this.botName) return this.botName;
    try {
      const call = async () => await this.invoker!.data('get_login_info', {});
      const info: any = this.rpcRetryEnabled
        ? await this.withRpcRetry(call, 'get_login_info', selfId)
        : await call();
      const nick = info?.nickname;
      if (nick && typeof nick === 'string') {
        this.botName = nick;
      }
    } catch {
      // 忽略获取失败，后续可重试
    }
    return this.botName;
  }

  private async formatPoke(ev: NoticeEvent): Promise<PokeNotice> {
    const time = ev.time ?? Math.floor(Date.now() / 1000);
    const timeStr = formatEventTimeStr(time);

    const isGroup = !!(ev as any).group_id;
    const msgType: 'group' | 'private' = isGroup ? 'group' : 'private';
    const selfId = (ev as any).self_id as number | undefined;
    const groupId = (ev as any).group_id as number | undefined;
    let senderId = (ev as any).user_id as number;
    let targetId = (ev as any).target_id as number;

    if (msgType === 'private' && selfId) {
      if (targetId !== selfId) {
        senderId = selfId;
      }
    }

    let groupName: string | undefined;
    if (msgType === 'group' && groupId && this.getGroupNameFn) {
      try {
        groupName = await this.getGroupNameFn(groupId);
      } catch { }
    }

    let senderName = String(senderId || '');
    let senderCard: string | undefined;
    let senderRole: 'owner' | 'admin' | 'member' | undefined;

    const inv = this.invoker;
    if (inv && senderId) {
      try {
        if (msgType === 'group' && groupId) {
          const call = async () => await inv.data('get_group_member_info', { group_id: groupId, user_id: senderId });
          const info: any = this.rpcRetryEnabled
            ? await this.withRpcRetry(call, 'get_group_member_info', senderId)
            : await call();
          const nick = info?.nickname;
          const card = info?.card;
          const role = info?.role;
          senderName = nick || card || String(senderId);
          senderCard = card || undefined;
          if (role === 'owner' || role === 'admin' || role === 'member') senderRole = role;
        } else if (msgType === 'private') {
          if (selfId && senderId === selfId) {
            const botName = await this.getBotName(selfId);
            senderName = botName || String(senderId);
          } else {
            const call = async () => await inv.data('get_stranger_info', { user_id: senderId });
            const info: any = this.rpcRetryEnabled
              ? await this.withRpcRetry(call, 'get_stranger_info', senderId)
              : await call();
            const nick = info?.nickname;
            senderName = nick || String(senderId);
          }
        }
      } catch { }
    }

    let targetName: string | undefined;
    if (inv && targetId) {
      try {
        if (msgType === 'group' && groupId) {
          const call = async () => await inv.data('get_group_member_info', { group_id: groupId, user_id: targetId });
          const info: any = this.rpcRetryEnabled
            ? await this.withRpcRetry(call, 'get_group_member_info', targetId)
            : await call();
          const nick = info?.nickname;
          const card = info?.card;
          targetName = card || nick || String(targetId);
        } else if (msgType === 'private') {
          if (selfId && targetId === selfId) {
            // 获取 Bot 自身昵称
            const botName = await this.getBotName(selfId);
            targetName = botName || String(targetId);
          } else {
            const call = async () => await inv.data('get_stranger_info', { user_id: targetId });
            const info: any = this.rpcRetryEnabled
              ? await this.withRpcRetry(call, 'get_stranger_info', targetId)
              : await call();
            const nick = info?.nickname;
            targetName = nick || String(targetId);
          }
        }
      } catch { }
    }
    if (!targetName) targetName = String(targetId);

    const senderIsBot = !!(selfId && senderId === selfId);
    const targetIsBot = !!(selfId && targetId === selfId);

    const senderBaseLabel = senderName ? `${senderName}(QQ:${senderId})` : `QQ:${senderId}`;
    const targetBaseLabel = targetName ? `${targetName}(QQ:${targetId})` : `QQ:${targetId}`;

    const senderRoleLabel =
      msgType === 'group'
        ? (senderRole === 'owner'
          ? '群主'
          : senderRole === 'admin'
            ? '管理员'
            : senderRole === 'member'
              ? '成员'
              : '')
        : '';

    const senderDisplayFull =
      msgType === 'group' && senderRoleLabel
        ? `${senderRoleLabel} ${senderBaseLabel}`
        : senderBaseLabel;

    const targetDisplayFull = targetBaseLabel;

    let summary: string;
    let objective: string;

    if (msgType === 'group') {
      const gName = groupName || (groupId ? `群${groupId}` : '未知群');
      const senderSummary = senderIsBot ? `你（${senderBaseLabel}）` : senderDisplayFull;
      const targetSummary = targetIsBot ? `你（${targetBaseLabel}）` : targetDisplayFull;
      summary = `在群聊「${gName}」中，${senderSummary} 轻轻戳了 ${targetSummary}`;

      const senderObj = senderIsBot ? `我（${senderDisplayFull}）` : senderDisplayFull;
      const targetObj = targetIsBot ? `我（${targetDisplayFull}）` : targetDisplayFull;
      objective = `在群聊「${gName}」里，${senderObj} 戳了 ${targetObj}`;
    } else {
      if (targetIsBot) {
        summary = `好友 ${senderBaseLabel} 戳了你（${targetBaseLabel}）`;
        objective = `好友 ${senderBaseLabel} 戳了我（${targetBaseLabel}）`;
      } else if (senderIsBot) {
        summary = `你（${senderBaseLabel}） 在私聊中戳了 ${targetBaseLabel}`;
        objective = `我（${senderBaseLabel}） 戳了好友 ${targetBaseLabel}`;
      } else {
        summary = `${senderBaseLabel} 在私聊中戳了 ${targetBaseLabel}`;
        objective = `${senderBaseLabel} 在私聊中戳了 ${targetBaseLabel}`;
      }
    }

    const poke: PokeNotice = {
      event_type: 'poke',
      message_id: 0,
      time,
      time_str: timeStr,
      type: msgType,
      self_id: selfId,
      summary,
      objective,
      sender_id: senderId,
      sender_name: senderName,
      sender_card: senderCard,
      sender_role: senderRole,
      group_id: groupId,
      group_name: groupName,
      text: '',
      segments: [],
      reply: undefined,
      images: [],
      videos: [],
      files: [],
      records: [],
      cards: [],
      forwards: [],
      faces: [],
      at_users: [],
      at_all: false,
      target_id: targetId,
      target_name: targetName,
    };

    if (this.includeRaw) {
      (poke as any).raw = ev;
    }

    return poke;
  }

  /**
   * 设置获取群名称的函数
   * 由于群名称需要异步查询，外部提供此函数
   */
  setGroupNameResolver(fn: (groupId: number) => Promise<string | undefined>) {
    this.getGroupNameFn = fn;
  }

  setInvoker(fn: SdkInvoke) {
    this.invoker = fn;
  }

  updateRuntimeOptions(options: {
    includeRaw?: boolean;
    skipAnimatedEmoji?: boolean;
    skipVoice?: boolean;
    rpcRetryEnabled?: boolean;
    rpcRetryIntervalMs?: number;
    rpcRetryMaxAttempts?: number;
    whitelistGroups?: number[];
    whitelistUsers?: number[];
    logFiltered?: boolean;
  }) {
    if (options.includeRaw !== undefined) {
      this.includeRaw = options.includeRaw;
    }
    if (options.skipAnimatedEmoji !== undefined) {
      this.skipAnimatedEmoji = options.skipAnimatedEmoji;
    }
    if (options.skipVoice !== undefined) {
      this.skipVoice = options.skipVoice;
    }
    if (options.rpcRetryEnabled !== undefined) {
      this.rpcRetryEnabled = options.rpcRetryEnabled;
    }
    if (options.rpcRetryIntervalMs !== undefined) {
      this.rpcRetryIntervalMs = options.rpcRetryIntervalMs;
    }
    if (options.rpcRetryMaxAttempts !== undefined) {
      this.rpcRetryMaxAttempts = options.rpcRetryMaxAttempts;
    }

    if (options.whitelistGroups !== undefined) {
      this.whitelistGroups = new Set(options.whitelistGroups);
    }
    if (options.whitelistUsers !== undefined) {
      this.whitelistUsers = new Set(options.whitelistUsers);
    }
    if (options.logFiltered !== undefined) {
      this.logFiltered = options.logFiltered;
    }
  }

  /**
   * 内部通用重试：用于 NapCat SDK 的远程调用失败时自动重试
   */
  private async withRpcRetry<T>(fn: () => Promise<T>, label: string, reqId?: string | number): Promise<T> {
    const max = Math.max(1, this.rpcRetryMaxAttempts);
    const interval = Math.max(0, this.rpcRetryIntervalMs);
    let lastErr: any;
    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        return await fn();
      } catch (e: any) {
        lastErr = e;
        if (!this.rpcRetryEnabled || !this.isRetriableError(e) || attempt >= max) {
          throw e;
        }
        try {
          log.warn({ label, reqId, attempt, nextDelayMs: interval, error: e?.message || String(e) }, 'RPC 调用失败，等待重试');
        } catch { }
        await new Promise((r) => setTimeout(r, interval));
      }
    }
    throw lastErr;
  }

  private isRetriableError(err: any): boolean {
    const msg = String(err?.message || err || '').toLowerCase();
    // 明确不可重试的错误（路径/鉴权/参数等）
    if (
      msg.includes('invalid_path') ||
      msg.includes('invalid path') ||
      msg.includes('unauthorized') ||
      msg.includes('forbidden') ||
      msg.includes('bad request') ||
      msg.includes('not found') ||
      msg.includes('参数错误') ||
      msg.includes('invalid')
    ) {
      return false;
    }
    // 典型可重试错误（断联、超时、未打开等）
    if (
      msg.includes('websocket not open') ||
      msg.includes('no reverse ws client connected') ||
      msg.includes('closed') ||
      msg.includes('timeout') ||
      msg.includes('timed out') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('failed to fetch') ||
      msg.includes('network') ||
      msg.includes('temporarily')
    ) {
      return true;
    }
    // 默认允许重试
    return true;
  }

  /**
   * 启动WebSocket服务器
   */
  start(): Promise<void> {
    if (this.wss) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({
          port: this.port,
          host: '0.0.0.0'
        });

        this.wss.on('listening', () => {
          const addr = this.wss?.address();
          const host = (addr && typeof addr === 'object') ? addr.address : '0.0.0.0';
          const port = (addr && typeof addr === 'object') ? addr.port : this.port;
          log.info(`消息流服务已启动，监听: ws://${host}:${port}`);
          resolve();
        });

        this.wss.on('error', (err) => {
          log.error({ err }, '消息流服务错误');
          reject(err);
        });

        this.wss.on('connection', (ws, req) => {
          const ip = req.socket.remoteAddress;
          log.info({ ip }, '新客户端连接');
          this.clients.add(ws);

          // 发送欢迎消息
          ws.send(JSON.stringify({
            type: 'welcome',
            message: 'NapCat消息流服务',
            time: Date.now(),
          }));

          ws.on('close', () => {
            log.info({ ip }, '客户端断开连接');
            this.clients.delete(ws);
          });

          ws.on('error', (err) => {
            log.error({ err, ip }, '客户端连接错误');
            this.clients.delete(ws);
          });

          // 处理客户端消息（可选，用于心跳等）
          ws.on('message', async (data) => {
            try {
              const msg = JSON.parse(data.toString());
              if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
                return;
              }
              if (msg.type === 'invoke' && this.invoker) {
                const reqId = msg.requestId ?? msg.reqId ?? msg.id;
                const call = String(msg.call || 'call');
                const action = msg.action;
                const params = msg.params;
                try {
                  this.assertAllowedInvoke(action, params);
                  const doCall = async () => {
                    if (call === 'data') return await this.invoker!.data(action, params);
                    else if (call === 'ok') return await this.invoker!.ok(action, params);
                    else if (call === 'retry') return await this.invoker!.retry(action, params);
                    return await this.invoker!(action, params);
                  };
                  const result: any = (this.rpcRetryEnabled && call !== 'retry')
                    ? await this.withRpcRetry(doCall, `invoke:${call}:${action}`, reqId)
                    : await doCall();
                  ws.send(JSON.stringify({ type: 'result', requestId: reqId, ok: true, data: result }));
                } catch (e: any) {
                  ws.send(JSON.stringify({ type: 'result', requestId: reqId, ok: false, error: e?.message || String(e) }));
                }
                return;
              }
              if (msg.type === 'sdk' && this.invoker) {
                const reqId = msg.requestId ?? msg.reqId ?? msg.id;
                const path = String(msg.path || '');
                const args = Array.isArray(msg.args) ? msg.args : [];
                try {
                  this.assertAllowedSdkCall(path, args);
                  const doCall = async () => {
                    let target: any = this.invoker as any;
                    for (const key of path.split('.').filter(Boolean)) {
                      target = target?.[key];
                    }
                    if (typeof target !== 'function') throw new Error('invalid_path');
                    return await target(...args);
                  };
                  const result = this.rpcRetryEnabled
                    ? await this.withRpcRetry(doCall, `sdk:${path}`, reqId)
                    : await doCall();
                  ws.send(JSON.stringify({ type: 'result', requestId: reqId, ok: true, data: result }));
                } catch (e: any) {
                  ws.send(JSON.stringify({ type: 'result', requestId: reqId, ok: false, error: e?.message || String(e) }));
                }
                return;
              }
            } catch {
            }
          });
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * 停止WebSocket服务器
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }

      // 关闭所有客户端连接
      for (const client of this.clients) {
        try {
          client.send(JSON.stringify({ type: 'shutdown', message: '服务器关闭' }));
          client.close();
        } catch {
          // 忽略
        }
      }
      this.clients.clear();

      this.wss.close(() => {
        log.info('消息流服务已停止');
        resolve();
      });
    });
  }

  /**
   * 推送格式化消息到所有已连接的客户端
   */
  async push(ev: MessageEvent, replyContext?: any) {
    try {
      if ((ev as any).message_type === 'group') {
        const gid = (ev as any).group_id as number | undefined;
        if (!this.isAllowedGroup(gid)) {
          if (this.logFiltered) {
            log.info({ group_id: gid, message_id: (ev as any).message_id }, 'Filtered: message group not in whitelist (stream.push)');
          }
          return;
        }
      } else if ((ev as any).message_type === 'private') {
        const uid = (ev as any).user_id as number | undefined;
        if (!this.isAllowedUser(uid)) {
          if (this.logFiltered) {
            log.info({ user_id: uid, message_id: (ev as any).message_id }, 'Filtered: message user not in whitelist (stream.push)');
          }
          return;
        }
      }

      // 过滤：非引用语音消息
      if (this.skipVoice) {
        const hasReply = !!replyContext?.reply;
        if (!hasReply && Array.isArray((ev as any).message)) {
          const segs: any[] = (ev as any).message;
          const hasRecord = segs.some((s) => s?.type === 'record');
          if (hasRecord) {
            const hasText = segs.some((s) => s?.type === 'text' && String(s?.data?.text ?? '').trim());
            // 只在“纯语音”时跳过：没有文本、没有 @、没有其他多媒体段
            const hasOther = segs.some((s) => {
              const t = String(s?.type || '');
              if (!t) return false;
              return !['record', 'text'].includes(t);
            });
            if (!hasText && !hasOther) {
              log.debug({ message_id: (ev as any).message_id, sender_id: (ev as any).user_id }, '跳过非引用语音消息');
              return;
            }
          }
        }
      }

      const formatted = await this.formatMessage(ev, replyContext);

      // 检查是否需要跳过动画表情
      if (this.skipAnimatedEmoji) {
        // 条件：1) 没有引用消息 2) 没有文本或只有图片占位符 3) 有图片 4) 图片summary包含"[动画表情]"
        const hasNoReply = !formatted.reply;
        const hasNoMeaningfulText = !formatted.text || formatted.text.trim() === '' || /^\[CQ:image[^\]]*\]$/.test(formatted.text.trim());
        const hasImages = formatted.images.length > 0;
        const isAnimatedEmoji = hasImages && formatted.images.some(img => img.summary === '[动画表情]');

        if (hasNoReply && hasNoMeaningfulText && hasImages && isAnimatedEmoji) {
          log.debug({ message_id: formatted.message_id, sender_id: formatted.sender_id }, '跳过动画表情图片消息');
          return; // 跳过，不推送
        }
      }

      const payload = JSON.stringify({
        type: 'message',
        data: formatted,
      });

      // 广播给所有客户端
      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(payload);
          } catch (err) {
            log.error({ err }, '推送消息失败');
          }
        }
      }
    } catch (err) {
      log.error({ err }, '格式化消息失败');
    }
  }

  /**
   * 推送戳一戳通知到所有已连接的客户端
   * 仅处理 notice_type=notify 且 sub_type=poke 的通知事件
   * 以与普通消息相同的格式推送（type='message'，data=PokeNotice），
   * 下游只需统一处理 message，再通过 event_type='poke' 识别
   */
  async pushNotice(ev: NoticeEvent) {
    try {
      const nt = (ev as any).notice_type;
      const sub = (ev as any).sub_type;
      if (nt !== 'notify' || sub !== 'poke') {
        return;
      }

      const groupId = (ev as any).group_id as number | undefined;
      const userId = (ev as any).user_id as number | undefined;
      if (groupId) {
        if (!this.isAllowedGroup(groupId)) {
          if (this.logFiltered) {
            log.info({ group_id: groupId, user_id: userId }, 'Filtered: poke group not in whitelist');
          }
          return;
        }
      } else {
        if (!this.isAllowedUser(userId)) {
          if (this.logFiltered) {
            log.info({ user_id: userId }, 'Filtered: poke user not in whitelist');
          }
          return;
        }
      }

      const poke = await this.formatPoke(ev);

      if (poke.self_id && poke.sender_id === poke.self_id && poke.target_id !== poke.self_id) {
        return;
      }

      try {
        log.info({
          type: poke.type,
          group_id: poke.group_id,
          sender_id: poke.sender_id,
          sender_name: poke.sender_name,
          target_id: poke.target_id,
          target_name: poke.target_name,
        }, '收到戳一戳通知，准备推送到消息流');
      } catch { }

      const payload = JSON.stringify({
        type: 'message',
        data: poke,
      });

      for (const client of this.clients) {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(payload);
          } catch (err) {
            log.error({ err }, '推送戳一戳通知失败');
          }
        }
      }
    } catch (err) {
      log.error({ err }, '处理戳一戳通知失败');
    }
  }

  /**
   * 将OneBot消息事件格式化为统一结构
   */
  private async formatMessage(ev: MessageEvent, replyContext?: any): Promise<FormattedMessage> {
    const time = ev.time ?? Math.floor(Date.now() / 1000);
    const timeStr = formatEventTimeStr(time);

    const ctx = {
      messageType: ev.message_type,
      groupId: (ev as any).group_id as number | undefined,
      userId: (ev as any).user_id as number | undefined,
    };

    const segments = (Array.isArray(ev.message) ? ev.message : []).map((seg: any) => ({
      type: seg?.type,
      data: seg?.data ? { ...seg.data } : {},
    }));

    try {
      await this.enrichSegmentsMedia(segments, ctx);
    } catch {
    }

    const stringifyRaw = (v: any): string => {
      if (typeof v === 'string') return v;
      if (v === undefined) return '';
      if (v === null) return '';
      try {
        return JSON.stringify(v);
      } catch {
        try {
          return String(v);
        } catch {
          return '';
        }
      }
    };

    const tryParseJsonAny = (v: any): any | undefined => {
      if (!v) return undefined;
      if (typeof v === 'object') return v;
      if (typeof v !== 'string') return undefined;
      const s = v.trim();
      if (!s) return undefined;
      if (!(s.startsWith('{') || s.startsWith('['))) return undefined;
      try {
        return JSON.parse(s);
      } catch {
        return undefined;
      }
    };

    const compactText = (s: string, maxLen = 140): string => {
      const one = String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (!one) return '';
      return one.length > maxLen ? `${one.slice(0, maxLen)}...` : one;
    };

    const pickUrlLike = (v: any, depth = 0): string | undefined => {
      if (v == null) return undefined;
      if (depth > 2) return undefined;
      if (typeof v === 'string') {
        const s = v.trim();
        return s ? s : undefined;
      }
      if (Array.isArray(v)) {
        for (const it of v) {
          const got = pickUrlLike(it, depth + 1);
          if (got) return got;
        }
        return undefined;
      }
      if (typeof v === 'object') {
        const obj: any = v;
        const keys = [
          'url',
          'src',
          'srcUrl',
          'src_url',
          'preview',
          'previewUrl',
          'preview_url',
          'cover',
          'coverUrl',
          'cover_url',
          'image',
          'imageUrl',
          'image_url',
          'pic',
          'picUrl',
          'pic_url',
          'picture',
          'thumb',
          'thumbUrl',
          'thumb_url',
          'thumbnail',
          'thumbnailUrl',
          'thumbnail_url',
          'icon',
          'iconUrl',
          'icon_url',
        ];
        for (const k of keys) {
          const got = pickUrlLike(obj?.[k], depth + 1);
          if (got) return got;
        }
      }
      return undefined;
    };

    const buildCardFromRaw = (type: string, rawInput: any): any => {
      const rawStr = stringifyRaw(rawInput);
      const obj = tryParseJsonAny(rawInput) ?? tryParseJsonAny(rawStr);

      const metaData = obj?.metaData || obj?.meta_data || obj?.meta || undefined;
      const details = [
        metaData?.detail_1,
        metaData?.detail1,
        metaData?.detail_0,
        metaData?.detail0,
        metaData?.detail_2,
        metaData?.detail2,
        metaData?.detail_3,
        metaData?.detail3,
        metaData?.news,
      ].filter(Boolean);
      const detail1 = (details[0] as any) || undefined;

      const title =
        detail1?.title ||
        metaData?.title ||
        obj?.prompt ||
        obj?.title ||
        obj?.meta?.title ||
        obj?.appName ||
        undefined;

      const content =
        detail1?.desc ||
        metaData?.desc ||
        obj?.desc ||
        obj?.meta?.desc ||
        obj?.appView ||
        obj?.ver ||
        undefined;

      const url =
        detail1?.url ||
        detail1?.jumpUrl ||
        detail1?.qqdocurl ||
        detail1?.jump_url ||
        metaData?.jumpUrl ||
        metaData?.jump_url ||
        obj?.jumpUrl ||
        obj?.webUrl ||
        obj?.url ||
        obj?.jump_url ||
        obj?.web_url ||
        obj?.meta?.url ||
        obj?.meta?.news?.jumpUrl ||
        obj?.meta?.news?.url ||
        undefined;

      const image =
        pickUrlLike(detail1?.preview) ||
        pickUrlLike(detail1?.previewUrl) ||
        pickUrlLike(detail1?.preview_url) ||
        pickUrlLike(detail1?.cover) ||
        pickUrlLike(detail1?.coverUrl) ||
        pickUrlLike(detail1?.cover_url) ||
        pickUrlLike(detail1?.image) ||
        pickUrlLike(detail1?.imageUrl) ||
        pickUrlLike(detail1?.image_url) ||
        pickUrlLike(detail1?.pic) ||
        pickUrlLike(detail1?.picUrl) ||
        pickUrlLike(detail1?.pic_url) ||
        pickUrlLike(detail1?.icon) ||
        pickUrlLike(detail1?.iconUrl) ||
        pickUrlLike(detail1?.icon_url) ||
        pickUrlLike(metaData?.preview) ||
        pickUrlLike(metaData?.previewUrl) ||
        pickUrlLike(metaData?.cover) ||
        pickUrlLike(metaData?.coverUrl) ||
        pickUrlLike(metaData?.image) ||
        pickUrlLike(metaData?.imageUrl) ||
        pickUrlLike(metaData?.icon) ||
        pickUrlLike(metaData?.iconUrl) ||
        pickUrlLike(obj?.picUrl) ||
        pickUrlLike(obj?.pic_url) ||
        pickUrlLike(obj?.image) ||
        pickUrlLike(obj?.imageUrl) ||
        pickUrlLike(obj?.image_url) ||
        pickUrlLike(obj?.meta?.preview) ||
        pickUrlLike(obj?.meta?.news?.preview) ||
        pickUrlLike(obj?.meta?.news?.image) ||
        pickUrlLike(obj?.cover) ||
        pickUrlLike(obj?.coverUrl) ||
        pickUrlLike(obj?.cover_url) ||
        undefined;

      const source =
        detail1?.source ||
        detail1?.sourceName ||
        detail1?.tag ||
        detail1?.app ||
        detail1?.appName ||
        metaData?.source ||
        metaData?.tag ||
        metaData?.app ||
        metaData?.appName ||
        obj?.meta?.source ||
        obj?.meta?.tag ||
        obj?.meta?.news?.tag ||
        obj?.appName ||
        obj?.app ||
        undefined;

      const preview = (() => {
        const pieces: string[] = [];
        if (title) pieces.push(String(title));
        const c = content ? String(content) : '';
        if (c && (!title || c !== String(title))) pieces.push(c);
        if (pieces.length) return compactText(pieces.join(' - '));
        if (obj?.config?.type) return compactText(`类型: ${obj.config.type}`);
        if (obj?.config?.token) return compactText(`类型: ${obj?.config?.type || 'ark'}`);
        return compactText(rawStr);
      })();

      return {
        type,
        raw: rawStr,
        title,
        content,
        url,
        image,
        source,
        preview,
      };
    };

    // 提取纯文本
    const text = segments
      .filter((seg: any) => seg.type === 'text')
      .map((seg: any) => String(seg.data?.text ?? ''))
      .join('');

    // 提取多媒体
    const images: any[] = [];
    const videos: any[] = [];
    const files: any[] = [];
    const records: any[] = [];
    const forwards: any[] = [];
    const faces: any[] = [];
    const cards: any[] = [];
    const atUsers: number[] = [];
    let atAll = false;

    for (const seg of segments) {
      if (seg.type === 'image') {
        images.push({
          file: seg.data?.file,
          url: seg.data?.url,
          path: seg.data?.cache_path || seg.data?.path,
          summary: seg.data?.summary
        });
      } else if (seg.type === 'video') {
        videos.push({ file: seg.data?.file, url: seg.data?.url, path: seg.data?.cache_path || seg.data?.path });
      } else if (seg.type === 'file') {
        const name = seg.data?.name || seg.data?.file_name || seg.data?.file || seg.data?.filename;
        files.push({
          name,
          file_id: seg.data?.file_id || seg.data?.file_unique || seg.data?.id,
          size: seg.data?.file_size ?? seg.data?.size,
          url: seg.data?.url,
          path: seg.data?.cache_path || seg.data?.path,
        });
      } else if (seg.type === 'record') {
        records.push({
          file: seg.data?.file,
          url: seg.data?.url,
          path: seg.data?.cache_path || seg.data?.path,
          file_size: seg.data?.file_size,
        });
      } else if (seg.type === 'forward') {
        const id = seg.data?.message_id ?? seg.data?.id;
        const nodes = Array.isArray(seg.data?.nodes) ? seg.data.nodes : [];
        const preview = nodes
          .map((n: any) => {
            const name = n?.sender_name || `用户${n?.sender_id || ''}`;
            const t = String(n?.message_text || '').trim();
            return `${name}: ${t || '[空消息]'}`;
          })
          .slice(0, 30);
        forwards.push({
          id: id ? String(id) : undefined,
          count: typeof seg.data?.count === 'number' ? seg.data.count : nodes.length,
          preview,
          nodes: nodes.length ? nodes : undefined,
        });
      } else if (seg.type === 'face') {
        faces.push({ id: seg.data?.id, text: seg.data?.text });
      } else if (seg.type === 'json') {
        const raw = seg.data?.data ?? seg.data?.json ?? seg.data?.content ?? seg.data ?? '';
        cards.push(buildCardFromRaw('json', raw));
      } else if (seg.type === 'xml') {
        const raw = seg.data?.data ?? seg.data?.xml ?? '';
        const rawStr = stringifyRaw(raw);
        const m = rawStr ? rawStr.match(/<title>([^<]{1,64})<\/title>/i) : null;
        const title = m?.[1];
        const preview = compactText(title || rawStr);
        cards.push({ type: 'xml', raw: rawStr, title, preview });
      } else if (seg.type === 'share') {
        const title = seg.data?.title;
        const url = seg.data?.url;
        const content = seg.data?.content;
        const image = seg.data?.image;
        const source = seg.data?.source || seg.data?.app || seg.data?.origin;
        const preview = compactText(String(title || content || url || ''));
        cards.push({ type: 'share', title, url, content, image, source, preview });
      } else if (seg.type === 'app') {
        const raw = seg.data?.content ?? seg.data?.data ?? seg.data ?? '';
        cards.push(buildCardFromRaw('app', raw));
      } else if (seg.type === 'at') {
        const qq = seg.data?.qq;
        if (qq === 'all') {
          atAll = true;
        } else if (qq) {
          atUsers.push(Number(qq));
        }
      }
    }

    // 基础消息结构
    const formatted: FormattedMessage = {
      message_id: ev.message_id,
      time,
      time_str: timeStr,
      type: ev.message_type,
      self_id: (ev as any).self_id,
      summary: '', // 稍后生成
      objective: '', // 稍后生成
      sender_id: ev.user_id ?? ev.sender?.user_id ?? 0,
      sender_name: ev.sender?.nickname || String(ev.user_id ?? ev.sender?.user_id ?? 0),
      text,
      segments,
      images,
      videos,
      files,
      records,
      cards,
      forwards,
      faces,
      at_users: atUsers,
      at_all: atAll,
    };

    // 群聊特有字段
    if (ev.message_type === 'group' && ev.group_id) {
      formatted.group_id = ev.group_id;
      formatted.sender_card = ev.sender?.card;
      formatted.sender_role = ev.sender?.role as any;

      // 尝试获取群名称
      if (this.getGroupNameFn) {
        try {
          formatted.group_name = await this.getGroupNameFn(ev.group_id);
        } catch {
          // 忽略
        }
      }
    }

    // 引用消息
    if (replyContext?.reply) {
      formatted.reply = {
        id: replyContext.reply.id,
        text: replyContext.referredPlain || '',
        sender_name: replyContext.referred?.sender?.nickname || replyContext.referred?.sender?.card,
        sender_id: replyContext.referred?.user_id || replyContext.referred?.sender?.user_id,
        media: replyContext.media || {
          images: [],
          videos: [],
          files: [],
          records: [],
          forwards: [],
          cards: [],
          faces: [],
        },
      };

      // 获取引用消息中的转发消息详情
      if (formatted.reply.media.forwards.length > 0 && this.invoker) {
        try {
          const tasks = formatted.reply.media.forwards.map(async (fwd) => {
            try {
              const messageId = (fwd as any).message_id ?? (fwd as any).id;
              log.info({ messageId }, 'get_forward_msg(引用) 请求');
              const call = async () => await this.invoker!.data('get_forward_msg', { message_id: messageId, id: messageId });
              const detail: any = this.rpcRetryEnabled
                ? await this.withRpcRetry(call, 'get_forward_msg', messageId as any)
                : await call();
              const data = detail?.data ?? detail;
              const nodes: any[] =
                (detail?.messages as any[]) ||
                (detail?.data as any)?.messages ||
                (data as any)?.message ||
                (data as any)?.messages ||
                (data as any)?.data?.messages ||
                (data as any)?.data?.message ||
                [];
              const nodesLen = Array.isArray(nodes) ? nodes.length : 0;
              if (nodesLen === 0) {
                log.warn({ messageId, detail }, 'get_forward_msg(引用) nodes为空');
              } else {
                log.info(
                  {
                    messageId,
                    topKeys: detail ? Object.keys(detail) : [],
                    dataKeys: detail?.data ? Object.keys(detail.data) : [],
                    nodesLen,
                  },
                  'get_forward_msg(引用) 响应',
                );
              }
              fwd.count = nodes.length;
              const nodesOut = await Promise.all(nodes.map(async (node: any) => {
                const merged: any[] = [];
                if (Array.isArray(node?.message)) merged.push(...node.message);
                if (Array.isArray(node?.content)) merged.push(...node.content);
                if (Array.isArray(node?.data?.content)) merged.push(...node.data.content);
                if (Array.isArray(node?.data?.message)) merged.push(...node.data.message);
                if (merged.length === 0) {
                  if (typeof node?.content === 'string') merged.push({ type: 'text', data: { text: node.content } });
                  else if (typeof node?.message === 'string') merged.push({ type: 'text', data: { text: node.message } });
                }
                const baseSegs = merged;
                await this.enrichSegmentsMedia(baseSegs, {
                  messageType: ev.message_type,
                  groupId: ev.group_id,
                  userId: ev.user_id,
                });
                return {
                  sender_id: node.sender_id || node.user_id || node.sender?.user_id,
                  sender_name: node.sender_name || node.nickname || node.sender?.nickname,
                  time: node.time,
                  message: baseSegs,
                  message_text: this.renderSegmentsMarkdownInline(baseSegs),
                };
              }));
              fwd.nodes = nodesOut;
              fwd.preview = nodesOut.map((node: any) => {
                const name = node.sender_name || `用户${node.sender_id || ''}`;
                const msgText = String(node.message_text || '');
                return `${name}: ${msgText || '[空消息]'}`;
              });
            } catch (err) {
              log.error({ err, fwdId: fwd.id }, '获取引用消息转发详情失败');
            }
          });
          await Promise.all(tasks);
        } catch (err) {
          log.error({ err }, '批量获取引用消息转发失败');
        }
      }
    }

    // 是否包含原始事件
    if (this.includeRaw) {
      formatted.raw = ev;
    }

    // 生成消息摘要（Markdown格式）
    formatted.summary = await this.generateSummary(formatted);
    // 生成事件的自然语言描述（Markdown，自然语言 + 多媒体md）
    formatted.objective = await this.generateObjective(formatted);

    return formatted;
  }

  /**
   * 获取当前连接的客户端数量
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * 生成事件的自然语言描述（Markdown，自然语言 + 多媒体md）
   * 不包含时间/消息ID等技术信息，只关注「谁在什么场景做了什么」
   */
  private async generateObjective(msg: FormattedMessage): Promise<string> {
    const isGroup = msg.type === 'group';
    const groupName = msg.group_name || (msg.group_id ? `群${msg.group_id}` : '未知群');
    const selfId = msg.self_id;
    const botNick = typeof selfId === 'number' ? await this.getBotName(selfId) : undefined;

    const botIdentity = (() => {
      if (typeof selfId !== 'number') return '';
      const n = botNick && typeof botNick === 'string' ? botNick : String(selfId);
      return `${n}(QQ:${selfId})`;
    })();

    const roleLabel = (r: any): string => {
      if (r === 'owner') return '[群主]';
      if (r === 'admin') return '[管理员]';
      return '';
    };

    const formatUserDisplay = (opts: {
      userId: number;
      nickname?: string;
      card?: string;
      role?: any;
      isBot?: boolean;
    }): string => {
      const baseName = opts.nickname || String(opts.userId);
      const card = opts.card && opts.card !== baseName ? String(opts.card) : '';
      const namePart = card ? `${baseName}(${card})` : baseName;
      const rolePart = roleLabel(opts.role);
      const qqPart = `(QQ:${opts.userId})`;
      if (opts.isBot) {
        const botName = botNick && typeof botNick === 'string' ? botNick : baseName;
        const name = card && card !== botName ? `${botName}(${card})` : botName;
        return `我（${name}${rolePart}${qqPart}）`;
      }
      return `${namePart}${rolePart}${qqPart}`;
    };

    const resolveTargets = async (ids: number[]): Promise<string[]> => {
      const uniqIds = Array.from(new Set(ids.filter((x) => Number.isFinite(x))));
      if (uniqIds.length === 0) return [];

      if (!this.invoker) {
        return uniqIds.map((uid) => {
          const isBot = typeof selfId === 'number' && uid === selfId;
          return formatUserDisplay({ userId: uid, nickname: String(uid), isBot });
        });
      }

      if (isGroup && msg.group_id) {
        const gid = msg.group_id;
        const tasks = uniqIds.map(async (uid) => {
          const isBot = typeof selfId === 'number' && uid === selfId;
          try {
            const call = async () => await this.invoker!.data('get_group_member_info', { group_id: gid, user_id: uid });
            const info: any = this.rpcRetryEnabled
              ? await this.withRpcRetry(call, 'get_group_member_info', uid)
              : await call();
            return formatUserDisplay({
              userId: uid,
              nickname: info?.nickname || String(uid),
              card: info?.card,
              role: info?.role,
              isBot,
            });
          } catch {
            return formatUserDisplay({ userId: uid, nickname: String(uid), isBot });
          }
        });
        return await Promise.all(tasks);
      }

      const tasks = uniqIds.map(async (uid) => {
        const isBot = typeof selfId === 'number' && uid === selfId;
        try {
          const call = async () => await this.invoker!.data('get_stranger_info', { user_id: uid });
          const info: any = this.rpcRetryEnabled
            ? await this.withRpcRetry(call, 'get_stranger_info', uid)
            : await call();
          return formatUserDisplay({
            userId: uid,
            nickname: info?.nickname || String(uid),
            isBot,
          });
        } catch {
          return formatUserDisplay({ userId: uid, nickname: String(uid), isBot });
        }
      });
      return await Promise.all(tasks);
    };

    const senderIsBot = typeof selfId === 'number' && msg.sender_id === selfId;
    const senderDisplay = formatUserDisplay({
      userId: msg.sender_id,
      nickname: msg.sender_name || `QQ:${msg.sender_id}`,
      card: msg.sender_card,
      role: msg.sender_role,
      isBot: senderIsBot,
    });

    const scenePrefix = isGroup ? `在群聊「${groupName}」里，` : '在私聊里，';
    let desc = `${scenePrefix}${senderDisplay}`;

    if (msg.at_all) {
      desc += ' @了全体成员';
    } else if (msg.at_users && msg.at_users.length > 0) {
      const selfAt = typeof selfId === 'number' && msg.at_users.includes(selfId);
      const otherIds = typeof selfId === 'number'
        ? msg.at_users.filter((u) => u !== selfId)
        : msg.at_users;
      const otherTargets = otherIds.length > 0 ? await resolveTargets(otherIds) : [];
      if (selfAt && botIdentity) {
        desc += ` @了我（${botIdentity}）`;
        if (otherTargets.length > 0) {
          desc += `，同时也@了 ${otherTargets.join('、')}`;
        }
      } else if (otherTargets.length > 0) {
        desc += ` @了 ${otherTargets.join('、')}`;
      }
    }

    const text = (msg.text || '').trim();
    if (text) {
      desc += `，说：“${text}”`;
    }

    const actions: string[] = [];

    // 图片（使用完整 Markdown 链接，优先本地路径）
    if (msg.images && msg.images.length > 0) {
      const items: string[] = [];
      msg.images.forEach((img, idx) => {
        let label: string | undefined = (img as any).summary && String((img as any).summary).trim();
        if (label && label.startsWith('[') && label.endsWith(']')) {
          label = label.substring(1, label.length - 1);
        }
        const filename = label || img.file || `图片${idx + 1}`;
        const localPath = (img as any).path;
        let target = localPath as string | undefined;
        if (!target && img.url) {
          let url = img.url;
          if (!url.match(/^[a-zA-Z]:[\\\/]/) && !url.startsWith('/')) {
            url = `${url}${url.includes('?') ? '&' : '?'}file=${encodeURIComponent(filename)}`;
          }
          target = url;
        }
        const safeTarget = target || img.url || img.file || '';
        items.push(`![${filename}](${safeTarget})`);
      });
      const countText = msg.images.length === 1 ? '一张图片' : `${msg.images.length}张图片`;
      actions.push(`发送了${countText}: ${items.join('、 ')}`);
    }

    // 语音（使用 Markdown 链接，带大小信息）
    if (msg.records && msg.records.length > 0) {
      const items: string[] = [];
      msg.records.forEach((rec, idx) => {
        const filename = rec.file || `语音${idx + 1}`;
        let target = rec.path as string | undefined;
        if (!target && rec.url) {
          let url = rec.url;
          if (!url.match(/^[a-zA-Z]:[\\\/]/) && !url.startsWith('/')) {
            url = `${url}${url.includes('?') ? '&' : '?'}file=${encodeURIComponent(filename)}`;
          }
          target = url;
        }
        const safeTarget = target || rec.url || rec.file || '';
        const sizeText = rec.file_size ? ` (${this.formatFileSize(rec.file_size)})` : '';
        items.push(`[语音: ${filename}](${safeTarget})${sizeText}`);
      });
      const countText = msg.records.length === 1 ? '一条语音消息' : `${msg.records.length}条语音消息`;
      actions.push(`发送了${countText}: ${items.join('、 ')}`);
    }

    // 文件（使用 Markdown 链接，处理远程 URL 上的文件名参数）
    if (msg.files && msg.files.length > 0) {
      const items: string[] = [];
      msg.files.forEach((file, idx) => {
        const filename = file.name || `文件${idx + 1}`;
        let link = file.url || '';
        if (link && !link.match(/^[a-zA-Z]:[\\\/]/) && !link.startsWith('/')) {
          if (link.includes('fname=')) {
            link = link.replace(/fname=([^&]*)/, `fname=${encodeURIComponent(filename)}`);
          } else {
            link = `${link}${link.includes('?') ? '&' : '?'}file=${encodeURIComponent(filename)}`;
          }
        }
        const safeTarget = link || file.path || '';
        const sizeText = file.size ? ` (${this.formatFileSize(file.size)})` : '';
        items.push(`[${filename}](${safeTarget})${sizeText}`);
      });
      const countText = msg.files.length === 1 ? '一个文件' : `${msg.files.length}个文件`;
      actions.push(`发送了${countText}: ${items.join('、 ')}`);
    }

    // 视频（使用 Markdown 链接）
    if (msg.videos && msg.videos.length > 0) {
      const items: string[] = [];
      msg.videos.forEach((vid, idx) => {
        const filename = vid.file || `视频${idx + 1}`;
        let link = vid.url || '';
        if (link && !link.match(/^[a-zA-Z]:[\\\/]/) && !link.startsWith('/')) {
          link = `${link}${link.includes('?') ? '&' : '?'}file=${encodeURIComponent(filename)}`;
        }
        const safeTarget = link || vid.path || '';
        items.push(`[视频: ${filename}](${safeTarget})`);
      });
      const countText = msg.videos.length === 1 ? '一个视频' : `${msg.videos.length}个视频`;
      actions.push(`发送了${countText}: ${items.join('、 ')}`);
    }

    // 表情（保持为人类可读文本）
    if (msg.faces && msg.faces.length > 0) {
      const labels = msg.faces
        .map((f) => f.text || `表情${f.id ?? ''}`);
      actions.push(`发送了表情：${labels.join('、')}`);
    }

    // 卡片消息（share/json/xml/app，使用标题+链接的 Markdown）
    if (msg.cards && msg.cards.length > 0) {
      const items: string[] = [];
      msg.cards.forEach((card) => {
        const type = card.type || 'card';
        let label: string;
        if (type === 'share') label = '链接';
        else if (type === 'app') label = '应用卡片';
        else if (type === 'json') label = 'JSON卡片';
        else if (type === 'xml') label = 'XML卡片';
        else label = '卡片';

        const title = card.title || card.preview || '(无标题)';
        const url = card.url || '';
        const desc = card.content || '';

        let part: string;
        if (url) {
          part = `${label}: [${title}](${url})`;
        } else {
          part = `${label}: ${title}`;
        }
        if (desc) {
          part += `，简介: ${String(desc)}`;
        }
        items.push(part);
      });

      const countText = msg.cards.length === 1 ? '一条卡片消息' : `${msg.cards.length}条卡片消息`;
      actions.push(`分享了${countText}: ${items.join('；')}`);
    }

    // 转发消息（概括节点数量与预览）
    if (msg.forwards && msg.forwards.length > 0) {
      const items: string[] = [];
      const selfId = msg.self_id;
      const botNick = typeof selfId === 'number' ? await this.getBotName(selfId) : undefined;
      msg.forwards.forEach((fwd, idx) => {
        const count =
          (fwd as any).count ?? ((fwd as any).nodes?.length ?? 0);
        items.push(`第${idx + 1}个转发，共${count}条消息`);
        const nodes = (fwd as any).nodes as any[] | undefined;
        if (Array.isArray(nodes) && nodes.length > 0) {
          nodes.forEach((node, nidx) => {
            const nodeSender = (() => {
              const sid = node.sender_id;
              if (typeof selfId === 'number' && sid === selfId) {
                return botNick ? `我（${botNick}）` : '我';
              }
              return node.sender_name || `用户${sid || ''}`;
            })();
            const nodeText = String(node.message_text || '').trim();
            if (nodeText) {
              items.push(`  - [${nidx + 1}/${nodes.length}] ${nodeSender}: ${nodeText}`);
            } else {
              items.push(`  - [${nidx + 1}/${nodes.length}] ${nodeSender}: [空消息]`);
            }
          });
        } else if (Array.isArray((fwd as any).preview) && (fwd as any).preview.length > 0) {
          (fwd as any).preview.forEach((p: any) => items.push(`  - ${String(p)}`));
        }
      });
      const countText = msg.forwards.length === 1 ? '一组转发消息' : `${msg.forwards.length}组转发消息`;
      actions.push(`转发了${countText}: ${items.join('；')}`);
    }

    // 引用消息（拟人化 + 多媒体 Markdown，包含转发节点详情）
    if (msg.reply) {
      const r = msg.reply;
      const rSenderName = r.sender_name || (r.sender_id ? `QQ:${r.sender_id}` : `消息${r.id}`);
      const replyParts: string[] = [];

      replyParts.push(`引用了 ${rSenderName} 的一条消息`);
      if (r.text && r.media.cards.length === 0) {
        replyParts.push(`${rSenderName} 说: ${r.text}`);
      }

      if (r.media.images.length > 0) {
        const items = r.media.images.map((img, idx) => {
          let label: string | undefined = (img as any).summary && String((img as any).summary).trim();
          if (label && label.startsWith('[') && label.endsWith(']')) {
            label = label.substring(1, label.length - 1);
          }
          const filename = label || img.filename || img.file?.split(/[\\/]/).pop() || `图片${idx + 1}`;
          const target = this.toMarkdownTarget((img as any).path) || this.toMarkdownTarget(img.url) || img.file || '';
          return `![${filename}](${target})`;
        });
        replyParts.push(`其中包含图片: ${items.join('、 ')}`);
      }

      if (r.media.records.length > 0) {
        const items = r.media.records.map((rec, idx) => {
          const filename = rec.file || `语音${idx + 1}`;
          const target = this.toMarkdownTarget((rec as any).path) || this.toMarkdownTarget((rec as any).url) || rec.file || '';
          return `[语音: ${filename}](${target})`;
        });
        replyParts.push(`其中包含语音: ${items.join('、 ')}`);
      }

      if (r.media.files.length > 0) {
        const items = r.media.files.map((file, idx) => {
          const filename = file.name || `文件${idx + 1}`;
          const sizeText = file.size !== undefined ? ` (${this.formatFileSize(file.size)})` : '';
          const target = this.toMarkdownTarget((file as any).path) || this.toMarkdownTarget(file.url) || '';
          return `[${filename}](${target})${sizeText}`;
        });
        replyParts.push(`其中包含文件: ${items.join('、 ')}`);
      }

      if (r.media.videos.length > 0) {
        const items = r.media.videos.map((vid, idx) => {
          const filename = vid.file || `视频${idx + 1}`;
          const target = this.toMarkdownTarget((vid as any).path) || this.toMarkdownTarget(vid.url) || '';
          return `[视频: ${filename}](${target})`;
        });
        replyParts.push(`其中包含视频: ${items.join('、 ')}`);
      }

      if (r.media.faces.length > 0) {
        const labels = r.media.faces.map((f) => f.text || `表情${f.id ?? ''}`);
        replyParts.push(`其中包含表情: ${labels.join('、')}`);
      }

      if (r.media.cards.length > 0) {
        const items = r.media.cards.map((card) => {
          const type = card.type || 'card';
          const title = card.title || card.preview || '(无标题)';
          const url = card.url || '';
          const content = card.content || '';
          const head = url ? `[${title}](${url})` : title;
          const label = type === 'share' ? '链接' : type === 'app' ? '应用卡片' : type === 'json' ? 'JSON卡片' : type === 'xml' ? 'XML卡片' : '卡片';
          return content ? `${label}: ${head}（${content}）` : `${label}: ${head}`;
        });
        replyParts.push(`其中包含卡片消息: ${items.join('；')}`);
      }

      if (r.media.forwards.length > 0) {
        const items: string[] = [];
        r.media.forwards.forEach((fwd, idx) => {
          const nodes = (fwd as any).nodes as any[] | undefined;
          const count = (fwd as any).count ?? (Array.isArray(nodes) ? nodes.length : 0);
          items.push(`第${idx + 1}个转发，共${count}条消息`);
          if (Array.isArray(nodes) && nodes.length > 0) {
            nodes.forEach((node, nidx) => {
              const nodeSender = node.sender_name || `用户${node.sender_id || ''}`;
              const nodeText = String(node.message_text || '').trim();
              items.push(`  - [${nidx + 1}/${nodes.length}] ${nodeSender}: ${nodeText || '[空消息]'}`);
            });
          } else if (Array.isArray((fwd as any).preview) && (fwd as any).preview.length > 0) {
            (fwd as any).preview.forEach((p: any) => items.push(`  - ${String(p)}`));
          }
        });
        replyParts.push(`其中包含转发消息: ${items.join('；')}`);
      }

      actions.push(replyParts.join('，'));
    }

    if (actions.length > 0) {
      desc += `，另外${actions.join('；')}`;
    }

    return desc;
  }

  /**
   * 生成消息摘要（Markdown格式）
   * 包含时间、消息ID、会话ID、发送者、内容、多媒体等信息
   */
  private async generateSummary(msg: FormattedMessage): Promise<string> {
    const lines: string[] = [];

    const typeText = msg.type === 'group' ? '群聊' : '私聊';
    const convText = msg.type === 'group'
      ? `会话: G:${msg.group_id || '未知'}`
      : `会话: U:${msg.sender_id}`;

    const headerParts: string[] = [`消息ID: ${msg.message_id}`, convText, typeText];
    if (msg.type === 'group') {
      if (msg.group_name) headerParts.push(`群名: ${msg.group_name}`);
      headerParts.push(`群号: ${msg.group_id || '未知'}`);
    }

    let senderInfo = `${msg.sender_name}`;
    if (msg.sender_card) senderInfo += `(${msg.sender_card})`;
    if (msg.sender_role === 'owner') senderInfo += '[群主]';
    else if (msg.sender_role === 'admin') senderInfo += '[管理员]';
    senderInfo += `(QQ:${msg.sender_id})`;
    headerParts.push(`发送者: ${senderInfo}`);
    lines.push(headerParts.join(' | '));

    // 文本
    if (msg.text && msg.text.trim()) {
      lines.push('');
      lines.push(`说: ${msg.text.trim()}`);
    }

    // 图片
    if (msg.images.length > 0) {
      lines.push('');
      lines.push(msg.images.length === 1 ? '发送了一张图片:' : `发送了${msg.images.length}张图片:`);
      msg.images.forEach((img, i) => {
        let label: string | undefined = (img as any).summary && String((img as any).summary).trim();
        if (label && label.startsWith('[') && label.endsWith(']')) {
          label = label.substring(1, label.length - 1);
        }
        const filename = label || img.file || `图片${i + 1}`;
        const target = this.toMarkdownTarget((img as any).path) || this.toMarkdownTarget(img.url) || this.toMarkdownTarget(img.file);
        lines.push(`![${filename}](${target})`);
      });
    }

    // 视频
    if (msg.videos.length > 0) {
      lines.push('');
      lines.push(msg.videos.length === 1 ? '发送了一个视频:' : `发送了${msg.videos.length}个视频:`);
      msg.videos.forEach((vid, i) => {
        const filename = vid.file || `视频${i + 1}`;
        const target = this.toMarkdownTarget(vid.path) || this.toMarkdownTarget(vid.url) || '';
        lines.push(`[视频: ${filename}](${target})`);
      });
    }

    // 语音
    if (msg.records.length > 0) {
      lines.push('');
      lines.push(msg.records.length === 1 ? '发送了一条语音消息:' : `发送了${msg.records.length}条语音消息:`);
      msg.records.forEach((rec, i) => {
        const filename = rec.file || `语音${i + 1}`;
        const target = this.toMarkdownTarget(rec.path) || this.toMarkdownTarget(rec.url) || this.toMarkdownTarget(rec.file);
        const sizeText = rec.file_size ? ` (${this.formatFileSize(rec.file_size)})` : '';
        lines.push(`[语音: ${filename}](${target})${sizeText}`);
      });
    }

    // 文件
    if (msg.files.length > 0) {
      lines.push('');
      lines.push(msg.files.length === 1 ? '发送了一个文件:' : `发送了${msg.files.length}个文件:`);
      msg.files.forEach((file, i) => {
        const filename = file.name || `文件${i + 1}`;
        const sizeText = file.size !== undefined ? ` (${this.formatFileSize(file.size)})` : '';
        const target = this.toMarkdownTarget(file.path) || this.toMarkdownTarget(file.url) || '';
        lines.push(`[${filename}](${target})${sizeText}`);
      });
    }

    // 卡片
    if (msg.cards.length > 0) {
      msg.cards.forEach((card) => {
        lines.push('');
        const type = card.type || 'card';
        const title = card.title || card.preview || '(无标题)';
        const url = card.url || '';
        const content = card.content || '';
        const label = type === 'share' ? '分享' : type === 'app' ? '应用卡片' : type === 'json' ? 'JSON卡片' : type === 'xml' ? 'XML卡片' : '卡片';
        if (url) lines.push(`${label}: [${title}](${url})`);
        else lines.push(`${label}: ${title}`);
        if (content) lines.push(`  简介: ${content}`);
      });
    }

    // 转发（展开所有节点）
    if (msg.forwards.length > 0) {
      const selfId = msg.self_id;
      const botNick = typeof selfId === 'number' ? await this.getBotName(selfId) : undefined;
      msg.forwards.forEach((fwd, i) => {
        const nodes = (fwd as any).nodes as any[] | undefined;
        const count = (fwd as any).count ?? (Array.isArray(nodes) ? nodes.length : 0);
        lines.push('');
        lines.push(`转发了${count}条消息${msg.forwards.length > 1 ? ` #${i + 1}` : ''}:`);
        if (Array.isArray(nodes) && nodes.length > 0) {
          nodes.forEach((node, idx) => {
            const nodeTime = node.time
              ? new Date(node.time * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
              : '';
            const nodeSender = (() => {
              const sid = node.sender_id;
              if (typeof selfId === 'number' && sid === selfId) {
                return botNick ? `我（${botNick}）` : '我';
              }
              return node.sender_name || `用户${sid || ''}`;
            })();
            lines.push(`[${idx + 1}/${nodes.length}] ${nodeSender}${nodeTime ? ` (${nodeTime})` : ''}`);
            const txt = String(node.message_text || '').trim();
            if (txt) lines.push(`  ${txt}`);
          });
          lines.push('—— 转发消息结束 ——');
        } else if (Array.isArray((fwd as any).preview) && (fwd as any).preview.length > 0) {
          lines.push('预览:');
          (fwd as any).preview.forEach((p: any) => lines.push(`  ${String(p)}`));
        }
      });
    }

    // 引用（展开引用媒体 + 转发节点）
    if (msg.reply) {
      const r = msg.reply;
      const rSenderName = r.sender_name || (r.sender_id ? `QQ:${r.sender_id}` : `消息${r.id}`);
      lines.push('');
      lines.push('—— 引用的消息 ——');
      lines.push(`引用 消息ID: ${r.id} | 发送者: ${rSenderName}`);
      if (r.text && r.media.cards.length === 0) {
        lines.push(`${rSenderName} 说: ${r.text}`);
      }

      if (r.media.images.length > 0) {
        lines.push(r.media.images.length === 1 ? `${rSenderName} 发送了一张图片:` : `${rSenderName} 发送了${r.media.images.length}张图片:`);
        r.media.images.forEach((img, i) => {
          let label: string | undefined = (img as any).summary && String((img as any).summary).trim();
          if (label && label.startsWith('[') && label.endsWith(']')) {
            label = label.substring(1, label.length - 1);
          }
          const filename = label || img.filename || img.file?.split(/[\\/]/).pop() || `图片${i + 1}`;
          const target = this.toMarkdownTarget((img as any).path) || this.toMarkdownTarget(img.url) || this.toMarkdownTarget(img.file);
          lines.push(`![${filename}](${target})`);
        });
      }

      if (r.media.records.length > 0) {
        lines.push(r.media.records.length === 1 ? `${rSenderName} 发送了一条语音消息:` : `${rSenderName} 发送了${r.media.records.length}条语音消息:`);
        r.media.records.forEach((rec, i) => {
          const filename = rec.file || `语音${i + 1}`;
          const target = this.toMarkdownTarget((rec as any).path) || this.toMarkdownTarget((rec as any).url) || this.toMarkdownTarget(rec.file);
          lines.push(`[语音: ${filename}](${target})`);
        });
      }

      if (r.media.files.length > 0) {
        lines.push(r.media.files.length === 1 ? `${rSenderName} 发送了一个文件:` : `${rSenderName} 发送了${r.media.files.length}个文件:`);
        r.media.files.forEach((file, i) => {
          const filename = file.name || `文件${i + 1}`;
          const sizeText = file.size !== undefined ? ` (${this.formatFileSize(file.size)})` : '';
          const target = this.toMarkdownTarget((file as any).path) || this.toMarkdownTarget(file.url) || '';
          lines.push(`[${filename}](${target})${sizeText}`);
        });
      }

      if (r.media.videos.length > 0) {
        lines.push(r.media.videos.length === 1 ? `${rSenderName} 发送了一个视频:` : `${rSenderName} 发送了${r.media.videos.length}个视频:`);
        r.media.videos.forEach((vid, i) => {
          const filename = vid.file || `视频${i + 1}`;
          const target = this.toMarkdownTarget((vid as any).path) || this.toMarkdownTarget(vid.url) || '';
          lines.push(`[视频: ${filename}](${target})`);
        });
      }

      if (r.media.faces.length > 0) {
        const faceTexts = r.media.faces.map((f) => f.text || `[表情${f.id}]`).join('、');
        lines.push(`${rSenderName} 发送了表情: ${faceTexts}`);
      }

      if (r.media.cards.length > 0) {
        r.media.cards.forEach((card) => {
          const type = card.type || 'card';
          const title = card.title || card.preview || '(无标题)';
          const url = card.url || '';
          const content = card.content || '';
          const label = type === 'share' ? '分享' : type === 'app' ? '应用卡片' : type === 'json' ? 'JSON卡片' : type === 'xml' ? 'XML卡片' : '卡片';
          if (url) lines.push(`${rSenderName} ${label}: [${title}](${url})`);
          else lines.push(`${rSenderName} ${label}: ${title}`);
          if (content) lines.push(`  简介: ${content}`);
        });
      }

      if (r.media.forwards.length > 0) {
        const selfId = msg.self_id;
        const botNick = typeof selfId === 'number' ? await this.getBotName(selfId) : undefined;
        r.media.forwards.forEach((fwd, i) => {
          const nodes = (fwd as any).nodes as any[] | undefined;
          const count = (fwd as any).count ?? (Array.isArray(nodes) ? nodes.length : 0);
          lines.push(`${rSenderName} 转发了${count}条消息${r.media.forwards.length > 1 ? ` #${i + 1}` : ''}:`);
          if (Array.isArray(nodes) && nodes.length > 0) {
            nodes.forEach((node, idx) => {
              const nodeSender = (() => {
                const sid = node.sender_id;
                if (typeof selfId === 'number' && sid === selfId) {
                  return botNick ? `我（${botNick}）` : '我';
                }
                return node.sender_name || `用户${sid || ''}`;
              })();
              lines.push(`  [${idx + 1}/${nodes.length}] ${nodeSender}`);
              const txt = String(node.message_text || '').trim();
              if (txt) lines.push(`    ${txt}`);
            });
            lines.push('—— 转发消息结束 ——');
          }
        });
      }
    }

    return lines.join('\n');
  }

  /**
   * 格式化文件大小
   */
  private formatFileSize(size: string | number): string {
    const bytes = typeof size === 'string' ? parseInt(size) : size;
    if (isNaN(bytes)) return '未知大小';

    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  }

  private toMarkdownTarget(target?: string): string {
    if (!target) return '';
    const t = String(target);
    if (isLocalPath(t)) {
      const p = t.replace(/\\/g, '/');
      if (p.startsWith('//')) {
        return encodeURI(`file:${p}`);
      }
      if (/^[a-zA-Z]:\//.test(p)) {
        return encodeURI(`file:///${p}`);
      }
      return encodeURI(p);
    }
    return t;
  }

  private renderSegmentsMarkdownInline(segs: any[]): string {
    if (!Array.isArray(segs) || segs.length === 0) return '';
    const parts: string[] = [];

    for (const s of segs) {
      if (!s || !s.type) continue;
      if (s.type === 'text') {
        const t = String(s.data?.text ?? '');
        if (t) parts.push(t);
        continue;
      }

      if (s.type === 'at') {
        const qq = s.data?.qq;
        if (qq === 'all') parts.push('@全体成员');
        else if (qq) parts.push(`@${qq}`);
        continue;
      }

      if (s.type === 'face') {
        const text = s.data?.text;
        const id = s.data?.id;
        parts.push(text ? String(text) : `表情${id ?? ''}`);
        continue;
      }

      if (s.type === 'image') {
        let label: string | undefined = s.data?.summary && String(s.data.summary).trim();
        if (label && label.startsWith('[') && label.endsWith(']')) {
          label = label.substring(1, label.length - 1);
        }
        const filename = label || s.data?.file || '图片';
        const target = this.toMarkdownTarget(s.data?.path || s.data?.cache_path) || this.toMarkdownTarget(s.data?.url);
        parts.push(target ? `![${filename}](${target})` : `图片:${filename}`);
        continue;
      }

      if (s.type === 'video') {
        const filename = s.data?.file || '视频';
        const target = this.toMarkdownTarget(s.data?.path) || this.toMarkdownTarget(s.data?.url);
        parts.push(target ? `[视频: ${filename}](${target})` : `视频:${filename}`);
        continue;
      }

      if (s.type === 'record') {
        const filename = s.data?.file || '语音';
        const target = this.toMarkdownTarget(s.data?.path) || this.toMarkdownTarget(s.data?.url);
        parts.push(target ? `[语音: ${filename}](${target})` : `语音:${filename}`);
        continue;
      }

      if (s.type === 'file') {
        const filename = s.data?.file || s.data?.name || '文件';
        const path = s.data?.path;
        let url: string | undefined = s.data?.url;
        if (url === 'empty') url = undefined;
        if (url && !url.match(/^[a-zA-Z]:[\\\/]/) && !url.startsWith('/') && !url.includes('fname=') && !url.includes('file=')) {
          url = `${url}${url.includes('?') ? '&' : '?'}file=${encodeURIComponent(filename)}`;
        }
        const target = this.toMarkdownTarget(path) || this.toMarkdownTarget(url);
        const size = s.data?.file_size ?? s.data?.size;
        const sizeText = size !== undefined && size !== null ? ` (${this.formatFileSize(size)})` : '';
        parts.push(target ? `[${filename}](${target})${sizeText}` : `文件:${filename}${sizeText}`);
        continue;
      }

      if (s.type === 'share') {
        const title = s.data?.title || s.data?.url || '分享链接';
        const url = s.data?.url || '';
        const content = s.data?.content;
        const core = url ? `[${title}](${url})` : String(title);
        parts.push(content ? `分享: ${core}（${String(content)}）` : `分享: ${core}`);
        continue;
      }

      if (s.type === 'json' || s.type === 'app') {
        const raw = s.data?.content ?? s.data?.data ?? s.data?.json ?? '';
        const label = s.type === 'json' ? 'JSON卡片' : '应用卡片';

        const asString = (v: any): string => {
          if (typeof v === 'string') return v;
          if (v === undefined || v === null) return '';
          try {
            return JSON.stringify(v);
          } catch {
            try {
              return String(v);
            } catch {
              return '';
            }
          }
        };

        const tryParse = (v: any): any | undefined => {
          if (!v) return undefined;
          if (typeof v === 'object') return v;
          if (typeof v !== 'string') return undefined;
          const t = v.trim();
          if (!t) return undefined;
          if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
          try {
            return JSON.parse(t);
          } catch {
            return undefined;
          }
        };

        const obj = tryParse(raw) ?? tryParse(asString(raw));
        const detail1 =
          obj?.metaData?.detail_1 ||
          obj?.meta_data?.detail_1 ||
          obj?.meta?.detail_1 ||
          obj?.meta?.detail1 ||
          obj?.meta?.news ||
          undefined;

        const title =
          detail1?.title ||
          obj?.prompt ||
          obj?.title ||
          obj?.meta?.title ||
          obj?.appName ||
          '';

        const desc =
          detail1?.desc ||
          obj?.desc ||
          obj?.meta?.desc ||
          '';

        const url =
          detail1?.url ||
          detail1?.jumpUrl ||
          detail1?.qqdocurl ||
          obj?.jumpUrl ||
          obj?.webUrl ||
          obj?.url ||
          obj?.meta?.url ||
          obj?.meta?.news?.jumpUrl ||
          obj?.meta?.news?.url ||
          '';

        const fallbackTitle = title || (typeof raw === 'string' ? raw : asString(raw));
        const core = url ? `[${fallbackTitle || '(无标题)'}](${url})` : (fallbackTitle || '(无标题)');
        parts.push(desc ? `${label}: ${core}（${desc}）` : `${label}: ${core}`);
        continue;
      }

      if (s.type === 'xml') {
        const raw = s.data?.data ?? s.data?.xml ?? '';
        const title = typeof raw === 'string' ? (raw.match(/<title>([^<]{1,100})<\/title>/i)?.[1] || raw) : '';
        parts.push(`XML卡片: ${title || '(无标题)'}`);
        continue;
      }

      if (s.type === 'node') {
        const content = s.data?.content;
        if (Array.isArray(content) && content.length > 0) {
          parts.push(this.renderSegmentsMarkdownInline(content));
        } else {
          parts.push('节点消息');
        }
        continue;
      }

      if (s.type === 'forward') {
        const id = s.data?.id;
        const nodes = s.data?.nodes;
        const content = s.data?.content;

        // NapCat V4: 可能直接带 content（节点列表）而不是 nodes
        const normalizedNodes: any[] | undefined = Array.isArray(nodes)
          ? nodes
          : (Array.isArray(content) ? content : undefined);

        if (Array.isArray(normalizedNodes) && normalizedNodes.length > 0) {
          const total = normalizedNodes.length;
          const preview = normalizedNodes
            .map((n: any, idx: number) => {
              const sender =
                n?.sender_name ||
                n?.nickname ||
                n?.sender?.nickname ||
                (n?.sender_id || n?.user_id || n?.sender?.user_id ? `用户${n?.sender_id || n?.user_id || n?.sender?.user_id}` : '用户');

              // nodes 可能是 get_forward_msg 返回的 node，也可能是 node segment（{type:'node', data:{...}}）
              const segs: any[] =
                (Array.isArray(n?.message) ? n.message : [])
                  .concat(Array.isArray(n?.content) ? n.content : [])
                  .concat(Array.isArray(n?.data?.content) ? n.data.content : [])
                  .concat(Array.isArray(n?.data?.message) ? n.data.message : []);

              const text = String(n?.message_text || this.renderSegmentsMarkdownInline(segs) || '').trim();
              return `[${idx + 1}/${total}] ${sender}: ${text || '[空消息]'}`;
            })
            .join('； ');
          parts.push(`转发${total}条: ${preview}`);
        } else {
          const msgId = s.data?.message_id ?? id;
          parts.push(msgId ? `转发消息(id=${msgId})` : '转发消息');
        }
        continue;
      }

      parts.push(`[${String(s.type)}]`);
    }

    return parts.join('');
  }

  private async enrichSegmentsMedia(
    segs: any[],
    ctx: { messageType?: 'group' | 'private'; groupId?: number; userId?: number },
    depth: number = 0,
  ): Promise<void> {
    if (!Array.isArray(segs) || segs.length === 0) return;

    // 防止“转发里再转发”无限递归
    if (depth > 2) return;

    for (const s of segs) {
      if (!s || !s.type || !s.data) continue;

      if (s.type === 'image') {
        try {
          const fileParam = s.data?.file || s.data?.url;
          let detail: any;
          try {
            detail = this.invoker ? await this.invoker.data('get_image', { file: fileParam }) : undefined;
          } catch {
            detail = undefined;
          }
          const localPath = await ensureLocalFile({
            kind: 'image',
            file: detail?.file || s.data?.file,
            url: s.data?.url || detail?.url,
            filenameHint: detail?.file_name || s.data?.file,
          });
          if (localPath) {
            s.data.path = localPath;
            s.data.cache_path = localPath;
          }
          if (!s.data.url && detail?.url) {
            s.data.url = detail.url;
          }
          if (!s.data.file_size && detail?.file_size) {
            s.data.file_size = detail.file_size;
          }
        } catch {
        }
        continue;
      }

      if (s.type === 'video') {
        try {
          const localPath = await ensureLocalFile({
            kind: 'video',
            file: s.data?.file,
            url: s.data?.url,
            filenameHint: s.data?.file,
          });
          if (localPath) {
            s.data.path = localPath;
          }
        } catch {
        }
        continue;
      }

      if (s.type === 'record') {
        try {
          let detail: any;
          try {
            detail = this.invoker ? await this.invoker.data('get_record', { file: s.data?.file, out_format: 'mp3' }) : undefined;
          } catch {
            detail = undefined;
          }
          const localPath = await ensureLocalFile({
            kind: 'record',
            file: detail?.file || s.data?.path || s.data?.file,
            url: s.data?.url,
            filenameHint: s.data?.file,
          });
          if (localPath) {
            s.data.path = localPath;
          } else if (detail?.file) {
            s.data.path = detail.file;
          }
          if (!s.data.file_size && detail?.file_size) {
            s.data.file_size = detail.file_size;
          }
        } catch {
        }
        continue;
      }

      if (s.type === 'file') {
        try {
          const fileId = s.data?.file_id || s.data?.file_unique || s.data?.id;
          let detail: any;
          try {
            if (this.invoker && fileId) {
              if (ctx.messageType === 'group' && ctx.groupId) {
                detail = await this.invoker.data('get_group_file_url', {
                  group_id: ctx.groupId,
                  file_id: fileId,
                  busid: s.data?.busid || 102,
                });
              } else if (ctx.messageType === 'private' && ctx.userId) {
                detail = await this.invoker.data('get_file', { file_id: fileId });
              }
            }
          } catch {
            detail = undefined;
          }

          let url = detail?.url || detail?.file_url || s.data?.url;
          if (url === 'empty') url = undefined;
          if (url) s.data.url = url;
          if (!s.data.file_size && detail?.file_size) s.data.file_size = detail.file_size;
          if (!s.data.file && detail?.file_name) s.data.file = detail.file_name;

          const p = s.data?.path;
          if (p === 'empty') {
            s.data.path = undefined;
          }

          const localPath = await ensureLocalFile({
            kind: 'file',
            file: detail?.file || s.data?.path || s.data?.file,
            url,
            filenameHint: detail?.file_name || s.data?.file || s.data?.name,
          });
          if (localPath) {
            s.data.path = localPath;
          }
        } catch {
        }
        continue;
      }

      if (s.type === 'node') {
        try {
          const content = s.data?.content;
          if (Array.isArray(content) && content.length > 0) {
            await this.enrichSegmentsMedia(content, ctx, depth + 1);
          }
        } catch {
        }
        continue;
      }

      if (s.type === 'forward') {
        try {
          const messageId = s.data?.message_id ?? s.data?.id;
          if (!messageId || !this.invoker) {
            continue;
          }

          // 如果已经有 nodes（上游已展开），直接递归 enrich 节点内容，不再调用 get_forward_msg
          if (Array.isArray(s.data?.nodes) && s.data.nodes.length > 0) {
            try {
              await Promise.all(
                (s.data.nodes as any[]).map(async (n: any) => {
                  const segs = Array.isArray(n?.message)
                    ? n.message
                    : (Array.isArray(n?.content) ? n.content : (Array.isArray(n?.data?.content) ? n.data.content : []));
                  if (Array.isArray(segs) && segs.length > 0) {
                    await this.enrichSegmentsMedia(segs, ctx, depth + 1);
                  }
                }),
              );
            } catch { }
            continue;
          }

          // NapCat V4: 如果 forward 段本身带了 content（节点列表），直接用 content 构造 nodes
          // 这样无需依赖 get_forward_msg，也能展示具体内容
          if (!Array.isArray(s.data?.nodes) && Array.isArray(s.data?.content) && s.data.content.length > 0) {
            const rawNodes: any[] = s.data.content;
            const nodesOut = await Promise.all(
              rawNodes.map(async (node: any) => {
                // node 可能是 {type:'node', data:{...}} 也可能是直接的 node 对象
                const nData = node?.data ?? node;
                const merged: any[] = [];
                if (Array.isArray(nData?.message)) merged.push(...nData.message);
                if (Array.isArray(nData?.content)) merged.push(...nData.content);
                if (Array.isArray(nData?.data?.content)) merged.push(...nData.data.content);
                if (Array.isArray(nData?.data?.message)) merged.push(...nData.data.message);
                if (merged.length === 0) {
                  if (typeof nData?.content === 'string') merged.push({ type: 'text', data: { text: nData.content } });
                  else if (typeof nData?.message === 'string') merged.push({ type: 'text', data: { text: nData.message } });
                }
                const baseSegs = merged;

                await this.enrichSegmentsMedia(baseSegs, ctx, depth + 1);

                return {
                  sender_id: nData?.sender_id || nData?.user_id || nData?.sender?.user_id,
                  sender_name: nData?.sender_name || nData?.nickname || nData?.sender?.nickname,
                  time: nData?.time,
                  message: baseSegs,
                  message_text: this.renderSegmentsMarkdownInline(baseSegs),
                };
              }),
            );

            s.data.nodes = nodesOut;
            s.data.count = nodesOut.length;

            // 内层转发经常无法再通过 get_forward_msg 获取（issue #1278），既然 content 已给出，就不要再继续调用
            continue;
          }

          log.info({ messageId, depth }, 'get_forward_msg(嵌套) 请求');

          let detail: any;
          try {
            const call = async () => await this.invoker!.data('get_forward_msg', { message_id: messageId, id: messageId });
            detail = this.rpcRetryEnabled
              ? await this.withRpcRetry(call, 'get_forward_msg', messageId as any)
              : await call();
          } catch (e: any) {
            const errMsg = 'get_forward_msg(嵌套) 调用失败';
            try {
              log.warn({ messageId, depth, error: e?.message || String(e) }, errMsg);
            } catch { }
            detail = undefined;
          }

          const data = detail?.data ?? detail;
          const nodes: any[] =
            (detail?.messages as any[]) ||
            (detail?.data as any)?.messages ||
            (data as any)?.message ||
            (data as any)?.messages ||
            (data as any)?.content ||
            (data as any)?.data?.content ||
            (data as any)?.data?.messages ||
            (data as any)?.data?.message ||
            (detail?.data as any[]) ||
            [];
          const nodesLen = Array.isArray(nodes) ? nodes.length : 0;
          if (nodesLen === 0) {
            log.warn({ messageId, depth, detail }, 'get_forward_msg(嵌套) nodes为空');
          } else {
            log.info(
              {
                messageId,
                depth,
                topKeys: detail ? Object.keys(detail) : [],
                dataKeys: detail?.data ? Object.keys(detail.data) : [],
                nodesLen,
              },
              'get_forward_msg(嵌套) 响应',
            );
          }
          if (!Array.isArray(nodes) || nodes.length === 0) {
            continue;
          }

          const nodesOut = await Promise.all(
            nodes.map(async (node: any) => {
              const nData = node?.data ?? node;
              const merged: any[] = [];
              if (Array.isArray(nData?.message)) merged.push(...nData.message);
              if (Array.isArray(nData?.content)) merged.push(...nData.content);
              if (Array.isArray(nData?.data?.content)) merged.push(...nData.data.content);
              if (Array.isArray(nData?.data?.message)) merged.push(...nData.data.message);
              if (merged.length === 0) {
                if (typeof nData?.content === 'string') merged.push({ type: 'text', data: { text: nData.content } });
                else if (typeof nData?.message === 'string') merged.push({ type: 'text', data: { text: nData.message } });
              }
              const baseSegs = merged;

              // 递归 enrich 子节点（包含子转发）
              await this.enrichSegmentsMedia(baseSegs, ctx, depth + 1);

              return {
                sender_id: nData?.sender_id || nData?.user_id || nData?.sender?.user_id,
                sender_name: nData?.sender_name || nData?.nickname || nData?.sender?.nickname,
                time: nData?.time,
                message: baseSegs,
                message_text: this.renderSegmentsMarkdownInline(baseSegs),
              };
            }),
          );

          s.data.nodes = nodesOut;
          s.data.count = nodesOut.length;
        } catch {
        }
        continue;
      }
    }
  }
}
