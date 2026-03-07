import 'dotenv/config';
import createSDK from './sdk';
import { createLogger } from './logger';
import { formatEventCompact, formatMessageHuman, formatReplyContextHuman, isMeaningfulMessage } from './events';
import type { MessageEvent } from './types/onebot';
import { getConfig, refreshConfigFromEnv } from './runtimeConfig';
import { startEnvWatcher } from './envWatcher';
import { ensureLocalFile, startCacheCleanupTimer, isLocalPath } from './utils/fileCache';

const log = createLogger(process.env.LOG_LEVEL as any || 'info');

async function main() {
  startEnvWatcher();
  const cfg = refreshConfigFromEnv() || getConfig();
  const mode = cfg.connectMode;
  const isReverse = mode === 'reverse';

  log.info({ mode }, '启动配置');

  // 启动缓存目录的周期清理（图片/文件等），默认 2 天过期
  startCacheCleanupTimer(log as any);

  const sdk = createSDK();

  // 启动消息流服务
  if (sdk.stream) {
    try {
      await sdk.stream.start();
      log.info({ port: cfg.streamPort }, '✅ 消息流服务已启动');
    } catch (err) {
      log.error({ err }, '消息流服务启动失败');
    }
  }

  const groupNameCache = new Map<number, { name: string; ts: number }>();
  const getGroupNameCached = async (groupId: number | undefined): Promise<string | undefined> => {
    if (!groupId || !Number.isFinite(groupId)) return undefined;
    const now = Date.now();
    const cached = groupNameCache.get(groupId);
    // 10 分钟缓存
    if (cached && now - cached.ts < 10 * 60 * 1000) return cached.name;
    try {
      const resp: any = await sdk.data('get_group_info', { group_id: groupId, no_cache: false });
      const name = resp?.group_name;
      if (name && typeof name === 'string') {
        groupNameCache.set(groupId, { name, ts: now });
        return name;
      }
    } catch {
      // ignore
    }
    return cached?.name;
  };

  // 连接成功
  sdk.on.open(async () => {
    log.info('✅ 已连接到 NapCat');
    if (isReverse) {
      log.info(
        {
          port: cfg.reversePort,
          path: cfg.reversePath,
        },
        '反向 WS 服务器已启动'
      );
    } else {
      log.info({ url: cfg.wsUrl }, '正向 WS 已连接');
    }

    // 启动消息流服务（如果启用）
    if (sdk.stream) {
      try {
        await sdk.stream.start();
        log.info({ port: cfg.streamPort }, '✅ 消息流服务已启动');
      } catch (err) {
        log.error({ err }, '消息流服务启动失败');
      }
    }
  });

  // 监听所有消息（记录日志）
  sdk.on.message(async (ev) => {
    const summaryMode = (process.env.EVENT_SUMMARY || 'debug').toLowerCase();
    let line = '';
    if ((ev as any)?.post_type === 'message') {
      const msg = ev as any;
      const groupName = msg.message_type === 'group' ? await getGroupNameCached(msg.group_id) : undefined;
      line = formatMessageHuman(msg, { withColor: true, groupName });
    } else {
      line = formatEventCompact(ev, { withColor: true });
    }
    if (summaryMode === 'always') {
      log.info(line);
    } else if (summaryMode === 'debug' && process.env.LOG_LEVEL === 'debug') {
      log.debug(line);
    }

    const meaningful = isMeaningfulMessage(ev as MessageEvent);
    if (!meaningful) {
      if (process.env.LOG_LEVEL === 'debug') {
        log.warn({ message_id: (ev as any).message_id }, '跳过推送：无有效内容');
      }
      return;
    }

    // 获取引用上下文（用于日志和流推送）
    let replyContext: any = undefined;
    const hasReply = Array.isArray((ev as any).message) && (ev as MessageEvent).message.some((s: any) => s.type === 'reply');
    if (hasReply) {
      try {
        replyContext = await (sdk as any).utils.getReplyContext(ev as MessageEvent);
        if (summaryMode === 'always' || process.env.LOG_LEVEL === 'debug') {
          const line = formatReplyContextHuman(replyContext, { withColor: true });
          if (summaryMode === 'always') log.info(line);
          else log.debug(line);
        }
      } catch { }
    }

    // 推送到消息流（如果启用）
    if (sdk.stream) {
      try {
        const streamInstance = sdk.stream.getInstance();
        if (streamInstance) {
          const msg = ev as MessageEvent;

          // 图片：统一通过 fileCache 转成本地路径，写入 path/cache_path，供下游使用
          const imageSegments = msg.message.filter((s: any) => s.type === 'image');
          if (imageSegments.length > 0) {
            await Promise.all(imageSegments.map(async (seg: any) => {
              try {
                const fileParam = seg.data?.file || seg.data?.url;
                let detail: any;
                try {
                  const resp: any = await sdk.data('get_image', { file: fileParam });
                  detail = resp;
                } catch {
                  detail = undefined;
                }
                const localPath = await ensureLocalFile({
                  kind: 'image',
                  file: detail?.file || seg.data?.file,
                  url: seg.data?.url || detail?.url,
                  filenameHint: detail?.file_name || seg.data?.file,
                });
                if (localPath) {
                  seg.data.path = localPath;
                  // 为兼容旧逻辑，仍保留 cache_path 字段
                  seg.data.cache_path = localPath;
                }
                if (!seg.data.url && detail?.url) {
                  seg.data.url = detail.url;
                }
              } catch {
              }
            }));
          }

          // 视频：如果只有 URL，则下载到本地缓存
          const videoSegments = msg.message.filter((s: any) => s.type === 'video');
          if (videoSegments.length > 0) {
            await Promise.all(videoSegments.map(async (seg: any) => {
              try {
                const localPath = await ensureLocalFile({
                  kind: 'video',
                  file: seg.data?.file,
                  url: seg.data?.url,
                  filenameHint: seg.data?.file,
                });
                if (localPath) {
                  seg.data.path = localPath;
                }
              } catch {
              }
            }));
          }

          // 语音：获取 NapCat 返回的本地路径，并通过 fileCache 统一成本地文件
          const recordSegments = msg.message.filter((s: any) => s.type === 'record');
          if (recordSegments.length > 0) {
            await Promise.all(recordSegments.map(async (seg: any) => {
              try {
                const response: any = await sdk.data('get_record', { file: seg.data?.file, out_format: 'mp3' });
                const detail = response;
                if (detail) {
                  const localPath = await ensureLocalFile({
                    kind: 'record',
                    file: detail.file,
                    url: seg.data?.url,
                    filenameHint: seg.data?.file,
                  });
                  seg.data.path = localPath || detail.file;
                  seg.data.file_size = detail.file_size;
                }
              } catch {
                try {
                  const localPath = await ensureLocalFile({
                    kind: 'record',
                    file: seg.data?.path || seg.data?.file,
                    url: seg.data?.url,
                    filenameHint: seg.data?.file,
                  });
                  if (localPath) {
                    seg.data.path = localPath;
                  }
                } catch {
                }
              }
            }));
          }

          // 文件：先获取 NapCat 提供的下载信息，再统一缓存为本地文件路径
          const fileSegments = msg.message.filter((s: any) => s.type === 'file');
          if (fileSegments.length > 0) {
            await Promise.all(fileSegments.map(async (seg: any) => {
              try {
                const fileId = seg.data?.file_id;
                let detail: any;
                if (fileId) {
                  if (msg.message_type === 'group') {
                    // 群聊文件：使用 get_group_file_url
                    const resp: any = await sdk.data('get_group_file_url', {
                      group_id: msg.group_id!,
                      file_id: fileId,
                      busid: seg.data?.busid || 102,
                    });
                    detail = resp;
                  } else {
                    // 私聊文件：使用 get_file
                    const resp: any = await sdk.data('get_file', {
                      file_id: fileId,
                    });
                    detail = resp;
                  }
                }

                if (detail) {
                  const url = detail.url || detail.file_url || seg.data?.url;
                  if (detail.file_size) {
                    seg.data.file_size = detail.file_size;
                  }
                  if (detail.file_name && !seg.data.file) {
                    seg.data.file = detail.file_name;
                  }
                  if (url) {
                    seg.data.url = url;
                  }
                  const localPath = await ensureLocalFile({
                    kind: 'file',
                    file: detail.file,
                    url,
                    filenameHint: detail.file_name || seg.data.file,
                  });
                  if (localPath) {
                    seg.data.path = localPath;
                  }
                }

                if (!seg.data.path) {
                  const localPath = await ensureLocalFile({
                    kind: 'file',
                    file: seg.data?.path || seg.data?.file,
                    url: seg.data?.url,
                    filenameHint: seg.data?.file,
                  });
                  if (localPath) {
                    seg.data.path = localPath;
                  }
                }
              } catch {
              }
            }));
          }

          // 如果文件既没有本地路径也没有可用 URL，则跳过推送（过滤掉该消息）
          if (fileSegments.length > 0) {
            const unresolved = fileSegments.some((seg: any) => {
              const p = seg.data?.path;
              const u = seg.data?.url;
              const hasLocal = typeof p === 'string' && isLocalPath(p);
              const hasUrl = typeof u === 'string' && /^https?:\/\//i.test(u);
              return !(hasLocal || hasUrl);
            });
            if (unresolved) {
              if (process.env.LOG_LEVEL === 'debug') {
                log.warn({ files: fileSegments.map((s: any) => s.data) }, '跳过推送：文件未就绪（无本地路径/URL）');
              }
              return; // 不推送该条消息
            }
          }

          await streamInstance.push(ev as MessageEvent, replyContext);
        }
      } catch (err) {
        log.error({ err }, '消息流推送失败');
      }
    }
  });

  // 监听通知事件
  sdk.on.notice(async (ev: any) => {
    const isPoke = ev && ev.notice_type === 'notify' && ev.sub_type === 'poke';

    if (isPoke) {
      const scene = ev.group_id ? 'group' : 'friend';
      const summary = {
        scene,
        group_id: ev.group_id,
        user_id: ev.user_id,
        target_id: ev.target_id,
        self_id: ev.self_id,
      };

      // 结构化日志：谁在什么场景戳了谁
      log.info(summary, '收到戳一戳通知');

      // 推送到消息流（如果启用）
      if (sdk.stream) {
        try {
          const streamInstance = sdk.stream.getInstance();
          if (streamInstance && typeof (streamInstance as any).pushNotice === 'function') {
            await (streamInstance as any).pushNotice(ev);
          }
        } catch (err) {
          log.error({ err, notice_type: ev.notice_type, sub_type: ev.sub_type }, '戳一戳通知推流失败');
        }
      }
    } else if (process.env.LOG_LEVEL === 'debug') {
      // 其他通知在 debug 模式下仍打印简要信息
      log.debug({
        notice_type: ev.notice_type,
        sub_type: ev.sub_type,
        group_id: ev.group_id,
        user_id: ev.user_id,
        target_id: ev.target_id,
      }, '收到通知');
    }
  });

  // 监听请求事件
  sdk.on.request(async (ev: any) => {
    if (process.env.LOG_LEVEL === 'debug') {
      log.debug({ request_type: ev.request_type }, '收到请求');
    }
  });

  // 错误处理
  sdk.on.error((err) => {
    log.error({ err }, '❌ SDK 错误');
  });

  // 连接关闭
  sdk.on.close((code, reason) => {
    log.warn({ code, reason }, '❌ 连接关闭');
  });

  // 优雅退出
  const cleanup = async () => {
    log.info('正在关闭...');
    await sdk.dispose();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  log.info('🚀 NapCat 适配器已启动');
  log.info('按 Ctrl+C 退出');
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
