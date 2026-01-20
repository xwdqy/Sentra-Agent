/**
 * Sentra Emoji Manager
 * 
 * 功能：
 * - 加载本地表情包配置
 * - 提供表情包路径映射
 * - 生成表情包使用说明
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './logger.js';

const logger = createLogger('EmojiManager');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 表情包配置目录
const EMOJI_CONFIG_DIR = path.join(__dirname, 'emoji-stickers');
// 表情包图片目录
const EMOJI_DIR = path.join(EMOJI_CONFIG_DIR, 'emoji');
// 配置文件路径
const EMOJI_ENV_PATH = path.join(EMOJI_CONFIG_DIR, '.env');
// JSON 配置文件路径（支持 tags）
const EMOJI_JSON_PATH = path.join(EMOJI_CONFIG_DIR, 'stickers.json');

/**
 * 表情包配置缓存
 */
let emojiConfig = null;
let emojiItems = null;
let lastLoadTime = 0;
const CACHE_TTL = 60000; // 缓存 60 秒

function normalizeTags(tags, category) {
  const out = [];
  if (Array.isArray(tags)) {
    for (const t of tags) {
      const s = String(t || '').trim();
      if (s) out.push(s);
    }
  }
  if (out.length === 0 && category) {
    const c = String(category || '').trim();
    if (c) out.push(c);
  }
  return Array.from(new Set(out));
}

function loadFromJson() {
  try {
    if (!fs.existsSync(EMOJI_JSON_PATH)) return { map: {}, items: [] };
    const raw = fs.readFileSync(EMOJI_JSON_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const itemsRaw = Array.isArray(parsed?.items) ? parsed.items : [];
    const items = [];
    const map = {};

    for (const it of itemsRaw) {
      const filename = String(it?.filename || '').trim();
      const description = String(it?.description || '').trim();
      const enabled = it?.enabled !== false;
      if (!enabled) continue;
      if (!filename) continue;
      if (!description) continue;
      const tags = normalizeTags(it?.tags, it?.category);

      items.push({ filename, description, tags });
      map[filename] = description;
    }

    return { map, items };
  } catch (error) {
    logger.warn('Failed to load stickers.json, fallback to .env', error);
    return { map: {}, items: [] };
  }
}

/**
 * 加载表情包配置
 * @returns {Object} 表情包配置对象 { filename: description }
 */
function loadEmojiConfig() {
  const now = Date.now();
  
  // 使用缓存
  if (emojiConfig && emojiItems && (now - lastLoadTime) < CACHE_TTL) {
    return emojiConfig;
  }

  const config = {};
  const items = [];

  try {
    // 1) 优先加载 stickers.json（支持 tags）
    const json = loadFromJson();
    if (json.items.length > 0) {
      Object.assign(config, json.map);
      items.push(...json.items);
    }

    // 2) 如果 json 为空，则回退加载旧版 .env（filename=description）
    if (Object.keys(config).length === 0) {
      // 检查 .env 文件是否存在
      if (!fs.existsSync(EMOJI_ENV_PATH)) {
        logger.warn('.env file not found:', EMOJI_ENV_PATH);
        emojiConfig = {};
        emojiItems = [];
        lastLoadTime = now;
        return {};
      }

      // 读取 .env 文件
      const envContent = fs.readFileSync(EMOJI_ENV_PATH, 'utf-8');
      const lines = envContent.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();

        // 跳过空行和注释
        if (!trimmed || trimmed.startsWith('#')) {
          continue;
        }

        // 解析 KEY=VALUE 格式
        const equalIndex = trimmed.indexOf('=');
        if (equalIndex === -1) {
          continue;
        }

        const key = trimmed.substring(0, equalIndex).trim();
        const value = trimmed.substring(equalIndex + 1).trim();

        // 移除引号
        const cleanValue = value.replace(/^["']|["']$/g, '');

        if (key && cleanValue) {
          config[key] = cleanValue;
          items.push({ filename: key, description: cleanValue, tags: [] });
        }
      }
    }

    emojiConfig = config;
    emojiItems = items;
    lastLoadTime = now;

    logger.info(`Loaded ${Object.keys(config).length} emoji configs`);
    return config;

  } catch (error) {
    logger.error('Failed to load emoji config', error);
    emojiConfig = {};
    emojiItems = [];
    lastLoadTime = now;
    return {};
  }
}

/**
 * 获取表情包的绝对路径
 * @param {string} filename - 表情包文件名
 * @returns {string|null} 绝对路径，如果文件不存在则返回 null
 */
export function getEmojiPath(filename) {
  if (!filename) return null;

  const fullPath = path.join(EMOJI_DIR, filename);

  // 检查文件是否存在
  if (!fs.existsSync(fullPath)) {
    logger.warn(`Emoji file not found: ${filename}`);
    return null;
  }

  return path.resolve(fullPath);
}

/**
 * 获取所有可用的表情包列表
 * @returns {Array<{filename: string, description: string, path: string}>}
 */
export function getAvailableEmojis() {
  const config = loadEmojiConfig();
  const emojis = [];

  const byFilename = new Map();
  for (const it of Array.isArray(emojiItems) ? emojiItems : []) {
    if (!it?.filename) continue;
    byFilename.set(it.filename, it);
  }

  for (const [filename, description] of Object.entries(config)) {
    const fullPath = getEmojiPath(filename);
    if (fullPath) {
      const meta = byFilename.get(filename);
      emojis.push({
        filename,
        description,
        path: fullPath,
        tags: Array.isArray(meta?.tags) ? meta.tags : []
      });
    }
  }

  return emojis;
}

/**
 * 生成表情包使用说明（用于 AI 提示词）
 * @returns {string} Markdown 格式的表情包说明
 */
export function generateEmojiPrompt() {
  const config = loadEmojiConfig();
  const entries = Object.entries(config);

  if (entries.length === 0) {
    return '(No emoji stickers configured)';
  }

  const items = Array.isArray(emojiItems) ? emojiItems : [];
  const hasTags = items.some(it => Array.isArray(it?.tags) && it.tags.length);

  const toRow = (filename, description) => {
    const fullPath = getEmojiPath(filename);
    if (!fullPath) return '';
    return `| \`${fullPath}\` | ${description} | Use when context matches |\n`;
  };

  let prompt = '\n';
  prompt += '| Absolute Path | Description | Usage Scenario |\n';
  prompt += '|---------------|-------------|----------------|\n';

  if (!hasTags) {
    for (const [filename, description] of entries) {
      prompt += toRow(filename, description);
    }
    prompt += '\n**IMPORTANT**: Use the EXACT absolute path from the table above. Do NOT use placeholder paths like `/absolute/path/to/...`';
    return prompt;
  }

  const byTag = new Map();
  for (const it of items) {
    const filename = String(it?.filename || '').trim();
    const description = String(it?.description || '').trim();
    if (!filename || !description) continue;
    const tags = Array.isArray(it?.tags) ? it.tags : [];
    const bucket = tags.length ? tags : ['未分类'];
    for (const t of bucket) {
      const tag = String(t || '').trim() || '未分类';
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push([filename, description]);
    }
  }

  // 输出：先“未分类”，再按字母序
  const tags = Array.from(byTag.keys());
  tags.sort((a, b) => {
    if (a === '未分类') return -1;
    if (b === '未分类') return 1;
    return a.localeCompare(b);
  });

  let out = '\n';
  for (const tag of tags) {
    out += `\n### ${tag}\n\n`;
    out += '| Absolute Path | Description | Usage Scenario |\n';
    out += '|---------------|-------------|----------------|\n';
    for (const [filename, description] of byTag.get(tag)) {
      out += toRow(filename, description);
    }
  }

  out += '\n**IMPORTANT**: Use the EXACT absolute path from the table above. Do NOT use placeholder paths like `/absolute/path/to/...`';
  return out;
}

/**
 * 生成 Markdown 预览（用于文档）
 * @returns {string} Markdown 格式的表情包预览
 */
export function generateEmojiMarkdown() {
  const config = loadEmojiConfig();
  const entries = Object.entries(config);

  if (entries.length === 0) {
    return '(No emoji stickers configured)';
  }

  let markdown = '# Sentra Emoji Stickers\n\n';

  for (const [filename, description] of entries) {
    const fullPath = path.join(EMOJI_DIR, filename);
    const exists = fs.existsSync(fullPath);
    
    if (exists) {
      markdown += `## ${filename}\n\n`;
      markdown += `**Description**: ${description}\n\n`;
      markdown += `![${description}](${filename})\n\n`;
      markdown += '---\n\n';
    }
  }

  return markdown;
}

/**
 * 验证表情包文件名是否有效
 * @param {string} filename - 表情包文件名
 * @returns {boolean}
 */
export function isValidEmoji(filename) {
  if (!filename || typeof filename !== 'string') {
    return false;
  }

  const config = loadEmojiConfig();
  return filename in config && fs.existsSync(path.join(EMOJI_DIR, filename));
}

/**
 * 获取表情包目录路径
 * @returns {string}
 */
export function getEmojiDirectory() {
  return EMOJI_DIR;
}

/**
 * 重新加载表情包配置（清除缓存）
 */
export function reloadEmojiConfig() {
  emojiConfig = null;
  emojiItems = null;
  lastLoadTime = 0;
  return loadEmojiConfig();
}

// 默认导出
export default {
  getEmojiPath,
  getAvailableEmojis,
  generateEmojiPrompt,
  generateEmojiMarkdown,
  isValidEmoji,
  getEmojiDirectory,
  reloadEmojiConfig
};
