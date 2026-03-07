// HTML to Desktop App Generator
// 基于 Electron 将 HTML/应用描述转换为完整的桌面应用项目
// 支持一体化流程：生成代码 → 安装依赖 → 打包 → 压缩
import path from 'node:path';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import logger from '../../src/logger/index.js';
import { config } from '../../src/config/index.js';
import { chatCompletion, chatCompletionStream } from '../../src/openai/client.js';
import { abs as toAbs, toPosix } from '../../src/utils/path.js';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ok, fail } from '../../src/utils/result.js';
import { countTokens, fitToTokenLimit } from '../../src/utils/tokenizer.js';

// 支持的框架列表
const FRAMEWORKS = new Set(['electron-vanilla', 'electron-react', 'electron-vue', 'vanilla', 'react', 'vue']);

const PLUGIN_FILE = fileURLToPath(import.meta.url);
const PLUGIN_DIR = path.dirname(PLUGIN_FILE);
const REPO_ROOT = path.resolve(PLUGIN_DIR, '..', '..');

function absFromRepoRoot(p) {
  const raw = String(p || '').trim();
  if (!raw) return REPO_ROOT;
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(REPO_ROOT, raw);
}

function isTimeoutError(e) {
  const msg = String(e?.message || e || '').toLowerCase();
  const code = String(e?.code || '').toUpperCase();
  return (
    code === 'ETIMEDOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    code === 'ECONNABORTED' ||
    msg.includes('timeout') ||
    msg.includes('timed out')
  );
}

function normalizeSentraProjectXmlText(raw) {
  const s0 = String(raw || '').trim();
  if (!s0) return '';
  const startReOnce = /<sentra_project\s*>/i;
  const startReAll = /<sentra_project\s*>/ig;
  const endRe = /<\/sentra_project\s*>/ig;

  const startIdx = s0.search(startReOnce);
  if (startIdx < 0) return s0;
  let s = s0.slice(startIdx);

  const ends = [...s.matchAll(endRe)];
  if (ends.length > 0) {
    const last = ends[ends.length - 1];
    const endIdx = last.index + String(last[0]).length;
    s = s.slice(0, endIdx);
  }

  // Remove duplicate root start tags (keep the first)
  const startMatches = [...s.matchAll(startReAll)];
  if (startMatches.length > 1) {
    const firstStart = startMatches[0].index;
    let out = s.slice(0, firstStart + String(startMatches[0][0]).length);
    out += s.slice(firstStart + String(startMatches[0][0]).length).replace(startReOnce, '');
    s = out;
  }

  // Remove duplicate close tags (keep the last)
  const closeTag = '</sentra_project>';
  const parts = s.split(closeTag);
  if (parts.length > 2) {
    s = parts.slice(0, -1).join('') + closeTag + parts[parts.length - 1];
  }

  return s.trim();
}

function checkProjectFiles(files) {
  if (!files || typeof files !== 'object') return { ok: false, error: '未解析到任何文件内容' };

  const requiredFiles = ['package.json', 'main.js', 'index.html'];
  const extracted = Object.keys(files);
  for (const rf of requiredFiles) {
    if (!files[rf]) {
      return { ok: false, error: `生成的项目结构不完整。已提取文件：${extracted.join(', ')}。缺少必要文件：${requiredFiles.join(', ')}` };
    }
  }

  // Basic path safety: disallow absolute paths and traversal
  for (const p of extracted) {
    const k = String(p || '').trim();
    if (!k) return { ok: false, error: '存在空文件路径' };
    if (k.includes('\u0000')) return { ok: false, error: `文件路径包含非法字符: ${k}` };
    if (path.isAbsolute(k) || /^[a-zA-Z]:[\\/]/.test(k)) return { ok: false, error: `禁止输出绝对路径文件: ${k}` };
    const segs = k.split(/[\\/]+/).filter(Boolean);
    if (segs.some((s) => s === '..')) return { ok: false, error: `禁止输出包含 .. 的文件路径: ${k}` };
  }

  let pkg;
  try {
    pkg = JSON.parse(String(files['package.json'] || ''));
  } catch {
    return { ok: false, error: 'package.json 不是合法 JSON' };
  }

  const mainOk = String(pkg?.main || '').trim() === 'main.js';
  if (!mainOk) return { ok: false, error: 'package.json 中 main 必须为 main.js' };

  const startOk = typeof pkg?.scripts?.start === 'string' && pkg.scripts.start.trim().length > 0;
  if (!startOk) return { ok: false, error: 'package.json 中缺少 scripts.start' };

  const buildOk = typeof pkg?.scripts?.build === 'string' && pkg.scripts.build.trim().length > 0;
  if (!buildOk) return { ok: false, error: 'package.json 中缺少 scripts.build（electron-builder）' };

  const hasElectron = !!pkg?.devDependencies?.electron;
  const hasBuilder = !!pkg?.devDependencies?.['electron-builder'];
  if (!hasElectron || !hasBuilder) return { ok: false, error: 'package.json 中 devDependencies 必须包含 electron 与 electron-builder' };

  return { ok: true };
}

function isProjectXmlReady(xmlText) {
  const xml = normalizeSentraProjectXmlText(xmlText);
  if (!isWellFormedXml(xml)) return false;
  try {
    const files = parseXmlProjectFiles(xml);
    return checkProjectFiles(files).ok === true;
  } catch {
    return false;
  }
}

async function checkElectronBuilderInstalled(projectPath) {
  try {
    const binBases = [
      { scope: 'project', base: path.join(projectPath, 'node_modules', '.bin') },
      { scope: 'root', base: path.join(REPO_ROOT, 'node_modules', '.bin') },
    ];
    const names = process.platform === 'win32'
      ? ['electron-builder.cmd', 'electron-builder.exe', 'electron-builder']
      : ['electron-builder'];

    for (const b of binBases) {
      for (const n of names) {
        const p = path.join(b.base, n);
        try {
          await fs.access(p);
          return { ok: true, path: p, scope: b.scope };
        } catch {
          // continue
        }
      }
    }
    return { ok: false, error: 'electron-builder binary not found (project node_modules/.bin nor repo root node_modules/.bin)' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function quoteCmd(s) {
  const v = String(s || '');
  if (!v) return v;
  if (v.startsWith('"') && v.endsWith('"')) return v;
  return /\s/.test(v) ? `"${v}"` : v;
}

function getInstallEnvOverrides() {
  return {
    NODE_ENV: 'development',
    npm_config_production: 'false',
    NPM_CONFIG_PRODUCTION: 'false',
    npm_config_ignore_scripts: 'false',
    NPM_CONFIG_IGNORE_SCRIPTS: 'false',
  };
}

function buildAdvice(kind, ctx = {}) {
  const tool = 'html_to_app';
  const base = {
    suggested_reply: '',
    next_steps: [],
    persona_hint: '你需要明确告诉用户当前是生成桌面应用项目的工具，优先收集缺失信息并给出可执行的下一步。',
    context: { tool, ...ctx },
  };

  if (kind === 'INVALID') {
    return {
      ...base,
      suggested_reply: '你的参数里缺少必要信息（例如 description/app_name/details）。请补充后我再为你生成完整的桌面应用项目。',
      next_steps: [
        '补充完整的 description（功能需求）与 details（UI/UX 细节）',
        '确认 app_name 只包含字母/数字/下划线/连字符',
      ],
    };
  }
  if (kind === 'PROJECT_EXISTS') {
    return {
      ...base,
      suggested_reply: '目标项目目录已存在。请更换 app_name，或先删除/清空现有目录后再生成。',
      next_steps: ['更换 app_name', '或删除现有项目目录后重试'],
    };
  }
  if (kind === 'INVALID_XML') {
    return {
      ...base,
      suggested_reply: '模型输出的 XML 不完整或不合法，导致无法解析出项目文件。我可以尝试继续拉取剩余内容，或者你也可以让我重新生成。',
      next_steps: [
        '确认模型输出必须只包含一个完整的 XML 根节点（无 Markdown、无解释文字）',
        '如仍失败，建议减少需求复杂度或拆分需求后重试',
      ],
    };
  }
  if (kind === 'INVALID_PROJECT') {
    return {
      ...base,
      suggested_reply: '生成的项目文件不完整或关键文件内容无法解析（例如 package.json 不是合法 JSON）。建议我重新生成，并强调必须包含必需文件。',
      next_steps: ['重新生成并确保包含 package.json / main.js / index.html', '确保 package.json 是合法 JSON 且 main 指向 main.js'],
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      ...base,
      suggested_reply: '生成或拉取代码超时了。你可以稍后重试，或降低需求复杂度/减少一次输出文件数量。',
      next_steps: ['稍后重试', '减少需求复杂度或拆分功能后重试'],
    };
  }
  if (kind === 'SYMLINK_DENIED') {
    return {
      ...base,
      suggested_reply: '打包失败的原因不是项目代码，而是当前 Windows 环境缺少“创建符号链接”的权限，electron-builder 在解压签名工具依赖时无法创建 symlink（winCodeSign 内含 darwin 目录的链接）。',
      next_steps: [
        '开启 Windows“开发人员模式”（Settings → Privacy & security → For developers → Developer Mode），然后重试打包',
        '或以管理员身份运行当前进程/终端后重试',
        '若在公司/受控电脑：让管理员在本地安全策略中授予“创建符号链接”权限（SeCreateSymbolicLinkPrivilege）',
      ],
    };
  }
  if (kind === 'PNPM_BUILD_SCRIPTS_IGNORED') {
    return {
      ...base,
      suggested_reply: '依赖安装看似成功，但 pnpm 出于安全策略忽略了部分依赖的构建脚本（尤其是 electron 的 postinstall），导致 electron 二进制未下载/未落盘，从而无法运行 electron .。',
      next_steps: [
        '在项目目录执行：pnpm approve-builds（勾选/允许 electron），然后删除 node_modules 并重新 pnpm install',
        '或在 package.json 增加 pnpm.onlyBuiltDependencies: ["electron"] 后再 pnpm install（适合自动化/CI）',
        '如果你不需要 pnpm：直接用 npm install（npm 默认会执行 electron 的 postinstall）',
      ],
    };
  }
  if (kind === 'MISSING_ELECTRON_BUILDER') {
    return {
      ...base,
      suggested_reply: '打包脚本里调用了 electron-builder，但当前项目依赖中没有可用的 electron-builder 可执行文件（通常是 devDependencies 没有被安装，或安装被“production 模式”跳过）。',
      next_steps: [
        '检查是否设置了 NODE_ENV=production 或 NPM_CONFIG_PRODUCTION=true（会导致 devDependencies 不安装）；清除后重新安装依赖',
        '在项目目录执行 npm install（推荐），确保安装 devDependencies 后再 npm run build',
        '如果必须使用 cnpm：尝试 cnpm install --production=false，然后再 cnpm run build',
      ],
    };
  }
  if (kind === 'ELECTRON_NOT_INSTALLED') {
    return {
      ...base,
      suggested_reply: '项目依赖安装后未检测到 Electron 二进制（node_modules/electron/dist 下缺少 electron.exe 等），因此无法开发运行，也无法让 electron-builder 推导 Electron 版本进行打包。通常原因是安装脚本（postinstall）被禁用/忽略。',
      next_steps: [
        '确认没有开启 ignore-scripts（例如环境变量 NPM_CONFIG_IGNORE_SCRIPTS=true 或 npm config ignore-scripts=true）；关闭后删除 node_modules 并重新安装依赖',
        '如果你使用 pnpm：执行 pnpm approve-builds 允许 electron，然后删除 node_modules 并重新 pnpm install',
        '若仍失败：删除 node_modules/electron 后重新安装（确保 postinstall 会下载 electron 二进制）',
      ],
    };
  }
  return {
    ...base,
    suggested_reply: '生成过程中出现异常。我可以根据报错信息调整提示词或缩小需求范围后重试。',
    next_steps: ['把报错信息发给我以便定位', '尝试重试或拆分需求'],
  };
}

function buildRunCmd(packageManager) {
  const pm = String(packageManager || 'npm').toLowerCase();
  const validPM = ['npm', 'pnpm', 'cnpm', 'yarn'].includes(pm) ? pm : 'npm';
  if (validPM === 'yarn') return { install: 'yarn install', start: 'yarn start', build: 'yarn build' };
  return { install: `${validPM} install`, start: `${validPM} start`, build: `${validPM} run build` };
}

async function checkElectronInstalled(projectPath) {
  try {
    const base = path.join(projectPath, 'node_modules', 'electron', 'dist');
    const candidates = process.platform === 'win32'
      ? [path.join(base, 'electron.exe')]
      : [path.join(base, 'electron'), path.join(base, 'Electron.app')];
    for (const p of candidates) {
      try {
        await fs.access(p);
        return { ok: true, path: p };
      } catch {
        // continue
      }
    }
    return { ok: false, error: 'electron binary not found under node_modules/electron/dist' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function normalizeFramework(fw) {
  const normalized = String(fw || 'vanilla').toLowerCase();
  if (normalized === 'vanilla' || normalized === 'html') return 'electron-vanilla';
  if (normalized === 'react') return 'electron-react';
  if (normalized === 'vue') return 'electron-vue';
  return FRAMEWORKS.has(normalized) ? normalized : 'electron-vanilla';
}

function generateSystemPromptXml(framework) {
  return `你是一个专业的 Electron 应用开发助手。请根据用户需求生成“可直接运行”的桌面应用项目代码。

框架类型：${framework}

## 输出协议（必须严格遵守，否则视为失败）

你必须只输出一个完整、可解析、可落盘的 XML 文档：

1) 输出必须以 <sentra_project> 开始，并以 </sentra_project> 结束。
2) XML 之外不得输出任何字符：禁止 Markdown、禁止代码块标记、禁止解释文字、禁止前后缀。
3) 根节点只能出现一次：禁止重复 <sentra_project> 或 </sentra_project>。

## XML 结构（严格）

<sentra_project>
  <file path="package.json"><![CDATA[...]]></file>
  <file path="main.js"><![CDATA[...]]></file>
  <file path="preload.js"><![CDATA[...]]></file>
  <file path="index.html"><![CDATA[...]]></file>
  <file path="renderer.js"><![CDATA[...]]></file>
  <file path="styles.css"><![CDATA[...]]></file>
  <file path="README.md"><![CDATA[...]]></file>
</sentra_project>

## 关键约束（必须满足）

- 每个文件内容必须放在 CDATA 内：<![CDATA[...]]>。
- 文件内容如果包含 “]]>”，必须拆分为多个 CDATA 段，例如：]]]]><![CDATA[>（避免 XML 断裂）。
- file.path 规则：
  - 只允许相对路径（例如 package.json、src/main.js）。
  - 禁止绝对路径（含盘符/根目录）。
  - 禁止出现 ..（路径穿越）。
- 必须生成且内容可用：package.json、main.js、index.html（缺一不可）。
- package.json 必须是合法 JSON，且 main === "main.js"。
- scripts 至少包含："start": "electron ."，并提供 build（electron-builder）。
- electron 与 electron-builder 必须在 devDependencies。
- 不要输出占位符 “...”，不要留 TODO/伪代码；所有文件必须可直接运行。

## 超长输出续写协议（continue）

如果你没能一次输出完整 XML：
- 当收到用户消息以 “continue” 开头时，只从中断处继续输出“剩余 XML”。
- 禁止重复输出 <sentra_project> 或 </sentra_project>。
- 禁止重头再输出已给出的文件。
- 优先补齐未闭合的 <file> 节点，并确保最终只出现一次 </sentra_project>。

当你已经输出过 </sentra_project> 时表示已完成：此后不得再输出任何内容。`;
}

// 生成系统提示词（引导 LLM 使用 Markdown 代码块输出）
function generateSystemPrompt(framework) {
  return `你是一个专业的 Electron 应用开发助手。请根据用户需求生成完整的桌面应用项目代码。

框架类型：${framework}

## 输出格式

请按以下格式输出各个文件的代码，每个文件使用独立的 Markdown 代码块：

### 文件：package.json
\`\`\`json
{
  "name": "app-name",
  "version": "1.0.0",
  ...
}
\`\`\`

### 文件：main.js
\`\`\`javascript
const { app, BrowserWindow } = require('electron');
...
\`\`\`

### 文件：preload.js
\`\`\`javascript
const { contextBridge } = require('electron');
...
\`\`\`

### 文件：index.html
\`\`\`html
<!DOCTYPE html>
<html>
...
</html>
\`\`\`

### 文件：renderer.js
\`\`\`javascript
// 渲染进程代码
...
\`\`\`

### 文件：styles.css
\`\`\`css
body {
  ...
}
\`\`\`

### 文件：README.md
\`\`\`markdown
# 项目名称
...
\`\`\`

## 必须生成的文件

1. **package.json**（必需）：
   - name、version、main (指向 main.js)
   - scripts: "start": "electron .", "build": "electron-builder"
   - devDependencies: electron 和 electron-builder（必须都在 devDependencies）
   - dependencies: 其他运行时依赖（如有需要）
   - 注意：electron 必须在 devDependencies，不能在 dependencies

2. **main.js**（必需）：
   - 创建 BrowserWindow
   - 加载 index.html
   - 处理应用生命周期
   - 配置安全选项（webPreferences）

3. **preload.js**（必需）：
   - 使用 contextBridge 暴露安全 API
   - 不要直接暴露 Node.js 模块

4. **index.html**（必需）：
   - 完整的 HTML5 文档结构
   - 引用 styles.css 和 renderer.js
   - 实现用户需求的界面

5. **renderer.js**（推荐）：
   - 界面交互逻辑
   - 使用 window.electronAPI 与主进程通信

6. **styles.css**（推荐）：
   - 美观的样式设计
   - 响应式布局

7. **README.md**（推荐）：
   - 项目说明
   - 安装和运行步骤

## 代码质量要求

- 代码规范、注释清晰（中文注释）
- 遵循 Electron 最佳安全实践
- 禁用 nodeIntegration，使用 contextBridge
- 使用现代 JavaScript（ES6+）
- 确保代码可直接运行

## 重要提示

- 每个文件必须使用 "### 文件：<文件名>" 标记
- 代码块必须指定语言（json/javascript/html/css/markdown）
- 不要添加额外的解释文字
- 确保所有文件路径引用正确
- package.json 中的依赖版本要兼容`;
}

// 生成用户提示词
function generateUserPrompt(description, details, htmlContent, features, opts = {}) {
  const outputFormat = String(opts?.outputFormat || '').toLowerCase();
  const isXml = outputFormat === 'xml';
  let prompt = `请生成一个桌面应用项目，需求如下：

## 主要功能需求
${description}`;

  // 细节要求（新增）
  if (details) {
    prompt += `\n\n## UI/UX 细节要求\n${details}`;
  }

  if (htmlContent) {
    if (isXml) {
      prompt += `\n\n## 已有的 HTML 代码\n请将以下 HTML 作为参考并整合进生成的项目文件（例如 index.html 或对应渲染层）。注意：你仍然必须只输出 XML，不要输出 Markdown 代码块。\n\n[HTML_BEGIN]\n${htmlContent}\n[HTML_END]`;
    } else {
      prompt += `\n\n## 已有的 HTML 代码\n请整合到项目中：\n\`\`\`html\n${htmlContent}\n\`\`\``;
    }
  }

  if (features && features.length > 0) {
    prompt += `\n\n## 功能特性\n${features.map(f => `- ${f}`).join('\n')}`;
  }

  prompt += `\n\n请严格按照上述需求和细节要求生成完整的项目文件。`;

  return prompt;
}

function diagnoseProjectXml(xmlText) {
  const raw = String(xmlText || '');
  const xml = String(xmlText || '').trim();
  const issues = [];

  const openRe = /<sentra_project\s*>/ig;
  const closeRe = /<\/sentra_project\s*>/ig;
  const openCount = (raw.match(openRe) || []).length;
  const closeCount = (raw.match(closeRe) || []).length;

  const fileOpenCount = (raw.match(/<file\b/ig) || []).length;
  const fileCloseCount = (raw.match(/<\/file\s*>/ig) || []).length;
  const cdataOpenCount = (raw.match(/<!\[CDATA\[/g) || []).length;
  const cdataCloseCount = (raw.match(/\]\]>/g) || []).length;

  // Best-effort path scan even when XML is not well-formed
  const pathRe = /<file\b[^>]*\bpath\s*=\s*("|')([^"']+)(\1)/ig;
  const badPaths = [];
  let pm;
  while ((pm = pathRe.exec(raw)) !== null) {
    const p = String(pm[2] || '').trim();
    if (!p) continue;
    if (p.includes('\u0000')) badPaths.push({ path: p, reason: '包含空字符' });
    else if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) badPaths.push({ path: p, reason: '绝对路径/盘符路径' });
    else if (p.split(/[\\/]+/).filter(Boolean).some((seg) => seg === '..')) badPaths.push({ path: p, reason: '包含 ..（路径穿越）' });
    if (badPaths.length >= 3) break;
  }

  if (!xml) issues.push({ code: 'EMPTY', message: '输出为空' });
  if (xml && !xml.startsWith('<')) issues.push({ code: 'NOT_XML', message: '输出不是以 < 开头，疑似夹杂了说明文字/Markdown' });

  if (openCount === 0) issues.push({ code: 'MISSING_ROOT_OPEN', message: '缺少 <sentra_project> 根开始标签' });
  if (closeCount === 0) issues.push({ code: 'MISSING_ROOT_CLOSE', message: '缺少 </sentra_project> 根结束标签' });
  if (openCount > 1) issues.push({ code: 'DUP_ROOT_OPEN', message: `重复根开始标签 <sentra_project>：${openCount} 次` });
  if (closeCount > 1) issues.push({ code: 'DUP_ROOT_CLOSE', message: `重复根结束标签 </sentra_project>：${closeCount} 次` });
  if (openCount > 0 && closeCount > 0 && closeCount < openCount) {
    issues.push({ code: 'UNBALANCED_ROOT', message: `根标签可能未闭合（open=${openCount}, close=${closeCount}）` });
  }

  if (fileOpenCount > 0 && fileCloseCount > 0 && fileCloseCount < fileOpenCount) {
    issues.push({ code: 'UNBALANCED_FILE_TAG', message: `<file> 节点可能未闭合（open=${fileOpenCount}, close=${fileCloseCount}）` });
  }
  if (cdataOpenCount > 0 && cdataCloseCount > 0 && cdataCloseCount < cdataOpenCount) {
    issues.push({ code: 'UNBALANCED_CDATA', message: `CDATA 可能未闭合（open=${cdataOpenCount}, close=${cdataCloseCount}）` });
  }
  if (badPaths.length > 0) {
    issues.push({
      code: 'ILLEGAL_PATH',
      message: `检测到疑似非法 file.path：${badPaths.map((x) => `${x.path}（${x.reason}）`).join('；')}`,
    });
  }

  let xmlValidate = null;
  try {
    xmlValidate = XMLValidator.validate(xml);
  } catch (e) {
    issues.push({ code: 'XML_VALIDATE_THROW', message: `XML 校验异常：${String(e?.message || e)}` });
  }
  if (xmlValidate !== true && xmlValidate) {
    const err = (typeof xmlValidate === 'object') ? xmlValidate : { message: String(xmlValidate) };
    const line = err?.line ?? err?.err?.line;
    const col = err?.col ?? err?.err?.col;
    const msg = err?.message || err?.err?.message || 'XML 不合法';
    const pos = (Number.isFinite(line) && Number.isFinite(col)) ? `（line ${line}, col ${col}）` : '';
    issues.push({ code: 'INVALID_XML', message: `${msg}${pos}` });
  }

  if (xmlValidate === true) {
    try {
      const files = parseXmlProjectFiles(xml);
      const check = checkProjectFiles(files);
      if (!check?.ok) {
        issues.push({ code: 'INVALID_PROJECT', message: String(check?.error || '项目结构不完整') });
      }
    } catch (e) {
      issues.push({ code: 'PARSE_XML_FILES_FAIL', message: `解析文件节点失败：${String(e?.message || e)}` });
    }
  }

  const summary = issues.length
    ? issues.map((x) => `- ${x.message}`).join('\n')
    : '- 未发现明显问题（但仍未通过完整性检查）';

  return { issues, summary, openCount, closeCount, isWellFormed: xmlValidate === true };
}

function buildContinuePrompt({ diagnosis }) {
  const diagText = String(diagnosis?.summary || '').trim();
  return `continue\n\n你上一次的输出未通过校验，请你只从中断处继续补齐剩余 XML（不要重头生成）。\n\n必须遵守：\n- 禁止输出任何非 XML 字符（禁止 Markdown/解释文字/代码块标记）\n- 禁止重复输出 <sentra_project> 或 </sentra_project>\n- 优先补齐未闭合的 <file> 节点，最后只输出一次 </sentra_project>\n\n当前诊断：\n${diagText || '- 无'}\n\n现在开始输出：只输出剩余 XML。`;
}

// 从 Markdown 响应中提取文件
function parseMarkdownFiles(content) {
  const files = {};

  // 匹配 "### 文件：filename" 后面跟着的代码块
  const filePattern = /###\s*文件[：:](\S+)\s*```(\w+)?\s*([\s\S]*?)```/g;

  let match;
  while ((match = filePattern.exec(content)) !== null) {
    const filename = match[1].trim();
    const code = match[3].trim();
    files[filename] = code;
  }

  return files;
}

function isWellFormedXml(content) {
  const s = String(content || '').trim();
  if (!s) return false;
  if (!s.startsWith('<')) return false;
  const res = XMLValidator.validate(s);
  return res === true;
}

function mergeTextWithOverlap(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (!left) return right;
  if (!right) return left;
  if (left.includes(right)) return left;

  const maxCheck = Math.min(left.length, right.length, 8192);
  const leftTail = left.slice(left.length - maxCheck);
  let best = 0;
  const maxOverlap = Math.min(leftTail.length, right.length);
  for (let k = 1; k <= maxOverlap; k += 1) {
    if (leftTail.slice(leftTail.length - k) === right.slice(0, k)) best = k;
  }
  return left + right.slice(best);
}

function parseXmlProjectFiles(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    cdataPropName: '#cdata',
    preserveOrder: false,
    parseTagValue: false,
    trimValues: false,
  });
  const obj = parser.parse(String(xml || '').trim());
  const root = obj?.sentra_project || obj?.sentraProject || obj?.project || obj;
  let nodes = root?.file || root?.files?.file;
  if (!nodes) return {};
  if (!Array.isArray(nodes)) nodes = [nodes];

  const out = {};
  for (const n of nodes) {
    const p = String(n?.['@_path'] || n?.path || '').trim();
    if (!p) continue;
    const raw = (typeof n === 'string')
      ? n
      : (typeof n?.['#cdata'] === 'string' ? n['#cdata'] : (typeof n?.['#text'] === 'string' ? n['#text'] : ''));
    out[p] = String(raw || '');
  }
  return out;
}

async function collectXmlWithContinue({
  messages,
  temperature,
  apiKey,
  baseURL,
  model,
  omitMaxTokens,
  maxContinueCalls,
  onStream,
}) {
  const convo = Array.isArray(messages) ? [...messages] : [];
  const firstStream = await chatCompletionStream({
    messages: convo,
    temperature,
    apiKey,
    baseURL,
    model,
    omitMaxTokens,
    onDelta: (delta, content) => {
      if (typeof onStream === 'function') {
        try { onStream({ type: 'delta', delta, content }); } catch { }
        try { onStream({ type: 'llm_delta', stage: 'first', delta, content }); } catch { }
      }
    },
  });
  const firstText = String(firstStream?.content || '');
  convo.push({ role: 'assistant', content: firstText });
  let acc = firstText;
  let candidate = normalizeSentraProjectXmlText(acc);

  let used = 0;
  const limit = Number.isFinite(maxContinueCalls) ? Math.max(0, maxContinueCalls) : 0;
  while (!isProjectXmlReady(candidate) && used < limit) {
    const diagnosis = diagnoseProjectXml(candidate || acc);
    if (typeof onStream === 'function') {
      try { onStream({ type: 'log', stage: 'diagnose', message: 'xml diagnosis', detail: diagnosis }); } catch { }
      try { onStream({ type: 'delta', delta: `\n[html_to_app][diagnose] xml diagnosis\n`, content: '' }); } catch { }
    }
    for (let i = 0; i < 2 && used < limit; i += 1) {
      if (typeof onStream === 'function') {
        try { onStream({ type: 'log', stage: 'continue', message: 'requesting continue', detail: { attempt: used + 1, maxContinueCalls: limit } }); } catch { }
        try { onStream({ type: 'delta', delta: `\n[html_to_app][continue] requesting continue (${used + 1}/${limit})\n`, content: '' }); } catch { }
      }
      convo.push({ role: 'user', content: buildContinuePrompt({ diagnosis }) });
      const r = await chatCompletionStream({
        messages: convo,
        temperature,
        apiKey,
        baseURL,
        model,
        omitMaxTokens,
        onDelta: (delta, content) => {
          if (typeof onStream === 'function') {
            try { onStream({ type: 'delta', delta, content }); } catch { }
            try { onStream({ type: 'llm_delta', stage: 'continue', delta, content }); } catch { }
          }
        },
      });
      const part = String(r?.content || '');
      convo.push({ role: 'assistant', content: part });
      acc = mergeTextWithOverlap(acc, String(part || ''));
      candidate = normalizeSentraProjectXmlText(acc);
      used += 1;
    }
  }
  return { xml: candidate, continueCalls: used, firstResp: firstStream };
}

// 验证提取的文件结构
function validateProjectFiles(files) {
  return checkProjectFiles(files).ok === true;
}

// 写入项目文件到磁盘
async function writeProjectFiles(projectPath, files) {
  await fs.mkdir(projectPath, { recursive: true });

  const written = [];
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(projectPath, filePath);
    const dir = path.dirname(fullPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    written.push(filePath);
  }

  return written;
}

// 执行命令（同步）
function execCommand(command, cwd, description, envOverrides = {}) {
  logger.info?.(`html_to_app: ${description}`, { command, cwd });

  // 合并环境变量
  const env = { ...process.env, ...envOverrides };

  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
      env,
    });
    logger.debug?.(`html_to_app: ${description} 完成`, { output: output.slice(0, 500) });
    return { success: true, output };
  } catch (e) {
    // 捕获完整的错误信息：stdout + stderr
    const stdout = e?.stdout?.toString() || '';
    const stderr = e?.stderr?.toString() || '';
    const fullError = [stdout, stderr].filter(Boolean).join('\n') || String(e?.message || e);

    const symlinkDenied = /cannot create symbolic link/i.test(fullError)
      || /SeCreateSymbolicLinkPrivilege/i.test(fullError)
      || /\u7279\u6743/.test(fullError)
      || /\u6240\u9700\u7684\u7279\u6743/.test(fullError);

    logger.error?.(`html_to_app: ${description} 失败`, {
      error: String(e?.message || e),
      stdout: stdout.slice(0, 1000),
      stderr: stderr.slice(0, 1000),
      fullError: fullError.slice(0, 2000)
    });

    return {
      success: false,
      code: symlinkDenied ? 'SYMLINK_DENIED' : 'CMD_ERROR',
      error: fullError,
      stdout,
      stderr,
      advice: buildAdvice(symlinkDenied ? 'SYMLINK_DENIED' : 'ERR', { stage: 'execCommand', description, command, cwd })
    };
  }
}

// 自动安装依赖
async function installDependencies(projectPath, packageManager = 'npm', installArgs = '') {
  const pm = String(packageManager || 'npm').toLowerCase();
  const validPM = ['npm', 'pnpm', 'cnpm', 'yarn'].includes(pm) ? pm : 'npm';

  let installCmd;
  if (validPM === 'yarn') {
    installCmd = 'yarn install';
  } else {
    installCmd = `${validPM} install`;
  }

  if (installArgs) {
    installCmd += ` ${installArgs}`;
  }

  const installEnv = getInstallEnvOverrides();
  const r = execCommand(installCmd, projectPath, '安装依赖', installEnv);
  if (!r?.success) {
    if (validPM !== 'npm') {
      const fallback = execCommand('npm install', projectPath, '安装依赖(npm fallback)', installEnv);
      if (fallback?.success) {
        const check2 = await checkElectronInstalled(projectPath);
        if (check2.ok) {
          return {
            ...fallback,
            packageManagerUsed: 'npm',
            requestedPackageManager: packageManager,
            warning: `install failed with ${validPM}; used npm install fallback`,
          };
        }
      }
    }
    return r;
  }

  if (validPM === 'pnpm') {
    const output = String(r?.output || '');
    const ignored = /Ignored build scripts:/i.test(output) || /approve-builds/i.test(output);
    const check = await checkElectronInstalled(projectPath);
    if (ignored || !check.ok) {
      logger.warn?.('html_to_app: pnpm ignored build scripts, trying npm install fallback', {
        label: 'PLUGIN',
        projectPath,
        packageManager,
        ignored,
        electronCheck: check,
      });

      const fallback = execCommand('npm install', projectPath, '安装依赖(npm fallback)');
      if (fallback?.success) {
        const check2 = await checkElectronInstalled(projectPath);
        if (check2.ok) {
          return {
            ...fallback,
            packageManagerUsed: 'npm',
            requestedPackageManager: packageManager,
            warning: 'pnpm blocked build scripts; used npm install fallback to ensure electron postinstall runs',
          };
        }
      }

      return {
        success: false,
        code: 'PNPM_BUILD_SCRIPTS_IGNORED',
        error: 'pnpm ignored build scripts (electron postinstall), electron binary not installed',
        stdout: r?.output || '',
        detail: {
          pnpmIgnored: ignored,
          electronCheck: check,
          npmFallbackSuccess: !!fallback?.success,
          npmFallbackOutputPreview: String(fallback?.output || '').slice(0, 800),
        },
        advice: buildAdvice('PNPM_BUILD_SCRIPTS_IGNORED', { stage: 'installDependencies', projectPath, packageManager }),
      };
    }
  }

  const check = await checkElectronInstalled(projectPath);
  if (!check.ok) {
    if (validPM !== 'npm') {
      const fallback = execCommand('npm install', projectPath, '安装依赖(npm fallback)', installEnv);
      if (fallback?.success) {
        const check2 = await checkElectronInstalled(projectPath);
        if (check2.ok) {
          return {
            ...fallback,
            packageManagerUsed: 'npm',
            requestedPackageManager: packageManager,
            warning: `electron not installed after ${validPM} install; used npm install fallback`,
          };
        }
      }
    }

    return {
      success: false,
      code: 'ELECTRON_NOT_INSTALLED',
      error: 'electron binary not installed after dependency install',
      detail: { packageManager, electronCheck: check },
      advice: buildAdvice('ELECTRON_NOT_INSTALLED', { stage: 'installDependencies', projectPath, packageManager, electronCheck: check }),
    };
  }

  return r;
}

// 验证 package.json 中是否有 build script
async function checkBuildScript(projectPath) {
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    const pkgContent = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(pkgContent);

    if (!pkg.scripts?.build) {
      return { success: false, code: 'INVALID_PROJECT', error: 'package.json 中缺少 build script', advice: buildAdvice('INVALID_PROJECT', { stage: 'checkBuildScript', field: 'scripts.build' }) };
    }

    return { success: true, script: pkg.scripts.build };
  } catch (e) {
    return { success: false, code: 'INVALID_PROJECT', error: `读取 package.json 失败: ${e.message}`, advice: buildAdvice('INVALID_PROJECT', { stage: 'checkBuildScript' }) };
  }
}

// 自动打包应用
async function buildApp(projectPath, packageManager = 'npm', penv = {}) {
  // 验证 build script
  const checkResult = await checkBuildScript(projectPath);
  const checkOk = (checkResult && typeof checkResult === 'object')
    ? (checkResult.success === true || checkResult.valid === true)
    : false;
  if (!checkOk) {
    logger.error?.('html_to_app: 构建配置有误', { error: checkResult?.error });
    return { success: false, code: checkResult?.code || 'INVALID_PROJECT', error: checkResult?.error || '构建配置校验失败', advice: checkResult?.advice || buildAdvice('INVALID_PROJECT', { stage: 'buildApp' }) };
  }

  const echeck = await checkElectronInstalled(projectPath);
  if (!echeck.ok) {
    logger.error?.('html_to_app: electron 未安装或不可用', { projectPath, error: echeck.error });
    return {
      success: false,
      code: 'ELECTRON_NOT_INSTALLED',
      error: 'electron is not installed (binary missing under node_modules/electron/dist)',
      detail: echeck,
      advice: buildAdvice('ELECTRON_NOT_INSTALLED', { stage: 'buildApp', projectPath, packageManager, electronCheck: echeck }),
    };
  }

  const eb = await checkElectronBuilderInstalled(projectPath);
  if (!eb.ok) {
    logger.error?.('html_to_app: electron-builder 未安装或不可用', { projectPath, error: eb.error });
    return {
      success: false,
      code: 'MISSING_ELECTRON_BUILDER',
      error: 'electron-builder is not installed or not available in node_modules/.bin',
      detail: eb,
      advice: buildAdvice('MISSING_ELECTRON_BUILDER', { stage: 'buildApp', projectPath, packageManager }),
    };
  }

  const buildCmd = quoteCmd(eb.path);
  const r = execCommand(buildCmd, projectPath, '打包应用', penv);
  return { ...r, builderPath: eb.path, builderScope: eb.scope };
}

// 压缩目录为 zip
async function zipDirectory(sourceDir, outputZip) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputZip);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      logger.info?.('html_to_app: 压缩完成', { size: archive.pointer(), path: outputZip });
      resolve({ success: true, size: archive.pointer(), path: outputZip });
    });

    archive.on('error', (err) => {
      logger.error?.('html_to_app: 压缩失败', { error: String(err?.message || err) });
      reject(err);
    });

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// 查找打包输出目录中的文件
async function findBuildOutput(projectPath) {
  const distDir = path.join(projectPath, 'dist');
  try {
    const entries = await fs.readdir(distDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        const fullPath = path.join(distDir, entry.name);
        const stat = await fs.stat(fullPath);
        files.push({ name: entry.name, path: fullPath, size: stat.size });
      }
    }
    return files;
  } catch (e) {
    logger.warn?.('html_to_app: 读取打包输出失败', { error: String(e?.message || e) });
    return [];
  }
}

// 生成项目使用说明
function generateInstructions(projectPath, appName, automated = false, packageManager = 'npm') {
  const relativePath = path.relative(REPO_ROOT, projectPath);
  const cmds = buildRunCmd(packageManager);
  const pnpmHint = String(packageManager || '').toLowerCase() === 'pnpm'
    ? '\n\n⚠️ pnpm 提示：如果看到 “Ignored build scripts: electron”，请运行 pnpm approve-builds 允许 electron，然后删除 node_modules 并重新 pnpm install。'
    : '';

  if (automated) {
    return `✅ 已完成一体化打包流程！

📦 项目位置：${projectPath}

🎉 打包结果已自动生成并压缩

🚀 如需修改和重新开发：

1. 进入项目目录
   cd ${relativePath}

2. 开发运行
   ${cmds.start}

3. 重新打包
   ${cmds.build}

💡 提示：
- 打包结果已压缩为 zip 文件，可直接分发
- 修改代码后需要重新运行 ${cmds.build}
- 首次运行需要下载 Electron，可能需要几分钟`;
  }

  return `已成功生成桌面应用项目！

📦 项目位置：${projectPath}

🚀 快速开始：

1. 安装依赖
   cd ${relativePath}
   ${cmds.install}

2. 开发运行
   ${cmds.start}

3. 打包应用
   ${cmds.build}

打包后的应用将在 dist 目录中：
- Windows: dist/${appName} Setup.exe
- macOS: dist/${appName}.dmg
- Linux: dist/${appName}.AppImage

💡 提示：

- 首次运行需要下载 Electron，可能需要几分钟
- 打包需要较长时间，请耐心等待
- 修改代码后，重启应用即可看到效果${pnpmHint}`;
}

export default async function handler(args = {}, options = {}) {
  const emit = (payload) => {
    if (typeof options?.onStream === 'function') {
      try { options.onStream(payload); } catch { }
      if (payload && payload.type === 'log') {
        const msg = String(payload.message || '').trim();
        const stage = String(payload.stage || '').trim();
        const line = `[html_to_app]${stage ? `[${stage}]` : ''} ${msg}`.trim();
        if (line) {
          try { options.onStream({ type: 'delta', delta: `\n${line}\n`, content: '' }); } catch { }
        }
      }
    }
  };

  const penv = options?.pluginEnv || {};
  try {
    const description = String(args.description || '').trim();
    const appName = String(args.app_name || '').trim();
    const details = String(args.details || '').trim();

    if (!description) {
      return fail('description 参数必填', 'INVALID', { advice: buildAdvice('INVALID', { field: 'description' }) });
    }

    if (!appName) {
      return fail('app_name 参数必填', 'INVALID', { advice: buildAdvice('INVALID', { field: 'app_name' }) });
    }

    if (!details) {
      return fail('details 参数必填，请提供具体的 UI/UX 细节要求', 'INVALID', { advice: buildAdvice('INVALID', { field: 'details' }) });
    }

    // 验证应用名称格式（只允许字母、数字、连字符、下划线）
    if (!/^[a-zA-Z0-9_-]+$/.test(appName)) {
      return fail('app_name 只能包含字母、数字、连字符和下划线', 'INVALID', { advice: buildAdvice('INVALID', { field: 'app_name' }) });
    }

    let htmlContent = String(args.html_content || '').trim();
    const tokenizerModelRaw = penv.HTML_TO_APP_TOKENIZER_MODEL || process.env.HTML_TO_APP_TOKENIZER_MODEL;
    const tokenizerModel = String(tokenizerModelRaw || '').trim() || undefined;
    const maxInputTokensRaw = penv.HTML_TO_APP_MAX_INPUT_TOKENS ?? process.env.HTML_TO_APP_MAX_INPUT_TOKENS;
    const maxInputTokens = Number(maxInputTokensRaw);
    if (htmlContent && Number.isFinite(maxInputTokens) && maxInputTokens > 0) {
      const before = countTokens(htmlContent, { model: tokenizerModel });
      if (before > maxInputTokens) {
        const fitted = fitToTokenLimit(htmlContent, { model: tokenizerModel, maxTokens: maxInputTokens });
        htmlContent = fitted.text;
        logger.info?.('html_to_app: html_content truncated by token limit', {
          label: 'PLUGIN',
          tokenizerModel,
          beforeTokens: before,
          afterTokens: fitted.tokens,
          maxInputTokens,
          truncated: fitted.truncated,
        });
        emit({
          type: 'log',
          stage: 'truncate',
          message: 'html_content truncated by token limit',
          detail: { tokenizerModel, beforeTokens: before, afterTokens: fitted.tokens, maxInputTokens, truncated: fitted.truncated },
        });
      }
    }
    const framework = normalizeFramework(args.framework || penv.HTML_TO_APP_DEFAULT_FRAMEWORK);
    const features = Array.isArray(args.features) ? args.features : [];

    // === 2. 准备输出目录 ===
    const outputBaseRaw = penv.HTML_TO_APP_OUTPUT_DIR || 'artifacts/apps';
    const outputBase = absFromRepoRoot(outputBaseRaw);
    const projectPath = path.join(outputBase, appName);

    // 检查项目是否已存在
    try {
      await fs.access(projectPath);
      return fail(`项目已存在：${projectPath}。请使用不同的 app_name 或删除现有项目。`, 'PROJECT_EXISTS', { advice: buildAdvice('PROJECT_EXISTS', { projectPath }) });
    } catch {
      // 项目不存在，可以继续
    }

    // === 3. 调用 LLM 生成项目代码 ===
    logger.info?.('html_to_app: 开始生成项目代码', { appName, framework, hasDetails: !!details });
    emit({ type: 'log', stage: 'generate', message: 'start generating project code', detail: { appName, framework } });

    const outputFormat = String(penv.HTML_TO_APP_OUTPUT_FORMAT || process.env.HTML_TO_APP_OUTPUT_FORMAT || 'xml').toLowerCase();
    const useXml = outputFormat !== 'markdown';

    const systemPrompt = useXml ? generateSystemPromptXml(framework) : generateSystemPrompt(framework);
    const userPrompt = generateUserPrompt(description, details, htmlContent, features, { outputFormat: useXml ? 'xml' : 'markdown' });

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const apiKey = penv.HTML_TO_APP_API_KEY || process.env.HTML_TO_APP_API_KEY || config.llm.apiKey;
    const baseURL = penv.HTML_TO_APP_BASE_URL || process.env.HTML_TO_APP_BASE_URL || config.llm.baseURL;
    const model = penv.HTML_TO_APP_MODEL || process.env.HTML_TO_APP_MODEL || config.llm.model || 'gpt-4o';
    const maxContinueCalls = Number.parseInt(penv.HTML_TO_APP_MAX_CONTINUE_CALLS || process.env.HTML_TO_APP_MAX_CONTINUE_CALLS || '8', 10);

    let resp;
    let content = '';
    let files;

    try {
      if (useXml) {
        const gathered = await collectXmlWithContinue({
          messages,
          temperature: 0.3,
          apiKey,
          baseURL,
          model,
          omitMaxTokens: true,
          maxContinueCalls: Number.isFinite(maxContinueCalls) ? Math.max(0, maxContinueCalls) : 8,
          onStream: options?.onStream,
        });
        content = String(gathered.xml || '').trim();
        resp = gathered.firstResp;

        if (!isWellFormedXml(content)) {
          const diagnosis = diagnoseProjectXml(content);
          logger.error?.('html_to_app: XML 不完整或不合法', { usedContinueCalls: gathered.continueCalls, preview: content.slice(0, 500), diagnosis });
          return {
            success: false,
            code: 'INVALID_XML',
            error: `模型输出的 XML 不完整或不合法（已尝试 continue ${gathered.continueCalls} 次）。\n\n诊断摘要：\n${diagnosis.summary}`,
            advice: buildAdvice('INVALID_XML', { usedContinueCalls: gathered.continueCalls, diagnosis: diagnosis.issues?.slice(0, 6) })
          };
        }
        files = parseXmlProjectFiles(content);
      } else {
        resp = await chatCompletionStream({
          messages,
          temperature: 0.3,
          apiKey,
          baseURL,
          model,
          omitMaxTokens: true,
          onDelta: (delta, full) => {
            emit({ type: 'llm_delta', stage: 'markdown', delta, content: full });
            if (typeof options?.onStream === 'function') {
              try { options.onStream({ type: 'delta', delta, content: full }); } catch { }
            }
          },
        });
        content = String(resp?.content || '').trim();
        files = parseMarkdownFiles(content);
      }
    } catch (e) {
      const isTimeout = isTimeoutError(e);
      logger.error?.('html_to_app: LLM 调用失败', { error: String(e?.message || e), code: e?.code, stack: e?.stack });
      return {
        success: false,
        code: isTimeout ? 'TIMEOUT' : 'ERR',
        error: String(e?.message || e),
        advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { stage: 'chatCompletion' }),
      };
    }

    if (!validateProjectFiles(files)) {
      const extractedFiles = Object.keys(files || {});
      const check = checkProjectFiles(files);
      logger.error?.('html_to_app: 提取的文件不完整', { extractedFiles, reason: check?.error });
      return {
        success: false,
        code: 'INVALID_PROJECT',
        error: String(check?.error || `生成的项目结构不完整。已提取文件：${extractedFiles.join(', ')}`),
        advice: buildAdvice('INVALID_PROJECT', { extractedFiles, reason: check?.error })
      };
    }

    // === 4. 写入项目文件 ===
    logger.info?.('html_to_app: 开始写入项目文件', { projectPath, filesCount: Object.keys(files).length });
    emit({ type: 'log', stage: 'write_files', message: 'writing project files', detail: { projectPath, filesCount: Object.keys(files).length } });
    const writtenFiles = await writeProjectFiles(projectPath, files);
    emit({ type: 'log', stage: 'write_files', message: 'project files written', detail: { projectPath, writtenCount: writtenFiles.length } });

    // === 5. 可选：自动化流程（安装、打包、压缩）===
    const autoInstall = String(penv.HTML_TO_APP_AUTO_INSTALL || 'false').toLowerCase() === 'true';
    const autoBuild = String(penv.HTML_TO_APP_AUTO_BUILD || 'false').toLowerCase() === 'true';
    const autoZip = String(penv.HTML_TO_APP_AUTO_ZIP || 'false').toLowerCase() === 'true';
    const cleanBuild = String(penv.HTML_TO_APP_CLEAN_BUILD || 'false').toLowerCase() === 'true';
    const requestedPackageManager = penv.HTML_TO_APP_PACKAGE_MANAGER || 'npm';
    const installArgs = penv.HTML_TO_APP_INSTALL_ARGS || '';

    let effectivePackageManager = requestedPackageManager;

    let installResult = null;
    let buildResult = null;
    let zipResult = null;
    let buildFiles = [];

    if (autoInstall) {
      logger.info?.('html_to_app: 开始自动安装依赖', { packageManager: requestedPackageManager, projectPath });
      emit({ type: 'log', stage: 'install', message: 'installing dependencies', detail: { packageManager: requestedPackageManager, projectPath } });
      installResult = await installDependencies(projectPath, requestedPackageManager, installArgs);
      if (installResult?.success && installResult?.packageManagerUsed) {
        effectivePackageManager = installResult.packageManagerUsed;
      }
      emit({ type: 'log', stage: 'install', message: 'dependencies install finished', detail: { success: !!installResult?.success } });

      if (!installResult.success) {
        logger.warn?.('html_to_app: 依赖安装失败，跳过后续自动化步骤', { error: installResult.error });
        // 不返回错误，继续返回项目路径
      }
    }

    if (autoInstall && installResult?.success && autoBuild) {
      logger.info?.('html_to_app: 开始自动打包应用', { projectPath });
      emit({ type: 'log', stage: 'build', message: 'building app', detail: { projectPath } });

      // 准备环境变量（镜像和代理）
      const buildEnv = {};

      // Electron 镜像配置
      if (penv.HTML_TO_APP_ELECTRON_MIRROR) {
        buildEnv.ELECTRON_MIRROR = penv.HTML_TO_APP_ELECTRON_MIRROR;
      }

      if (penv.HTML_TO_APP_ELECTRON_BUILDER_BINARIES_MIRROR) {
        buildEnv.ELECTRON_BUILDER_BINARIES_MIRROR = penv.HTML_TO_APP_ELECTRON_BUILDER_BINARIES_MIRROR;
      }

      // 代理配置
      if (penv.HTML_TO_APP_HTTP_PROXY) {
        buildEnv.HTTP_PROXY = penv.HTML_TO_APP_HTTP_PROXY;
        buildEnv.http_proxy = penv.HTML_TO_APP_HTTP_PROXY;
      }

      if (penv.HTML_TO_APP_HTTPS_PROXY) {
        buildEnv.HTTPS_PROXY = penv.HTML_TO_APP_HTTPS_PROXY;
        buildEnv.https_proxy = penv.HTML_TO_APP_HTTPS_PROXY;
      }

      logger.info?.('html_to_app: 使用环境配置', {
        electronMirror: buildEnv.ELECTRON_MIRROR || 'default',
        binariesMirror: buildEnv.ELECTRON_BUILDER_BINARIES_MIRROR || 'default',
        httpProxy: buildEnv.HTTP_PROXY || 'none',
        httpsProxy: buildEnv.HTTPS_PROXY || 'none'
      });

      buildResult = await buildApp(projectPath, effectivePackageManager, buildEnv);
      emit({ type: 'log', stage: 'build', message: 'build finished', detail: { success: !!buildResult?.success } });

      if (buildResult.success) {
        buildFiles = await findBuildOutput(projectPath);
        logger.info?.('html_to_app: 打包完成', { filesCount: buildFiles.length });
        emit({ type: 'log', stage: 'build', message: 'build outputs collected', detail: { filesCount: buildFiles.length } });
      } else {
        const manualBuildCmd = buildResult?.builderPath
          ? quoteCmd(buildResult.builderPath)
          : 'electron-builder';
        logger.warn?.('html_to_app: 打包失败', {
          error: buildResult.error,
          stdout: buildResult.stdout?.slice(0, 500),
          stderr: buildResult.stderr?.slice(0, 500),
          tip: `请手动运行 ${manualBuildCmd} 查看详细错误`
        });
      }
    }

    if (buildResult?.success && autoZip) {
      logger.info?.('html_to_app: 开始压缩打包结果', { projectPath });
      emit({ type: 'log', stage: 'zip', message: 'zipping build outputs', detail: { projectPath } });
      const distDir = path.join(projectPath, 'dist');
      const zipPath = path.join(path.dirname(projectPath), `${appName}_build.zip`);

      try {
        zipResult = await zipDirectory(distDir, zipPath);
        emit({ type: 'log', stage: 'zip', message: 'zip finished', detail: { success: !!zipResult?.success, zipPath: zipResult?.path } });

        // 清理构建文件（可选）
        if (cleanBuild && zipResult.success) {
          try {
            await fs.rm(distDir, { recursive: true, force: true });
            logger.info?.('html_to_app: 已清理构建目录', { distDir });
          } catch (e) {
            logger.warn?.('html_to_app: 清理构建目录失败', { error: String(e?.message || e) });
          }
        }
      } catch (e) {
        logger.error?.('html_to_app: 压缩失败', { error: String(e?.message || e) });
      }
    }

    // === 6. 生成使用说明 ===
    const automated = autoInstall && autoBuild;
    const instructions = generateInstructions(projectPath, appName, automated, effectivePackageManager);

    // === 7. 返回结果 ===
    const data = {
      action: 'html_to_app',
      project_path: projectPath,
      app_name: appName,
      framework,
      files_count: writtenFiles.length,
      files: writtenFiles,
      instructions,
      generation_info: {
        model: resp.model,
        created: resp.created,
        baseURL: penv.HTML_TO_APP_BASE_URL || process.env.HTML_TO_APP_BASE_URL || config.llm.baseURL,
      },
    };

    // 添加自动化流程结果
    if (autoInstall || autoBuild || autoZip) {
      data.automation = {
        install: installResult ? {
          success: installResult.success,
          code: installResult.code,
          error: installResult.error,
          requestedPackageManager,
          effectivePackageManager,
          warning: installResult.warning,
        } : null,
        build: buildResult ? { success: buildResult.success, files: buildFiles } : null,
        zip: zipResult
          ? {
            success: true,
            path_markdown: `[${appName}_build.zip](${toPosix(zipResult.path)})`,
            size: zipResult.size,
          }
          : null,
      };
    }

    return ok(data);
  } catch (e) {
    logger.error?.('html_to_app: 生成失败', { label: 'PLUGIN', error: String(e?.message || e), stack: e?.stack });
    const isTimeout = isTimeoutError(e);
    return fail(e, isTimeout ? 'TIMEOUT' : 'GENERATION_ERROR', { advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { stage: 'handler' }) });
  }
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
