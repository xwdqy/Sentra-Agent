/**
 * Sentra Sticker Image Manager
 *
 * Responsibilities:
 * - Load local sticker image config
 * - Resolve absolute sticker image paths
 * - Generate prompt-friendly sticker image catalog
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { resolveProjectAssetPath } from './pathResolver.js';

const logger = createLogger('StickerImageManager');
const STICKER_IMAGE_CONFIG_DIR = resolveProjectAssetPath('utils/emoji-stickers', {
  importMetaUrl: import.meta.url,
  probePaths: ['emoji', 'stickers.json', '.env'],
  probeMode: 'any',
  maxParentLevels: 4
});
const STICKER_IMAGE_DIR = path.join(STICKER_IMAGE_CONFIG_DIR, 'emoji');
const STICKER_IMAGE_ENV_PATH = path.join(STICKER_IMAGE_CONFIG_DIR, '.env');
const STICKER_IMAGE_JSON_PATH = path.join(STICKER_IMAGE_CONFIG_DIR, 'stickers.json');

type StickerImageItem = {
  filename: string;
  description: string;
  tags: string[];
};

type StickerImageConfig = Record<string, string>;

type StickerImageLoadResult = {
  map: StickerImageConfig;
  items: StickerImageItem[];
};

let stickerImageConfig: StickerImageConfig | null = null;
let stickerImageItems: StickerImageItem[] | null = null;
let lastLoadTime = 0;
const CACHE_TTL = 60000;

function normalizeTags(tags: unknown, category: unknown): string[] {
  const out: string[] = [];
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

function loadFromJson(): StickerImageLoadResult {
  try {
    if (!fs.existsSync(STICKER_IMAGE_JSON_PATH)) return { map: {}, items: [] };
    const raw = fs.readFileSync(STICKER_IMAGE_JSON_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const itemsRaw = Array.isArray(parsed?.items) ? parsed.items : [];
    const items: StickerImageItem[] = [];
    const map: StickerImageConfig = {};

    for (const it of itemsRaw) {
      const obj = it && typeof it === 'object' ? (it as Record<string, unknown>) : {};
      const filename = String(obj.filename || '').trim();
      const description = String(obj.description || '').trim();
      const enabled = obj.enabled !== false;
      if (!enabled) continue;
      if (!filename || !description) continue;
      const tags = normalizeTags(obj.tags, obj.category);
      items.push({ filename, description, tags });
      map[filename] = description;
    }

    return { map, items };
  } catch (error) {
    logger.warn('Failed to load stickers.json, fallback to .env', error);
    return { map: {}, items: [] };
  }
}

function loadStickerImageConfig(): StickerImageConfig {
  const now = Date.now();
  if (stickerImageConfig && stickerImageItems && (now - lastLoadTime) < CACHE_TTL) {
    return stickerImageConfig;
  }

  const config: StickerImageConfig = {};
  const items: StickerImageItem[] = [];

  try {
    const json = loadFromJson();
    if (json.items.length > 0) {
      Object.assign(config, json.map);
      items.push(...json.items);
    }

    // fallback for legacy config format: filename=description
    if (Object.keys(config).length === 0) {
      if (!fs.existsSync(STICKER_IMAGE_ENV_PATH)) {
        logger.warn('.env file not found:', STICKER_IMAGE_ENV_PATH);
        stickerImageConfig = {};
        stickerImageItems = [];
        lastLoadTime = now;
        return {};
      }

      const envContent = fs.readFileSync(STICKER_IMAGE_ENV_PATH, 'utf-8');
      const lines = envContent.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const equalIndex = trimmed.indexOf('=');
        if (equalIndex === -1) continue;

        const key = trimmed.substring(0, equalIndex).trim();
        const value = trimmed.substring(equalIndex + 1).trim();
        const cleanValue = value.replace(/^["']|["']$/g, '');

        if (key && cleanValue) {
          config[key] = cleanValue;
          items.push({ filename: key, description: cleanValue, tags: [] });
        }
      }
    }

    stickerImageConfig = config;
    stickerImageItems = items;
    lastLoadTime = now;
    logger.info(`Loaded ${Object.keys(config).length} sticker image configs from ${STICKER_IMAGE_CONFIG_DIR}`);
    return config;
  } catch (error) {
    logger.error('Failed to load sticker image config', error);
    stickerImageConfig = {};
    stickerImageItems = [];
    lastLoadTime = now;
    return {};
  }
}

export function getStickerImagePath(filename: string): string | null {
  if (!filename) return null;
  const fullPath = path.join(STICKER_IMAGE_DIR, filename);
  if (!fs.existsSync(fullPath)) {
    logger.warn(`Sticker image file not found: ${filename}`);
    return null;
  }
  return path.resolve(fullPath);
}

export function getAvailableStickerImages(): Array<{ filename: string; description: string; path: string; tags: string[] }> {
  const config = loadStickerImageConfig();
  const stickerImages: Array<{ filename: string; description: string; path: string; tags: string[] }> = [];

  const byFilename = new Map<string, StickerImageItem>();
  for (const it of Array.isArray(stickerImageItems) ? stickerImageItems : []) {
    if (it?.filename) byFilename.set(it.filename, it);
  }

  for (const [filename, description] of Object.entries(config)) {
    const fullPath = getStickerImagePath(filename);
    if (!fullPath) continue;
    const meta = byFilename.get(filename);
    stickerImages.push({
      filename,
      description,
      path: fullPath,
      tags: Array.isArray(meta?.tags) ? meta!.tags : []
    });
  }

  return stickerImages;
}

export function generateStickerImagePrompt(): string {
  const config = loadStickerImageConfig();
  const entries = Object.entries(config);
  if (entries.length === 0) {
    return '(No local sticker images configured)';
  }

  const items: StickerImageItem[] = Array.isArray(stickerImageItems) ? stickerImageItems : [];
  const hasTags = items.some((it) => Array.isArray(it.tags) && it.tags.length > 0);

  const toRow = (filename: string, description: string): string => {
    const fullPath = getStickerImagePath(filename);
    if (!fullPath) return '';
    return `| \`${fullPath}\` | ${description} | Use when context matches |\n`;
  };

  if (!hasTags) {
    let prompt = '\n';
    prompt += '| Absolute Path | Description | Usage Scenario |\n';
    prompt += '|---------------|-------------|----------------|\n';
    for (const [filename, description] of entries) {
      prompt += toRow(filename, description);
    }
    prompt += '\n**IMPORTANT**: For sticker output, use image segment with the EXACT absolute file path from the table above.';
    return prompt;
  }

  const byTag = new Map<string, Array<[string, string]>>();
  for (const it of items) {
    const filename = String(it?.filename || '').trim();
    const description = String(it?.description || '').trim();
    if (!filename || !description) continue;

    const tags = Array.isArray(it?.tags) ? it.tags : [];
    const bucket = tags.length > 0 ? tags : ['uncategorized'];
    for (const t of bucket) {
      const tag = String(t || '').trim() || 'uncategorized';
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push([filename, description]);
    }
  }

  const tags = Array.from(byTag.keys()).sort((a, b) => {
    if (a === 'uncategorized') return -1;
    if (b === 'uncategorized') return 1;
    return a.localeCompare(b);
  });

  let out = '\n';
  for (const tag of tags) {
    out += `\n### ${tag}\n\n`;
    out += '| Absolute Path | Description | Usage Scenario |\n';
    out += '|---------------|-------------|----------------|\n';
    const rows = byTag.get(tag) || [];
    for (const [filename, description] of rows) {
      out += toRow(filename, description);
    }
  }

  out += '\n**IMPORTANT**: For sticker output, use image segment with the EXACT absolute file path from the table above.';
  return out;
}

export function generateStickerImageMarkdown(): string {
  const config = loadStickerImageConfig();
  const entries = Object.entries(config);
  if (entries.length === 0) {
    return '(No local sticker images configured)';
  }

  let markdown = '# Sentra Sticker Images\n\n';
  for (const [filename, description] of entries) {
    const fullPath = path.join(STICKER_IMAGE_DIR, filename);
    if (!fs.existsSync(fullPath)) continue;

    markdown += `## ${filename}\n\n`;
    markdown += `**Description**: ${description}\n\n`;
    markdown += `![${description}](${filename})\n\n`;
    markdown += '---\n\n';
  }

  return markdown;
}

export function isValidStickerImage(filename: string): boolean {
  if (!filename || typeof filename !== 'string') return false;
  const config = loadStickerImageConfig();
  return filename in config && fs.existsSync(path.join(STICKER_IMAGE_DIR, filename));
}

export function getStickerImageDirectory(): string {
  return STICKER_IMAGE_DIR;
}

export function reloadStickerImageConfig(): StickerImageConfig {
  stickerImageConfig = null;
  stickerImageItems = null;
  lastLoadTime = 0;
  return loadStickerImageConfig();
}

export default {
  getStickerImagePath,
  getAvailableStickerImages,
  generateStickerImagePrompt,
  generateStickerImageMarkdown,
  isValidStickerImage,
  getStickerImageDirectory,
  reloadStickerImageConfig
};
