import path from 'node:path';
import fs from 'node:fs/promises';
import PptxGenJS from 'pptxgenjs';
import MarkdownIt from 'markdown-it';
import { parse as parseHtml } from 'node-html-parser';
import logger from '../../src/logger/index.js';
import { config } from '../../src/config/index.js';
import { chatCompletion } from '../../src/openai/client.js';
import { abs as toAbs } from '../../src/utils/path.js';
import { ok, fail } from '../../src/utils/result.js';

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

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

function buildAdvice(kind, ctx = {}) {
  const personaHint = '请结合你当前的预设/人设继续作答：当 PPT 生成失败时，要解释原因、给替代方案（补充主题/给大纲/减少页数/改模式），并引导用户补充更清晰的信息。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我现在还缺少生成 PPT 的关键信息（比如 subject/内容），所以没法开始生成。你告诉我主题、受众、页数和你希望包含的要点，我就能继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 subject（主题）',
        '可选提供 outline（大纲），能显著提升结构稳定性',
        '确认页数 page_count、主题 theme、以及模式 mode（ai_generate/direct_render）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我在生成 PPT 时卡住了，像是接口/渲染超时了。我可以先给你一份 PPT 大纲（文本版）作为交付，之后再生成文件版。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '先输出大纲/每页要点（文本交付）',
        '减少 page_count 或简化内容后重试',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试帮你生成 PPT，但这次工具执行失败了。我可以先把结构化大纲和每页要点整理出来，等你确认后再生成 PPT 文件。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '补充：受众、语气（学术/商务/科普）、是否需要图表/案例',
      '我也可以给你 2-3 套不同结构的 PPT 大纲供选择',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

function ensureTheme(theme) {
  const allowed = new Set(['default', 'dark', 'business', 'simple']);
  return allowed.has(theme) ? theme : 'default';
}

function ensureFilename(raw) {
  const base = String(raw || '').trim() || `ppt_${Date.now()}.pptx`;
  const safe = base.replace(/[\\/:*?"<>|]/g, '_');
  return safe.toLowerCase().endsWith('.pptx') ? safe : `${safe}.pptx`;
}

function splitMarkdownToSlides(markdown, pageCount) {
  const slides = [];
  if (!markdown || typeof markdown !== 'string') return slides;
  const blocks = markdown.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return slides;
  const perSlide = Math.max(1, Math.ceil(blocks.length / Math.max(1, pageCount)));
  for (let i = 0; i < blocks.length; i += perSlide) {
    const chunk = blocks.slice(i, i + perSlide).join('\n\n');
    slides.push({ format: 'markdown', content: chunk });
  }
  return slides;
}

function slidesFromDirectInput(slidesArg, autoSplit, pageCount) {
  if (Array.isArray(slidesArg) && slidesArg.length) {
    return slidesArg.map((s) => ({
      title: s.title || '',
      format: s.format === 'html' ? 'html' : 'markdown',
      content: String(s.content || '')
    })).filter((s) => s.content.trim());
  }
  if (!slidesArg || !autoSplit) return [];
  // slidesArg 不是数组但 auto_split=true，尝试从单个 content 字段构建
  const single = Array.isArray(slidesArg) ? slidesArg[0] : slidesArg;
  const content = typeof single === 'string' ? single : String(single?.content || '');
  if (!content.trim()) return [];
  return splitMarkdownToSlides(content, pageCount);
}

function buildPptThemeProps(theme) {
  const key = ensureTheme(theme);
  switch (key) {
    case 'dark':
      return { key, bgColor: '111111', titleColor: 'FFFFFF', bodyColor: 'EEEEEE', accentColor: '00BCD4' };
    case 'business':
      return { key, bgColor: 'FFFFFF', titleColor: '003366', bodyColor: '333333', accentColor: '0088CC' };
    case 'simple':
      return { key, bgColor: 'FFFFFF', titleColor: '111111', bodyColor: '444444', accentColor: '888888' };
    default:
      return { key: 'default', bgColor: 'FFFFFF', titleColor: '222222', bodyColor: '333333', accentColor: '4F81BD' };
  }
}

function defineThemeMaster(ppt, themeProps) {
  const key = themeProps.key || 'default';
  const masterName = `PPT_GEN_${key.toUpperCase()}_MASTER`;
  let objects = [];

  if (key === 'business') {
    objects = [
      // Top accent bar
      { rect: { x: 0, y: 0, w: '100%', h: 0.6, fill: { color: themeProps.accentColor } } },
      // Bottom light footer bar
      { rect: { x: 0, y: 6.6, w: '100%', h: 0.4, fill: { color: 'F1F1F1' } } }
    ];
  } else if (key === 'dark') {
    objects = [
      { rect: { x: 0, y: 0, w: '100%', h: 0.6, fill: { color: themeProps.accentColor } } },
      { rect: { x: 0, y: 6.6, w: '100%', h: 0.4, fill: { color: '222222' } } }
    ];
  } else if (key === 'simple' || key === 'default') {
    objects = [
      { line: { x: 0.5, y: 0.9, w: 11.0, line: { color: themeProps.accentColor, width: 1 } } },
      { rect: { x: 0, y: 6.7, w: '100%', h: 0.3, fill: { color: 'F5F5F5' } } }
    ];
  }

  ppt.defineSlideMaster({
    title: masterName,
    background: { color: themeProps.bgColor },
    objects,
    slideNumber: { x: 0.3, y: '95%' }
  });

  return masterName;
}

function addMarkdownSlide(ppt, slideDef, themeProps, slideIndex) {
  const slide = themeProps.masterName ? ppt.addSlide({ masterName: themeProps.masterName }) : ppt.addSlide();
  slide.background = { color: themeProps.bgColor };
  const tokens = md.parse(slideDef.content || '', {});
  let title = slideDef.title || '';
  const bodyLines = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!title && t.type === 'heading_open' && t.tag === 'h1') {
      const inline = tokens[i + 1];
      if (inline && inline.type === 'inline') {
        title = inline.content.trim();
      }
    }
    if (t.type === 'inline') {
      bodyLines.push(t.content.trim());
    }
  }
  const layout = (slideDef.layout || (slideIndex === 0 ? 'title' : 'content')).toLowerCase();
  const isTitle = layout === 'title';
  const isSection = layout === 'section';
  const kind = (slideDef.kind || (isTitle ? 'title_cover' : isSection ? 'section_intro' : 'content')).toLowerCase();

  if (title) {
    if (isTitle) {
      slide.addText(title, {
        x: 1.0,
        y: 1.8,
        w: 8,
        h: 1,
        fontSize: 40,
        bold: true,
        color: themeProps.titleColor,
        align: 'center',
        fontFace: 'Microsoft YaHei',
        fit: 'shrink',
        autoFit: true,
        valign: 'middle',
        wrap: true
      });
    } else if (isSection) {
      slide.addText(title, {
        x: 0.9,
        y: 2.0,
        w: 9,
        h: 1,
        fontSize: 32,
        bold: true,
        color: themeProps.titleColor,
        fontFace: 'Microsoft YaHei',
        fit: 'shrink',
        autoFit: true,
        valign: 'middle',
        wrap: true
      });
    } else {
      slide.addText(title, {
        x: 0.6,
        y: 0.6,
        w: 9,
        h: 1,
        fontSize: 28,
        bold: true,
        color: themeProps.titleColor,
        fontFace: 'Microsoft YaHei',
        fit: 'shrink',
        autoFit: true,
        valign: 'middle',
        wrap: true
      });
    }
  }

  if (bodyLines.length) {
    const rawLines = bodyLines.filter((l) => l && l.trim().length > 1);
    const textLines = rawLines.slice(0, 12);
    if (textLines.length) {
      if (kind === 'quote') {
        const text = textLines.join('\n');
        slide.addText(text, {
          x: 1.0,
          y: 2.0,
          w: 8,
          h: 3.0,
          fontSize: 30,
          color: themeProps.titleColor,
          align: 'center',
          fontFace: 'Microsoft YaHei',
          fit: 'shrink',
          autoFit: true,
          valign: 'middle',
          wrap: true
        });
      } else if (kind === 'two_col') {
        const mid = Math.ceil(textLines.length / 2);
        const leftText = textLines.slice(0, mid).join('\n');
        const rightText = textLines.slice(mid).join('\n');
        const baseY = title ? 1.6 : 1.0;
        const h = 4.5;
        slide.addText(leftText, {
          x: 0.9,
          y: baseY,
          w: 3.8,
          h,
          fontSize: 18,
          color: themeProps.bodyColor,
          bullet: true,
          fontFace: 'Microsoft YaHei',
          fit: 'shrink',
          autoFit: true,
          valign: 'top',
          wrap: true
        });
        if (rightText) {
          slide.addText(rightText, {
            x: 5.0,
            y: baseY,
            w: 3.8,
            h,
            fontSize: 18,
            color: themeProps.bodyColor,
            bullet: true,
            fontFace: 'Microsoft YaHei',
            fit: 'shrink',
            autoFit: true,
            valign: 'top',
            wrap: true
          });
        }
      } else {
        const narrowForVisual = kind === 'image_right' || kind === 'kpi_chart';
        const wContent = narrowForVisual ? 5.6 : 8;
        const xContent = narrowForVisual ? 0.8 : 0.9;
        const text = textLines.slice(0, 10).join('\n');
        if (isTitle) {
          slide.addText(text, {
            x: 1.0,
            y: 3.0,
            w: 8,
            h: 3.5,
            fontSize: 22,
            color: themeProps.bodyColor,
            align: 'center',
            fontFace: 'Microsoft YaHei',
            fit: 'shrink',
            autoFit: true,
            valign: 'top',
            wrap: true
          });
        } else if (isSection) {
          slide.addText(text, {
            x: 1.0,
            y: 3.2,
            w: 8,
            h: 3.0,
            fontSize: 20,
            color: themeProps.bodyColor,
            fontFace: 'Microsoft YaHei',
            fit: 'shrink',
            autoFit: true,
            valign: 'top',
            wrap: true
          });
        } else {
          slide.addText(text, {
            x: xContent,
            y: title ? 1.6 : 1.0,
            w: wContent,
            h: 4.5,
            fontSize: 18,
            color: themeProps.bodyColor,
            bullet: true,
            fontFace: 'Microsoft YaHei',
            fit: 'shrink',
            autoFit: true,
            valign: 'top',
            wrap: true
          });
        }
      }
    }
  }

  renderExtraElements(ppt, slide, slideDef);
}

function addHtmlSlide(ppt, slideDef, themeProps, slideIndex) {
  const slide = themeProps.masterName ? ppt.addSlide({ masterName: themeProps.masterName }) : ppt.addSlide();
  slide.background = { color: themeProps.bgColor };
  const html = slideDef.content || '';
  const root = parseHtml(html);
  let title = slideDef.title || '';
  let bodyLines = [];
  const h1 = root.querySelector('h1, h2');
  if (!title && h1) {
    title = h1.text.trim();
  }
  const ps = root.querySelectorAll('p');
  bodyLines = ps.map((p) => p.text.trim()).filter(Boolean);
  if (!bodyLines.length) {
    const lis = root.querySelectorAll('li');
    bodyLines = lis.map((li) => li.text.trim()).filter(Boolean);
  }
  const layout = (slideDef.layout || (slideIndex === 0 ? 'title' : 'content')).toLowerCase();
  const isTitle = layout === 'title';
  const isSection = layout === 'section';
  const kind = (slideDef.kind || (isTitle ? 'title_cover' : isSection ? 'section_intro' : 'content')).toLowerCase();

  if (title) {
    if (isTitle) {
      slide.addText(title, {
        x: 1.0,
        y: 1.8,
        w: 8,
        h: 1,
        fontSize: 40,
        bold: true,
        color: themeProps.titleColor,
        align: 'center',
        fontFace: 'Microsoft YaHei',
        fit: 'shrink',
        autoFit: true,
        valign: 'middle',
        wrap: true
      });
    } else if (isSection) {
      slide.addText(title, {
        x: 0.9,
        y: 2.0,
        w: 9,
        h: 1,
        fontSize: 32,
        bold: true,
        color: themeProps.titleColor,
        fontFace: 'Microsoft YaHei',
        fit: 'shrink',
        autoFit: true,
        valign: 'middle',
        wrap: true
      });
    } else {
      slide.addText(title, {
        x: 0.6,
        y: 0.6,
        w: 9,
        h: 1,
        fontSize: 28,
        bold: true,
        color: themeProps.titleColor,
        fontFace: 'Microsoft YaHei',
        fit: 'shrink',
        autoFit: true,
        valign: 'middle',
        wrap: true
      });
    }
  }

  if (bodyLines.length) {
    const rawLines = bodyLines.filter((l) => l && l.trim().length > 1);
    const textLines = rawLines.slice(0, 12);
    if (textLines.length) {
      if (kind === 'quote') {
        const text = textLines.join('\n');
        slide.addText(text, {
          x: 1.0,
          y: 2.0,
          w: 8,
          h: 3.0,
          fontSize: 30,
          color: themeProps.titleColor,
          align: 'center',
          fontFace: 'Microsoft YaHei',
          fit: 'shrink',
          autoFit: true,
          valign: 'middle',
          wrap: true
        });
      } else if (kind === 'two_col') {
        const mid = Math.ceil(textLines.length / 2);
        const leftText = textLines.slice(0, mid).join('\n');
        const rightText = textLines.slice(mid).join('\n');
        const baseY = title ? 1.6 : 1.0;
        const h = 4.5;
        slide.addText(leftText, {
          x: 0.9,
          y: baseY,
          w: 3.8,
          h,
          fontSize: 18,
          color: themeProps.bodyColor,
          bullet: true,
          fontFace: 'Microsoft YaHei',
          fit: 'shrink',
          autoFit: true,
          valign: 'top',
          wrap: true
        });
        if (rightText) {
          slide.addText(rightText, {
            x: 5.0,
            y: baseY,
            w: 3.8,
            h,
            fontSize: 18,
            color: themeProps.bodyColor,
            bullet: true,
            fontFace: 'Microsoft YaHei',
            fit: 'shrink',
            autoFit: true,
            valign: 'top',
            wrap: true
          });
        }
      } else {
        const narrowForVisual = kind === 'image_right' || kind === 'kpi_chart';
        const wContent = narrowForVisual ? 5.6 : 8;
        const xContent = narrowForVisual ? 0.8 : 0.9;
        const text = textLines.slice(0, 10).join('\n');
        if (isTitle) {
          slide.addText(text, {
            x: 1.0,
            y: 3.0,
            w: 8,
            h: 3.5,
            fontSize: 22,
            color: themeProps.bodyColor,
            align: 'center',
            fontFace: 'Microsoft YaHei',
            fit: 'shrink',
            autoFit: true,
            valign: 'top',
            wrap: true
          });
        } else if (isSection) {
          slide.addText(text, {
            x: 1.0,
            y: 3.2,
            w: 8,
            h: 3.0,
            fontSize: 20,
            color: themeProps.bodyColor,
            fontFace: 'Microsoft YaHei',
            fit: 'shrink',
            autoFit: true,
            valign: 'top',
            wrap: true
          });
        } else {
          slide.addText(text, {
            x: xContent,
            y: title ? 1.6 : 1.0,
            w: wContent,
            h: 4.5,
            fontSize: 18,
            color: themeProps.bodyColor,
            bullet: true,
            fontFace: 'Microsoft YaHei',
            fit: 'shrink',
            autoFit: true,
            valign: 'top',
            wrap: true
          });
        }
      }
    }
  }
}

function pickAttr(attrs, name) {
  if (!attrs) return undefined;
  const re = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i');
  const m = attrs.match(re);
  return m ? m[1] : undefined;
}

function pickAttrNumber(attrs, name) {
  const v = pickAttr(attrs, name);
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function stripCdata(text) {
  if (!text || typeof text !== 'string') return text;
  let t = text;
  t = t.replace(/^<!\[CDATA\[/i, '');
  t = t.replace(/\]\]>$/i, '');
  return t;
}

function renderExtraElements(ppt, slide, slideDef) {
  if (!slideDef || !slide) return;

  if (slideDef.notes) {
    try {
      if (typeof slide.addNotes === 'function') {
        slide.addNotes(String(slideDef.notes));
      }
    } catch (e) {
      logger.warn?.('ppt_gen: failed to add notes', { label: 'PLUGIN', error: String(e) });
    }
  }

  if (Array.isArray(slideDef.images)) {
    for (const img of slideDef.images) {
      if (!img || !img.path) continue;
      const opts = { path: img.path };
      let hasPos = false;
      if (typeof img.x === 'number') { opts.x = img.x; hasPos = true; }
      if (typeof img.y === 'number') { opts.y = img.y; hasPos = true; }
      if (typeof img.w === 'number') { opts.w = img.w; hasPos = true; }
      if (typeof img.h === 'number') { opts.h = img.h; hasPos = true; }
      if (!hasPos) {
        const kind = String(slideDef.kind || '').toLowerCase();
        if (kind === 'image_right' || kind === 'kpi_chart') {
          // Reserve right side of slide for image/chart visual
          opts.x = 6.4;
          opts.y = 1.6;
          opts.w = 3.0;
          opts.h = 4.0;
        } else {
          // Centered generic image
          opts.x = 1.0;
          opts.y = 1.5;
          opts.w = 8.0;
          opts.h = 4.5;
        }
      }
      try {
        slide.addImage(opts);
      } catch (e) {
        logger.warn?.('ppt_gen: failed to add image', { label: 'PLUGIN', error: String(e) });
      }
    }
  }

  if (Array.isArray(slideDef.tables)) {
    for (const tbl of slideDef.tables) {
      if (!tbl || !Array.isArray(tbl.rows) || !tbl.rows.length) continue;
      const baseOpts = {
        fontFace: 'Microsoft YaHei',
        fontSize: 14
      };
      const pos = {};
      if (tbl.options) {
        ['x', 'y', 'w', 'h'].forEach((k) => {
          if (typeof tbl.options[k] === 'number') pos[k] = tbl.options[k];
        });
      }
      const opts = { ...baseOpts, ...pos };
      try {
        slide.addTable(tbl.rows, opts);
      } catch (e) {
        logger.warn?.('ppt_gen: failed to add table', { label: 'PLUGIN', error: String(e) });
      }
    }
  }

  if (Array.isArray(slideDef.charts) && ppt && ppt.ChartType) {
    for (const ch of slideDef.charts) {
      if (!ch || !Array.isArray(ch.data) || !ch.data.length) continue;
      const kind = String(ch.type || 'bar').toLowerCase();
      let chartType = ppt.ChartType.bar;
      if (kind === 'line') chartType = ppt.ChartType.line;
      else if (kind === 'pie') chartType = ppt.ChartType.pie;
      else if (kind === 'area') chartType = ppt.ChartType.area;
      const pos = {};
      if (ch.options) {
        ['x', 'y', 'w', 'h'].forEach((k) => {
          if (typeof ch.options[k] === 'number') pos[k] = ch.options[k];
        });
      }
      if (!('x' in pos) && !('y' in pos) && !('w' in pos) && !('h' in pos)) {
        const skind = String(slideDef.kind || '').toLowerCase();
        if (skind === 'kpi_chart') {
          pos.x = 0.8;
          pos.y = 2.0;
          pos.w = 8.4;
          pos.h = 3.5;
        } else if (skind === 'image_right') {
          // Chart on left side when kind suggests visual on right
          pos.x = 0.8;
          pos.y = 1.8;
          pos.w = 5.6;
          pos.h = 4.0;
        }
      }
      try {
        slide.addChart(chartType, ch.data, pos);
      } catch (e) {
        logger.warn?.('ppt_gen: failed to add chart', { label: 'PLUGIN', error: String(e) });
      }
    }
  }
  if (Array.isArray(slideDef.texts)) {
    for (const tx of slideDef.texts) {
      if (!tx || !tx.text) continue;
      const o = tx.options || {};
      const pos = {};
      ['x', 'y', 'w', 'h'].forEach((k) => {
        if (typeof o[k] === 'number') pos[k] = o[k];
      });
      const opts = {
        ...pos,
        fontFace: 'Microsoft YaHei',
        fontSize: typeof o.fontSize === 'number' ? o.fontSize : 18,
        color: o.color || undefined,
        align: o.align || 'left',
        bullet: typeof o.bullet === 'boolean' ? o.bullet : false,
        bold: typeof o.bold === 'boolean' ? o.bold : false
      };
      try {
        slide.addText(String(tx.text), opts);
      } catch (e) {
        logger.warn?.('ppt_gen: failed to add extra text', { label: 'PLUGIN', error: String(e) });
      }
    }
  }
  if (Array.isArray(slideDef.shapes) && ppt && ppt.ShapeType) {
    for (const sh of slideDef.shapes) {
      if (!sh || !sh.type) continue;
      const kind = String(sh.type).toUpperCase();
      const shapeType = ppt.ShapeType[kind] || ppt.ShapeType.rect;
      const opts = {};
      ['x', 'y', 'w', 'h'].forEach((k) => {
        if (typeof sh[k] === 'number') opts[k] = sh[k];
      });
      if (sh.fillColor) {
        opts.fill = { color: sh.fillColor };
      }
      if (sh.lineColor) {
        opts.line = { color: sh.lineColor };
      }
      try {
        slide.addShape(shapeType, opts);
      } catch (e) {
        logger.warn?.('ppt_gen: failed to add shape', { label: 'PLUGIN', error: String(e) });
      }
    }
  }
  if (Array.isArray(slideDef.media)) {
    for (const m of slideDef.media) {
      if (!m || !m.type || !m.path) continue;
      const opts = { type: m.type, path: m.path };
      ['x', 'y', 'w', 'h'].forEach((k) => {
        if (typeof m[k] === 'number') opts[k] = m[k];
      });
      try {
        slide.addMedia(opts);
      } catch (e) {
        logger.warn?.('ppt_gen: failed to add media', { label: 'PLUGIN', error: String(e) });
      }
    }
  }
}

function buildPptXmlSystemPrompt(pageCount) {
  return (
    'You are a PowerPoint slide generation assistant. ' +
    'You MUST output ONE AND ONLY ONE Sentra-style XML block that describes slides for a PPTX file.\n\n' +
    'High-level goal:\n' +
    '- Design a visually appealing, well-structured slide deck using multiple layout types and visual elements.\n' +
    '- Mix text, tables, charts and (optionally) images when the outline suggests data, comparisons or KPIs.\n\n' +
    'Root XML element and example (Sentra PPT XML Protocol):\n' +
    '<sentra-ppt-slides>\n' +
    '  <slide index="1">\n' +
    '    <layout>title</layout>\n' +
    '    <kind>title_cover</kind>\n' +
    '    <title>Slide title in the same language as the outline</title>\n' +
    '    <format>markdown</format>\n' +
    '    <content><![CDATA[# Heading\n- short tagline 1\n- short tagline 2]]></content>\n' +
    '    <notes><![CDATA[Speaker notes for the presenter...]]></notes>\n' +
    '  </slide>\n' +
    '  <slide index="2">\n' +
    '    <layout>content</layout>\n' +
    '    <kind>two_col</kind>\n' +
    '    <title>Section title</title>\n' +
    '    <format>markdown</format>\n' +
    '    <content><![CDATA[## Key ideas\n- bullet 1\n- bullet 2]]></content>\n' +
    '    <table x="0.8" y="2.0" w="8.4" h="3.5">\n' +
    '      <row>\n' +
    '        <cell>Item</cell>\n' +
    '        <cell>Before</cell>\n' +
    '        <cell>After</cell>\n' +
    '      </row>\n' +
    '      <row>\n' +
    '        <cell>Cost</cell>\n' +
    '        <cell>High</cell>\n' +
    '        <cell>Lower</cell>\n' +
    '      </row>\n' +
    '    </table>\n' +
    '  </slide>\n' +
    '  <slide index="3">\n' +
    '    <layout>content</layout>\n' +
    '    <kind>kpi_chart</kind>\n' +
    '    <title>KPIs</title>\n' +
    '    <format>markdown</format>\n' +
    '    <content><![CDATA[Short intro text for the KPI chart.]]></content>\n' +
    '    <chart x="0.8" y="2.0" w="8.4" h="3.5">\n' +
    '      <type>line</type>\n' +
    '      <data><![CDATA[[{ "name": "Actual", "labels": ["Q1","Q2","Q3","Q4"], "values": [10,20,25,30] }]]></data>\n' +
    '    </chart>\n' +
    '  </slide>\n' +
    '</sentra-ppt-slides>\n\n' +
    'Coordinate system and layout semantics:\n' +
    '- Coordinates x, y, w, h are in inches on a 10 x 7.5 inch slide (approx).\n' +
    '- "title": big title/cover slide (first slide).\n' +
    '- "section": section separator slide introducing a new chapter (large title, minimal body).\n' +
    '- "content": normal content slide (title + body + optional tables/charts/images).\n' +
    '- If <layout> is missing, treat the slide as "content".\n\n' +
    'Slide kinds (semantic templates):\n' +
    '- <kind>title_cover</kind>: cover slide with big title and short tagline. Should be used on the first slide.\n' +
    '- <kind>section_intro</kind>: section separator slide with a chapter title and 1-2 short lines.\n' +
    '- <kind>content</kind>: standard one-column content slide (title + bullets).\n' +
    '- <kind>two_col</kind>: two-column comparison or grouping slide; body text is automatically split into left/right columns.\n' +
    '- <kind>image_right</kind>: text on the left and visual (image or chart) on the right; suitable for diagrams or illustrations.\n' +
    '- <kind>kpi_chart</kind>: numeric KPI or trend slide; usually combines a short intro text and a chart.\n' +
    '- <kind>quote</kind>: big quote or key message centered on the slide.\n' +
    '- If <kind> is missing, it will be inferred from layout and content, but you SHOULD set it explicitly for better control.\n\n' +
    'Element types you can use inside <slide>:\n' +
    '- <title>: slide title (plain text).\n' +
    '- <format>: "markdown" or "html" (controls how <content> is interpreted).\n' +
    '- <content>: main body (headings + bullet lists; avoid long paragraphs). Always wrap raw text in <![CDATA[ ... ]]> to avoid escaping issues.\n' +
    '- <notes>: speaker notes; short bullet-style phrases for the presenter. Also wrapped in <![CDATA[ ... ]]> if they contain special characters.\n' +
    '- <image path="..." x="..." y="..." w="..." h="..." />: optional image. Only use when the outline explicitly describes available assets.\n' +
    '- <table x="..." y="..." w="..." h="...">: tabular data defined by <row> and <cell> elements.\n' +
    '- <chart x="..." y="..." w="..." h="...">: quantitative data visualized as a chart; must contain <type> and <data>.\n' +
    '- <shape type="RECT|ELLIPSE|..." x="..." y="..." w="..." h="..." fillColor="..." lineColor="..." />: decorative or structural shapes from PptxGenJS ShapeType.\n' +
    '- <media type="video|audio" path="..." x="..." y="..." w="..." h="..." />: optional audio/video element when appropriate.\n' +
    '- <text x="..." y="..." w="..." h="..." fontSize="..." color="..." bold="true|false" align="left|center|right" bullet="true|false"><![CDATA[inline text block when you need a second text area.]]></text>\n\n' +
    'Chart rules:\n' +
    '- <type> MUST be one of: "bar", "line", "pie", "area".\n' +
    '- <data> MUST be a valid JSON array compatible with PptxGenJS, wrapped in a single <![CDATA[ ... ]]> block, for example:\n' +
    '  <data><![CDATA[[{ "name": "Series A", "labels": ["Jan","Feb"], "values": [10,20] }]]></data>\n' +
    '- Use charts only when the outline includes numeric or time-series data.\n\n' +
    'Table rules:\n' +
    '- Use <row> and <cell> (or <c>) to represent a logical grid; avoid extremely wide tables.\n' +
    '- Use tables only when comparing structured items (pros/cons, before/after, feature matrices, etc.).\n\n' +
    'Global rules (aligned with Sentra XML Protocol):\n' +
    '- You MUST generate between 1 and ' + pageCount + ' slides (prefer concise, high-value slides).\n' +
    '- First slide MUST use <layout>title</layout> and <kind>title_cover</kind> and act as a cover.\n' +
    '- Subsequent slides should mix different <kind> values (section_intro, content, two_col, image_right, kpi_chart, quote) when appropriate, instead of using the same kind for every slide.\n' +
    '- Use the user\'s main language from the outline for all text.\n' +
    '- <format> MUST be either "markdown" or "html" (default to "markdown" if uncertain).\n' +
    '- In markdown mode, use headings and bullet lists, avoid long paragraphs (about 3-7 bullets per slide).\n' +
    '- Do NOT wrap the XML with Markdown code fences or any other formatting markers.\n' +
    '- Do NOT output any explanatory text before or after the <sentra-ppt-slides> block.\n' +
    '- Inside <content>, <notes>, <text>, and <data>, do NOT XML-escape characters; instead, always wrap raw text in a single <![CDATA[ ... ]]> block.\n' +
    '- It is strictly forbidden to output multiple <sentra-ppt-slides> blocks.'
  );
}

function parseSlidesFromXml(xml, { subject, outline, pageCount }) {
  const slides = [];
  if (!xml || typeof xml !== 'string') return slides;

  // Extract inner content of <sentra-ppt-slides> if present
  let inner = xml;
  const rootMatch = xml.match(/<sentra-ppt-slides[^>]*>([\s\S]*?)<\/sentra-ppt-slides>/i);
  if (rootMatch) {
    inner = rootMatch[1];
  }

  const slideRe = /<slide\b[^>]*>([\s\S]*?)<\/slide>/gi;
  let match;
  let idx = 0;
  while ((match = slideRe.exec(inner)) !== null) {
    const whole = match[0];
    const block = match[1];

    const idxAttr = whole.match(/index\s*=\s*"(\d+)"/i);
    const index = idxAttr ? Number(idxAttr[1]) : idx + 1;

    const layoutMatch = block.match(/<layout[^>]*>([\s\S]*?)<\/layout>/i);
    const kindMatch = block.match(/<kind[^>]*>([\s\S]*?)<\/kind>/i);
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const formatMatch = block.match(/<format[^>]*>([\s\S]*?)<\/format>/i);
    const contentMatch = block.match(/<content[^>]*>([\s\S]*?)<\/content>/i);
    const notesMatch = block.match(/<notes[^>]*>([\s\S]*?)<\/notes>/i);

    const layout = layoutMatch ? layoutMatch[1].trim().toLowerCase() : '';
    let kind = kindMatch ? kindMatch[1].trim().toLowerCase() : '';
    let title = titleMatch ? stripCdata(titleMatch[1]).trim() : '';
    const rawFormat = formatMatch ? formatMatch[1].trim().toLowerCase() : 'markdown';
    let content = contentMatch ? stripCdata(contentMatch[1]) : '';
    let notes = notesMatch ? stripCdata(notesMatch[1]).trim() : '';

    // Preserve internal formatting but trim leading/trailing blank lines
    content = content.replace(/^\s*\n/, '').replace(/\n\s*$/, '');

    if (!title && subject) title = subject;

    const images = [];
    const imageRe = /<image\b([^>]*?)\/>/gi;
    let imgMatch;
    while ((imgMatch = imageRe.exec(block)) !== null) {
      const attrs = imgMatch[1] || '';
      const path = pickAttr(attrs, 'path');
      if (!path) continue;
      images.push({
        path,
        x: pickAttrNumber(attrs, 'x'),
        y: pickAttrNumber(attrs, 'y'),
        w: pickAttrNumber(attrs, 'w'),
        h: pickAttrNumber(attrs, 'h')
      });
    }
    const shapes = [];
    const shapeRe = /<shape\b([^>]*?)\/>/gi;
    let shapeMatch;
    while ((shapeMatch = shapeRe.exec(block)) !== null) {
      const sAttrs = shapeMatch[1] || '';
      const sType = pickAttr(sAttrs, 'type');
      if (!sType) continue;
      shapes.push({
        type: sType,
        x: pickAttrNumber(sAttrs, 'x'),
        y: pickAttrNumber(sAttrs, 'y'),
        w: pickAttrNumber(sAttrs, 'w'),
        h: pickAttrNumber(sAttrs, 'h'),
        fillColor: pickAttr(sAttrs, 'fillColor'),
        lineColor: pickAttr(sAttrs, 'lineColor')
      });
    }
    const tables = [];
    const tableRe = /<table\b([^>]*)>([\s\S]*?)<\/table>/gi;
    let tblMatch;
    while ((tblMatch = tableRe.exec(block)) !== null) {
      const tAttrs = tblMatch[1] || '';
      const tBody = tblMatch[2] || '';
      const rows = [];
      const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
      let rowMatch;
      while ((rowMatch = rowRe.exec(tBody)) !== null) {
        const rowBlock = rowMatch[1] || '';
        const rowCells = [];
        const cellRe = /<(?:cell|c)\b[^>]*>([\s\S]*?)<\/(?:cell|c)>/gi;
        let cellMatch;
        while ((cellMatch = cellRe.exec(rowBlock)) !== null) {
          const cellText = stripCdata(cellMatch[1] || '').trim();
          rowCells.push(cellText);
        }
        if (rowCells.length) rows.push(rowCells);
      }
      if (rows.length) {
        tables.push({
          rows,
          options: {
            x: pickAttrNumber(tAttrs, 'x'),
            y: pickAttrNumber(tAttrs, 'y'),
            w: pickAttrNumber(tAttrs, 'w'),
            h: pickAttrNumber(tAttrs, 'h')
          }
        });
      }
    }

    const charts = [];
    const chartRe = /<chart\b([^>]*)>([\s\S]*?)<\/chart>/gi;
    let chartMatch;
    while ((chartMatch = chartRe.exec(block)) !== null) {
      const cAttrs = chartMatch[1] || '';
      const cBody = chartMatch[2] || '';
      const typeMatch = cBody.match(/<type[^>]*>([\s\S]*?)<\/type>/i);
      const dataMatch = cBody.match(/<data[^>]*>([\s\S]*?)<\/data>/i);
      const chartTypeRaw = typeMatch ? stripCdata(typeMatch[1]).trim().toLowerCase() : '';
      const chartDataRaw = dataMatch ? stripCdata(dataMatch[1]).trim() : '';
      if (!chartTypeRaw || !chartDataRaw) continue;
      let chartData;
      try {
        chartData = JSON.parse(chartDataRaw);
      } catch (e) {
        logger.warn?.('ppt_gen: failed to parse chart data JSON', { label: 'PLUGIN', error: String(e) });
        continue;
      }
      charts.push({
        type: chartTypeRaw,
        data: chartData,
        options: {
          x: pickAttrNumber(cAttrs, 'x'),
          y: pickAttrNumber(cAttrs, 'y'),
          w: pickAttrNumber(cAttrs, 'w'),
          h: pickAttrNumber(cAttrs, 'h')
        }
      });
    }

    const texts = [];
    const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let txtMatch;
    while ((txtMatch = textRe.exec(block)) !== null) {
      const tAttrs = txtMatch[1] || '';
      const tBody = stripCdata(txtMatch[2] || '').trim();
      if (!tBody) continue;
      const boldAttr = pickAttr(tAttrs, 'bold');
      const bulletAttr = pickAttr(tAttrs, 'bullet');
      texts.push({
        text: tBody,
        options: {
          x: pickAttrNumber(tAttrs, 'x'),
          y: pickAttrNumber(tAttrs, 'y'),
          w: pickAttrNumber(tAttrs, 'w'),
          h: pickAttrNumber(tAttrs, 'h'),
          fontSize: pickAttrNumber(tAttrs, 'fontSize'),
          color: pickAttr(tAttrs, 'color'),
          align: pickAttr(tAttrs, 'align'),
          bold: boldAttr ? boldAttr.toLowerCase() === 'true' : undefined,
          bullet: bulletAttr ? bulletAttr.toLowerCase() === 'true' : undefined
        }
      });
    }
    const media = [];
    const mediaRe = /<media\b([^>]*?)\/>/gi;
    let mediaMatch;
    while ((mediaMatch = mediaRe.exec(block)) !== null) {
      const mAttrs = mediaMatch[1] || '';
      const mType = pickAttr(mAttrs, 'type');
      const mPath = pickAttr(mAttrs, 'path');
      if (!mType || !mPath) continue;
      media.push({
        type: mType,
        path: mPath,
        x: pickAttrNumber(mAttrs, 'x'),
        y: pickAttrNumber(mAttrs, 'y'),
        w: pickAttrNumber(mAttrs, 'w'),
        h: pickAttrNumber(mAttrs, 'h')
      });
    }

    // Infer kind when not explicitly provided
    if (!kind) {
      if (index === 1 || layout === 'title') {
        kind = 'title_cover';
      } else if (layout === 'section') {
        kind = 'section_intro';
      } else if (charts.length) {
        kind = 'kpi_chart';
      } else if (images.length) {
        kind = 'image_right';
      } else if (tables.length) {
        kind = 'two_col';
      } else {
        kind = 'content';
      }
    }

    slides.push({
      index,
      layout,
      kind,
      title,
      format: rawFormat === 'html' ? 'html' : 'markdown',
      content,
      notes,
      images,
      tables,
      charts,
      texts,
      shapes,
      media
    });
    idx += 1;
  }

  if (!slides.length && outline) {
    return [
      {
        index: 1,
        title: subject || '',
        format: 'markdown',
        content: outline,
        notes: '',
        images: [],
        tables: [],
        charts: [],
        texts: [],
        shapes: [],
        media: [],
        layout: 'content',
        kind: 'content'
      }
    ];
  }

  // Sort by index and clamp to desired pageCount
  slides.sort((a, b) => (a.index || 0) - (b.index || 0));
  const limited = slides.slice(0, Math.max(1, pageCount));

  return limited.map((s) => ({
    index: s.index,
    layout: s.layout,
    kind: s.kind,
    title: s.title || subject || '',
    format: s.format === 'html' ? 'html' : 'markdown',
    content: s.content || '',
    notes: s.notes || '',
    images: Array.isArray(s.images) ? s.images : [],
    tables: Array.isArray(s.tables) ? s.tables : [],
    charts: Array.isArray(s.charts) ? s.charts : [],
    texts: Array.isArray(s.texts) ? s.texts : [],
    shapes: Array.isArray(s.shapes) ? s.shapes : [],
    media: Array.isArray(s.media) ? s.media : []
  }));
}

async function generateSlidesByAI({ subject, outline, pageCount, penv }) {
  const model = penv.PPT_GEN_MODEL || process.env.PPT_GEN_MODEL || config.llm.model;
  const baseURL = penv.PPT_GEN_BASE_URL || process.env.PPT_GEN_BASE_URL || config.llm.baseURL || 'https://yuanplus.chat/v1';
  const apiKey = penv.PPT_GEN_API_KEY || process.env.PPT_GEN_API_KEY || config.llm.apiKey;
  // 1) If outline is empty, ask LLM to expand a high-level outline from subject first
  let outlineText = String(outline || '').trim();
  if (!outlineText) {
    try {
      const outlineSystem =
        'You are a PPT outline generation assistant. ' +
        'Given only a subject, you design a clear, hierarchical outline for a slide deck. ' +
        'Use the same language as the subject (Chinese in this case). ' +
        'Output ONLY the outline text in markdown-style bullet/numbered list, no explanation.';
      const outlineUser =
        `Subject: ${subject}\n` +
        `TargetSlides: ${pageCount}\n` +
        'Please propose a concise but comprehensive outline for this PPT (1st level = main sections, 2nd level = key points).';

      const oMessages = [
        { role: 'system', content: outlineSystem },
        { role: 'user', content: outlineUser }
      ];

      const oResp = await chatCompletion({
        messages: oMessages,
        temperature: 0.5,
        apiKey,
        baseURL,
        model,
        omitMaxTokens: true
      });
      outlineText = oResp.choices?.[0]?.message?.content?.trim() || '';
      logger.info?.('ppt_gen: outline generated by LLM', { label: 'PLUGIN', hasOutline: !!outlineText });
    } catch (e) {
      logger.warn?.('ppt_gen: outline generation failed, fallback to subject only', { label: 'PLUGIN', error: String(e) });
    }
  }

  // 2) Use Sentra-style PPT XML protocol to generate concrete slides
  const systemPrompt = buildPptXmlSystemPrompt(pageCount);
  const outlineForSlides = outlineText || outline || subject;
  const userPrompt =
    `Subject: ${subject}\n` +
    `TotalSlides: ${pageCount}\n` +
    'Outline or main content (same language you should use in slides):\n' +
    outlineForSlides +
    '\n\nPlease design the slide deck structure and output ONLY one <sentra-ppt-slides> XML block as specified. ' +
    'Ensure each slide is focused, with a clear title and 3-7 bullet points or short paragraphs.';

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  const resp = await chatCompletion({ messages, temperature: 0.4, apiKey, baseURL, model, omitMaxTokens: true });
  const text = resp.choices?.[0]?.message?.content?.trim() || '';

  const slides = parseSlidesFromXml(text, { subject, outline: outlineForSlides, pageCount });
  if (!slides.length) {
    logger.warn?.('ppt_gen: failed to parse PPT XML, fallback to single slide', { label: 'PLUGIN' });
    return {
      slides: [
        {
          title: subject,
          format: 'markdown',
          content: outlineForSlides
        }
      ],
      outline: outlineForSlides,
      rawXml: text
    };
  }

  return {
    slides,
    outline: outlineForSlides,
    rawXml: text
  };
}

async function legacyHandler(args = {}, options = {}) {
  try {
    const penv = options?.pluginEnv || {};
    const subject = String(args.subject || '').trim();
    const outline = String(args.outline || '').trim();
    const mode = String(args.mode || 'ai_generate');
    const pageCount = Math.max(1, Math.min(50, Number(args.page_count || 10)));
    const autoSplit = args.auto_split !== false;
    const theme = ensureTheme(String(args.theme || penv.PPT_GEN_DEFAULT_THEME || 'default'));
    const filename = ensureFilename(args.filename);
    const baseDir = 'artifacts';
    const relPath = path.join(baseDir, filename);
    const absPath = toAbs(relPath);

  let slides = [];
  let designInfo = null;

  if (mode === 'direct_render') {
    slides = slidesFromDirectInput(args.slides, autoSplit, pageCount);
  } else {
    if (!subject) {
      return { success: false, code: 'INVALID', error: 'ai_generate 模式下 subject 为必填', advice: buildAdvice('INVALID', { tool: 'ppt_gen', mode }) };
    }
    const gen = await generateSlidesByAI({ subject, outline, pageCount, penv });
    slides = gen?.slides || [];
    designInfo = {
      outline: gen?.outline || outline || null,
      raw_xml: gen?.rawXml || null,
      slide_titles: Array.isArray(slides) ? slides.map((s) => s.title).filter(Boolean) : []
    };
  }

  if (!slides.length) {
    return { success: false, code: 'INVALID', error: '没有可用的幻灯片内容', advice: buildAdvice('INVALID', { tool: 'ppt_gen', mode, subject: subject || null }) };
  }

  const themeProps = buildPptThemeProps(theme);
  const pptx = new PptxGenJS();
  themeProps.masterName = defineThemeMaster(pptx, themeProps);

  slides.forEach((s, idx) => {
    if (s.format === 'html') {
      addHtmlSlide(pptx, s, themeProps, idx);
    } else {
      addMarkdownSlide(pptx, s, themeProps, idx);
    }
  });

  await fs.mkdir(path.dirname(absPath), { recursive: true });
  const buffer = await pptx.write('nodebuffer');
  await fs.writeFile(absPath, buffer);

  logger.info?.('ppt_gen: pptx written', { label: 'PLUGIN', path: absPath, slides: slides.length, theme });

    return {
      success: true,
      data: {
        subject: subject || null,
        outline: outline || designInfo?.outline || null,
        mode,
        theme,
        page_count: slides.length,
        path_abs: absPath,
        rel_path: relPath,
        design: designInfo
      }
    };
  } catch (e) {
    const rawErr = String(e?.message || e);
    const isTimeout = isTimeoutError(e);
    return { success: false, code: isTimeout ? 'TIMEOUT' : 'ERR', error: rawErr, advice: buildAdvice(isTimeout ? 'TIMEOUT' : 'ERR', { tool: 'ppt_gen' }) };
  }
}

export default async function handler(args = {}, options = {}) {
  const out = await legacyHandler(args, options);
  if (out && typeof out === 'object' && typeof out.success === 'boolean') {
    if (out.success === true) {
      return ok(out.data ?? null, out.code || 'OK', { ...('advice' in out ? { advice: out.advice } : {}) });
    }
    const extra = { ...('advice' in out ? { advice: out.advice } : {}) };
    if ('data' in out && out.data != null) extra.detail = { data: out.data };
    return fail(('error' in out) ? out.error : 'Tool failed', out.code || 'ERR', extra);
  }
  return ok(out);
}

import { runCurrentModuleCliIfMain } from '../../src/plugins/plugin_entry.js';
runCurrentModuleCliIfMain(import.meta.url);
