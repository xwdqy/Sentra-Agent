import { parse, parseDate } from 'chrono-node';
import { DateTime } from 'luxon';
import RecognizersDateTime from '@microsoft/recognizers-text-date-time';
import RecognizersSuite from '@microsoft/recognizers-text-suite';

type Grain = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
type LuxonDateTime = ReturnType<typeof DateTime.now>;

type WindowAdaptConfig = {
  base: number;
  range: number;
  scale: number;
  minFraction: number;
  confidenceWeight: number;
};

type WindowCapsConfig = {
  minMs: number | null;
  maxMs: number | null;
};

type WindowConfig = {
  strategy: 'auto' | 'natural-only' | 'adaptive-only';
  preferRecognizerRange: boolean;
  naturalGrains: Grain[];
  adapt: WindowAdaptConfig;
  caps: WindowCapsConfig;
};

type WindowPayload = {
  kind: string;
  windowStart: number;
  windowEnd: number;
  windowSize: number;
  timeDiff: number;
};

type WindowTimestamps = { start: number; end: number };
type WindowFormatted = { start: string; end: string };

type ParseDetails = {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
  milliseconds: number;
  dayOfWeek: number;
  timezone: string;
  offset: number;
};

type MicrosoftResolutionValue = {
  value?: string;
  start?: string;
  end?: string;
  timex?: string;
  type?: string;
};

type MicrosoftResult = {
  text?: string;
  resolution?: { values?: MicrosoftResolutionValue[] };
};

type ChronoComponent = {
  isCertain?: ((field: string) => boolean) | boolean;
  date?: () => Date;
};

type ChronoResult = {
  text?: string;
  ref?: string;
  start?: ChronoComponent;
  end?: ChronoComponent;
};

type TimeParseOptions = {
  timezone?: string;
  language?: string;
  windowOptions?: Partial<WindowConfig>;
};

type TimeParseMeta = {
  source?: string;
  timezone?: string;
  primary?: MicrosoftResolutionValue;
  chronoResult?: ChronoResult;
  confidence?: number;
};

type TimeParseResult = {
  success: boolean;
  original: string;
  parsed?: Date;
  parsedDateTime?: LuxonDateTime;
  timezone?: string;
  confidence?: number;
  method?: string;
  timeExpression?: string;
  parseStartTimestamp?: number;
  parseEndTimestamp?: number;
  parseDuration?: number;
  chronoStartTimestamp?: number;
  chronoEndTimestamp?: number;
  chronoDuration?: number;
  parsedTimestamp?: number;
  parsedISO?: string | null;
  parsedLocal?: string;
  parsedChinaTime?: string;
  windowTimestamps?: WindowTimestamps;
  windowFormatted?: WindowFormatted;
  windowMeta?: WindowPayload;
  parsedDetails?: ParseDetails;
  error?: string;
  results?: TimeParseResult[];
  stats?: TimeParseStats;
  batchStartTimestamp?: number;
  batchEndTimestamp?: number;
  batchDuration?: number;
  totalTexts?: number;
};

type TimeParseStats = {
  total: number;
  successful: number;
  failed: number;
  successRate: number;
  averageConfidence: number;
  results: TimeParseResult[];
};

type TimeBatchResult = {
  results: TimeParseResult[];
  stats: TimeParseStats;
  batchStartTimestamp: number;
  batchEndTimestamp: number;
  batchDuration: number;
  totalTexts: number;
};

type TimeFormat = 'full' | 'iso' | 'date' | 'time' | 'datetime' | 'relative' | 'custom';

type JsonValue = string | number | boolean | null | undefined | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

/**
 * 时间解析工具类
 * 支持时间表达式的解析
 * 使用 Luxon 进行时间处理，简化时区和格式化操作
 */
export class TimeParser {
  windowConfig: WindowConfig;

  constructor(config: Partial<WindowConfig> = {}) {
    this.windowConfig = {
      strategy: 'auto', // auto | natural-only | adaptive-only
      preferRecognizerRange: true, // Microsoft 识别到区间时优先使用
      naturalGrains: ['day', 'week', 'month', 'year'],
      adapt: {
        base: 0.1,             // 最小比例
        range: 0.4,            // 变化幅度
        scale: 20,             // 时间差对窗口的影响尺度（越大越平缓）
        minFraction: 0.05,     // 半窗口的最小占比（相对粒度单位）
        confidenceWeight: 0.3  // 置信度对窗口的缩放权重（越大置信度越缩小）
      },
      caps: {
        minMs: 0,              // 窗口最小值（毫秒，0 表示不限定）
        maxMs: null            // 窗口最大值（毫秒，null 表示不限定）
      }
    };
    if (config && typeof config === 'object') {
      this.windowConfig = this._mergeDeep({}, this.windowConfig, config as JsonObject) as WindowConfig;
    }
  }

  // 更新窗口配置（深合并）
  setWindowConfig(partial: Partial<WindowConfig> = {}) {
    this.windowConfig = this._mergeDeep({}, this.windowConfig, partial as JsonObject) as WindowConfig;
  }

  // 计算时获取有效配置（在默认基础上应用 overrides）
  getEffectiveConfig(overrides: Partial<WindowConfig> = {}): WindowConfig {
    return this._mergeDeep({}, this.windowConfig, (overrides || {}) as JsonObject) as WindowConfig;
  }

  // 简单深合并
  _mergeDeep(target: JsonObject, ...sources: JsonObject[]): JsonObject {
    const isObj = (o: JsonValue): o is JsonObject => !!o && typeof o === 'object' && !Array.isArray(o);
    for (const src of sources) {
      if (!isObj(src)) continue;
      for (const [k, v] of Object.entries(src)) {
        if (isObj(v)) {
          if (!isObj(target[k])) target[k] = {};
          this._mergeDeep(target[k] as JsonObject, v);
        } else if (Array.isArray(v)) {
          target[k] = v.map((item) => item) as JsonValue[];
        } else {
          target[k] = v;
        }
      }
    }
    return target;
  }

  /**
   * 构建作用时间段（窗口）
   * 优先使用：
   *  - 解析结果自带的区间（start/end）
   *  - TIMEX 粒度（年/月/日/时/分/秒）对应的自然边界
   *  - 对于时间点（如“下午3点”），按粒度+自适应函数计算对称窗口
   */
  buildEffectiveWindow(
    targetDt: LuxonDateTime,
    nowDt: LuxonDateTime,
    meta: TimeParseMeta = {},
    cfg: WindowConfig = this.windowConfig
  ): WindowPayload {
    const tz = meta.timezone || targetDt.zoneName || 'UTC';
    const target = targetDt.setZone(tz);
    const now = nowDt.setZone(tz);
    const timeDiff = Math.abs(target.toMillis() - now.toMillis());

    // 1) 如果 Microsoft Recognizers 提供了 start/end，直接使用
    const preferRange = cfg?.preferRecognizerRange !== false;
    if (preferRange && meta.source === 'microsoft' && meta.primary) {
      const p = meta.primary;
      if (p.start && p.end && !/X/.test(p.start) && !/X/.test(p.end)) {
        let startDt = this.parseISOWithZone(p.start, tz);
        let endDt = this.parseISOWithZone(p.end, tz);
        if (startDt.isValid && endDt.isValid) {
          if (endDt.toMillis() <= startDt.toMillis()) {
            endDt = endDt.plus({ days: 1 });
          }
          return this._windowPayload(startDt, endDt, timeDiff, 'range');
        }
      }
    }

    // 2) 基于粒度计算自然边界或自适应窗口
    const grain = meta.source === 'microsoft'
      ? this.determineGrainFromMicrosoftPrimary(meta.primary)
      : this.determineGrainFromChrono(meta.chronoResult);

    // 若为日期级（>= day），使用自然边界 [startOf(grain), startOf(grain)+1*grain)
    const naturalSet = cfg?.naturalGrains || ['day', 'week', 'month', 'year'];
    const strategy = cfg?.strategy || 'auto';
    if (strategy !== 'adaptive-only' && naturalSet.includes(grain)) {
      const startDt = target.startOf(grain);
      let endDt;
      switch (grain) {
        case 'day':
          endDt = startDt.plus({ days: 1 });
          break;
        case 'week':
          endDt = startDt.plus({ weeks: 1 });
          break;
        case 'month':
          endDt = startDt.plus({ months: 1 });
          break;
        case 'year':
        default:
          endDt = startDt.plus({ years: 1 });
          break;
      }
      return this._windowPayload(startDt, endDt, timeDiff, `natural-${grain}`);
    }

    // 3) 时间点（<= hour）：构建基于粒度+自适应的对称窗口
    const unitMs = this.getUnitMsForGrain(grain);
    const halfWidthMs = this.computeAdaptiveHalfWidth(unitMs, timeDiff, meta?.confidence ?? 0.8, cfg);
    const startDt = target.minus({ milliseconds: halfWidthMs });
    const endDt = target.plus({ milliseconds: halfWidthMs });
    return this._windowPayload(startDt, endDt, timeDiff, `adaptive-${grain}`);
  }

  // 统一窗口载荷
  _windowPayload(startDt: LuxonDateTime, endDt: LuxonDateTime, timeDiff: number, kind: string): WindowPayload {
    return {
      kind,
      windowStart: startDt.toMillis(),
      windowEnd: endDt.toMillis(),
      windowSize: endDt.toMillis() - startDt.toMillis(),
      timeDiff
    };
  }

  // 解析 ISO 字符串并设置时区
  parseISOWithZone(isoText: string, zone: string): LuxonDateTime {
    let dt = DateTime.fromISO(isoText, { zone });
    if (!dt.isValid) {
      dt = DateTime.fromFormat(isoText, 'yyyy-MM-dd HH:mm:ss', { zone });
      if (!dt.isValid) dt = DateTime.fromFormat(isoText, 'yyyy-MM-dd', { zone });
    }
    return dt;
  }

  // 从 Microsoft Recognizers 的 value 推断粒度
  determineGrainFromMicrosoftPrimary(primary: MicrosoftResolutionValue = {}): Grain {
    const timex = primary.timex || '';
    const type = primary.type || '';
    // 基于 TIMEX 模式识别粒度
    if (/T\d{2}:\d{2}:\d{2}/.test(timex)) return 'second';
    if (/T\d{2}:\d{2}/.test(timex)) return 'minute';
    if (/T\d{2}/.test(timex) || /time/i.test(type)) return 'hour';
    if (/^\d{4}-W\d{2}/.test(timex)) return 'week';
    if (/^\d{4}-\d{2}-\d{2}$/.test(timex) || /date/i.test(type)) return 'day';
    if (/^\d{4}-\d{2}$/.test(timex)) return 'month';
    if (/^\d{4}$/.test(timex)) return 'year';
    // 兜底：若解析提供 start/end 则认为区间，否则按小时级
    if (primary.start && primary.end) return 'day';
    return 'hour';
  }

  // 从 chrono 解析结果推断粒度
  determineGrainFromChrono(result: ChronoResult = {}): Grain {
    try {
      const comp = result.start;
      if (comp && typeof comp.isCertain === 'function') {
        if (comp.isCertain('second')) return 'second';
        if (comp.isCertain('minute')) return 'minute';
        if (comp.isCertain('hour')) return 'hour';
        if (comp.isCertain('day')) return 'day';
        if (comp.isCertain('month')) return 'month';
        if (comp.isCertain('year')) return 'year';
      }
    } catch (_) {}
    // 尝试通过 JS Date 的分辨率推断
    try {
      const d = result.start?.date?.();
      if (d) {
        if (d.getSeconds() !== 0) return 'second';
        if (d.getMinutes() !== 0) return 'minute';
        if (d.getHours() !== 0) return 'hour';
      }
    } catch (_) {}
    return 'day';
  }

  // 不同粒度对应的毫秒值
  getUnitMsForGrain(grain: Grain): number {
    switch (grain) {
      case 'second': return 1000;
      case 'minute': return 60 * 1000;
      case 'hour': return 60 * 60 * 1000;
      case 'day': return 24 * 60 * 60 * 1000;
      case 'week': return 7 * 24 * 60 * 60 * 1000;
      case 'month': return 30 * 24 * 60 * 60 * 1000; // 作为近似，窗口起止使用自然边界
      case 'year': return 365 * 24 * 60 * 60 * 1000; // 近似
      default: return 60 * 60 * 1000;
    }
  }

  // 自适应半窗口宽度（毫秒）：基于粒度单位与当前时间差的平滑函数，范围约 [0.05, 0.5] * unit
  computeAdaptiveHalfWidth(
    unitMs: number,
    timeDiff: number,
    confidence = 0.8,
    cfg: WindowConfig = this.windowConfig
  ): number {
    const baseHalf = unitMs / 2;
    const base = cfg?.adapt?.base ?? 0.1;
    const range = cfg?.adapt?.range ?? 0.4;
    const scaleParam = cfg?.adapt?.scale ?? 20;
    const minFrac = cfg?.adapt?.minFraction ?? 0.05;
    const confW = cfg?.adapt?.confidenceWeight ?? 0.3;

    const scale = base + range * (1 - Math.exp(- timeDiff / (scaleParam * unitMs)));
    const confFactor = Math.max(0.5, Math.min(1.2, 1 - confW * (confidence - 0.5)));
    let half = baseHalf * scale * confFactor;

    const minHalf = unitMs * minFrac; // 至少 minFraction 的粒度
    half = Math.max(half, minHalf);

    const maxMs = cfg?.caps?.maxMs;
    if (typeof maxMs === 'number' && maxMs > 0) {
      half = Math.min(half, maxMs / 2);
    }
    const minMs = cfg?.caps?.minMs;
    if (typeof minMs === 'number' && minMs > 0) {
      half = Math.max(half, minMs / 2);
    }
    return half;
  }

  /**
   * 时间表达式解析
   * @param {string} text 包含时间表达式的文本
   * @param {Object} options 解析选项
   * @returns {Object} 解析结果
   */
  parseTimeExpression(text: string, options: TimeParseOptions = {}): TimeParseResult {
    const { timezone = 'Asia/Shanghai', language = 'en', windowOptions } = options;
    const tz: string = typeof timezone === 'string' && timezone ? timezone : 'UTC';
    const cfg = this.getEffectiveConfig(windowOptions);

    // 使用 Luxon 记录解析开始时间
    const parseStartTime = DateTime.now();

    try {
      // 如果指定中文，优先使用 Microsoft Recognizers 解析
      const useMicrosoft = typeof language === 'string' && /^(zh|zh-cn|zh_cn|cn)/i.test(language);
      if (useMicrosoft) {
        const chronoStart = DateTime.now();
        const msResults = RecognizersDateTime.recognizeDateTime(
          text,
          RecognizersSuite.Culture.Chinese
        ) as MicrosoftResult[];
        const chronoEnd = DateTime.now();

        const msResult = Array.isArray(msResults) && msResults.length > 0 ? msResults[0] : undefined;
        if (msResult) {
          const matchedText = typeof msResult.text === 'string' && msResult.text ? msResult.text : text;
          const rawValues = Array.isArray(msResult.resolution?.values) ? msResult.resolution?.values : [];
          const values: MicrosoftResolutionValue[] = rawValues.map((v) =>
            v && typeof v === 'object' ? (v as MicrosoftResolutionValue) : {}
          );

          // 选择优先含有 value 的项，其次 start，再不行取第一项
          const primary =
            values.find((v) => typeof v.value === 'string' && v.value && !/X/.test(v.value))
            || values.find((v) => typeof v.start === 'string' && v.start && !/X/.test(v.start))
            || values[0];

          if (primary) {
            let isoText = primary.value || primary.start || '';
            let parsedDateTime = DateTime.fromISO(isoText, { zone: tz });
            if (!parsedDateTime.isValid && isoText) {
              // 尝试常见格式兜底
              parsedDateTime = DateTime.fromFormat(isoText, 'yyyy-MM-dd HH:mm:ss', { zone: tz });
              if (!parsedDateTime.isValid) {
                parsedDateTime = DateTime.fromFormat(isoText, 'yyyy-MM-dd', { zone: tz });
              }
            }

            if (parsedDateTime.isValid) {
              const parseEndTime = DateTime.now();
              const pseudoResult: ChronoResult = { text: matchedText, ref: text, start: { isCertain: true } };
              const confidenceVal = this.calculateConfidence(pseudoResult);

              // 计算作用时间段（基于 TIMEX 粒度与自适应窗口）
              const nowDt = DateTime.now().setZone(tz);
              const windowInfo = this.buildEffectiveWindow(parsedDateTime, nowDt, {
                source: 'microsoft',
                primary,
                timezone: tz,
                confidence: confidenceVal
              }, cfg);

              return {
                success: true,
                original: text,
                parsed: parsedDateTime.toJSDate(),
                parsedDateTime: parsedDateTime,
                timezone: tz,
                confidence: confidenceVal,
                method: 'microsoft-recognizers',
                timeExpression: matchedText,

                // 时间戳
                parseStartTimestamp: parseStartTime.toMillis(),
                parseEndTimestamp: parseEndTime.toMillis(),
                parseDuration: parseEndTime.diff(parseStartTime, 'milliseconds').milliseconds,
                chronoStartTimestamp: chronoStart.toMillis(),
                chronoEndTimestamp: chronoEnd.toMillis(),
                chronoDuration: chronoEnd.diff(chronoStart, 'milliseconds').milliseconds,

                // 格式化输出
                parsedTimestamp: parsedDateTime.toMillis(),
                parsedISO: parsedDateTime.toISO(),
                parsedLocal: parsedDateTime.toLocaleString(DateTime.DATETIME_FULL),
                parsedChinaTime: parsedDateTime.setZone('Asia/Shanghai').toFormat('yyyy-MM-dd HH:mm:ss'),

                // 作用时间段（两个形式）
                windowTimestamps: {
                  start: windowInfo.windowStart,
                  end: windowInfo.windowEnd
                },
                windowFormatted: {
                  start: DateTime.fromMillis(windowInfo.windowStart).setZone(tz).toFormat('yyyy-MM-dd HH:mm:ss'),
                  end: DateTime.fromMillis(windowInfo.windowEnd).setZone(tz).toFormat('yyyy-MM-dd HH:mm:ss')
                },
                windowMeta: windowInfo,

                // 详细信息
                parsedDetails: {
                  year: parsedDateTime.year,
                  month: parsedDateTime.month,
                  day: parsedDateTime.day,
                  hours: parsedDateTime.hour,
                  minutes: parsedDateTime.minute,
                  seconds: parsedDateTime.second,
                  milliseconds: parsedDateTime.millisecond,
                  dayOfWeek: parsedDateTime.weekday,
                  timezone: parsedDateTime.zoneName,
                  offset: parsedDateTime.offset
                }
              };
            }
          }
          // 若无法从 Recognizers 解析出有效时间，则回退到 chrono
        }
      }

      // 使用 chrono-node 解析时间（默认/回退）
      const chronoStart = DateTime.now();
      const parsed = parse(text, new Date()) as ChronoResult[];
      const chronoEnd = DateTime.now();

      // 记录解析完成时间
      const parseEndTime = DateTime.now();

      if (Array.isArray(parsed) && parsed.length > 0) {
        const result = parsed[0];
        if (!result) {
          return {
            success: false,
            original: text,
            parseStartTimestamp: parseStartTime.toMillis(),
            parseEndTimestamp: parseEndTime.toMillis(),
            parseDuration: parseEndTime.diff(parseStartTime, 'milliseconds').milliseconds,
            error: '未解析到有效的时间结果',
            method: 'chrono-node'
          };
        }
        // 将原生 Date 转换为 Luxon DateTime
        const startDate = result?.start?.date?.();
        if (!startDate) {
          return {
            success: false,
            original: text,
            parseStartTimestamp: parseStartTime.toMillis(),
            parseEndTimestamp: parseEndTime.toMillis(),
            parseDuration: parseEndTime.diff(parseStartTime, 'milliseconds').milliseconds,
            error: '未解析到有效的时间起点',
            method: 'chrono-node'
          };
        }
        const parsedDateTime = DateTime.fromJSDate(startDate).setZone(tz);
        // 计算作用时间段
        const nowDt = DateTime.now().setZone(tz);
        const confidenceVal = this.calculateConfidence(result);
        const windowInfo = this.buildEffectiveWindow(parsedDateTime, nowDt, {
          source: 'chrono',
          chronoResult: result,
          timezone,
          confidence: confidenceVal
        }, cfg);

        return {
          success: true,
          original: text,
          parsed: parsedDateTime.toJSDate(), // 保持兼容性
          parsedDateTime: parsedDateTime, // Luxon DateTime 对象
          timezone: tz,
          confidence: confidenceVal,
          method: 'chrono-node',
          timeExpression: typeof result.text === 'string' ? result.text : text,

          // 使用 Luxon 简化时间戳处理
          parseStartTimestamp: parseStartTime.toMillis(),
          parseEndTimestamp: parseEndTime.toMillis(),
          parseDuration: parseEndTime.diff(parseStartTime, 'milliseconds').milliseconds,
          chronoStartTimestamp: chronoStart.toMillis(),
          chronoEndTimestamp: chronoEnd.toMillis(),
          chronoDuration: chronoEnd.diff(chronoStart, 'milliseconds').milliseconds,

          // 使用 Luxon 简化格式化
          parsedTimestamp: parsedDateTime.toMillis(),
          parsedISO: parsedDateTime.toISO(),
          parsedLocal: parsedDateTime.toLocaleString(DateTime.DATETIME_FULL),
          parsedChinaTime: parsedDateTime.setZone('Asia/Shanghai').toFormat('yyyy-MM-dd HH:mm:ss'),

          // 作用时间段（两个形式）
          windowTimestamps: {
            start: windowInfo.windowStart,
            end: windowInfo.windowEnd
          },
          windowFormatted: {
            start: DateTime.fromMillis(windowInfo.windowStart).setZone(tz).toFormat('yyyy-MM-dd HH:mm:ss'),
            end: DateTime.fromMillis(windowInfo.windowEnd).setZone(tz).toFormat('yyyy-MM-dd HH:mm:ss')
          },
          windowMeta: windowInfo,

          // 使用 Luxon 简化详细信息提取
          parsedDetails: {
            year: parsedDateTime.year,
            month: parsedDateTime.month,
            day: parsedDateTime.day,
            hours: parsedDateTime.hour,
            minutes: parsedDateTime.minute,
            seconds: parsedDateTime.second,
            milliseconds: parsedDateTime.millisecond,
            dayOfWeek: parsedDateTime.weekday, // 1=Monday, 7=Sunday
            timezone: parsedDateTime.zoneName,
            offset: parsedDateTime.offset // 时区偏移（分钟）
          }
        };
      } else {
        const parseEndTime = DateTime.now();

        return {
          success: false,
          original: text,

          // 时间戳信息
          parseStartTimestamp: parseStartTime.toMillis(),
          parseEndTimestamp: parseEndTime.toMillis(),
          parseDuration: parseEndTime.diff(parseStartTime, 'milliseconds').milliseconds,

          error: '未找到可识别的时间表达式',
          method: 'chrono-node'
        };
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error('时间解析失败:', errMsg);
      const currentTime = DateTime.now();

      return {
        success: false,
        original: text,

        // 时间戳信息
        parseStartTimestamp: parseStartTime.toMillis(),
        parseEndTimestamp: currentTime.toMillis(),
        parseDuration: currentTime.diff(parseStartTime, 'milliseconds').milliseconds,

        error: errMsg,
        method: 'chrono-node'
      };
    }
  }

  /**
   * 批量时间表达式解析
   * @param {Array} texts 文本数组
   * @param {Object} options 解析选项
   * @returns {Object} 解析结果和统计信息
   */
  parseTimeBatch(texts: string[], options: TimeParseOptions = {}): TimeBatchResult {
    // 使用 Luxon 记录批量解析开始时间
    const batchStartTime = DateTime.now();

    console.log(`🔄 开始批量解析 ${texts.length} 个时间表达式...`);

    const results: TimeParseResult[] = [];

    for (let i = 0; i < texts.length; i++) {
      const text = texts[i] ?? '';
      console.log(`📝 解析第 ${i + 1}/${texts.length} 个: "${text}"`);

      const result = this.parseTimeExpression(text, options);
      results.push(result);
    }

    // 记录批量解析完成时间
    const batchEndTime = DateTime.now();
    const batchDuration = batchEndTime.diff(batchStartTime, 'milliseconds').milliseconds;

    const stats = this.getParseStats(results);

    console.log(`✅ 批量解析完成！总耗时: ${batchDuration}ms`);
    console.log(`📊 统计: 成功 ${stats.successful}/${stats.total} (成功率: ${stats.successRate.toFixed(1)}%)`);

    return {
      results,
      stats,
      batchStartTimestamp: batchStartTime.toMillis(),
      batchEndTimestamp: batchEndTime.toMillis(),
      batchDuration,
      totalTexts: texts.length
    };
  }

  /**
   * 格式化时间输出 - 使用 Luxon 简化格式化
   * @param {Date|DateTime} date 时间对象（支持原生 Date 或 Luxon DateTime）
   * @param {string} format 输出格式
   * @param {string} timezone 时区
   * @returns {string} 格式化的时间字符串
   */
  formatTime(
    date: Date | LuxonDateTime,
    format: TimeFormat = 'full',
    timezone: string = 'UTC'
  ): string {
    // 转换为 Luxon DateTime
    let dt: LuxonDateTime;
    const tz: string = typeof timezone === 'string' && timezone ? timezone : 'UTC';
    if (date instanceof DateTime) {
      dt = date.setZone(String(tz));
    } else if (date instanceof Date) {
      dt = DateTime.fromJSDate(date).setZone(String(tz));
    } else {
      return '无效时间';
    }

    if (!dt.isValid) {
      return '无效时间';
    }

    // 使用 Luxon 的便捷格式化方法
    switch (format) {
      case 'iso':
        return dt.toISO();
      case 'date':
        return dt.toLocaleString(DateTime.DATE_FULL);
      case 'time':
        return dt.toLocaleString(DateTime.TIME_WITH_SECONDS);
      case 'datetime':
        return dt.toLocaleString(DateTime.DATETIME_FULL);
      case 'relative':
        return this.getRelativeTimeString(dt);
      case 'custom':
        // 自定义格式示例: 'yyyy-MM-dd HH:mm:ss'
        return dt.toFormat('yyyy-MM-dd HH:mm:ss');
      case 'full':
      default:
        return dt.toLocaleString(DateTime.DATETIME_FULL);
    }
  }

  /**
   * 获取相对时间字符串 - 使用 Luxon 简化时间差计算
   * @param {Date|DateTime} date 目标时间（支持原生 Date 或 Luxon DateTime）
   * @returns {string} 相对时间描述
   */
  getRelativeTimeString(date: Date | LuxonDateTime): string {
    // 转换为 Luxon DateTime
    let dt: LuxonDateTime;
    if (date instanceof DateTime) {
      dt = date;
    } else if (date instanceof Date) {
      dt = DateTime.fromJSDate(date);
    } else {
      return '无效时间';
    }

    const now = DateTime.now();
    const diff = dt.diff(now, ['days', 'hours', 'minutes', 'seconds']);

    const diffMinutes = Math.floor(diff.as('minutes'));
    const diffHours = Math.floor(diff.as('hours'));
    const diffDays = Math.floor(diff.as('days'));

    if (Math.abs(diffMinutes) < 1) {
      return '刚刚';
    } else if (Math.abs(diffMinutes) < 60) {
      return diffMinutes > 0 ? `${diffMinutes}分钟后` : `${Math.abs(diffMinutes)}分钟前`;
    } else if (Math.abs(diffHours) < 24) {
      return diffHours > 0 ? `${diffHours}小时后` : `${Math.abs(diffHours)}小时前`;
    } else if (Math.abs(diffDays) < 7) {
      return diffDays > 0 ? `${diffDays}天后` : `${Math.abs(diffDays)}天前`;
    } else {
      return this.formatTime(dt, 'date');
    }
  }

  /**
   * 计算解析置信度
   * @param {Object} result chrono-node解析结果
   * @returns {number} 置信度 (0-1)
   */
  calculateConfidence(result: ChronoResult): number {
    if (!result || !result.start) {
      return 0;
    }

    // 基于匹配文本长度和位置计算置信度
    const matchedText = typeof result.text === 'string' ? result.text : '';
    const fullText = typeof result.ref === 'string' ? result.ref : '';
    const matchLength = matchedText.length;
    const totalLength = fullText.length || 1;

    // 匹配文本越长，置信度越高
    const lengthScore = Math.min(matchLength / totalLength, 1);

    // 匹配文本在开头或结尾，置信度更高
    const positionScore = fullText.startsWith(matchedText) || fullText.endsWith(matchedText) ? 1 : 0.8;

    // 基础置信度
    const start = result.start;
    const isCertain = typeof start?.isCertain === 'function'
      ? !!start.isCertain('day')
      : !!start?.isCertain;
    const baseConfidence = isCertain ? 0.9 : 0.7;

    return Math.min(baseConfidence * lengthScore * positionScore, 1);
  }

  /**
   * 获取解析统计
   * @param {Array} results 解析结果数组
   * @returns {Object} 统计信息
   */
  getParseStats(results: TimeParseResult[]): TimeParseStats {
    const total = results.length;
    const successful = results.filter(r => r.success).length;
    const failed = total - successful;

    const confidences: number[] = results
      .filter((r): r is TimeParseResult & { confidence: number } => r.success && typeof r.confidence === 'number')
      .map((r) => r.confidence);

    const averageConfidence = confidences.length > 0
      ? confidences.reduce((sum, conf) => sum + conf, 0) / confidences.length
      : 0;

    return {
      total,
      successful,
      failed,
      successRate: total > 0 ? (successful / total) * 100 : 0,
      averageConfidence,
      results
    };
  }

  /**
   * 验证时间表达式
   * @param {string} text 文本内容
   * @returns {boolean} 是否包含时间表达式
   */
  containsTimeExpression(text: string, options: TimeParseOptions = {}): boolean {
    const { language } = options;
    try {
      // 中文优先使用 Microsoft Recognizers
      if (typeof language === 'string' && /^(zh|zh-cn|zh_cn|cn)/i.test(language)) {
        const res = RecognizersDateTime.recognizeDateTime(text, RecognizersSuite.Culture.Chinese);
        return res && res.length > 0;
      }
      // 其他语言使用 chrono-node 检查
      const results = parse(text);
      return results && results.length > 0;
    } catch (error) {
      return false;
    }
  }
}

// 导出默认实例
export const timeParser = new TimeParser();
