import { formatI18nTemplate, resolveI18nLocale, type I18nLocale } from './index.js';

type Catalog = Record<string, string>;

const ZH_CN: Catalog = Object.freeze({
  enqueue: 'DelayJobQueue: 入队任务',
  removed: 'DelayJobQueue: 删除任务',
  worker_start_skipped_missing_run_job: 'DelayJobQueue: 缺少 runJob 回调，跳过 worker 启动',
  drop_overdue_job: 'DelayJobQueue: 丢弃过期任务',
  trigger: 'DelayJobQueue: 触发任务',
  run_job_failed: 'DelayJobQueue: 任务执行失败',
  worker_tick_failed: 'DelayJobQueue: worker tick 异常'
});

const EN_US: Catalog = Object.freeze({
  enqueue: 'DelayJobQueue: enqueue',
  removed: 'DelayJobQueue: removed',
  worker_start_skipped_missing_run_job: 'DelayJobQueue: runJob callback missing, skip worker start',
  drop_overdue_job: 'DelayJobQueue: drop overdue job',
  trigger: 'DelayJobQueue: trigger',
  run_job_failed: 'DelayJobQueue: runJob failed',
  worker_tick_failed: 'DelayJobQueue: worker tick failed'
});

function getCatalog(locale: I18nLocale): Catalog {
  if (locale === 'en-US') return EN_US;
  return ZH_CN;
}

export function tDelayJobQueue(
  key: string,
  params: Record<string, unknown> = {},
  locale = resolveI18nLocale()
): string {
  const catalog = getCatalog(locale);
  const template = catalog[key] || ZH_CN[key] || key;
  return formatI18nTemplate(template, params);
}
