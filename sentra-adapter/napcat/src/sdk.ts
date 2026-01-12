import { NapcatAdapter } from './adapter/NapcatAdapter';
import { NapcatReverseAdapter } from './adapter/NapcatReverseAdapter';
import type { AdapterOptions } from './adapter/NapcatAdapter';
import type { ReverseAdapterOptions } from './adapter/NapcatReverseAdapter';
import type { OneBotResponse, MessageEvent } from './types/onebot';
import type { MessageInput } from './utils/message';
import { loadConfig } from './config';
import { onConfigChange } from './runtimeConfig';
import { assertOk } from './ob11';
import { extractReplyInfo, type ReplyInfo } from './utils/reply-parser';
import { MessageStream, type FormattedMessage } from './stream';
import { ensureLocalFile, isLocalPath } from './utils/fileCache';

export type SDKInit =
  | { adapter: NapcatAdapter | NapcatReverseAdapter }
  | (AdapterOptions & { reverse?: false })
  | ({ reverse: true } & ReverseAdapterOptions);

export type SdkInvoke = ((action: string, params?: any) => Promise<OneBotResponse>) & {
  // 核心调用方法
  data: <T = any>(action: string, params?: any) => Promise<T>;
  ok: <T = any>(action: string, params?: any) => Promise<OneBotResponse<T>>;
  retry: <T = any>(action: string, params?: any) => Promise<OneBotResponse<T>>;
  
  // 适配器实例
  adapter: NapcatAdapter | NapcatReverseAdapter;
  
  // 生命周期
  dispose: () => Promise<void>;
  
  // 消息发送
  send: {
    private: (user_id: number, message: MessageInput) => Promise<OneBotResponse>;
    group: (group_id: number, message: MessageInput) => Promise<OneBotResponse>;
    reply: (ev: MessageEvent, message: MessageInput) => Promise<OneBotResponse>;
    privateReply: (user_id: number, message_id: number, message: MessageInput) => Promise<OneBotResponse>;
    groupReply: (group_id: number, message_id: number, message: MessageInput) => Promise<OneBotResponse>;
    forwardGroup: (group_id: number, messages: any[]) => Promise<OneBotResponse>;
    forwardPrivate: (user_id: number, messages: any[]) => Promise<OneBotResponse>;
  };
  
  // 消息操作
  message: {
    recall: (message_id: number) => Promise<OneBotResponse>;
    get: (message_id: number) => Promise<OneBotResponse>;
    getForward: (id: string) => Promise<OneBotResponse>;
    getGroupHistory: (group_id: number, message_seq?: number, count?: number) => Promise<OneBotResponse>;
    getFriendHistory: (user_id: number, message_seq?: number, count?: number) => Promise<OneBotResponse>;
    markAsRead: (params: any) => Promise<OneBotResponse>;
    markPrivateAsRead: (params: any) => Promise<OneBotResponse>;
    markGroupAsRead: (params: any) => Promise<OneBotResponse>;
    markAllAsRead: () => Promise<OneBotResponse>;
    recentContact: (params?: any) => Promise<OneBotResponse>;
    emojiLike: (message_id: number, emoji_id: number) => Promise<OneBotResponse>;
  };
  
  // 群组管理
  group: {
    list: () => Promise<OneBotResponse>;
    info: (group_id: number, no_cache?: boolean) => Promise<OneBotResponse>;
    memberList: (group_id: number) => Promise<OneBotResponse>;
    memberInfo: (group_id: number, user_id: number, no_cache?: boolean) => Promise<OneBotResponse>;
    wholeBan: (group_id: number, enable?: boolean) => Promise<OneBotResponse>;
    ban: (group_id: number, user_id: number, duration: number) => Promise<OneBotResponse>;
    kick: (group_id: number, user_id: number, reject_add_request?: boolean) => Promise<OneBotResponse>;
    setCard: (group_id: number, user_id: number, card?: string) => Promise<OneBotResponse>;
    setName: (group_id: number, group_name: string) => Promise<OneBotResponse>;
    leave: (group_id: number, is_dismiss?: boolean) => Promise<OneBotResponse>;
  };
  
  // 文件操作
  file: {
    uploadGroup: (group_id: number, file: string, name?: string, folder?: string) => Promise<OneBotResponse>;
    uploadPrivate: (user_id: number, file: string, name?: string) => Promise<OneBotResponse>;
    getGroupRoot: (group_id: number) => Promise<OneBotResponse>;
    getGroupFolder: (group_id: number, folder_id: string) => Promise<OneBotResponse>;
    getGroupFileUrl: (group_id: number, file_id: string, busid: number) => Promise<OneBotResponse>;
    deleteGroupFile: (group_id: number, file_id: string, busid: number) => Promise<OneBotResponse>;
    deleteGroupFolder: (group_id: number, folder_id: string) => Promise<OneBotResponse>;
    createGroupFolder: (group_id: number, name: string, parent_id?: string) => Promise<OneBotResponse>;
  };
  
  // 用户信息
  user: {
    info: (user_id: number, no_cache?: boolean) => Promise<OneBotResponse>;
    friendList: () => Promise<OneBotResponse>;
    sendLike: (user_id: number, times?: number) => Promise<OneBotResponse>;
    sendPoke: (user_id: number, group_id?: number, target_id?: number) => Promise<OneBotResponse>;
    getFriendsWithCategory: () => Promise<OneBotResponse>;
    deleteFriend: (user_id: number) => Promise<OneBotResponse>;
    setFriendRemark: (user_id: number, remark: string) => Promise<OneBotResponse>;
    getProfileLike: (params?: any) => Promise<OneBotResponse>;
    fetchCustomFace: () => Promise<OneBotResponse>;
    getUnidirectionalFriendList: () => Promise<OneBotResponse>;
  };
  
  // 请求处理
  request: {
    setGroupAdd: (flag: string, sub_type: 'add' | 'invite', approve: boolean, reason?: string) => Promise<OneBotResponse>;
    setFriendAdd: (flag: string, approve: boolean, remark?: string) => Promise<OneBotResponse>;
    getDoubtFriendsAddRequest: () => Promise<OneBotResponse>;
    setDoubtFriendsAddRequest: (params: any) => Promise<OneBotResponse>;
  };
  
  // 图片和媒体
  media: {
    getImage: (file: string) => Promise<OneBotResponse>;
    ocrImage: (image: string) => Promise<OneBotResponse>;
  };
  
  // 系统信息
  system: {
    loginInfo: () => Promise<OneBotResponse>;
    status: () => Promise<OneBotResponse>;
    versionInfo: () => Promise<OneBotResponse>;
    getOnlineClients: () => Promise<OneBotResponse>;
    setOnlineStatus: (params: any) => Promise<OneBotResponse>;
    setDiyOnlineStatus: (params: any) => Promise<OneBotResponse>;
    getUserStatus: (user_id: number) => Promise<OneBotResponse>;
    getModelShow: () => Promise<OneBotResponse>;
    setModelShow: (params: any) => Promise<OneBotResponse>;
  };

  account: {
    setQQProfile: (params: any) => Promise<OneBotResponse>;
    setQQAvatar: (params: any) => Promise<OneBotResponse>;
    setSelfLongnick: (longnick: string) => Promise<OneBotResponse>;
  };

  ark: {
    sharePeer: (params: any) => Promise<OneBotResponse>;
    shareGroup: (params: any) => Promise<OneBotResponse>;
    getMiniAppArk: (params: any) => Promise<OneBotResponse>;
  };

  collection: {
    create: (params: any) => Promise<OneBotResponse>;
  };
  
  // 事件监听
  on: {
    message: (handler: (ev: any) => void) => () => void;
    groupMessage: (handler: (ev: any) => void) => () => void;
    privateMessage: (handler: (ev: any) => void) => () => void;
    notice: (handler: (ev: any) => void) => () => void;
    request: (handler: (ev: any) => void) => () => void;
    meta_event: (handler: (ev: any) => void) => () => void;
    open: (handler: () => void) => () => void;
    close: (handler: (code: number, reason: string) => void) => () => void;
    error: (handler: (err: Error) => void) => () => void;
  };
  
  // 工具方法
  utils: {
    isAtMe: (ev: MessageEvent) => boolean;
    getPlainText: (ev: MessageEvent) => string;
    parseReply: (ev: MessageEvent) => ReplyInfo | null;
    getReplyContext: (ev: MessageEvent) => Promise<{
      reply: ReplyInfo | null;
      referred?: any;
      referredPlain: string;
      currentPlain: string;
      media: {
        images: Array<{ file?: string; url?: string; size?: string | number; filename?: string; path?: string }>;
        videos: Array<{ file?: string; url?: string; size?: string | number; path?: string }>;
        files: Array<{ name?: string; url?: string; size?: string | number; path?: string }>;
        records: Array<{ file?: string; format?: string; path?: string }>;
        forwards: Array<{ 
          id?: string | number; 
          count?: number; 
          preview?: string[];
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
    }>;
  };
  
  // 消息流（WebSocket实时推送）
  stream?: {
    /** 启动消息流服务 */
    start: () => Promise<void>;
    /** 停止消息流服务 */
    stop: () => Promise<void>;
    /** 获取当前连接的客户端数量 */
    getClientCount: () => number;
    /** 获取MessageStream实例 */
    getInstance: () => MessageStream | undefined;
  };
};

export type { FormattedMessage };

export function createSDK(init?: SDKInit): SdkInvoke {
  let cfg = loadConfig();
  let adapter: NapcatAdapter | NapcatReverseAdapter;
  let isReverse = false;

  // 初始化适配器
  if (init && (init as any).adapter) {
    adapter = (init as any).adapter;
    isReverse = adapter instanceof NapcatReverseAdapter;
  } else {
    const wantReverse = (init && (init as any).reverse === true) || (!init && cfg.connectMode === 'reverse');
    if (wantReverse) {
      // 反向 WS 模式
      const reverseOpts: ReverseAdapterOptions = {
        port: (init as any)?.port || cfg.reversePort || 6701,
        path: (init as any)?.path || cfg.reversePath || '/onebot',
        accessToken: (init as any)?.accessToken || cfg.accessToken,
        logLevel: (init as any)?.logLevel || cfg.logLevel,
        whitelistGroups: (init as any)?.whitelistGroups || cfg.whitelistGroups,
        whitelistUsers: (init as any)?.whitelistUsers || cfg.whitelistUsers,
        logFiltered: (init as any)?.logFiltered ?? cfg.logFiltered,
        ...(init as any),
      } as any;
      adapter = new NapcatReverseAdapter(reverseOpts);
      (adapter as NapcatReverseAdapter).start();
      isReverse = true;
    } else {
      // 正向 WS 模式
      const opts: AdapterOptions = {
        wsUrl: (init as any)?.wsUrl || cfg.wsUrl,
        accessToken: (init as any)?.accessToken || cfg.accessToken,
        requestTimeoutMs: (init as any)?.requestTimeoutMs || cfg.requestTimeoutMs,
        reconnect: (init as any)?.reconnect ?? cfg.reconnect,
        reconnectMinMs: (init as any)?.reconnectMinMs || cfg.reconnectMinMs,
        reconnectMaxMs: (init as any)?.reconnectMaxMs || cfg.reconnectMaxMs,
        logLevel: (init as any)?.logLevel || cfg.logLevel,
        autoWaitOpen: (init as any)?.autoWaitOpen ?? cfg.autoWaitOpen,
        rateMaxConcurrency: (init as any)?.rateMaxConcurrency || cfg.rateMaxConcurrency,
        rateMinIntervalMs: (init as any)?.rateMinIntervalMs || cfg.rateMinIntervalMs,
        retryBackoffFactor: (init as any)?.retryBackoffFactor || cfg.retryBackoffFactor,
        retryInitialDelayMs: (init as any)?.retryInitialDelayMs || cfg.retryInitialDelayMs,
        retryJitterMs: (init as any)?.retryJitterMs || cfg.retryJitterMs,
        retryMaxAttempts: (init as any)?.retryMaxAttempts || cfg.retryMaxAttempts,
        deDupEvents: (init as any)?.deDupEvents ?? cfg.deDupEvents,
        deDupTtlMs: (init as any)?.deDupTtlMs || cfg.deDupTtlMs,
        whitelistGroups: (init as any)?.whitelistGroups || cfg.whitelistGroups,
        whitelistUsers: (init as any)?.whitelistUsers || cfg.whitelistUsers,
        logFiltered: (init as any)?.logFiltered ?? cfg.logFiltered,
        ...(init as any),
      };
      adapter = new NapcatAdapter(opts);
      (adapter as NapcatAdapter).connect().catch(() => void 0);
      isReverse = false;
    }
  }

  const stopConfigListener = onConfigChange((prev, next) => {
    cfg = next;
    try {
      if (adapter instanceof NapcatAdapter && typeof (adapter as any).updateRuntimeOptions === 'function') {
        (adapter as any).updateRuntimeOptions({
          whitelistGroups: next.whitelistGroups,
          whitelistUsers: next.whitelistUsers,
          logFiltered: next.logFiltered,
          deDupEvents: next.deDupEvents,
          deDupTtlMs: next.deDupTtlMs,
        });
      } else if (adapter instanceof NapcatReverseAdapter && typeof (adapter as any).updateRuntimeOptions === 'function') {
        (adapter as any).updateRuntimeOptions({
          whitelistGroups: next.whitelistGroups,
          whitelistUsers: next.whitelistUsers,
          logFiltered: next.logFiltered,
        });
      }
    } catch {}

    if (messageStream && typeof messageStream.updateRuntimeOptions === 'function') {
      try {
        messageStream.updateRuntimeOptions({
          includeRaw: next.streamIncludeRaw,
          skipAnimatedEmoji: next.streamSkipAnimatedEmoji,
          skipVoice: next.streamSkipVoice,
          rpcRetryEnabled: next.streamRpcRetryEnabled,
          rpcRetryIntervalMs: next.streamRpcRetryIntervalMs,
          rpcRetryMaxAttempts: next.streamRpcRetryMaxAttempts,
          whitelistGroups: next.whitelistGroups,
          whitelistUsers: next.whitelistUsers,
          logFiltered: next.logFiltered,
        });
      } catch {}
    }
  });

  // 统一的调用接口
  const fn = (async (action: string, params?: any) => {
    return adapter.call(action, params) as Promise<OneBotResponse>;
  }) as SdkInvoke;

  // 核心调用方法
  fn.data = async (action, params) => {
    return (await adapter.callData(action, params)) as any;
  };
  
  fn.ok = async (action, params) => {
    return adapter.callOk(action, params) as any;
  };
  
  fn.retry = async (action, params) => {
    if (adapter instanceof NapcatAdapter && typeof adapter.callRetry === 'function') {
      return adapter.callRetry(action, params) as any;
    }
    // 手动实现重试逻辑（用于反向适配器）
    const maxAttempts = cfg.retryMaxAttempts ?? 3;
    const backoff = cfg.retryBackoffFactor ?? 2;
    const jitterMs = cfg.retryJitterMs ?? 200;
    let delay = cfg.retryInitialDelayMs ?? 500;
    let lastErr: any;
    for (let n = 1; n <= maxAttempts; n++) {
      try {
        const res = await adapter.call(action, params);
        return assertOk(res) as any;
      } catch (e) {
        lastErr = e;
        if (n === maxAttempts) break;
        const j = Math.floor(Math.random() * jitterMs);
        await new Promise((r) => setTimeout(r, delay + j));
        delay = Math.floor(delay * backoff);
      }
    }
    throw lastErr;
  };

  // 消息发送
  fn.send = {
    private: (user_id, message) => adapter.sendPrivateMessage(user_id, message),
    group: (group_id, message) => adapter.sendGroupMessage(group_id, message),
    reply: (ev, message) => {
      if (adapter instanceof NapcatAdapter && typeof adapter.sendReply === 'function') {
        return adapter.sendReply(ev, message);
      }
      // 手动实现
      if (ev.message_type === 'group' && ev.group_id) {
        return adapter.sendGroupReply(ev.group_id, ev.message_id, message);
      }
      if (ev.message_type === 'private' && ev.user_id) {
        return adapter.sendPrivateReply(ev.user_id, ev.message_id, message);
      }
      throw new Error('Unsupported event for reply');
    },
    privateReply: (user_id, message_id, message) => 
      adapter.sendPrivateReply(user_id, message_id, message),
    groupReply: (group_id, message_id, message) => 
      adapter.sendGroupReply(group_id, message_id, message),
    forwardGroup: (group_id, messages) => 
      adapter.sendGroupForwardMessage(group_id, messages),
    forwardPrivate: (user_id, messages) => 
      adapter.sendPrivateForwardMessage(user_id, messages),
  };

  // 消息操作
  fn.message = {
    recall: (message_id) => fn('delete_msg', { message_id }),
    get: (message_id) => fn('get_msg', { message_id }),
    getForward: (message_id) => fn('get_forward_msg', { message_id }),
    getGroupHistory: (group_id, message_seq, count = 20) => 
      fn('get_group_msg_history', { group_id, message_seq, count }),
    getFriendHistory: (user_id, message_seq, count = 20) => 
      fn('get_friend_msg_history', { user_id, message_seq, count }),
    markAsRead: (params: any) => fn('mark_msg_as_read', params),
    markPrivateAsRead: (params: any) => fn('mark_private_msg_as_read', params),
    markGroupAsRead: (params: any) => fn('mark_group_msg_as_read', params),
    markAllAsRead: () => fn('_mark_all_as_read'),
    recentContact: (params?: any) => fn('get_recent_contact', params ?? {}),
    emojiLike: (message_id, emoji_id) => 
      fn('set_msg_emoji_like', { message_id, emoji_id }),
  };

  // 群组管理
  fn.group = {
    list: () => fn('get_group_list'),
    info: (group_id, no_cache) => fn('get_group_info', { group_id, no_cache }),
    memberList: (group_id) => fn('get_group_member_list', { group_id }),
    memberInfo: (group_id, user_id, no_cache) => 
      fn('get_group_member_info', { group_id, user_id, no_cache }),
    wholeBan: (group_id, enable = true) => fn('set_group_whole_ban', { group_id, enable }),
    ban: (group_id, user_id, duration) => fn('set_group_ban', { group_id, user_id, duration }),
    kick: (group_id, user_id, reject_add_request) => 
      fn('set_group_kick', { group_id, user_id, reject_add_request }),
    setCard: (group_id, user_id, card) => fn('set_group_card', { group_id, user_id, card }),
    setName: (group_id, group_name) => fn('set_group_name', { group_id, group_name }),
    leave: (group_id, is_dismiss) => fn('set_group_leave', { group_id, is_dismiss }),
  };

  // 文件操作
  fn.file = {
    uploadGroup: (group_id, file, name, folder) => 
      fn('upload_group_file', { group_id, file, name, folder }),
    uploadPrivate: (user_id, file, name) => 
      fn('upload_private_file', { user_id, file, name }),
    getGroupRoot: (group_id) => fn('get_group_root_files', { group_id }),
    getGroupFolder: (group_id, folder_id) => 
      fn('get_group_files_by_folder', { group_id, folder_id }),
    getGroupFileUrl: (group_id, file_id, busid) => 
      fn('get_group_file_url', { group_id, file_id, busid }),
    deleteGroupFile: (group_id, file_id, busid) => 
      fn('delete_group_file', { group_id, file_id, busid }),
    deleteGroupFolder: (group_id, folder_id) => 
      fn('delete_group_folder', { group_id, folder_id }),
    createGroupFolder: (group_id, name, parent_id) => 
      fn('create_group_file_folder', { group_id, name, parent_id }),
  };

  // 用户信息
  fn.user = {
    info: (user_id, no_cache) => fn('get_stranger_info', { user_id, no_cache }),
    friendList: () => fn('get_friend_list'),
    sendLike: (user_id, times = 1) => fn('send_like', { user_id, times }),
    sendPoke: (user_id, group_id, target_id) => {
      const params: any = { user_id };
      if (group_id !== undefined) params.group_id = group_id;
      if (target_id !== undefined) params.target_id = target_id;
      return fn('send_poke', params);
    },
    getFriendsWithCategory: () => fn('get_friends_with_category'),
    deleteFriend: (user_id) => fn('delete_friend', { user_id }),
    setFriendRemark: (user_id, remark) => fn('set_friend_remark', { user_id, remark }),
    getProfileLike: (params?: any) => fn('get_profile_like', params ?? {}),
    fetchCustomFace: () => fn('fetch_custom_face'),
    getUnidirectionalFriendList: () => fn('get_unidirectional_friend_list'),
  };

  // 请求处理
  fn.request = {
    setGroupAdd: (flag, sub_type, approve, reason) => 
      fn('set_group_add_request', { flag, sub_type, approve, reason }),
    setFriendAdd: (flag, approve, remark) => 
      fn('set_friend_add_request', { flag, approve, remark }),
    getDoubtFriendsAddRequest: () => fn('get_doubt_friends_add_request'),
    setDoubtFriendsAddRequest: (params: any) => fn('set_doubt_friends_add_request', params),
  };

  // 图片和媒体
  fn.media = {
    getImage: (file) => fn('get_image', { file }),
    ocrImage: (image) => fn('ocr_image', { image }),
  };

  // 系统信息
  fn.system = {
    loginInfo: () => fn('get_login_info'),
    status: () => fn('get_status'),
    versionInfo: () => fn('get_version_info'),
    getOnlineClients: () => fn('get_online_clients'),
    setOnlineStatus: (params: any) => fn('set_online_status', params),
    setDiyOnlineStatus: (params: any) => fn('set_diy_online_status', params),
    getUserStatus: (user_id: number) => fn('nc_get_user_status', { user_id }),
    getModelShow: () => fn('_get_model_show'),
    setModelShow: (params: any) => fn('_set_model_show', params),
  };

  // 账号相关
  fn.account = {
    setQQProfile: (params: any) => fn('set_qq_profile', params),
    setQQAvatar: (params: any) => fn('set_qq_avatar', params),
    setSelfLongnick: (longNick: string) => fn('set_self_longnick', { longNick }),
  } as any;

  // Ark / 小程序等
  fn.ark = {
    sharePeer: (params: any) => fn('ArkSharePeer', params),
    shareGroup: (params: any) => fn('ArkShareGroup', params),
    getMiniAppArk: (params: any) => fn('get_mini_app_ark', params),
  } as any;

  // 收藏
  fn.collection = {
    create: (params: any) => fn('create_collection', params),
  } as any;

  // 事件监听
  fn.on = {
    message: (handler) => {
      const listener = handler as any;
      (adapter as any).on('message', listener);
      return () => (adapter as any).off('message', listener);
    },
    groupMessage: (handler) => {
      if (adapter instanceof NapcatAdapter && typeof adapter.onGroupMessage === 'function') {
        return adapter.onGroupMessage(handler as any);
      }
      // 手动过滤
      const wrapper = (ev: any) => {
        if (ev.message_type === 'group') handler(ev);
      };
      (adapter as any).on('message', wrapper);
      return () => (adapter as any).off('message', wrapper);
    },
    privateMessage: (handler) => {
      if (adapter instanceof NapcatAdapter && typeof adapter.onPrivateMessage === 'function') {
        return adapter.onPrivateMessage(handler as any);
      }
      // 手动过滤
      const wrapper = (ev: any) => {
        if (ev.message_type === 'private') handler(ev);
      };
      (adapter as any).on('message', wrapper);
      return () => (adapter as any).off('message', wrapper);
    },
    notice: (handler) => {
      const listener = handler as any;
      (adapter as any).on('notice', listener);
      return () => (adapter as any).off('notice', listener);
    },
    request: (handler) => {
      const listener = handler as any;
      (adapter as any).on('request', listener);
      return () => (adapter as any).off('request', listener);
    },
    meta_event: (handler) => {
      const listener = handler as any;
      (adapter as any).on('meta_event', listener);
      return () => (adapter as any).off('meta_event', listener);
    },
    open: (handler) => {
      const listener = handler as any;
      if (isReverse) {
        // 反向模式使用 connected 事件
        (adapter as any).on('connected', listener);
        return () => (adapter as any).off('connected', listener);
      } else {
        (adapter as any).on('open', listener);
        return () => (adapter as any).off('open', listener);
      }
    },
    close: (handler) => {
      const listener = handler as any;
      if (isReverse) {
        (adapter as any).on('disconnected', listener);
        return () => (adapter as any).off('disconnected', listener);
      } else {
        (adapter as any).on('close', listener);
        return () => (adapter as any).off('close', listener);
      }
    },
    error: (handler) => {
      const listener = handler as any;
      (adapter as any).on('error', listener);
      return () => (adapter as any).off('error', listener);
    },
  };

  // 工具方法
  fn.utils = {
    isAtMe: (ev) => {
      if (typeof (adapter as any).isAtMe === 'function') {
        return (adapter as any).isAtMe(ev);
      }
      return false;
    },
    getPlainText: (ev) => {
      return ev.message
        .filter((seg: any) => seg.type === 'text')
        .map((seg: any) => String(seg.data?.text ?? ''))
        .join('');
    },
    parseReply: (ev) => extractReplyInfo(ev),
    getReplyContext: async (ev) => {
      const reply = extractReplyInfo(ev);
      const currentPlain = ev.message
        .filter((seg: any) => seg.type === 'text')
        .map((seg: any) => String(seg.data?.text ?? ''))
        .join('');

      let referred: any | undefined;
      let referredPlain = '';

      const toMarkdownTarget = (target?: string): string => {
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
      };

      const formatFileSize = (size: string | number): string => {
        const bytes = typeof size === 'string' ? parseInt(size, 10) : size;
        if (!Number.isFinite(bytes)) return '未知大小';
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
      };

      const renderSegmentsMarkdownInline = (segs: any[]): string => {
        if (!Array.isArray(segs)) return '';
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
            const target = toMarkdownTarget(s.data?.path || s.data?.cache_path) || toMarkdownTarget(s.data?.url);
            parts.push(target ? `![${filename}](${target})` : `图片:${filename}`);
            continue;
          }

          if (s.type === 'video') {
            const filename = s.data?.file || '视频';
            const target = toMarkdownTarget(s.data?.path) || toMarkdownTarget(s.data?.url);
            parts.push(target ? `[视频: ${filename}](${target})` : `视频:${filename}`);
            continue;
          }

          if (s.type === 'record') {
            const filename = s.data?.file || '语音';
            const target = toMarkdownTarget(s.data?.path) || toMarkdownTarget(s.data?.url);
            parts.push(target ? `[语音: ${filename}](${target})` : `语音:${filename}`);
            continue;
          }

          if (s.type === 'file') {
            const filename = s.data?.file || s.data?.name || '文件';
            const target = toMarkdownTarget(s.data?.path) || toMarkdownTarget(s.data?.url);
            const size = s.data?.file_size ?? s.data?.size;
            const sizeText = size !== undefined && size !== null ? ` (${formatFileSize(size)})` : '';
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
            let title = '';
            let desc = '';
            let url = '';
            try {
              const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
              title = obj?.meta?.news?.title || obj?.meta?.detail_1?.title || obj?.prompt || obj?.meta?.title || obj?.title || '';
              desc = obj?.meta?.news?.desc || obj?.meta?.detail_1?.desc || obj?.desc || obj?.meta?.desc || '';
              url = obj?.meta?.news?.jumpUrl || obj?.meta?.detail_1?.qqdocurl || obj?.meta?.news?.url || obj?.url || '';
            } catch {
              title = typeof raw === 'string' ? raw : '';
            }
            const label = s.type === 'json' ? 'JSON卡片' : '应用卡片';
            const core = url ? `[${title || '(无标题)'}](${url})` : (title || '(无标题)');
            parts.push(desc ? `${label}: ${core}（${desc}）` : `${label}: ${core}`);
            continue;
          }

          if (s.type === 'xml') {
            const raw = s.data?.data ?? s.data?.xml ?? '';
            const title = typeof raw === 'string' ? (raw.match(/<title>([^<]{1,100})<\/title>/i)?.[1] || raw) : '';
            parts.push(`XML卡片: ${title || '(无标题)'}`);
            continue;
          }

          if (s.type === 'forward') {
            const id = s.data?.id;
            parts.push(id ? `转发消息(id=${id})` : '转发消息');
            continue;
          }

          parts.push(`[${String(s.type)}]`);
        }

        return parts.join('');
      };

      const renderSegmentsTextOnly = (segs: any[]): string => {
        if (!Array.isArray(segs)) return '';
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
        }

        return parts.join('');
      };

      let embeddedPlain = '';
      if (reply?.message && Array.isArray(reply.message)) embeddedPlain = renderSegmentsTextOnly(reply.message);
      if (!embeddedPlain && reply?.raw_message) embeddedPlain = String(reply.raw_message);

      if (reply && reply.id) {
        try {
          referred = await fn.data('get_msg', { message_id: reply.id });
        } catch {}
      }

      const findInList = (arr: any[]): any | undefined => {
        if (!Array.isArray(arr)) return undefined;
        for (const m of arr) {
          const midEq = reply?.id && (Number(m?.message_id) === reply.id || Number(m?.real_id) === reply.id);
          const mseqEq = reply?.seq && (Number(m?.message_seq) === reply.seq || String(m?.real_seq) === String(reply.seq));
          const mseqEqById = !reply?.seq && reply?.id && (Number(m?.message_seq) === reply.id || String(m?.real_seq) === String(reply.id));
          if (midEq || mseqEq || mseqEqById) return m;
        }
        return undefined;
      };

      if (!referred && reply && typeof reply.seq === 'number' && Number.isFinite(reply.seq)) {
        const tries: Array<{ seq: number; reverseOrder?: boolean }> = [
          { seq: reply.seq, reverseOrder: false },
          { seq: reply.seq, reverseOrder: true },
          { seq: reply.seq - 1, reverseOrder: false },
          { seq: reply.seq + 1, reverseOrder: false },
        ];
        for (const t of tries) {
          try {
            if (ev.message_type === 'group' && ev.group_id) {
              const hist = await fn('get_group_msg_history', { group_id: ev.group_id, message_seq: t.seq, count: 50, reverseOrder: t.reverseOrder === true });
              const cand = findInList(((hist as any).data as any)?.messages || []);
              if (cand) { referred = cand; break; }
            } else if (ev.message_type === 'private' && ev.user_id) {
              const hist = await fn('get_friend_msg_history', { user_id: ev.user_id, message_seq: t.seq, count: 50, reverseOrder: t.reverseOrder === true });
              const cand = findInList(((hist as any).data as any)?.messages || []);
              if (cand) { referred = cand; break; }
            }
          } catch {}
        }
      }

      if (!referred) {
        try {
          if (ev.message_type === 'group' && ev.group_id) {
            let cursor: number | undefined = 0;
            for (let i = 0; i < 3; i++) {
              const hist: any = await fn('get_group_msg_history', { group_id: ev.group_id, message_seq: cursor, count: 100, reverseOrder: true });
              const arr: any[] = (hist?.data as any)?.messages || [];
              const cand: any = findInList(arr);
              if (cand) { referred = cand; break; }
              const seqs: number[] = arr.map((m: any) => Number(m?.message_seq)).filter((n: any) => Number.isFinite(n));
              if (!seqs.length) break;
              cursor = Math.min(...seqs) - 1;
            }
          } else if (ev.message_type === 'private' && ev.user_id) {
            let cursor: number | undefined = 0;
            for (let i = 0; i < 3; i++) {
              const hist: any = await fn('get_friend_msg_history', { user_id: ev.user_id, message_seq: cursor, count: 100, reverseOrder: true });
              const arr: any[] = (hist?.data as any)?.messages || [];
              const cand: any = findInList(arr);
              if (cand) { referred = cand; break; }
              const seqs: number[] = arr.map((m: any) => Number(m?.message_seq)).filter((n: any) => Number.isFinite(n));
              if (!seqs.length) break;
              cursor = Math.min(...seqs) - 1;
            }
          }
        } catch {}
      }

      if (referred && referred.message) {
        referredPlain = renderSegmentsTextOnly(referred.message as any[]);
      } else if (referred && referred.raw_message) {
        referredPlain = String(referred.raw_message);
      } else {
        referredPlain = embeddedPlain || '';
      }

      const collectMedia = (segs?: any[]) => {
        const images: any[] = [];
        const videos: any[] = [];
        const files: any[] = [];
        const records: any[] = [];
        const forwards: any[] = [];
        const faces: any[] = [];
        const cards: any[] = [];
        if (Array.isArray(segs)) {
          for (const s of segs) {
            if (!s || !s.type) continue;
            if (s.type === 'image') {
              images.push(s.data || {});
            } else if (s.type === 'video') {
              videos.push({ file: s.data?.file, url: s.data?.url, size: s.data?.file_size });
            } else if (s.type === 'file') {
              files.push(s.data || {});
            } else if (s.type === 'record') {
              records.push(s.data || {});
            } else if (s.type === 'forward' && s.data) {
              forwards.push({ id: s.data.id });
            } else if (s.type === 'face' && s.data) {
              faces.push({ id: s.data.id, text: s.data.text });
            } else if (s.type === 'json') {
              const raw = s.data?.data ?? s.data?.content ?? s.data?.json ?? '';
              let preview = '';
              try {
                const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
                // 尝试提取有意义的字段：prompt/desc/title/view 等
                preview = obj?.prompt || obj?.desc || obj?.meta?.detail_1?.desc || obj?.meta?.news?.desc || obj?.view || obj?.title || '';
                if (!preview && obj?.config?.type) preview = `类型: ${obj.config.type}`;
                if (!preview) preview = typeof raw === 'string' ? raw : JSON.stringify(raw);
              } catch {
                preview = typeof raw === 'string' ? raw : '';
              }
              cards.push({ type: 'json', raw, preview });
            } else if (s.type === 'xml') {
              const raw = s.data?.data ?? s.data?.xml ?? '';
              const m = typeof raw === 'string' ? raw.match(/<title>([^<]{1,64})<\/title>/i) : null;
              const preview = m?.[1] || (typeof raw === 'string' ? raw : '');
              cards.push({ type: 'xml', raw, preview });
            } else if (s.type === 'share') {
              cards.push({ type: 'share', title: s.data?.title, url: s.data?.url, content: s.data?.content, image: s.data?.image, preview: s.data?.title || s.data?.url });
            } else if (s.type === 'app') {
              const raw = s.data?.content ?? s.data?.data ?? '';
              let title: string | undefined; let url: string | undefined; let image: string | undefined; let content: string | undefined;
              try {
                const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
                title = obj?.meta?.news?.title || obj?.meta?.detail_1?.title || obj?.prompt || obj?.meta?.title || obj?.title;
                content = obj?.meta?.news?.desc || obj?.meta?.detail_1?.desc || obj?.desc || obj?.meta?.desc;
                url = obj?.meta?.news?.jumpUrl || obj?.meta?.detail_1?.qqdocurl || obj?.meta?.news?.url || obj?.url;
                image = obj?.meta?.news?.preview || obj?.meta?.detail_1?.preview || obj?.meta?.preview || obj?.cover;
              } catch {}
              const preview = title || (typeof raw === 'string' ? raw : '');
              cards.push({ type: 'app', title, url, image, content, raw, preview });
            }
          }
        }
        return { images, videos, files, records, forwards, faces, cards };
      };

      const media = referred?.message ? collectMedia(referred.message as any[]) : collectMedia(reply?.message as any[]);

      const enrichImages = async (items: any[]) => {
        const tasks = items.map(async (img: any) => {
          try {
            const detail: any = await fn.data('get_image', { file: img.file || img.url });
            const localPath = await ensureLocalFile({
              kind: 'image',
              file: detail?.file || img.file,
              url: detail?.url || img.url,
              filenameHint: detail?.file_name || img.file,
            });
            return {
              file: localPath || detail?.file || img.file,
              url: detail?.url || img.url,
              size: detail?.file_size || img.file_size,
              filename: detail?.file_name || img.file,
              path: localPath,
            };
          } catch {
            const localPath = await ensureLocalFile({
              kind: 'image',
              file: img.file,
              url: img.url,
              filenameHint: img.file,
            });
            return {
              file: localPath || img.file,
              url: img.url,
              size: img.file_size,
              filename: img.file,
              path: localPath,
            };
          }
        });
        return await Promise.all(tasks);
      };

      const enrichRecords = async (items: any[]) => {
        const tasks = items.map(async (rec: any) => {
          try {
            const detail: any = await fn.data('get_record', { file: rec.file, out_format: 'mp3' });
            const localPath = await ensureLocalFile({
              kind: 'record',
              file: detail?.file || rec.path || rec.file,
              url: undefined,
              filenameHint: rec.file,
            });
            return {
              file: localPath || detail?.file || rec.path || rec.file,
              format: detail?.out_format || 'mp3',
              path: localPath,
            };
          } catch {
            const localPath = await ensureLocalFile({
              kind: 'record',
              file: rec.path || rec.file,
              url: undefined,
              filenameHint: rec.file,
            });
            return {
              file: localPath || rec.path || rec.file,
              format: 'unknown',
              path: localPath,
            };
          }
        });
        return await Promise.all(tasks);
      };

      const enrichFiles = async (items: any[], msgType?: string, targetId?: number) => {
        const tasks = items.map(async (f: any) => {
          try {
            let detail: any;
            const fileId = f.file_id || f.id;
            if (msgType === 'group' && targetId && fileId) {
              detail = await fn.data('get_group_file_url', { group_id: targetId, file_id: fileId, busid: f.busid || 102 });
            } else if (msgType === 'private' && targetId && fileId) {
              detail = await fn.data('get_file', { file_id: fileId });
            }
            const url = detail?.url || detail?.file_url || f.url;
            const localPath = await ensureLocalFile({
              kind: 'file',
              file: detail?.file,
              url,
              filenameHint: detail?.file_name || f.file || f.name,
            });
            return {
              name: detail?.file_name || f.file || f.name,
              url,
              size: detail?.file_size || f.file_size || f.size,
              path: localPath,
            };
          } catch {
            const localPath = await ensureLocalFile({
              kind: 'file',
              file: (f as any).path || f.file,
              url: f.url,
              filenameHint: f.file || f.name,
            });
            return {
              name: f.file || f.name,
              url: f.url,
              size: f.file_size || f.size,
              path: localPath,
            };
          }
        });
        return await Promise.all(tasks);
      };

      const enrichForwards = async (items: any[]) => {
        const tasks = items.map(async (fwd: any) => {
          try {
            const messageId = fwd.message_id ?? fwd.id;
            const detail: any = await fn.data('get_forward_msg', { message_id: messageId, id: messageId });
            const data = detail?.data ?? detail;
            const nodes: any[] =
              (detail?.messages as any[]) ||
              (detail?.data as any)?.messages ||
              (data as any)?.message ||
              (data as any)?.messages ||
              (data as any)?.data?.messages ||
              (data as any)?.data?.message ||
              [];
            const nodesCount = Array.isArray(nodes) ? nodes.length : 0;
            let preview: string[] = [];
            if (Array.isArray(nodes) && nodes.length) {
              preview = nodes.map((n: any) => {
                const segs = (n?.content as any[]) || (n?.message as any[]) || [];
                const plain = renderSegmentsMarkdownInline(segs);
                const sender = n?.sender?.nickname || n?.user_id || '?';
                return `${sender}: ${plain || '[空消息]'}`;
              });
            }
            return { id: messageId, count: nodesCount, preview };
          } catch {
            return { id: fwd.id, count: 0, preview: [] };
          }
        });
        return await Promise.all(tasks);
      };

      const enrichCards = async (items: any[]) => {
        return items.map((c: any) => {
          if (c.type === 'share') {
            return { type: 'share', title: c.title, url: c.url, content: c.content, image: c.image, preview: c.preview || c.title || c.url };
          } else if (c.type === 'json') {
            return { type: 'json', preview: c.preview, raw: c.raw };
          } else if (c.type === 'xml') {
            return { type: 'xml', preview: c.preview, raw: c.raw };
          } else if (c.type === 'app') {
            return { type: 'app', title: c.title, url: c.url, image: c.image, content: c.content, preview: c.preview, raw: c.raw };
          }
          return c;
        });
      };

      const msgType = ev.message_type;
      const targetId = (msgType === 'group' ? ev.group_id : ev.user_id) as number | undefined;

      try {
        const [enrichedImages, enrichedRecords, enrichedFiles, enrichedForwards, enrichedCards] = await Promise.all([
          media.images.length ? enrichImages(media.images) : Promise.resolve([]),
          media.records.length ? enrichRecords(media.records) : Promise.resolve([]),
          media.files.length ? enrichFiles(media.files, msgType, targetId) : Promise.resolve([]),
          media.forwards.length ? enrichForwards(media.forwards) : Promise.resolve([]),
          media.cards && media.cards.length ? enrichCards(media.cards) : Promise.resolve([]),
        ]);
        media.images = enrichedImages;
        media.records = enrichedRecords;
        media.files = enrichedFiles;
        media.forwards = enrichedForwards;
        media.cards = enrichedCards;
      } catch {}

      return { reply, referred, referredPlain, currentPlain, media };
    },
  };

  fn.adapter = adapter;
  
  // 初始化消息流（可选）
  let messageStream: MessageStream | undefined;
  if (cfg.enableStream) {
    messageStream = new MessageStream({
      port: cfg.streamPort,
      includeRaw: cfg.streamIncludeRaw,
      skipAnimatedEmoji: cfg.streamSkipAnimatedEmoji,
      skipVoice: cfg.streamSkipVoice,
      rpcRetryEnabled: cfg.streamRpcRetryEnabled,
      rpcRetryIntervalMs: cfg.streamRpcRetryIntervalMs,
      rpcRetryMaxAttempts: cfg.streamRpcRetryMaxAttempts,
      whitelistGroups: cfg.whitelistGroups,
      whitelistUsers: cfg.whitelistUsers,
      logFiltered: cfg.logFiltered,
    });
    
    // 设置群名称解析器
    messageStream.setGroupNameResolver(async (groupId: number) => {
      try {
        const res = await fn.data<any>('get_group_info', { group_id: groupId });
        return res?.group_name;
      } catch {
        return undefined;
      }
    });
    // 注入 SDK 调用器，允许通过消息流直接调用 SDK 功能
    messageStream.setInvoker(fn);
    
    fn.stream = {
      start: () => messageStream!.start(),
      stop: () => messageStream!.stop(),
      getClientCount: () => messageStream!.getClientCount(),
      getInstance: () => messageStream,
    };
  }
  
  fn.dispose = async () => {
    try {
      if (messageStream) {
        await messageStream.stop();
      }
      if (adapter instanceof NapcatReverseAdapter) {
        adapter.stop();
      } else if (adapter instanceof NapcatAdapter) {
        await adapter.destroy();
      }
      if (typeof stopConfigListener === 'function') {
        try { stopConfigListener(); } catch {}
      }
    } catch {}
  };

  return fn;
}

export default createSDK;
