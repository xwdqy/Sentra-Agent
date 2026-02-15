import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { getEnv } from './envHotReloader.js';

const logger = createLogger('WorldbookLoader');

function defaultRealLifeWorldbook() {
  return {
    meta: {
      title: '现实生活（默认世界书）',
      version: '1.0.0',
      description: '默认现实生活世界：现代社会常识、时间地点、基本规则与常用术语。',
      language: 'zh-CN',
      tags: ['real_life', 'modern', 'default']
    },
    entries: [
      {
        id: 'world_overview',
        name: '世界概况',
        keywords: ['现实', '现代', '地球', '社会', '城市', '生活'],
        content: [
          '- 这是一个与现实世界一致的现代社会背景。',
          '- 科技水平：互联网、智能手机普及；不存在公开可证实的魔法与超自然。',
          '- 日常交流遵循礼貌、法律与社会常识；冲突应尽量用沟通与规则解决。'
        ].join('\n'),
        priority: 90,
        enabled: true,
        tags: ['overview']
      },
      {
        id: 'time_location',
        name: '时间与地点默认',
        keywords: ['时间', '日期', '今天', '现在', '地点', '城市', '中国', '上海', '北京'],
        content: [
          '- 未特别说明时，默认地点为中国的一座现代城市。',
          '- 时间默认采用本地现实时间线（不进行架空年代设定）。',
          '- 若涉及具体时区：默认 Asia/Shanghai。'
        ].join('\n'),
        priority: 80,
        enabled: true,
        tags: ['defaults']
      },
      {
        id: 'common_terms',
        name: '常用术语与口径',
        keywords: ['常识', '术语', '解释', '定义', '互联网', '手机', '微信', '短信', '社交'],
        content: [
          '- 互联网：现代信息网络，常见应用包括搜索、社交、视频、地图、支付。',
          '- 智能手机：随身通讯与上网设备，可拍照、定位、支付。',
          '- 社交媒体：用于发布动态、聊天、关注他人。'
        ].join('\n'),
        priority: 60,
        enabled: true,
        tags: ['glossary']
      },
      {
        id: 'law_and_safety',
        name: '法律与安全',
        keywords: ['法律', '违法', '报警', '警察', '危险', '安全', '急救'],
        content: [
          '- 现实世界存在法律与执法机构；严重冲突或犯罪应视为风险事件。',
          '- 危险/紧急情况：优先保护人身安全，必要时报警/求助。',
          '- 涉及医疗：建议寻求专业医生/急救渠道。'
        ].join('\n'),
        priority: 70,
        enabled: true,
        tags: ['safety']
      }
    ]
  };
}

function ensureDefaultWorldbookFile(presetsDir: string): { rel: string; abs: string } | null {
  try {
    if (!presetsDir) return null;
    const worldDir = path.join(presetsDir, 'world');
    if (!fs.existsSync(worldDir)) {
      fs.mkdirSync(worldDir, { recursive: true });
    }
    const rel = 'world/worldbook.json';
    const abs = path.join(presetsDir, rel);
    if (!fs.existsSync(abs)) {
      const json = defaultRealLifeWorldbook();
      fs.writeFileSync(abs, JSON.stringify(json, null, 2), 'utf8');
      logger.info('已自动创建默认世界书文件', { fileName: rel });
    }
    return { rel, abs };
  } catch (e) {
    logger.warn('自动创建默认世界书失败', { err: String(e) });
    return null;
  }
}

export function loadWorldbookSync() {
  const fileNameRaw = getEnv('WORLDBOOK_FILE', 'world/worldbook.json');
  const fileName = typeof fileNameRaw === 'string' ? fileNameRaw.trim() : '';
  const dir = './agent-presets';

  if (!fileName) {
    return {
      fileName: '',
      path: '',
      isDefaultFallback: false,
      text: '',
      parsedJson: null
    };
  }

  const normalizeRel = (p: unknown) => String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');

  const fileRel = normalizeRel(fileName);
  const hasSubPath = fileRel.includes('/');

  // Prefer world/ folder when user provides only a bare file name.
  const candidates = hasSubPath
    ? [fileRel]
    : [`world/${fileRel}`, fileRel];

  // Backward-compatible fallbacks.
  candidates.push('world/worldbook.json');
  candidates.push('worldbook.json');

  try {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        return {
          fileName: '',
          path: '',
          isDefaultFallback: false,
          text: '',
          parsedJson: null
        };
      }
    }

    let usedPath = '';
    let usedFileName = '';
    let isDefaultFallback = false;

    for (let i = 0; i < candidates.length; i += 1) {
      const rel = normalizeRel(candidates[i]);
      if (!rel || rel.includes('..')) continue;
      const abs = path.join(dir, rel);
      if (fs.existsSync(abs)) {
        usedPath = abs;
        usedFileName = rel;
        isDefaultFallback = i > 0;
        break;
      }
    }

    if (!usedPath) {
      const created = ensureDefaultWorldbookFile(dir);
      if (!created || !created.abs || !fs.existsSync(created.abs)) {
        logger.warn('世界书文件不存在，将跳过注入', { file: path.join(dir, fileRel || '') });
        return {
          fileName: '',
          path: '',
          isDefaultFallback: false,
          text: '',
          parsedJson: null
        };
      }

      usedPath = created.abs;
      usedFileName = created.rel;
      isDefaultFallback = true;
    }

    const content = fs.readFileSync(usedPath, 'utf8');
    if (typeof logger.success === 'function') {
      logger.success(`成功加载世界书: ${usedFileName}${isDefaultFallback ? ' (fallback)' : ''}`);
    } else {
      logger.info('成功加载世界书', { fileName: usedFileName, fallback: isDefaultFallback });
    }

    const parsedJson = tryParseWorldbookJson(content, usedFileName);

    return {
      fileName: usedFileName,
      path: usedPath,
      isDefaultFallback,
      text: content,
      parsedJson
    };
  } catch (e) {
    logger.warn('加载世界书失败，将跳过注入', { err: String(e) });
    return {
      fileName: '',
      path: '',
      isDefaultFallback: false,
      text: '',
      parsedJson: null
    };
  }
}

export function tryParseWorldbookJson(text: unknown, fileName: string = ''): unknown {
  if (!text || typeof text !== 'string') return null;
  const ext = String(fileName || '').toLowerCase();
  if (!ext.endsWith('.json')) return null;

  const trimmed = text.trim();
  if (!trimmed) return null;

  const firstChar = trimmed[0];
  if (firstChar !== '{' && firstChar !== '[') return null;

  try {
    const obj = JSON.parse(trimmed);
    if (obj && (typeof obj === 'object' || Array.isArray(obj))) return obj;
    return null;
  } catch (e) {
    logger.warn('WorldbookLoader: JSON.parse 失败，将跳过注入', { err: String(e) });
    return null;
  }
}
