import { formatI18nTemplate, resolveI18nLocale, type I18nLocale } from './index.js';

type Catalog = Record<string, string>;

const ZH_CN: Catalog = Object.freeze({
  embedding_client_reset: 'Embedding 客户端已重置（等待下次调用时重新初始化）',
  embedding_not_enabled_missing_key: 'Embedding 未启用: 缺少 EMBEDDING_API_KEY 或 API_KEY',
  embedding_enabled: 'Embedding 已启用: model={model}, baseURL={baseURL}',
  embedding_client_init_failed: '初始化 Embedding 客户端失败',
  embedding_similarity_compute: 'Embedding 相似度计算',
  embedding_similarity_incomplete_result: 'Embedding 相似度计算返回结果不完整，回退为纯时间聚合',
  embedding_similarity_failed: 'Embedding 相似度计算{reason}，回退为纯时间聚合 (attempt={attempt}/{maxAttempts}, timeoutMs={timeoutMs})',
  embedding_reason_timeout: '超时',
  embedding_reason_failed: '失败',

  bundle_append_empty_text: '聚合: 文本为空，直接追加 (sender={sender}, count={count})',
  bundle_low_similarity: '聚合: 语义相似度偏低 (sender={sender}, sim={sim}, violations={violations}/{maxLowSimCount})',
  bundle_low_similarity_split: '聚合: 检测到连续低相似度消息，当前会话将尽快收束，新消息转入延迟队列 (sender={sender}, pending={pending})',
  bundle_low_similarity_continue: '聚合: 相似度略低但未达分裂阈值，继续归入当前会话 (sender={sender}, sim={sim}, count={count})',
  bundle_similarity_good: '聚合: 语义相似度良好，追加到当前窗口 (sender={sender}, sim={sim}, count={count})',
  bundle_similarity_unavailable: '聚合: 相似度不可用，回退为时间聚合 (sender={sender}, count={count})',
  bundle_pending_collect_override: '延迟聚合(override): 进入聚合队列等待 (sender={sender})',
  bundle_start_new_window: '聚合: 启动新的聚合窗口 (sender={sender})',
  queue_bundle_reuse_window: '队列聚合: 复用现有窗口 (sender={sender}, count={count})',
  queue_bundle_start_window: '队列聚合: 启动新的聚合窗口 (sender={sender})',
  bundle_window_end: '聚合: 结束窗口 (sender={sender}, messages={messages}, reason={reason}, durationMs={durationMs}, idleMs={idleMs})',
  delayed_bundle_drain: '延迟聚合出队: sender={sender}, merged={merged}',
  delayed_bundle_requeue: '延迟聚合: 回灌待处理消息 (sender={sender}, pending={pending})'
});

const EN_US: Catalog = Object.freeze({
  embedding_similarity_compute: 'Embedding similarity compute'
});

function getCatalog(locale: I18nLocale): Catalog {
  if (locale === 'en-US') return EN_US;
  return ZH_CN;
}

export function tMessageBundler(
  key: string,
  params: Record<string, unknown> = {},
  locale = resolveI18nLocale()
): string {
  const catalog = getCatalog(locale);
  const template = catalog[key] || ZH_CN[key] || key;
  return formatI18nTemplate(template, params);
}
