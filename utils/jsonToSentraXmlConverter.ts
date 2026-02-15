import { jsonToXMLLines } from './xmlUtils.js';
import { createLogger } from './logger.js';

const logger = createLogger('PresetXml');

type PresetLike = {
  meta?: Record<string, unknown> | unknown;
  parameters?: Record<string, unknown> | unknown;
  rules?: Array<Record<string, unknown>> | unknown;
  personality?: Record<string, unknown> | unknown;
  raw_preset_text?: string;
  [key: string]: unknown;
};

type WorldbookLike = {
  meta?: Record<string, unknown> | unknown;
  [key: string]: unknown;
};

/**
 * 将结构化的 Agent 角色卡 JSON 转换为 Sentra XML 协议中的 <sentra-agent-preset> 块
 *
 * @param {any} preset
 * @returns {string} XML 字符串（为空表示不注入）
 */
export function buildAgentPresetXml(preset: PresetLike | null | undefined): string {
  if (!preset || typeof preset !== 'object') return '';

  try {
    const lines: string[] = [];
    lines.push('<sentra-agent-preset>');

    if (preset.meta && typeof preset.meta === 'object') {
      lines.push('  <meta>');
      lines.push(...jsonToXMLLines(preset.meta, 2));
      lines.push('  </meta>');
    }

    if (preset.parameters && typeof preset.parameters === 'object') {
      lines.push('  <parameters>');
      lines.push(...jsonToXMLLines(preset.parameters, 2));
      lines.push('  </parameters>');
    }

    if (Array.isArray(preset.rules) && preset.rules.length > 0) {
      lines.push('  <rules>');
      preset.rules.forEach((rule: Record<string, unknown>, index: number) => {
        lines.push(`    <rule index="${index + 1}">`);
        lines.push(...jsonToXMLLines(rule, 3));
        lines.push('    </rule>');
      });
      lines.push('  </rules>');
    }

    lines.push('</sentra-agent-preset>');
    return lines.join('\n');
  } catch (e) {
    logger.warn('buildAgentPresetXml: 生成 XML 失败，跳过注入', { err: String(e) });
    return '';
  }
}

export function buildWorldbookXml(worldbook: WorldbookLike | null | undefined): string {
  if (!worldbook || typeof worldbook !== 'object') return '';

  try {
    const lines: string[] = [];
    lines.push('<sentra-worldbook>');
    lines.push(...jsonToXMLLines(worldbook, 1));
    lines.push('</sentra-worldbook>');
    return lines.join('\n');
  } catch (e) {
    logger.warn('buildWorldbookXml: 生成 XML 失败，跳过注入', { err: String(e) });
    return '';
  }
}

/**
 * 将 JSON 角色卡压缩成一段中文文本，用于：
 * - 上下文压缩系统提示中的 persona 追加
 * - 作为 MCP overlays/global 的简要人设描述
 *
 * @param {any} preset
 * @returns {string}
 */
export function formatPresetJsonAsPlainText(preset: PresetLike | null | undefined): string {
  if (!preset || typeof preset !== 'object') return '';

  const parts: string[] = [];
  const meta = preset.meta && typeof preset.meta === 'object' ? preset.meta as Record<string, unknown> : {};
  const parameters = preset.parameters && typeof preset.parameters === 'object' ? preset.parameters as Record<string, unknown> : {};

  if (meta.node_name) {
    parts.push(`角色节点：${meta.node_name}`);
  }
  if (meta.description) {
    parts.push(`角色描述：${meta.description}`);
  }
  if (meta.category) {
    parts.push(`角色分类：${meta.category}`);
  }

  const identity = parameters.Identity || parameters['身份_Identity'] || parameters['identity'] || null;
  if (identity && typeof identity === 'object') {
    const vals = Object.values(identity).filter(v => typeof v === 'string' && v.trim());
    if (vals.length > 0) {
      parts.push(`身份 / 职业：${vals.join('，')}`);
    }
  }

  const appearance = parameters.Appearance || parameters['外貌'] || null;
  if (appearance && typeof appearance === 'object') {
    const vals = Object.values(appearance).filter(v => typeof v === 'string' && v.trim());
    if (vals.length > 0) {
      parts.push(`外貌特征：${vals.join('，')}`);
    }
  }

  const personality = parameters.Personality || parameters['性格'] || preset.personality || null;
  if (personality && typeof personality === 'object') {
    const vals = Object.values(personality).filter(v => typeof v === 'string' && v.trim());
    if (vals.length > 0) {
      parts.push(`性格特征：${vals.join('，')}`);
    }
  }

  if (Array.isArray(preset.rules) && preset.rules.length > 0) {
    parts.push('行为规则：预设了多条事件触发规则，用于控制说话风格和触发条件。');
  }

  if (!parts.length && typeof preset.raw_preset_text === 'string') {
    return preset.raw_preset_text;
  }

  return parts.join('\n');
}

export function formatWorldbookJsonAsPlainText(worldbook: WorldbookLike | null | undefined): string {
  if (!worldbook || typeof worldbook !== 'object') return '';

  const parts: string[] = [];
  const meta = worldbook.meta && typeof worldbook.meta === 'object' ? worldbook.meta as Record<string, unknown> : {};

  if (meta.title) {
    parts.push(`世界书：${meta.title}`);
  }
  if (meta.description) {
    parts.push(`背景简介：${meta.description}`);
  }
  if (meta.version) {
    parts.push(`版本：${meta.version}`);
  }

  if (!parts.length) {
    try {
      const raw = JSON.stringify(worldbook);
      if (raw && raw.length <= 800) return raw;
    } catch {}
  }

  return parts.join('\n');
}
