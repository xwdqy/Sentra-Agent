import { formatI18nTemplate, resolveI18nLocale, type I18nLocale } from './index.js';

type Catalog = Record<string, string>;

const ZH_CN: Catalog = Object.freeze({
  dispatch_missing_skip: 'DelayJobWorker: 缺少 dispatchToMainPipeline，跳过任务',
  due_trigger_session_loaded: 'DelayJobWorker: 到点触发会话已加载',
  due_trigger_session_missing: 'DelayJobWorker: 到点触发会话不存在',
  due_trigger_missing_session_id: 'DelayJobWorker: 到点触发缺少 delaySessionId',
  load_message_cache_failed: 'DelayJobWorker: loadMessageCache 失败',
  missing_sender_skip: 'DelayJobWorker: 缺少 senderId，跳过任务',
  dispatch_due_replay: 'DelayJobWorker: 分发到点回放任务到主流程',
  run_job_failed: 'DelayJobWorker: runJob 执行失败'
});

const EN_US: Catalog = Object.freeze({
  dispatch_missing_skip: 'DelayJobWorker: dispatchToMainPipeline missing, skip job',
  due_trigger_session_loaded: 'DelayJobWorker: due trigger session loaded',
  due_trigger_session_missing: 'DelayJobWorker: due trigger session missing',
  due_trigger_missing_session_id: 'DelayJobWorker: due trigger missing delaySessionId',
  load_message_cache_failed: 'DelayJobWorker: loadMessageCache failed',
  missing_sender_skip: 'DelayJobWorker: missing senderId, skip job',
  dispatch_due_replay: 'DelayJobWorker: dispatch due replay to main pipeline',
  run_job_failed: 'DelayJobWorker: runJob failed'
});

function getCatalog(locale: I18nLocale): Catalog {
  if (locale === 'en-US') return EN_US;
  return ZH_CN;
}

export function tDelayJobWorker(
  key: string,
  params: Record<string, unknown> = {},
  locale = resolveI18nLocale()
): string {
  const catalog = getCatalog(locale);
  const template = catalog[key] || ZH_CN[key] || key;
  return formatI18nTemplate(template, params);
}
