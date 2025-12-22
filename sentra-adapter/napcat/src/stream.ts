import { WebSocketServer, WebSocket } from 'ws';
import type { MessageEvent, NoticeEvent } from './types/onebot';
import type { SdkInvoke } from './sdk';
import { createLogger } from './logger';

const log = createLogger('info');

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
    const timeStr = new Date(time * 1000).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

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
      } catch {}
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
      } catch {}
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
      } catch {}
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

      const senderObj = senderIsBot ? `你（${senderDisplayFull}）` : senderDisplayFull;
      const targetObj = targetIsBot ? `你（${targetDisplayFull}）` : targetDisplayFull;
      objective = `在群聊「${gName}」中，${senderObj} 戳了 ${targetObj}`;
    } else {
      if (targetIsBot) {
        summary = `好友 ${senderBaseLabel} 戳了你（${targetBaseLabel}）`;
        objective = `好友 ${senderBaseLabel} 戳了你（${targetBaseLabel}）`;
      } else if (senderIsBot) {
        summary = `你（${senderBaseLabel}） 在私聊中戳了 ${targetBaseLabel}`;
        objective = `你（${senderBaseLabel}） 戳了好友 ${targetBaseLabel}`;
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
        } catch {}
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
      } catch {}

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
    const timeStr = new Date(time * 1000).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    // 提取纯文本
    const text = ev.message
      .filter((seg) => seg.type === 'text')
      .map((seg) => String(seg.data?.text ?? ''))
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

    for (const seg of ev.message) {
      if (seg.type === 'image') {
        images.push({ 
          file: seg.data?.file, 
          url: seg.data?.url, 
          path: seg.data?.cache_path || seg.data?.path,
          summary: seg.data?.summary 
        });
      } else if (seg.type === 'video') {
        videos.push({ file: seg.data?.file, url: seg.data?.url, path: seg.data?.path });
      } else if (seg.type === 'file') {
        files.push({ 
          name: seg.data?.file || seg.data?.name, 
          file_id: seg.data?.file_id,
          size: seg.data?.file_size || seg.data?.size,
          url: seg.data?.url,
          path: seg.data?.path,
        });
      } else if (seg.type === 'record') {
        records.push({ 
          file: seg.data?.file, 
          url: seg.data?.url,
          path: seg.data?.path,
          file_size: seg.data?.file_size
        });
      } else if (seg.type === 'forward') {
        forwards.push({ id: seg.data?.id });
      } else if (seg.type === 'face') {
        faces.push({ id: seg.data?.id, text: seg.data?.text });
      } else if (seg.type === 'json') {
        const raw = seg.data?.data ?? seg.data?.content ?? seg.data?.json ?? '';
        let preview = '';
        try {
          const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
          // 尝试提取有意义的字段：prompt/desc/title/view 等
          preview = obj?.prompt || obj?.desc || obj?.meta?.detail_1?.desc || obj?.meta?.news?.desc || obj?.view || obj?.title || '';
          if (!preview && obj?.config?.type) preview = `类型: ${obj.config.type}`;
          if (!preview) preview = typeof raw === 'string' ? raw.slice(0, 100) : JSON.stringify(raw).slice(0, 100);
        } catch {
          preview = typeof raw === 'string' ? raw.slice(0, 100) : '';
        }
        cards.push({ type: 'json', raw, preview });
      } else if (seg.type === 'xml') {
        const raw = seg.data?.data ?? seg.data?.xml ?? '';
        const m = typeof raw === 'string' ? raw.match(/<title>([^<]{1,64})<\/title>/i) : null;
        const preview = m?.[1] || (typeof raw === 'string' ? raw.slice(0, 300) : '');
        cards.push({ type: 'xml', raw, preview });
      } else if (seg.type === 'share') {
        cards.push({ type: 'share', title: seg.data?.title, url: seg.data?.url, content: seg.data?.content, image: seg.data?.image, preview: seg.data?.title || seg.data?.url });
      } else if (seg.type === 'app') {
        const raw = seg.data?.content ?? seg.data?.data ?? '';
        let title: string | undefined; let url: string | undefined; let image: string | undefined; let content: string | undefined;
        try {
          const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
          title = obj?.meta?.news?.title || obj?.meta?.detail_1?.title || obj?.prompt || obj?.meta?.title || obj?.title;
          content = obj?.meta?.news?.desc || obj?.meta?.detail_1?.desc || obj?.desc || obj?.meta?.desc;
          url = obj?.meta?.news?.jumpUrl || obj?.meta?.detail_1?.qqdocurl || obj?.meta?.news?.url || obj?.url;
          image = obj?.meta?.news?.preview || obj?.meta?.detail_1?.preview || obj?.meta?.preview || obj?.cover;
        } catch {}
        const preview = title || (typeof raw === 'string' ? raw.slice(0, 300) : '');
        cards.push({ type: 'app', title, url, image, content, raw, preview });
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
      sender_id: ev.user_id ?? 0,
      sender_name: ev.sender?.nickname || String(ev.user_id ?? 0),
      text,
      segments: ev.message.map((seg) => ({ type: seg.type, data: seg.data })),
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
              const call = async () => await this.invoker!.data('get_forward_msg', { id: fwd.id });
              const detail: any = this.rpcRetryEnabled
                ? await this.withRpcRetry(call, 'get_forward_msg', fwd.id as any)
                : await call();
              const nodes: any[] = (detail?.messages as any[]) || (detail?.data as any)?.messages || [];
              fwd.count = nodes.length;
              fwd.nodes = nodes.slice(0, 10).map((node: any) => ({
                sender_id: node.sender?.user_id || node.user_id,
                sender_name: node.sender?.nickname || node.nickname,
                time: node.time,
                message: Array.isArray(node.message) ? node.message : (Array.isArray(node.content) ? node.content : undefined),
                message_text: Array.isArray(node.message || node.content)
                  ? (node.message || node.content).filter((s: any) => s.type === 'text').map((s: any) => s.data?.text || '').join('')
                  : '',
              }));
              // 生成预览
              fwd.preview = nodes.slice(0, 3).map((node: any) => {
                const name = node.sender?.nickname || node.nickname || `用户${node.sender?.user_id || node.user_id || ''}`;
                const baseSegs: any[] = Array.isArray(node.message) ? node.message : (Array.isArray(node.content) ? node.content : []);
                const msgText = Array.isArray(baseSegs)
                  ? baseSegs.filter((s: any) => s.type === 'text').map((s: any) => s.data?.text || '').join('').slice(0, 30)
                  : '';
                return `${name}: ${msgText || '[多媒体消息]'}`;
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

    // 获取转发消息详情
    if (forwards.length > 0 && this.invoker) {
      try {
        const tasks = forwards.map(async (fwd) => {
          try {
            const call = async () => await this.invoker!.data('get_forward_msg', { id: fwd.id });
            const detail: any = this.rpcRetryEnabled
              ? await this.withRpcRetry(call, 'get_forward_msg', fwd.id as any)
              : await call();
            const nodes: any[] = (detail?.messages as any[]) || (detail?.data as any)?.messages || [];
            fwd.count = nodes.length;
            fwd.nodes = nodes.slice(0, 10).map((node: any) => ({
              sender_id: node.sender?.user_id || node.user_id,
              sender_name: node.sender?.nickname || node.nickname,
              time: node.time,
              message: Array.isArray(node.message) ? node.message : (Array.isArray(node.content) ? node.content : undefined),
              message_text: Array.isArray(node.message || node.content)
                ? (node.message || node.content).filter((s: any) => s.type === 'text').map((s: any) => s.data?.text || '').join('')
                : '',
            }));
            // 生成预览
            fwd.preview = nodes.slice(0, 3).map((node: any) => {
              const name = node.sender?.nickname || node.nickname || `用户${node.sender?.user_id || node.user_id || ''}`;
              const baseSegs: any[] = Array.isArray(node.message) ? node.message : (Array.isArray(node.content) ? node.content : []);
              const msgText = Array.isArray(baseSegs)
                ? baseSegs.filter((s: any) => s.type === 'text').map((s: any) => s.data?.text || '').join('').slice(0, 30)
                : '';
              return `${name}: ${msgText || '[多媒体消息]'}`;
            });
          } catch (err) {
            log.error({ err, fwdId: fwd.id }, '获取转发消息详情失败');
          }
        });
        await Promise.all(tasks);
      } catch (err) {
        log.error({ err }, '批量获取转发消息失败');
      }
    }

    // 是否包含原始事件
    if (this.includeRaw) {
      formatted.raw = ev;
    }

    // 生成消息摘要（Markdown格式）
    formatted.summary = await this.generateSummary(formatted);
    // 生成事件的自然语言描述（Markdown，自然语言 + 多媒体md）
    formatted.objective = this.generateObjective(formatted);

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
  private generateObjective(msg: FormattedMessage): string {
    const isGroup = msg.type === 'group';
    const senderName = msg.sender_name || `QQ:${msg.sender_id}`;
    const groupName = msg.group_name || (msg.group_id ? `群${msg.group_id}` : '未知群');
    let desc = isGroup ? `在群聊「${groupName}」中，${senderName}` : `在私聊中，${senderName}`;

    // @ 提及
    if (msg.at_all) {
      desc += ' 艾特了全体成员';
    } else if (msg.at_users && msg.at_users.length > 0) {
      const idsPreview = msg.at_users.slice(0, 3).map((u) => String(u)).join('、');
      const more = msg.at_users.length > 3 ? ` 等${msg.at_users.length}人` : '';
      desc += ` 艾特了${msg.at_users.length}人(${idsPreview}${more})`;
    }

    const text = (msg.text || '').trim();
    let hasSaid = false;
    if (text) {
      // 如果前面已经有艾特动作，加上“然后说”
      if (msg.at_all || (msg.at_users && msg.at_users.length > 0)) {
        desc += `，然后说: ${text}`;
      } else {
        desc += ` 说: ${text}`;
      }
      hasSaid = true;
    }

    const actions: string[] = [];

    // 图片（使用完整 Markdown 链接，优先本地路径）
    if (msg.images && msg.images.length > 0) {
      const items: string[] = [];
      msg.images.forEach((img, idx) => {
        let label: string | undefined = (img as any).summary && String((img as any).summary).trim();
        if (label && label.startsWith('[') && label.endsWith(']')) {
          label = label.slice(1, -1);
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
        .slice(0, 5)
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
          part += `，简介: ${String(desc).slice(0, 100)}${
            String(desc).length > 100 ? '...' : ''
          }`;
        }
        items.push(part);
      });

      const countText = msg.cards.length === 1 ? '一条卡片消息' : `${msg.cards.length}条卡片消息`;
      actions.push(`分享了${countText}: ${items.join('；')}`);
    }

    // 转发消息（概括节点数量与预览）
    if (msg.forwards && msg.forwards.length > 0) {
      const items: string[] = [];
      msg.forwards.forEach((fwd, idx) => {
        const count =
          (fwd as any).count ?? ((fwd as any).nodes?.length ?? 0);
        const previews = Array.isArray((fwd as any).preview)
          ? (fwd as any).preview!.slice(0, 3).join(' / ')
          : '';
        let line = `第${idx + 1}个转发，共${count}条消息`;
        if (previews) line += `，预览: ${previews}`;
        items.push(line);
      });
      const countText = msg.forwards.length === 1 ? '一组转发消息' : `${msg.forwards.length}组转发消息`;
      actions.push(`转发了${countText}: ${items.join('；')}`);
    }

    // 引用消息（拟人化 + 多媒体 Markdown）
    if (msg.reply) {
      const r = msg.reply;
      const rSenderName =
        r.sender_name ||
        (r.sender_id ? `QQ:${r.sender_id}` : `消息${r.id}`);
      const replyParts: string[] = [];

      replyParts.push(`引用了 ${rSenderName} 的一条消息`);

      if (r.text && r.media.cards.length === 0) {
        replyParts.push(`该消息说: ${r.text}`);
      }

      // 引用中的图片
      if (r.media.images && r.media.images.length > 0) {
        const items: string[] = [];
        r.media.images.forEach((img, idx) => {
          let label: string | undefined =
            (img as any).summary && String((img as any).summary).trim();
          if (label && label.startsWith('[') && label.endsWith(']')) {
            label = label.slice(1, -1);
          }
          const filename =
            label || img.filename || img.file?.split(/[\\/]/).pop() || `图片${idx + 1}`;
          const localPath = (img as any).path as string | undefined;
          let target = localPath;
          if (!target && img.url) {
            let url = img.url;
            if (!url.match(/^[a-zA-Z]:[\\\/]/) && !url.startsWith('/')) {
              url = `${url}${url.includes('?') ? '&' : '?'}file=${encodeURIComponent(
                filename,
              )}`;
            }
            target = url;
          }
          const safeTarget = target || img.url || img.file || '';
          items.push(`![${filename}](${safeTarget})`);
        });
        replyParts.push(
          `其中包含图片: ${items.join('、 ')}`,
        );
      }

      // 引用中的语音
      if (r.media.records && r.media.records.length > 0) {
        const items: string[] = [];
        r.media.records.forEach((rec, idx) => {
          const filename = rec.file || `语音${idx + 1}`;
          let target = (rec as any).path as string | undefined;
          const url = (rec as any).url as string | undefined;
          if (!target && url) {
            let u = url;
            if (!u.match(/^[a-zA-Z]:[\\\/]/) && !u.startsWith('/')) {
              u = `${u}${u.includes('?') ? '&' : '?'}file=${encodeURIComponent(filename)}`;
            }
            target = u;
          }
          const safeTarget = target || url || rec.file || '';
          items.push(`[语音: ${filename}](${safeTarget})`);
        });
        replyParts.push(
          `其中包含语音: ${items.join('、 ')}`,
        );
      }

      // 引用中的文件
      if (r.media.files && r.media.files.length > 0) {
        const items: string[] = [];
        r.media.files.forEach((file, idx) => {
          const filename = file.name || `文件${idx + 1}`;
          let link = file.url || '';
          if (link && !link.match(/^[a-zA-Z]:[\\\/]/) && !link.startsWith('/')) {
            if (link.includes('fname=')) {
              link = link.replace(
                /fname=([^&]*)/,
                `fname=${encodeURIComponent(filename)}`,
              );
            } else {
              link = `${link}${link.includes('?') ? '&' : '?'}file=${encodeURIComponent(
                filename,
              )}`;
            }
          }
          const safeTarget = link || file.path || '';
          const sizeText =
            file.size !== undefined
              ? ` (${this.formatFileSize(file.size)})`
              : '';
          items.push(`[${filename}](${safeTarget})${sizeText}`);
        });
        replyParts.push(
          `其中包含文件: ${items.join('、 ')}`,
        );
      }

      // 引用中的视频
      if (r.media.videos && r.media.videos.length > 0) {
        const items: string[] = [];
        r.media.videos.forEach((vid, idx) => {
          const filename = vid.file || `视频${idx + 1}`;
          let link = vid.url || '';
          if (link && !link.match(/^[a-zA-Z]:[\\\/]/) && !link.startsWith('/')) {
            link = `${link}${link.includes('?') ? '&' : '?'}file=${encodeURIComponent(
              filename,
            )}`;
          }
          const safeTarget = link || vid.path || '';
          items.push(`[视频: ${filename}](${safeTarget})`);
        });
        replyParts.push(
          `其中包含视频: ${items.join('、 ')}`,
        );
      }

      // 引用中的表情
      if (r.media.faces && r.media.faces.length > 0) {
        const labels = r.media.faces
          .slice(0, 5)
          .map((f) => f.text || `表情${f.id ?? ''}`);
        replyParts.push(`其中包含表情: ${labels.join('、')}`);
      }

      // 引用中的卡片
      if (r.media.cards && r.media.cards.length > 0) {
        const items: string[] = [];
        r.media.cards.forEach((card) => {
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
            part += `，简介: ${String(desc).slice(0, 100)}${
              String(desc).length > 100 ? '...' : ''
            }`;
          }
          items.push(part);
        });
        replyParts.push(`其中包含卡片消息: ${items.join('；')}`);
      }

      // 引用中的转发
      if (r.media.forwards && r.media.forwards.length > 0) {
        const items: string[] = [];
        r.media.forwards.forEach((fwd, idx) => {
          const count =
            (fwd as any).count ?? ((fwd as any).nodes?.length ?? 0);
          const previews = Array.isArray((fwd as any).preview)
            ? (fwd as any).preview!.slice(0, 3).join(' / ')
            : '';
          let line = `第${idx + 1}个转发，共${count}条消息`;
          if (previews) line += `，预览: ${previews}`;
          items.push(line);
        });
        replyParts.push(`其中包含转发消息: ${items.join('；')}`);
      }

      if (replyParts.length > 0) {
        actions.push(replyParts.join('，'));
      }
    }

    if (actions.length > 0) {
      desc += hasSaid ? '，并且' : '，';
      desc += actions.join('；');
    }

    return desc;
  }

  /**
   * 生成消息摘要（Markdown格式）
   * 包含时间、消息ID、会话ID、发送者、内容、多媒体等信息
   * 格式类似通讯平台，便于人类理解和机器学习
   */
  private async generateSummary(msg: FormattedMessage): Promise<string> {
    const lines: string[] = [];

    // 1. 消息头部：时间 | 消息ID | 会话ID | 类型 | 发送者信息
    // 高优先级展示 message_id 与 会话ID，便于外部检索、去重与精准定位
    // 会话ID规则：群聊 = G:<group_id>，私聊 = U:<sender_id>
    const typeText = msg.type === 'group' ? '群聊' : '私聊';
    const convText = msg.type === 'group'
      ? `会话: G:${msg.group_id || '未知'}`
      : `会话: U:${msg.sender_id}`;
    let headerParts = [`消息ID: ${msg.message_id}`, convText, typeText];
    
    // 群组信息
    if (msg.type === 'group') {
      if (msg.group_name) {
        headerParts.push(`群名: ${msg.group_name}`);
      }
      headerParts.push(`群号: ${msg.group_id || '未知'}`);
    }
    
    // 发送者信息
    let senderInfo = `${msg.sender_name}`;
    if (msg.sender_card) {
      senderInfo += `(${msg.sender_card})`;
    }
    if (msg.sender_role === 'owner') {
      senderInfo += '[群主]';
    } else if (msg.sender_role === 'admin') {
      senderInfo += '[管理员]';
    }
    senderInfo += `(QQ:${msg.sender_id})`;
    headerParts.push(`发送者: ${senderInfo}`);
    
    lines.push(headerParts.join(' | '));

    const replyLines: string[] = [];
    let consumedTextInMention = false;

    if (msg.type === 'group') {
      if (msg.at_all) {
        lines.push('');
        lines.push('在群内艾特了全体成员');
      } else if (msg.at_users.length > 0) {
        const selfId = msg.self_id;
        const selfAt = typeof selfId === 'number' && msg.at_users.includes(selfId);
        const otherIds = msg.at_users.filter((u) => u !== selfId);
        let selfDisplay = '';
        let otherDetails: string[] = [];
        if (this.invoker) {
          try {
            if (selfAt && msg.group_id && typeof selfId === 'number') {
              try {
                const call = async () => await this.invoker!.data('get_group_member_info', { group_id: msg.group_id!, user_id: selfId! });
                const info: any = this.rpcRetryEnabled
                  ? await this.withRpcRetry(call, 'get_group_member_info', selfId)
                  : await call();
                const nick = info?.nickname;
                const card = info?.card;
                const role = info?.role;
                let name = nick || String(selfId);
                if (card && card !== nick) name += `(${card})`;
                if (role === 'owner') name += '[群主]'; else if (role === 'admin') name += '[管理员]';
                selfDisplay = `${name}(QQ:${selfId})`;
              } catch {}
            }
            if (otherIds.length > 0 && msg.group_id) {
              const tasks = otherIds.map(async (uid) => {
                try {
                  const call = async () => await this.invoker!.data('get_group_member_info', { group_id: msg.group_id!, user_id: uid });
                  const info: any = this.rpcRetryEnabled
                    ? await this.withRpcRetry(call, 'get_group_member_info', uid)
                    : await call();
                  const nick = info?.nickname;
                  const card = info?.card;
                  const role = info?.role;
                  let name = nick || String(uid);
                  if (card && card !== nick) name += `(${card})`;
                  if (role === 'owner') name += '[群主]'; else if (role === 'admin') name += '[管理员]';
                  return `${name}(QQ:${uid})`;
                } catch {
                  return String(uid);
                }
              });
              otherDetails = await Promise.all(tasks);
            }
          } catch {}
        }
        if (selfAt) {
          const selfText = selfDisplay || (typeof selfId === 'number' ? `QQ:${selfId}` : '你');
          let line = `在群内艾特了你（${selfText}）`;
          if (msg.text) {
            line += `，说: ${msg.text}`;
            consumedTextInMention = true;
          }
          if (otherIds.length > 0) {
            const out = otherDetails.length > 0 ? otherDetails.join('、') : otherIds.map((u) => String(u)).join('、');
            line += `，然后又艾特了: ${out}`;
          }
          lines.push('');
          lines.push(line);
        } else {
          const allIds = msg.at_users;
          let atDetails: string[] = [];
          if (this.invoker) {
            try {
              const tasks = allIds.map(async (uid) => {
                try {
                  const call = async () => await this.invoker!.data('get_group_member_info', { group_id: msg.group_id!, user_id: uid });
                  const info: any = this.rpcRetryEnabled
                    ? await this.withRpcRetry(call, 'get_group_member_info', uid)
                    : await call();
                  const nick = info?.nickname;
                  const card = info?.card;
                  const role = info?.role;
                  let name = nick || String(uid);
                  if (card && card !== nick) name += `(${card})`;
                  if (role === 'owner') name += '[群主]'; else if (role === 'admin') name += '[管理员]';
                  return `${name}(QQ:${uid})`;
                } catch {
                  return String(uid);
                }
              });
              atDetails = await Promise.all(tasks);
            } catch {}
          }
          const out = atDetails.length > 0 ? atDetails.join('、') : allIds.map((u) => String(u)).join('、');
          lines.push('');
          lines.push('在群内艾特了: ' + out);
        }
      }
    }

    // 2. 引用消息（如果有）
    if (msg.reply) {
      let rConv = '';
      let rSenderInfo = '';
      let rSenderId = msg.reply.sender_id;
      const replyId = msg.reply.id;
      try {
        if (this.invoker) {
          const call = async () => await this.invoker!.data('get_msg', { message_id: replyId });
          const detail: any = this.rpcRetryEnabled
            ? await this.withRpcRetry(call, 'get_msg', replyId)
            : await call();
          const rtype = detail?.message_type || detail?.data?.message_type;
          const rgid = detail?.group_id || detail?.data?.group_id;
          const ruid = detail?.user_id || detail?.data?.user_id;
          if (!rSenderId) rSenderId = ruid;
          rConv = rtype === 'group' ? `会话: G:${rgid || '未知'}` : `会话: U:${ruid || rSenderId || '未知'}`;
          const rnick = detail?.sender?.nickname || detail?.data?.sender?.nickname;
          const rcard = detail?.sender?.card || detail?.data?.sender?.card;
          const rrole = detail?.sender?.role || detail?.data?.sender?.role;
          let s = rnick || String(rSenderId || '');
          if (rcard) s += `(${rcard})`;
          if (rrole === 'owner') s += '[群主]'; else if (rrole === 'admin') s += '[管理员]';
          if (rSenderId) s += `(QQ:${rSenderId})`;
          rSenderInfo = s;
        }
      } catch {}
      if (!rSenderInfo) {
        let s2 = msg.reply.sender_name || `用户${rSenderId || msg.reply.id}`;
        if (rSenderId) s2 += `(QQ:${rSenderId})`;
        rSenderInfo = s2;
      }
      const rHeaderParts: string[] = [];
      rHeaderParts.push(`引用 消息ID: ${msg.reply.id}`);
      if (rConv) rHeaderParts.push(rConv);
      rHeaderParts.push(`发送者: ${rSenderInfo}`);
      replyLines.push('');
      replyLines.push(rHeaderParts.join(' | '));
      // Only show 'said:' if there are no cards (cards will show the content)
      if (msg.reply.text && msg.reply.media.cards.length === 0) {
        replyLines.push(`${rSenderInfo} 说: ${msg.reply.text}`);
      }

      if (msg.reply.media.images.length > 0) {
        replyLines.push(msg.reply.media.images.length === 1 ? `${rSenderInfo} 发送了一张图片:` : `${rSenderInfo} 发送了${msg.reply.media.images.length}张图片:`);
        msg.reply.media.images.forEach((img, i) => {
          const imgPath = img.file || img.url || '未知';
          let label: string | undefined =
            (img as any).summary && String((img as any).summary).trim();
          if (label && label.startsWith('[') && label.endsWith(']')) {
            label = label.slice(1, -1);
          }
          const filename = label || img.filename || img.file?.split(/[\\\/]/).pop() || `图片${i + 1}`;
          replyLines.push(`![${filename}](${imgPath})`);
        });
      }

      if (msg.reply.media.records.length > 0) {
        replyLines.push(msg.reply.media.records.length === 1 ? `${rSenderInfo} 发送了一条语音消息:` : `${rSenderInfo} 发送了${msg.reply.media.records.length}条语音消息:`);
        msg.reply.media.records.forEach((rec, i) => {
          const recPath = rec.file || '未知';
          const filename = rec.file || `语音${i + 1}`;
          replyLines.push(`[语音: ${filename}](${recPath})`);
        });
      }

      if (msg.reply.media.files.length > 0) {
        replyLines.push(msg.reply.media.files.length === 1 ? `${rSenderInfo} 发送了一个文件:` : `${rSenderInfo} 发送了${msg.reply.media.files.length}个文件:`);
        msg.reply.media.files.forEach((file, i) => {
          const sizeText = file.size ? ` (${this.formatFileSize(file.size)})` : '';
          const filename = file.name || '文件';
          // 如果URL不是本地绝对路径，需要拼接文件名
          let fullUrl = file.url || '';
          if (fullUrl && !fullUrl.match(/^[a-zA-Z]:[\\\/]/) && !fullUrl.startsWith('/')) {
            // 文件URL特殊处理：如果有fname=参数，直接赋值；否则添加&file=参数
            if (fullUrl.includes('fname=')) {
              fullUrl = fullUrl.replace(/fname=([^&]*)/, `fname=${encodeURIComponent(filename)}`);
            } else {
              fullUrl = `${fullUrl}${fullUrl.includes('?') ? '&' : '?'}file=${encodeURIComponent(filename)}`;
            }
          }
          replyLines.push(`[${filename}](${fullUrl})${sizeText}`);
        });
      }

      if (msg.reply.media.videos.length > 0) {
        replyLines.push(msg.reply.media.videos.length === 1 ? `${rSenderInfo} 发送了一个视频:` : `${rSenderInfo} 发送了${msg.reply.media.videos.length}个视频:`);
        msg.reply.media.videos.forEach((vid, i) => {
          const filename = vid.file || `视频${i + 1}`;
          // 如果URL不是本地绝对路径，需要拼接文件名
          let fullUrl = vid.url || '';
          if (fullUrl && !fullUrl.match(/^[a-zA-Z]:[\\\/]/) && !fullUrl.startsWith('/')) {
            fullUrl = `${fullUrl}${fullUrl.includes('?') ? '&' : '?'}file=${encodeURIComponent(filename)}`;
          }
          replyLines.push(`[视频: ${filename}](${fullUrl})`);
        });
      }

      if (msg.reply.media.forwards.length > 0) {
        msg.reply.media.forwards.forEach((fwd, i) => {
          replyLines.push(`${rSenderInfo} 转发了${fwd.count || 0}条消息${msg.reply!.media.forwards.length > 1 ? ` #${i + 1}` : ''}:`);
          if (fwd.nodes && fwd.nodes.length > 0) {
            replyLines.push('—— 转发消息详情 ——');
            fwd.nodes.forEach((node, idx) => {
              const nodeTime = node.time ? new Date(node.time * 1000).toLocaleString('zh-CN', {
                month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
              }) : '';
              const nodeSender = node.sender_name || `用户${node.sender_id || ''}`;
              replyLines.push(`[${idx + 1}/${fwd.nodes!.length}] ${nodeSender}${nodeTime ? ` (${nodeTime})` : ''}`);
              if (node.message_text) {
                replyLines.push(`  ${node.message_text}`);
              }
              // 检查是否有其他媒体
              if (Array.isArray(node.message)) {
                const segs: any[] = node.message;
                const nodeImages = segs.filter((s: any) => s && s.type === 'image');
                if (nodeImages.length > 0) {
                  replyLines.push(`  发送了${nodeImages.length === 1 ? '一' : String(nodeImages.length)}张图片:`);
                  nodeImages.forEach((s: any, i2: number) => {
                    let label: string | undefined =
                      s.data?.summary && String(s.data.summary).trim();
                    if (label && label.startsWith('[') && label.endsWith(']')) {
                      label = label.slice(1, -1);
                    }
                    const fname = label || s.data?.file || `图片${i2 + 1}`;
                    const local = s.data?.path || s.data?.cache_path;
                    const url = s.data?.url;
                    const target = local || (url ? `${url}${String(url).includes('?') ? '&' : '?'}file=${encodeURIComponent(fname)}` : '');
                    replyLines.push(`  ![${fname}](${target})`);
                  });
                }
                const nodeVideos = segs.filter((s: any) => s && s.type === 'video');
                if (nodeVideos.length > 0) {
                  replyLines.push(`  发送了${nodeVideos.length === 1 ? '一个' : nodeVideos.length + '个'}视频:`);
                  nodeVideos.forEach((s: any, i2: number) => {
                    const fname = s.data?.file || `视频${i2 + 1}`;
                    const url = s.data?.url ? `${s.data.url}${String(s.data.url).includes('?') ? '&' : '?'}file=${encodeURIComponent(fname)}` : '';
                    replyLines.push(`  [视频: ${fname}](${url})`);
                  });
                }
                const nodeRecords = segs.filter((s: any) => s && s.type === 'record');
                if (nodeRecords.length > 0) {
                  replyLines.push(`  发送了${nodeRecords.length === 1 ? '一条' : nodeRecords.length + '条'}语音消息:`);
                  nodeRecords.forEach((s: any, i2: number) => {
                    const fname = s.data?.file || `语音${i2 + 1}`;
                    const url = s.data?.path || (s.data?.url ? `${s.data.url}${String(s.data.url).includes('?') ? '&' : '?'}file=${encodeURIComponent(fname)}` : '');
                    replyLines.push(`  [语音: ${fname}](${url})`);
                  });
                }
                const nodeFiles = segs.filter((s: any) => s && s.type === 'file');
                if (nodeFiles.length > 0) {
                  replyLines.push(`  发送了${nodeFiles.length === 1 ? '一个' : nodeFiles.length + '个'}文件:`);
                  nodeFiles.forEach((s: any, i2: number) => {
                    const fname = s.data?.file || s.data?.name || `文件${i2 + 1}`;
                    let link = s.data?.url || '';
                    if (link && !String(link).match(/^[a-zA-Z]:[\\\/]/) && !String(link).startsWith('/')) {
                      link = link.includes('fname=') ? link.replace(/fname=([^&]*)/, `fname=${encodeURIComponent(fname)}`) : `${link}${link.includes('?') ? '&' : '?'}file=${encodeURIComponent(fname)}`;
                    }
                    replyLines.push(`  [${fname}](${link})`);
                  });
                }
                const nodeCards = segs.filter((s: any) => s && (s.type === 'share' || s.type === 'json' || s.type === 'xml' || s.type === 'app'));
                if (nodeCards.length > 0) {
                  nodeCards.forEach((s: any) => {
                    if (s.type === 'share') {
                      const title = s.data?.title || s.data?.url || '分享链接';
                      const url = s.data?.url || '';
                      const content = s.data?.content || '';
                      replyLines.push(`  分享: ${title}`);
                      if (content) replyLines.push(`    简介: ${content}`);
                      if (url) replyLines.push(`    链接: ${url}`);
                    } else if (s.type === 'json' || s.type === 'app') {
                      const raw = s.data?.content ?? s.data?.data ?? s.data?.json ?? '';
                      let title = '';
                      let desc = '';
                      let url = '';
                      try {
                        const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
                        title = obj?.prompt || obj?.meta?.news?.title || obj?.meta?.detail_1?.title || obj?.meta?.title || obj?.title || '';
                        desc = obj?.meta?.news?.desc || obj?.meta?.detail_1?.desc || obj?.desc || obj?.meta?.desc || '';
                        url = obj?.meta?.news?.jumpUrl || obj?.meta?.detail_1?.qqdocurl || obj?.meta?.news?.url || obj?.url || '';
                      } catch {}
                      const label = s.type === 'json' ? 'JSON卡片' : '应用卡片';
                      replyLines.push(`  分享${label}: ${title || '(无标题)'}`);
                      if (desc) replyLines.push(`    简介: ${String(desc).slice(0, 100)}${String(desc).length > 100 ? '...' : ''}`);
                      if (url) replyLines.push(`    链接: ${url}`);
                    } else if (s.type === 'xml') {
                      const raw = s.data?.data ?? s.data?.xml ?? '';
                      const preview = typeof raw === 'string' ? (raw.match(/<title>([^<]{1,100})<\/title>/i)?.[1] || raw.slice(0, 100)) : '';
                      replyLines.push(`  发送了XML卡片: ${preview}`);
                    }
                  });
                }
              }
            });
            replyLines.push('—— 转发消息结束 ——');
          } else if (fwd.preview && fwd.preview.length > 0) {
            replyLines.push('预览:');
            fwd.preview.forEach((p) => replyLines.push(`  ${p}`));
          }
        });
      }

      if (msg.reply.media.faces.length > 0) {
        const faceTexts = msg.reply.media.faces.map((f) => f.text || `[表情${f.id}]`).join('、');
        replyLines.push(`${rSenderInfo} 发送了表情: ${faceTexts}`);
      }

      if (msg.reply.media.cards.length > 0) {
        msg.reply.media.cards.forEach((card) => {
          if (card.type === 'share' && (card.title || card.url)) {
            const title = card.title || '分享链接';
            const url = card.url || '';
            replyLines.push(`${rSenderInfo} 分享: ${title}`);
            if (card.content) replyLines.push(`  简介: ${card.content}`);
            if (url) replyLines.push(`  链接: ${url}`);
          } else if (card.type === 'json' || card.type === 'app') {
            // Parse raw JSON to extract full details
            let title = card.title || '';
            let desc = '';
            let url = '';
            if (card.raw) {
              try {
                const obj = typeof card.raw === 'string' ? JSON.parse(card.raw) : card.raw;
                if (!title) title = obj?.prompt || obj?.meta?.news?.title || obj?.meta?.detail_1?.title || obj?.meta?.title || obj?.title || '';
                desc = obj?.meta?.news?.desc || obj?.meta?.detail_1?.desc || obj?.desc || obj?.meta?.desc || '';
                url = obj?.meta?.news?.jumpUrl || obj?.meta?.detail_1?.qqdocurl || obj?.meta?.news?.url || obj?.url || '';
              } catch {}
            }
            const cardTypeLabel = card.type === 'json' ? 'JSON卡片' : '应用卡片';
            replyLines.push(`${rSenderInfo} 分享${cardTypeLabel}: ${title || '(无标题)'}`);
            if (desc) replyLines.push(`  简介: ${desc.slice(0, 100)}${desc.length > 100 ? '...' : ''}`);
            if (url) replyLines.push(`  链接: ${url}`);
          } else if (card.type === 'xml') {
            const preview = (card.preview || '').toString().slice(0, 100);
            replyLines.push(`${rSenderInfo} 发送了XML卡片: ${preview}`);
          } else {
            const preview = (card.preview || '').toString().slice(0, 100);
            replyLines.push(`${rSenderInfo} 发送了卡片: ${preview}`);
          }
        });
      }
    }

    // 3. 消息内容
    const bodyText = consumedTextInMention ? '' : msg.text;
    const hasBody = Boolean(bodyText) || msg.images.length > 0 || msg.videos.length > 0 || msg.records.length > 0 || msg.files.length > 0 || msg.cards.length > 0;
    if (hasBody) {
      lines.push('');
    }
    
    // 文本内容 - 添加“说:”前缀
    if (bodyText) {
      lines.push(`说: ${bodyText}`);
    }

    // 4. 多媒体内容 - 添加描述性前缀
    // 图片（优先使用本地缓存路径）
    if (msg.images.length > 0) {
      if (msg.images.length === 1) {
        lines.push(`发送了一张图片:`);
      } else {
        lines.push(`发送了${msg.images.length}张图片:`);
      }
      msg.images.forEach((img, i) => {
        let label: string | undefined =
          (img as any).summary && String((img as any).summary).trim();
        if (label && label.startsWith('[') && label.endsWith(']')) {
          label = label.slice(1, -1);
        }
        const filename = label || img.file || `图片${i + 1}`;
        const localPath = (img as any).path; // 本地缓存绝对路径（由 main.ts 填充）
        const fullUrl = !localPath && img.url ? `${img.url}${img.url.includes('?') ? '&' : '?'}file=${encodeURIComponent(filename)}` : '';
        const target = localPath || fullUrl || '';
        lines.push(`![${filename}](${target})`);
      });
    }

    // 视频
    if (msg.videos.length > 0) {
      if (msg.videos.length === 1) {
        lines.push(`发送了一个视频:`);
      } else {
        lines.push(`发送了${msg.videos.length}个视频:`);
      }
      msg.videos.forEach((vid, i) => {
        const filename = vid.file || `视频${i + 1}`;
        const fullUrl = vid.url ? `${vid.url}${vid.url.includes('?') ? '&' : '?'}file=${encodeURIComponent(filename)}` : '';
        lines.push(`[视频: ${filename}](${fullUrl})`);
      });
    }

    // 语音
    if (msg.records.length > 0) {
      if (msg.records.length === 1) {
        lines.push(`发送了一条语音消息:`);
      } else {
        lines.push(`发送了${msg.records.length}条语音消息:`);
      }
      msg.records.forEach((rec, i) => {
        const filename = rec.file || `语音${i + 1}`;
        let audioUrl = '';
        if (rec.path) {
          audioUrl = rec.path;
        } else if (rec.url) {
          audioUrl = `${rec.url}${rec.url.includes('?') ? '&' : '?'}file=${encodeURIComponent(filename)}`;
        }
        const sizeText = rec.file_size ? ` (${this.formatFileSize(rec.file_size)})` : '';
        lines.push(`[语音: ${filename}](${audioUrl})${sizeText}`);
      });
    }

    // 文件
    if (msg.files.length > 0) {
      if (msg.files.length === 1) {
        lines.push(`发送了一个文件:`);
      } else {
        lines.push(`发送了${msg.files.length}个文件:`);
      }
      msg.files.forEach((file, i) => {
        const filename = file.name || `文件${i + 1}`;
        const sizeText = file.size ? ` (${this.formatFileSize(file.size)})` : '';
        // 如果URL已有fname=参数，替换它；否则添加&file=参数
        let fullUrl = file.url || '';
        if (fullUrl && !fullUrl.match(/^[a-zA-Z]:[\\\/]/) && !fullUrl.startsWith('/')) {
          if (fullUrl.includes('fname=')) {
            fullUrl = fullUrl.replace(/fname=([^&]*)/, `fname=${encodeURIComponent(filename)}`);
          } else {
            fullUrl = `${fullUrl}${fullUrl.includes('?') ? '&' : '?'}file=${encodeURIComponent(filename)}`;
          }
        }
        lines.push(`[${filename}](${fullUrl})${sizeText}`);
      });
    }

    if (msg.cards.length > 0) {
      msg.cards.forEach((card) => {
        lines.push('');
        if (card.type === 'share' && (card.title || card.url)) {
          const title = card.title || '分享链接';
          const url = card.url || '';
          lines.push(`分享: ${title}`);
          if (card.content) lines.push(`  简介: ${card.content}`);
          if (url) lines.push(`  链接: ${url}`);
        } else if (card.type === 'json' || card.type === 'app') {
          // Parse raw JSON to extract full details
          let title = card.title || '';
          let desc = '';
          let url = '';
          if (card.raw) {
            try {
              const obj = typeof card.raw === 'string' ? JSON.parse(card.raw) : card.raw;
              if (!title) title = obj?.prompt || obj?.meta?.news?.title || obj?.meta?.detail_1?.title || obj?.meta?.title || obj?.title || '';
              desc = obj?.meta?.news?.desc || obj?.meta?.detail_1?.desc || obj?.desc || obj?.meta?.desc || '';
              url = obj?.meta?.news?.jumpUrl || obj?.meta?.detail_1?.qqdocurl || obj?.meta?.news?.url || obj?.url || '';
            } catch {}
          }
          const cardTypeLabel = card.type === 'json' ? 'JSON卡片' : '应用卡片';
          lines.push(`分享${cardTypeLabel}: ${title || '(无标题)'}`);
          if (desc) lines.push(`  简介: ${desc.slice(0, 100)}${desc.length > 100 ? '...' : ''}`);
          if (url) lines.push(`  链接: ${url}`);
        } else if (card.type === 'xml') {
          const preview = (card.preview || '').toString().slice(0, 100);
          lines.push(`发送了XML卡片: ${preview}`);
        } else {
          const preview = (card.preview || '').toString().slice(0, 100);
          lines.push(`发送了卡片: ${preview}`);
        }
      });
    }

    // 转发消息
    if (msg.forwards.length > 0) {
      msg.forwards.forEach((fwd, i) => {
        lines.push('');
        lines.push(`转发了${fwd.count || 0}条消息${msg.forwards.length > 1 ? ` #${i + 1}` : ''}:`);
        if (fwd.nodes && fwd.nodes.length > 0) {
          lines.push('—— 转发消息详情 ——');
          fwd.nodes.forEach((node, idx) => {
            const nodeTime = node.time ? new Date(node.time * 1000).toLocaleString('zh-CN', {
              month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
            }) : '';
            const nodeSender = node.sender_name || `用户${node.sender_id || ''}`;
            lines.push(`[${idx + 1}/${fwd.nodes!.length}] ${nodeSender}${nodeTime ? ` (${nodeTime})` : ''}`);
            if (node.message_text) {
              lines.push(`  ${node.message_text}`);
            }
            // 检查是否有其他媒体
            if (Array.isArray(node.message)) {
              const segs: any[] = node.message;
              const nodeImages = segs.filter((s: any) => s && s.type === 'image');
              if (nodeImages.length > 0) {
                lines.push(`  发送了${nodeImages.length === 1 ? '一' : String(nodeImages.length)}张图片:`);
                nodeImages.forEach((s: any, i2: number) => {
                  const fname = s.data?.file || `图片${i2 + 1}`;
                  const local = s.data?.path || s.data?.cache_path;
                  const url = s.data?.url;
                  const target = local || (url ? `${url}${String(url).includes('?') ? '&' : '?'}file=${encodeURIComponent(fname)}` : '');
                  lines.push(`  ![${fname}](${target})`);
                });
              }
              const nodeVideos = segs.filter((s: any) => s && s.type === 'video');
              if (nodeVideos.length > 0) {
                lines.push(`  发送了${nodeVideos.length === 1 ? '一个' : nodeVideos.length + '个'}视频:`);
                nodeVideos.forEach((s: any, i2: number) => {
                  const fname = s.data?.file || `视频${i2 + 1}`;
                  const url = s.data?.url ? `${s.data.url}${String(s.data.url).includes('?') ? '&' : '?'}file=${encodeURIComponent(fname)}` : '';
                  lines.push(`  [视频: ${fname}](${url})`);
                });
              }
              const nodeRecords = segs.filter((s: any) => s && s.type === 'record');
              if (nodeRecords.length > 0) {
                lines.push(`  发送了${nodeRecords.length === 1 ? '一条' : nodeRecords.length + '条'}语音消息:`);
                nodeRecords.forEach((s: any, i2: number) => {
                  const fname = s.data?.file || `语音${i2 + 1}`;
                  const url = s.data?.path || (s.data?.url ? `${s.data.url}${String(s.data.url).includes('?') ? '&' : '?'}file=${encodeURIComponent(fname)}` : '');
                  lines.push(`  [语音: ${fname}](${url})`);
                });
              }
              const nodeFiles = segs.filter((s: any) => s && s.type === 'file');
              if (nodeFiles.length > 0) {
                lines.push(`  发送了${nodeFiles.length === 1 ? '一个' : nodeFiles.length + '个'}文件:`);
                nodeFiles.forEach((s: any, i2: number) => {
                  const fname = s.data?.file || s.data?.name || `文件${i2 + 1}`;
                  let link = s.data?.url || '';
                  if (link && !String(link).match(/^[a-zA-Z]:[\\\/]/) && !String(link).startsWith('/')) {
                    link = link.includes('fname=') ? link.replace(/fname=([^&]*)/, `fname=${encodeURIComponent(fname)}`) : `${link}${link.includes('?') ? '&' : '?'}file=${encodeURIComponent(fname)}`;
                  }
                  lines.push(`  [${fname}](${link})`);
                });
              }
              const nodeCards = segs.filter((s: any) => s && (s.type === 'share' || s.type === 'json' || s.type === 'xml' || s.type === 'app'));
              if (nodeCards.length > 0) {
                nodeCards.forEach((s: any) => {
                  if (s.type === 'share') {
                    const title = s.data?.title || s.data?.url || '分享链接';
                    const url = s.data?.url || '';
                    const content = s.data?.content || '';
                    lines.push(`  分享: ${title}`);
                    if (content) lines.push(`    简介: ${content}`);
                    if (url) lines.push(`    链接: ${url}`);
                  } else if (s.type === 'json' || s.type === 'app') {
                    const raw = s.data?.content ?? s.data?.data ?? s.data?.json ?? '';
                    let title = '';
                    let desc = '';
                    let url = '';
                    try {
                      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
                      title = obj?.prompt || obj?.meta?.news?.title || obj?.meta?.detail_1?.title || obj?.meta?.title || obj?.title || '';
                      desc = obj?.meta?.news?.desc || obj?.meta?.detail_1?.desc || obj?.desc || obj?.meta?.desc || '';
                      url = obj?.meta?.news?.jumpUrl || obj?.meta?.detail_1?.qqdocurl || obj?.meta?.news?.url || obj?.url || '';
                    } catch {}
                    const label = s.type === 'json' ? 'JSON卡片' : '应用卡片';
                    lines.push(`  分享${label}: ${title || '(无标题)'}`);
                    if (desc) lines.push(`    简介: ${String(desc).slice(0, 100)}${String(desc).length > 100 ? '...' : ''}`);
                    if (url) lines.push(`    链接: ${url}`);
                  } else if (s.type === 'xml') {
                    const raw = s.data?.data ?? s.data?.xml ?? '';
                    const preview = typeof raw === 'string' ? (raw.match(/<title>([^<]{1,100})<\/title>/i)?.[1] || raw.slice(0, 100)) : '';
                    lines.push(`  发送了XML卡片: ${preview}`);
                  }
                });
              }
            }
          });
          lines.push('—— 转发消息结束 ——');
        } else if (fwd.preview && fwd.preview.length > 0) {
          lines.push('预览:');
          fwd.preview.forEach((p) => lines.push(`  ${p}`));
        }
      });
    }

    // 表情
    if (msg.faces.length > 0) {
      const faceTexts = msg.faces.map((f) => f.text || `[表情${f.id}]`).join('、');
      lines.push('');
      lines.push(`发送了表情: ${faceTexts}`);
    }

    // 5. @提及（非群聊保留末尾展示）
    if (msg.type !== 'group') {
      if (msg.at_all) {
        lines.push('');
        lines.push('艾特了全体成员');
      } else if (msg.at_users.length > 0) {
        let atDetails: string[] = [];
        if (this.invoker) {
          try {
            const tasks = msg.at_users.map(async (uid) => {
              try {
                const info: any = await this.invoker!.data('get_stranger_info', { user_id: uid });
                const name = info?.nickname || String(uid);
                return `${name}(QQ:${uid})`;
              } catch {
                return String(uid);
              }
            });
            atDetails = await Promise.all(tasks);
          } catch {}
        }
        const out = atDetails.length > 0 ? atDetails.join('、') : msg.at_users.map((u) => String(u)).join('、');
        lines.push('');
        lines.push('艾特了: ' + out);
      }
    }

    if (replyLines.length > 0) {
      lines.push('');
      lines.push('—— 引用的消息 ——');
      lines.push(...replyLines);
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
}
