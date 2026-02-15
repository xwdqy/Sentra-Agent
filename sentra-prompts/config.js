/**
 * 配置加载模块
 * 负责加载和解析 JSON 配置
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 加载配置（JSON 映射：placeholder -> 函数名或静态值）
 * @param {string|null} configPath - JSON 文件路径（可选）
 * @returns {Object} 配置对象
 */
export function loadConfig(configPath = null) {
  const p = configPath || path.join(__dirname, 'sentra.config.json');
  if (!fs.existsSync(p)) {
    console.warn(`警告: 配置文件 ${p} 不存在`);
    return {};
  }
  try {
    const content = fs.readFileSync(p, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`错误: 解析配置文件失败:`, error.message);
    return {};
  }
}

/**
 * 加载 JSON 配置文件
 * @param {string} jsonPath - JSON 文件路径
 * @returns {Object} 配置对象
 */
export function loadJsonConfig(jsonPath) {
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`配置文件 ${jsonPath} 不存在`);
  }

  try {
    const content = fs.readFileSync(jsonPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`解析 JSON 配置文件失败: ${error.message}`);
  }
}

/**
 * 保存配置到 JSON 文件
 * @param {string} jsonPath - JSON 文件路径
 * @param {Object} config - 配置对象
 */
export function saveJsonConfig(jsonPath, config) {
  try {
    const content = JSON.stringify(config, null, 2);
    fs.writeFileSync(jsonPath, content, 'utf-8');
  } catch (error) {
    throw new Error(`保存 JSON 配置文件失败: ${error.message}`);
  }
}

/**
 * 获取所有可用的占位符列表
 * @returns {string[]} 占位符名称数组
 */
export function getAvailablePlaceholders() {
  const config = loadConfig();
  return Object.keys(config);
}
