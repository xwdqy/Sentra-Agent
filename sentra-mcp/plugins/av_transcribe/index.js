import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import logger from '../../src/logger/index.js';
import { httpClient } from '../../src/utils/http.js';
import mime from 'mime-types';
import { toAbsoluteLocalPath } from '../../src/utils/path.js';
import { ok, fail } from '../../src/utils/result.js';

function normalizeBaseUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  return v.endsWith('/') ? v.slice(0, -1) : v;
}

async function postJsonWithRetry(url, data, timeoutMs, retries, retryBaseMs, headers) {
  let attempt = 0;
  while (true) {
    try {
      const res = await httpClient.post(url, data, {
        headers: {
          'Content-Type': 'application/json',
          ...(headers && typeof headers === 'object' ? headers : {}),
        },
        timeout: timeoutMs,
        validateStatus: () => true,
      });
      const status = Number(res?.status);
      if (!Number.isFinite(status) || status < 200 || status >= 300) {
        const err = new Error(`HTTP ${Number.isFinite(status) ? status : 'unknown'}`);
        err.response = res;
        throw err;
      }
      return res;
    } catch (e) {
      attempt++;
      if (attempt > retries || !shouldRetry(e)) throw e;
      await sleep(retryBaseMs * Math.pow(2, attempt - 1));
    }
  }
}

function isHttpUrl(s) {
  try { const u = new URL(String(s)); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

function isGeminiBaseUrl(baseUrl) {
  try {
    const u = new URL(String(baseUrl));
    return String(u.hostname || '').includes('generativelanguage.googleapis.com');
  } catch {
    return false;
  }
}

function normalizeWhisperMode(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return 'whisper';
  if (['gemini', 'google', 'google_gemini'].includes(v)) return 'gemini';
  if (['chat', 'chat_completions', 'chat-completions', 'completions'].includes(v)) return 'chat';
  return 'whisper';
}

function normalizeMimeType(raw) {
  return String(raw || '').split(';')[0].trim().toLowerCase();
}

function isAudioOrVideoMime(m) {
  const mt = normalizeMimeType(m);
  return !!mt && (mt.startsWith('audio/') || mt.startsWith('video/'));
}

function readFileHead(p, bytes = 4096) {
  const filePath = String(p || '');
  const fd = fssync.openSync(filePath, 'r');
  try {
    const size = Math.max(0, Number(bytes) || 0);
    const buf = Buffer.allocUnsafe(size);
    const n = fssync.readSync(fd, buf, 0, size, 0);
    return buf.slice(0, Math.max(0, n || 0));
  } finally {
    try { fssync.closeSync(fd); } catch {}
  }
}

function inferAudioFormat({ mimeType, ext, magic }) {
  const mt = normalizeMimeType(mimeType);
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  const mg = String(magic || '').toUpperCase();
  if (mg === 'WAV' || mt === 'audio/wav' || e === 'wav') return 'wav';
  if (mg === 'MP3' || mg === 'MP3_ID3' || mt === 'audio/mpeg' || e === 'mp3' || e === 'mpeg' || e === 'mpga') return 'mp3';
  if (mg === 'MP4' || mt === 'video/mp4' || mt === 'audio/mp4' || e === 'm4a' || e === 'mp4') return 'm4a';
  if (mt === 'audio/ogg' || e === 'ogg') return 'ogg';
  if (mt === 'audio/flac' || e === 'flac') return 'flac';
  if (mt === 'video/webm' || e === 'webm') return 'webm';
  if (mt === 'audio/amr' || e === 'amr') return 'amr';
  return e || 'mp3';
}

function guessAudioMimeByPath(p) {
  const m = normalizeMimeType(mime.lookup(String(p || '')) || '');
  if (isAudioOrVideoMime(m)) return m;
  return '';
}

function guessInputAudioFormatByPath(p) {
  const ext = String(path.extname(String(p || '')) || '').toLowerCase().replace(/^\./, '');
  return inferAudioFormat({ mimeType: guessAudioMimeByPath(p), ext, magic: '' });
}

function buildGeminiGenerateContentUrl(baseUrl, model, apiKey) {
  const safeBase = normalizeBaseUrl(baseUrl);
  return `${safeBase}/models/${encodeURIComponent(String(model || '').trim())}:generateContent`;
}

function isGeminiUnsupportedAudio(mimeType, format) {
  const mt = String(mimeType || '').toLowerCase();
  const fmt = String(format || '').toLowerCase();
  if (fmt === 'amr') return true;
  if (mt === 'audio/amr' || mt.endsWith('/amr')) return true;
  return false;
}

function isAmrAudio(mimeType, format, filePath) {
  const mt = String(mimeType || '').toLowerCase();
  const fmt = String(format || '').toLowerCase();
  const ext = String(path.extname(String(filePath || '')) || '').toLowerCase();
  return fmt === 'amr' || mt === 'audio/amr' || mt.endsWith('/amr') || ext === '.amr';
}

function shouldAttemptFfmpegForAmrMagic(magic) {
  const m = String(magic || '').toUpperCase();
  if (!m) return true;
  if (m === 'AMR' || m === 'AMR-WB') return true;
  return false;
}

function sniffAudioMagic(buf) {
  try {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
    const s = b.slice(0, 16).toString('utf8');
    if (s.startsWith('#!AMR-WB')) return 'AMR-WB';
    if (s.startsWith('#!AMR')) return 'AMR';
    if (s.startsWith('#!SILK_V3')) return 'SILK_V3';
    if (b.length >= 4 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) {
      const riffType = b.length >= 12 ? b.slice(8, 12).toString('ascii') : '';
      if (riffType === 'WAVE') return 'WAV';
      if (riffType === 'AVI ') return 'AVI';
      return 'RIFF';
    }
    if (b.length >= 4 && b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'OGG';
    if (b.length >= 4 && b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return 'FLAC';
    if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'MP3_ID3';
    if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'MP3';
    if (b.length >= 8 && b.slice(4, 8).toString('utf8') === 'ftyp') return 'MP4';
    if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'WEBM';
    return '';
  } catch {
    return '';
  }
}

function detectMediaFromMagic(buf, nameHint = '') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const hint = String(nameHint || '');
  const hintExt = String(path.extname(hint) || '').toLowerCase();
  const magic = sniffAudioMagic(b);
  if (!magic) return { mimeType: '', ext: '', kind: '', magic: '' };

  if (magic === 'AMR' || magic === 'AMR-WB') return { mimeType: 'audio/amr', ext: 'amr', kind: 'audio', magic };
  if (magic === 'SILK_V3') return { mimeType: 'audio/silk', ext: 'silk', kind: 'audio', magic };
  if (magic === 'WAV') return { mimeType: 'audio/wav', ext: 'wav', kind: 'audio', magic };
  if (magic === 'OGG') return { mimeType: 'audio/ogg', ext: 'ogg', kind: 'audio', magic };
  if (magic === 'FLAC') return { mimeType: 'audio/flac', ext: 'flac', kind: 'audio', magic };
  if (magic === 'MP3' || magic === 'MP3_ID3') return { mimeType: 'audio/mpeg', ext: 'mp3', kind: 'audio', magic };
  if (magic === 'WEBM') return { mimeType: 'video/webm', ext: 'webm', kind: 'video', magic };
  if (magic === 'AVI') return { mimeType: 'video/x-msvideo', ext: 'avi', kind: 'video', magic };
  if (magic === 'MP4') {
    let brand = '';
    try { brand = b.length >= 12 ? b.slice(8, 12).toString('ascii').trim().toLowerCase() : ''; } catch {}
    const isM4A = hintExt === '.m4a' || brand === 'm4a' || brand === 'm4a ';
    return {
      mimeType: isM4A ? 'audio/mp4' : 'video/mp4',
      ext: isM4A ? 'm4a' : 'mp4',
      kind: isM4A ? 'audio' : 'video',
      magic,
    };
  }
  return { mimeType: '', ext: '', kind: '', magic };
}

function detectUploadMediaHintLocalFile(localPath) {
  const p = String(localPath || '');
  const head = readFileHead(p, 4096);
  const magicInfo = detectMediaFromMagic(head, p);
  const extMime = guessAudioMimeByPath(p);
  const chosen = isAudioOrVideoMime(magicInfo.mimeType)
    ? magicInfo.mimeType
    : (isAudioOrVideoMime(extMime) ? extMime : '');
  const mimeType = chosen || 'application/octet-stream';
  const ext = magicInfo.ext || String(path.extname(p) || '').toLowerCase().replace(/^\./, '') || (mime.extension(mimeType) || '');
  return { mimeType, ext, magic: magicInfo.magic || '', kind: (magicInfo.kind || (isAudioOrVideoMime(mimeType) ? (mimeType.startsWith('audio/') ? 'audio' : 'video') : '')) };
}

async function sniffRemoteMagic(url, timeoutMs, headers) {
  try {
    const res = await httpClient.get(String(url), {
      responseType: 'arraybuffer',
      timeout: Math.min(timeoutMs || 30000, 30000),
      maxBodyLength: 512 * 1024,
      maxContentLength: 512 * 1024,
      headers: { Range: 'bytes=0-4095', ...(headers || {}) },
      validateStatus: () => true,
    });
    const status = Number(res?.status);
    if (!Number.isFinite(status) || status < 200 || status >= 300) return null;
    const buf = Buffer.from(res.data);
    const hintPath = (() => { try { return new URL(String(url)).pathname; } catch { return String(url || ''); } })();
    const magicInfo = detectMediaFromMagic(buf, hintPath);
    if (!magicInfo || !isAudioOrVideoMime(magicInfo.mimeType)) return null;
    return { ...magicInfo, size: buf.length };
  } catch {
    return null;
  }
}

const __ffmpegAvailCache = new Map();
async function checkFfmpegAvailable(ffmpegBin = 'ffmpeg') {
  const key = String(ffmpegBin || 'ffmpeg').trim() || 'ffmpeg';
  if (__ffmpegAvailCache.has(key)) return __ffmpegAvailCache.get(key);
  let ok = false;
  let preview = '';
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(key, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = [];
      const onData = (d) => {
        if (chunks.length >= 3) return;
        const s = String(d || '');
        if (s) chunks.push(s);
      };
      p.stdout.on('data', onData);
      p.stderr.on('data', onData);
      p.on('error', reject);
      p.on('exit', (code) => {
        preview = chunks.join('').slice(0, 300);
        (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
      });
    });
    ok = true;
  } catch {
    ok = false;
  }
  __ffmpegAvailCache.set(key, ok);
  return ok;
}

async function transcodeAudioToWavWithFfmpeg(inputPath, outputDir, timeoutMs, ffmpegBin = 'ffmpeg') {
  const out = path.join(outputDir, `av_transcribe_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out];
  const startedAt = Date.now();
  let stderr = '';
  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const killTimer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      reject(new Error('ffmpeg timeout'));
    }, Math.max(10000, Math.min(300000, timeoutMs || 60000)));
    p.stderr.on('data', (d) => {
      const chunk = String(d || '');
      stderr = (stderr + chunk).slice(-4000);
    });
    p.on('error', (e) => {
      clearTimeout(killTimer);
      reject(e);
    });
    p.on('exit', (code) => {
      clearTimeout(killTimer);
      if (code === 0) resolve();
      else {
        const u = (Number(code) >>> 0);
        const hex = '0x' + u.toString(16).padStart(8, '0');
        const signed = (Number(code) | 0);
        const cmdPreview = `${ffmpegBin} ${args.map((a) => (String(a).includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
        reject(new Error(`ffmpeg failed (code=${code}, signed=${signed}, hex=${hex}) cmd=${cmdPreview} stderr=${stderr.slice(-800)}`));
      }
    });
  });

  return { outPath: out, elapsedMs: Date.now() - startedAt, stderrPreview: stderr.slice(0, 800) };
}

function pickGeminiText(resData) {
  const parts = resData?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  const texts = parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).map((t) => t.trim()).filter(Boolean);
  return texts.join('\n');
}

async function readAudioAsDataUri(src, { timeoutMs, headers }) {
  let buf;
  let type = '';
  let format = '';
  let magic = '';
  if (isHttpUrl(src)) {
    const res = await httpClient.get(String(src), {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      maxBodyLength: Infinity,
      headers,
      validateStatus: () => true,
    });
    const status = Number(res?.status);
    if (!Number.isFinite(status) || status < 200 || status >= 300) {
      throw new Error(`fetch audio failed: HTTP ${Number.isFinite(status) ? status : 'unknown'}`);
    }
    buf = Buffer.from(res.data);
    const ct = normalizeMimeType(res.headers?.['content-type'] || '');
    if (isAudioOrVideoMime(ct)) type = ct;
    if (!type) {
      try { const u = new URL(String(src)); type = guessAudioMimeByPath(u.pathname); } catch {}
    }
    if (!format) {
      try { const u = new URL(String(src)); format = guessInputAudioFormatByPath(u.pathname); } catch {}
    }
  } else {
    const p = toAbsoluteLocalPath(src);
    if (!p) throw new Error('local audio path must be absolute');
    buf = fssync.readFileSync(p);
    type = guessAudioMimeByPath(p);
    format = guessInputAudioFormatByPath(p);
  }

  if (!buf || !buf.length) throw new Error('empty audio file');
  const nameHint = (() => {
    try {
      if (isHttpUrl(src)) return new URL(String(src)).pathname;
      return String(src || '');
    } catch {
      return String(src || '');
    }
  })();

  const magicInfo = detectMediaFromMagic(buf, nameHint);
  magic = magicInfo.magic || sniffAudioMagic(buf);

  const headerOrPathMime = type;
  const extMime = guessAudioMimeByPath(nameHint);
  const chosenMime = isAudioOrVideoMime(magicInfo.mimeType)
    ? magicInfo.mimeType
    : (isAudioOrVideoMime(headerOrPathMime) ? headerOrPathMime : (isAudioOrVideoMime(extMime) ? extMime : ''));
  if (!chosenMime) {
    throw new Error(`unsupported media type: content-type=${headerOrPathMime || 'none'} magic=${magic || 'unknown'} name=${String(nameHint || '')}`);
  }

  const chosenExt = magicInfo.ext || String(path.extname(nameHint) || '').toLowerCase().replace(/^\./, '') || (mime.extension(chosenMime) || '');
  format = inferAudioFormat({ mimeType: chosenMime, ext: chosenExt, magic });

  const dataUri = `data:${chosenMime};base64,${buf.toString('base64')}`;
  return { uri: dataUri, mime: chosenMime, size: buf.length, base64: buf.toString('base64'), format, magic };
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

function buildAdvice(kind, ctx = {}) {
  const personaHint = '请结合你当前的预设/人设继续作答：当音视频转写失败时，要说明原因（文件路径/网络/权限/接口/长度），给替代方案（换文件/压缩/截取片段/稍后重试/分段），并引导用户补充必要信息。';
  if (kind === 'INVALID') {
    return {
      suggested_reply: '我需要你提供要转写的音频/视频文件（file 或 files）。当前参数缺失，所以我没法开始转写。你把文件路径或链接发我一下（单个用 file，多个用 files），我就继续。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '提供 file 或 files：本地文件路径或 http(s) URL',
        '可选提供 language（语言）和 prompt（转写提示/上下文）',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'NO_API_KEY') {
    return {
      suggested_reply: '我这边缺少语音转写服务的鉴权信息（API Key），所以暂时无法开始转写。你可以把 WHISPER_API_KEY 配置好后再试；如果你不方便配置，我也可以先按你的需求给出“整理/摘要/时间轴”的结构模板。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '在插件环境中配置 WHISPER_API_KEY（必填）',
        '可选配置 WHISPER_BASE_URL 与 WHISPER_MODEL',
        '如果文件较大，建议先截取关键片段或压缩码率',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'FILE_NOT_FOUND') {
    return {
      suggested_reply: '我没有找到你提供的本地文件路径，所以没法开始转写。你确认一下路径是否存在、是否有权限读取，然后再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认 file 路径真实存在（建议用绝对路径）',
        '检查文件权限（是否可读）',
        '如果是 URL，确认链接可直接访问且稳定',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'TIMEOUT') {
    return {
      suggested_reply: '我在转写音视频时卡住了，像是网络/接口超时了。我可以先给你一个不依赖工具的整理方案，或者我们稍后重试；也可以把文件截短/压缩后再试一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '稍后重试',
        '如果文件较大，建议先截取关键片段或压缩码率',
        '如果是 URL，建议先下载成本地文件再转写',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'SUSPECT') {
    return {
      suggested_reply: '我拿到了转写结果，但看起来像是占位/默认文本，并不像来自你这段语音本身（可能是接口未真正读取音频或音频格式不被该模式支持）。为了避免误导，我建议我们换一种方式再转写一次。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '把 WHISPER_MODE 切回 whisper（/audio/transcriptions）再试一次（更兼容音频格式）',
        '把语音转成 wav/mp3/m4a 后再试（尤其是 amr 语音）',
        '如果你有公网可访问的音频链接（http/https），也可以直接给链接',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'UNSUPPORTED_FORMAT') {
    return {
      suggested_reply: '这段语音的格式在当前模式下不被支持（常见是 QQ 语音 amr）。为了保证转写准确性，我建议换一种更兼容的转写方式。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '把 WHISPER_MODE 切回 whisper（/audio/transcriptions）再试一次',
        '或先把 amr 转成 wav/mp3/m4a 再转写',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'FFMPEG') {
    return {
      suggested_reply: '我尝试用系统 ffmpeg 将音频转码后再转写，但 ffmpeg 执行失败了，所以这次没能继续。你可以先确认 ffmpeg 能在当前环境正常运行，然后我们再重试。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '在本机终端执行：ffmpeg -version（或用你配置的绝对路径执行）确认能输出版本信息',
        '确认 FFMPEG_PATH 指向的就是 ffmpeg 可执行文件（Windows 建议写成 D:/ffmpeg.exe 或 C:/ffmpeg/bin/ffmpeg.exe）',
        '如果 ffmpeg 本身能运行但转码失败，尝试把原始 amr 重新下载一次或换一条语音',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  if (kind === 'INVALID_AUDIO') {
    return {
      suggested_reply: '我读取到的音频文件内容为空或格式异常（扩展名与真实格式可能不一致），所以无法转写。你可以先确认文件本身是可播放的音频，再重试。\n\n（请结合你当前的预设/人设继续作答）',
      next_steps: [
        '确认该文件不是 0 字节，并且可以在本机播放器里正常播放',
        '如果文件扩展名是 .amr 但头部是 #!SILK_V3（QQ 语音常见），需要先用 QQ/微信导出为 mp3/m4a，或用 SILK 解码工具转换后再转写',
        '如果是刚生成/刚下载的语音，稍等 1-2 秒再重试，避免文件还没写入完成',
      ],
      persona_hint: personaHint,
      context: ctx,
    };
  }
  return {
    suggested_reply: '我尝试转写音视频，但这次工具执行失败了。我可以先按你的需求给出整理/摘要的结构模板；如果你愿意，我们也可以换更短的片段或分段重试。\n\n（请结合你当前的预设/人设继续作答）',
    next_steps: [
      '提供更短的片段或拆成多个文件分段转写',
      '告诉我你更想要“逐字稿”还是“摘要/要点/时间轴”',
    ],
    persona_hint: personaHint,
    context: ctx,
  };
}

// ---- Chunking helpers ----
function mb(n) { return Math.max(0, Number(n) || 0) * 1024 * 1024; }

function buildFetchHeaders(penv, args) {
  const headers = {};
  const ua = penv.AV_FETCH_USER_AGENT || process.env.AV_FETCH_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
  headers['User-Agent'] = ua;
  const referer = penv.AV_FETCH_REFERER || process.env.AV_FETCH_REFERER || args?.referer || args?.headers?.Referer || args?.headers?.referer;
  if (referer) headers['Referer'] = referer;
  const cookie = penv.AV_FETCH_COOKIE || process.env.AV_FETCH_COOKIE || args?.headers?.Cookie || args?.headers?.cookie;
  if (cookie) headers['Cookie'] = cookie;
  const extra = penv.AV_FETCH_HEADERS_JSON || process.env.AV_FETCH_HEADERS_JSON || null;
  if (extra) {
    try {
      const parsed = JSON.parse(extra);
      if (parsed && typeof parsed === 'object') Object.assign(headers, parsed);
    } catch {}
  }
  if (args?.headers && typeof args.headers === 'object') Object.assign(headers, args.headers);
  return headers;
}

function resolveBaseDir(penv) {
  const base = penv.AV_BASE_DIR || process.env.AV_BASE_DIR || 'artifacts';
  const abs = path.isAbsolute(base) ? base : path.resolve(process.cwd(), base);
  const dir = path.join(abs, 'tmp', 'av_transcribe');
  try { fssync.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

async function downloadToTempFile(url, timeoutMs, headers, baseTmpDir) {
  const ext = (() => { try { return path.extname(new URL(url).pathname) || '.bin'; } catch { return '.bin'; } })();
  const root = baseTmpDir || path.join(os.tmpdir(), 'av_transcribe');
  try { fssync.mkdirSync(root, { recursive: true }); } catch {}
  const tmp = path.join(root, `av_transcribe_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  const resp = await httpClient.get(url, { responseType: 'stream', timeout: timeoutMs, maxBodyLength: Infinity, headers });
  await new Promise((resolve, reject) => {
    const ws = fssync.createWriteStream(tmp);
    resp.data.pipe(ws);
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
  return tmp;
}
function kb(n) { return Math.max(0, Number(n) || 0) * 1024; }

function buildChunks(fileSize, chunkSize, overlapBytes) {
  if (!Number.isFinite(fileSize) || fileSize <= 0) return [];
  const chunks = [];
  let offset = 0;
  let idx = 0;
  while (offset < fileSize) {
    const start = offset;
    const end = Math.min(offset + chunkSize, fileSize);
    let actualEnd = end;
    if (end < fileSize && idx < 3 && overlapBytes > 0) {
      actualEnd = Math.min(end + overlapBytes, fileSize);
    }
    chunks.push({ index: idx, start, end: actualEnd });
    offset += chunkSize; // next slice (no overlap move)
    idx += 1;
  }
  return chunks;
}

async function headRemote(url, timeoutMs, headers) {
  try {
    const res = await httpClient.head(url, { timeout: Math.min(timeoutMs, 15000), headers, validateStatus: () => true });
    const status = Number(res?.status);
    if (!Number.isFinite(status) || status < 200 || status >= 400) return { size: null, acceptRanges: '', contentType: '' };
    const len = Number(res.headers['content-length']);
    const acceptRanges = String(res.headers['accept-ranges'] || '').toLowerCase();
    const contentType = normalizeMimeType(res.headers['content-type'] || '');
    return { size: Number.isFinite(len) ? len : null, acceptRanges, contentType };
  } catch {
    return { size: null, acceptRanges: '', contentType: '' };
  }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let i = 0, active = 0;
  return await new Promise((resolve, reject) => {
    const next = () => {
      while (active < limit && i < items.length) {
        const cur = i++;
        active++;
        Promise.resolve(worker(items[cur], cur))
          .then((r) => { results[cur] = r; active--; (i >= items.length && active === 0) ? resolve(results) : next(); })
          .catch(reject);
      }
    };
    if (items.length === 0) resolve(results);
    else next();
  });
}

function pickLanguage(langs) {
  const map = new Map();
  for (const l of langs) { if (!l) continue; map.set(l, (map.get(l) || 0) + 1); }
  let best = null, max = -1;
  for (const [k, v] of map.entries()) { if (v > max) { best = k; max = v; } }
  return best || langs.find(Boolean) || '未知';
}

function inferLangCode(value) {
  const val = String(value || '').trim();
  if (!val) return null;
  if (/^[a-z]{2,5}$/i.test(val)) return val.toLowerCase();
  const match = val.match(/^([a-z]{2,3})[-_][a-z]{2}$/i);
  if (match) return match[1].toLowerCase();
  return null;
}

function guessLanguageInfo(raw, hint) {
  const rawStr = String(raw || '').trim();
  const hintStr = String(hint || '').trim();
  const code = inferLangCode(rawStr) || inferLangCode(hintStr);
  const name = rawStr || hintStr || '';
  return {
    raw: rawStr || hintStr || '',
    code,
    name,
    hint: hintStr || null,
  };
}

function normalizeTranscribeOutput(raw, extra = {}) {
  const baseMeta = {
    model: extra.model || null,
    file: extra.file || null,
    chunks: typeof extra.chunks === 'number' ? extra.chunks : null,
    source: extra.source || null,
  };

  const fromArray = (arr) => {
    const list = Array.isArray(arr) ? arr : [];
    if (!list.length) {
      return {
        text: '',
        segments: [],
        language: guessLanguageInfo('', extra.languageHint),
        meta: { ...baseMeta, raw: list, rawType: 'array' },
      };
    }
    const langRaw = list[list.length - 1];
    const segRaw = list.slice(0, -1);
    const segTexts = segRaw
      .map((item) => {
        if (item == null) return '';
        if (typeof item === 'string') return item;
        try { return JSON.stringify(item); } catch { return String(item); }
      })
      .map((s) => s.trim())
      .filter(Boolean);
    const langInfo = guessLanguageInfo(langRaw, extra.languageHint);
    return {
      text: segTexts.join('\n'),
      segments: segTexts.map((t, idx) => ({ index: idx, text: t })),
      language: langInfo,
      meta: { ...baseMeta, raw: list, rawType: 'array' },
    };
  };

  if (Array.isArray(raw)) {
    return fromArray(raw);
  }

  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.data) && raw.data.length >= 2) {
      return fromArray(raw.data);
    }
    const text = String(raw.text || raw.transcript || raw.content || raw.result || '').trim();
    const langRaw = raw.language_name || raw.language || '';
    const langInfo = guessLanguageInfo(langRaw, extra.languageHint);
    const segments = Array.isArray(raw.segments)
      ? raw.segments
          .map((s, idx) => ({
            index: typeof s?.id === 'number' ? s.id : idx,
            start: typeof s?.start === 'number' ? s.start : undefined,
            end: typeof s?.end === 'number' ? s.end : undefined,
            text: String(s?.text || '').trim(),
          }))
          .filter((s) => s.text)
      : (text ? [{ index: 0, text }] : []);
    return {
      text,
      segments,
      language: langInfo,
      meta: { ...baseMeta, raw, rawType: 'object' },
    };
  }

  if (typeof raw === 'string') {
    const text = raw.trim();
    return {
      text,
      segments: text ? [{ index: 0, text }] : [],
      language: guessLanguageInfo('', extra.languageHint),
      meta: { ...baseMeta, raw, rawType: 'string' },
    };
  }

  return {
    text: '',
    segments: [],
    language: guessLanguageInfo('', extra.languageHint),
    meta: { ...baseMeta, raw, rawType: typeof raw },
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function toErrInfo(e) {
  return {
    message: e?.message || String(e),
    code: e?.code,
    status: e?.response?.status,
    statusText: e?.response?.statusText,
    dataPreview: (() => {
      const d = e?.response?.data;
      if (!d) return undefined;
      try {
        if (typeof d === 'string') return d.slice(0, 300);
        if (Buffer.isBuffer?.(d)) return `<buffer ${d.length}>`;
        return JSON.stringify(d).slice(0, 300);
      } catch {
        return String(d).slice(0, 300);
      }
    })(),
  };
}

function shouldRetry(e) {
  const status = e?.response?.status;
  const code = String(e?.code || '').toUpperCase();
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED'].includes(code)) return true;
  return false;
}

async function postWithRetry(url, formData, timeoutMs, retries, retryBaseMs, extraHeaders) {
  let attempt = 0;
  while (true) {
    try {
      const mergedHeaders = {
        ...(typeof formData?.getHeaders === 'function' ? formData.getHeaders() : {}),
        ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}),
      };
      const res = await httpClient.post(url, formData, {
        headers: mergedHeaders,
        timeout: timeoutMs,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      return res;
    } catch (e) {
      const info = toErrInfo(e);
      if (attempt >= retries || !shouldRetry(e)) {
        logger.error?.('av_transcribe:post_failed', { attempt, info });
        throw e;
      }
      const delay = Math.min(retryBaseMs * Math.pow(2, attempt), 8000) + Math.floor(Math.random() * 250);
      logger.warn?.('av_transcribe:post_retry', { attempt, waitMs: delay, info });
      await sleep(delay);
      attempt += 1;
    }
  }
}

async function legacyHandler(args = {}, options = {}) {
  const fileInput = String(args.file || '').trim();
  const language = args.language || null;
  const prompt = args.prompt || null;
  
  if (!fileInput) {
    return { success: false, code: 'INVALID', error: 'file/files is required', advice: buildAdvice('INVALID', { tool: 'av_transcribe' }) };
  }
  
  const penv = options?.pluginEnv || {};
  const baseUrl = normalizeBaseUrl(penv.WHISPER_BASE_URL || process.env.WHISPER_BASE_URL || 'https://api.openai.com/v1');
  const apiKey = String(penv.WHISPER_API_KEY || process.env.WHISPER_API_KEY || '').trim();
  const mode = normalizeWhisperMode(penv.WHISPER_MODE || process.env.WHISPER_MODE || 'whisper');
  const model = String(penv.WHISPER_MODEL || process.env.WHISPER_MODEL || 'whisper-1');
  const timeoutMs = Number(penv.WHISPER_TIMEOUT_MS || process.env.WHISPER_TIMEOUT_MS || 300000);
  const ffmpegBin = String(penv.FFMPEG_PATH || process.env.FFMPEG_PATH || 'ffmpeg').trim() || 'ffmpeg';
  // Chunking config (env)
  const chunkEnabledRaw = String(penv.AV_CHUNK_ENABLED ?? '1').trim().toLowerCase();
  const chunkEnabled = !(chunkEnabledRaw === '0' || chunkEnabledRaw === 'false' || chunkEnabledRaw === 'off' || chunkEnabledRaw === 'no');
  const chunkSizeBytes = penv.AV_CHUNK_SIZE_BYTES ? Number(penv.AV_CHUNK_SIZE_BYTES) : mb(penv.AV_CHUNK_SIZE_MB ?? 2.5);
  const chunkOverlapBytes = penv.AV_CHUNK_OVERLAP_BYTES ? Number(penv.AV_CHUNK_OVERLAP_BYTES) : kb(penv.AV_CHUNK_OVERLAP_KB ?? 10);
  const maxChunkThreshold = penv.AV_MAX_CHUNK_SIZE_BYTES ? Number(penv.AV_MAX_CHUNK_SIZE_BYTES) : mb(penv.AV_MAX_CHUNK_SIZE_MB ?? 3);
  const maxConcurrency = Math.max(1, Number(penv.AV_MAX_CONCURRENCY || 4));
  const retries = Math.max(0, Number(penv.AV_MAX_RETRIES || 2));
  const retryBaseMs = Math.max(100, Number(penv.AV_RETRY_BASE_MS || 600));
  
  try {
    if (!apiKey) {
      return { success: false, code: 'NO_API_KEY', error: 'WHISPER_API_KEY is required', advice: buildAdvice('NO_API_KEY', { tool: 'av_transcribe' }) };
    }

    logger.info?.('av_transcribe:start', {
      label: 'PLUGIN',
      file: fileInput,
      language: (mode === 'chat' || mode === 'gemini') ? null : (language || 'auto'),
      model,
      mode
    });

    const baseTmpDir = resolveBaseDir(penv);

    const isUrlAudio = isHttpUrl(fileInput);
    const localFilePath = !isUrlAudio ? toAbsoluteLocalPath(fileInput) : null;
    if (!isUrlAudio && !localFilePath) {
      return { success: false, code: 'INVALID_PATH', error: 'local audio path must be absolute', advice: buildAdvice('INVALID', { tool: 'av_transcribe', file: fileInput }) };
    }

    const filePath = isUrlAudio ? fileInput : localFilePath;

    if (mode === 'chat' || mode === 'gemini') {
      const fetchHeaders = buildFetchHeaders(penv, args);

      const chatLanguage = null;
      const chatPrompt = null;

      let localAudio = !isUrlAudio ? await readAudioAsDataUri(filePath, { timeoutMs, headers: fetchHeaders }) : null;
      const audioUrl = isUrlAudio ? filePath : null;

      if (!isUrlAudio && isAmrAudio(localAudio.mime, localAudio.format, filePath) && !shouldAttemptFfmpegForAmrMagic(localAudio.magic)) {
        return {
          success: false,
          code: 'UNSUPPORTED_AUDIO_FORMAT',
          error: `unsupported audio content: magic=${localAudio.magic || 'unknown'} ext=.amr`,
          advice: buildAdvice('INVALID_AUDIO', { tool: 'av_transcribe', file: filePath, magic: localAudio.magic, format: localAudio.format, mime: localAudio.mime }),
        };
      }

      if (!isUrlAudio && isAmrAudio(localAudio.mime, localAudio.format, filePath)) {
        const ok = await checkFfmpegAvailable(ffmpegBin);
        if (ok) {
          logger.info?.('av_transcribe:ffmpeg_transcode_start', { label: 'PLUGIN', from: filePath, to: 'wav' });
          let r;
          try {
            r = await transcodeAudioToWavWithFfmpeg(filePath, baseTmpDir, timeoutMs, ffmpegBin);
          } catch (e) {
            return { success: false, code: 'FFMPEG_ERR', error: String(e?.message || e), advice: buildAdvice('FFMPEG', { tool: 'av_transcribe', file: filePath, ffmpeg: ffmpegBin }) };
          }
          try {
            localAudio = await readAudioAsDataUri(r.outPath, { timeoutMs, headers: fetchHeaders });
            localAudio.format = 'wav';
            localAudio.mime = 'audio/wav';
          } finally {
            try { fssync.unlinkSync(r.outPath); } catch {}
          }
        }
      }

      const instructionParts = [
        'You are a precise audio transcription assistant.',
        'Transcribe the provided audio into plain text only.',
        'Do not add any extra commentary or formatting.',
        'Do not translate. Keep the original language exactly as spoken.',
      ];
      if (chatLanguage) instructionParts.push(`Language hint: ${String(chatLanguage)}`);
      if (chatPrompt) instructionParts.push(`Context hint: ${String(chatPrompt)}`);
      const userText = instructionParts.join('\n');

      const items = [{ type: 'text', text: userText }];
      if (isUrlAudio) {
        items.push({ type: 'audio_url', audio_url: { url: audioUrl } });
      } else {
        items.push({ type: 'input_audio', input_audio: { data: localAudio.base64, format: localAudio.format } });
      }

      if (mode === 'gemini' || isGeminiBaseUrl(baseUrl)) {
        const url = buildGeminiGenerateContentUrl(baseUrl, model, apiKey);
        let geminiAudio = isUrlAudio ? await readAudioAsDataUri(filePath, { timeoutMs, headers: fetchHeaders }) : localAudio;
        if (isGeminiUnsupportedAudio(geminiAudio.mime, geminiAudio.format) && !shouldAttemptFfmpegForAmrMagic(geminiAudio.magic)) {
          return {
            success: false,
            code: 'UNSUPPORTED_AUDIO_FORMAT',
            error: `unsupported audio content: magic=${geminiAudio.magic || 'unknown'} ext=${String(path.extname(filePath || '') || '')}`,
            advice: buildAdvice('INVALID_AUDIO', { tool: 'av_transcribe', file: filePath, magic: geminiAudio.magic, format: geminiAudio.format, mime: geminiAudio.mime }),
          };
        }
        if (isGeminiUnsupportedAudio(geminiAudio.mime, geminiAudio.format)) {
          const ok = await checkFfmpegAvailable(ffmpegBin);
          if (ok && isUrlAudio) {
            const tmpIn = path.join(baseTmpDir, `av_transcribe_${Date.now()}_${Math.random().toString(36).slice(2)}.amr`);
            try {
              fssync.writeFileSync(tmpIn, Buffer.from(geminiAudio.base64, 'base64'));
              logger.info?.('av_transcribe:ffmpeg_transcode_start', { label: 'PLUGIN', from: 'url(audio)', to: 'wav' });
              let r;
              try {
                r = await transcodeAudioToWavWithFfmpeg(tmpIn, baseTmpDir, timeoutMs, ffmpegBin);
              } catch (e) {
                return { success: false, code: 'FFMPEG_ERR', error: String(e?.message || e), advice: buildAdvice('FFMPEG', { tool: 'av_transcribe', file: filePath, ffmpeg: ffmpegBin }) };
              }
              try {
                geminiAudio = await readAudioAsDataUri(r.outPath, { timeoutMs, headers: fetchHeaders });
                geminiAudio.format = 'wav';
                geminiAudio.mime = 'audio/wav';
              } finally {
                try { fssync.unlinkSync(r.outPath); } catch {}
              }
            } finally {
              try { fssync.unlinkSync(tmpIn); } catch {}
            }
          }
        }
        if (isGeminiUnsupportedAudio(geminiAudio.mime, geminiAudio.format)) {
          return {
            success: false,
            code: 'UNSUPPORTED_AUDIO_FORMAT',
            error: `unsupported audio format for gemini: ${geminiAudio.format || geminiAudio.mime || 'unknown'}`,
            advice: buildAdvice('UNSUPPORTED_FORMAT', { tool: 'av_transcribe', file: filePath, mode: 'gemini', provider: 'gemini', model, audioFormat: geminiAudio.format, audioMime: geminiAudio.mime }),
          };
        }
        const parts = [
          { text: userText },
          { inlineData: { mimeType: geminiAudio.mime || 'audio/mpeg', data: geminiAudio.base64 } },
        ];

        logger.info?.('av_transcribe:chat_call', {
          label: 'PLUGIN',
          url,
          provider: 'gemini',
          model,
          language: null,
          source: isUrlAudio ? 'url' : 'file',
          audioFormat: geminiAudio.format,
          audioMime: geminiAudio.mime,
          audioBytes: geminiAudio.size,
        });

        const res = await postJsonWithRetry(
          url,
          {
            contents: [{ role: 'user', parts }],
            generationConfig: { temperature: 0 },
          },
          timeoutMs,
          retries,
          retryBaseMs,
          { ...(apiKey ? { 'x-goog-api-key': apiKey } : {}) }
        );
        const content = pickGeminiText(res?.data);
        const text = String(content || '').trim();
        if (!text) {
          return { success: false, code: 'EMPTY_TRANSCRIPTION', error: 'empty transcription result', advice: buildAdvice('ERR', { tool: 'av_transcribe', file: filePath, mode: 'gemini', provider: 'gemini', model }) };
        }
        const normalized = normalizeTranscribeOutput({ text, language: '' }, {
          model,
          file: filePath,
          chunks: 1,
          source: 'chat',
          languageHint: null,
        });
        return { success: true, code: 'OK', data: normalized };
      }

      const url = `${baseUrl}/chat/completions`;
      logger.info?.('av_transcribe:chat_call', {
        label: 'PLUGIN',
        url,
        provider: 'openai_compatible',
        model,
        language: null,
        source: isUrlAudio ? 'url' : 'file',
        audioFormat: isUrlAudio ? null : localAudio.format,
        audioMime: isUrlAudio ? null : localAudio.mime,
        audioBytes: isUrlAudio ? null : localAudio.size,
      });
      const res = await postJsonWithRetry(
        url,
        { model, messages: [{ role: 'user', content: items }] },
        timeoutMs,
        retries,
        retryBaseMs,
        { Authorization: `Bearer ${apiKey}` }
      );
      const content = res?.data?.choices?.[0]?.message?.content || '';
      const text = String(content || '').trim();
      if (!text) {
        return { success: false, code: 'EMPTY_TRANSCRIPTION', error: 'empty transcription result', advice: buildAdvice('ERR', { tool: 'av_transcribe', file: filePath, mode: 'chat', provider: 'openai_compatible', model }) };
      }
      const normalized = normalizeTranscribeOutput({ text, language: '' }, {
        model,
        file: filePath,
        chunks: 1,
        source: 'chat',
        languageHint: null,
      });
      return { success: true, code: 'OK', data: normalized };
    }
    
    // 支持本地文件与 http/https URL
    const isUrl = filePath.startsWith('http://') || filePath.startsWith('https://');
    if (!isUrl && !fssync.existsSync(filePath)) {
      return { success: false, code: 'FILE_NOT_FOUND', error: `File not found: ${filePath}`, advice: buildAdvice('FILE_NOT_FOUND', { tool: 'av_transcribe', file: filePath }) };
    }

    // 获取大小与是否支持 Range（URL 优先 HEAD；不支持则回落为本地临时文件以启用切片）
    let fileSize = null; let acceptRanges = ''; let remoteContentType = '';
    let localPath = filePath; let usingTemp = false;
    const fetchHeaders = buildFetchHeaders(penv, args);
    if (isUrl) {
      const info = await headRemote(filePath, timeoutMs, fetchHeaders);
      remoteContentType = String(info?.contentType || '');
      if (!Number.isFinite(info.size) || !String(info.acceptRanges || '').includes('bytes')) {
        logger.info?.('av_transcribe:fallback_download', { label: 'PLUGIN', reason: 'no-range-or-size', url: filePath });
        localPath = await downloadToTempFile(filePath, timeoutMs, fetchHeaders, baseTmpDir);
        usingTemp = true;
        try { fileSize = fssync.statSync(localPath).size; } catch {}
      } else {
        fileSize = info.size; acceptRanges = info.acceptRanges;
      }
    } else {
      try { fileSize = fssync.statSync(filePath).size; } catch {}
    }

    const uploadHint = (!isUrl || usingTemp)
      ? detectUploadMediaHintLocalFile(localPath)
      : {
          mimeType: (isAudioOrVideoMime(remoteContentType)
            ? remoteContentType
            : (() => {
                try { return guessAudioMimeByPath(new URL(String(filePath)).pathname) || ''; } catch { return ''; }
              })() || 'application/octet-stream'),
          ext: (() => { try { return String(path.extname(new URL(String(filePath)).pathname) || '').toLowerCase().replace(/^\./, ''); } catch { return ''; } })(),
          magic: '',
          kind: '',
        };

    if (isUrl && !usingTemp && (!isAudioOrVideoMime(uploadHint.mimeType) || uploadHint.mimeType === 'application/octet-stream')) {
      const sniffed = await sniffRemoteMagic(filePath, timeoutMs, fetchHeaders);
      if (sniffed?.mimeType) {
        uploadHint.mimeType = sniffed.mimeType;
        uploadHint.ext = sniffed.ext || uploadHint.ext;
        uploadHint.magic = sniffed.magic || uploadHint.magic;
        uploadHint.kind = sniffed.kind || uploadHint.kind;
      }
    }

    const canChunk = chunkEnabled && Number.isFinite(fileSize) && fileSize > maxChunkThreshold && (!isUrl || usingTemp || (acceptRanges && acceptRanges.includes('bytes')));
    logger.info?.('av_transcribe:chunk_decision', {
      label: 'PLUGIN', isUrl, usingTemp, fileSize, chunkEnabled, acceptRanges, threshold: maxChunkThreshold, canChunk
    });

    if (!canChunk) {
      // 单次直传：调用一次 ASR 接口，然后将结果归一化为结构化 JSON
      const FormData = (await import('form-data')).default;
      const formData = new FormData();
      if (isUrl && !usingTemp) {
        const remote = await httpClient.get(filePath, { responseType: 'stream', timeout: timeoutMs, maxBodyLength: Infinity, headers: fetchHeaders });
        const guessedName = (() => { try { return path.basename(new URL(filePath).pathname) || 'audio'; } catch { return 'audio'; }})();
        const remoteCT = normalizeMimeType(remote.headers?.['content-type'] || '');
        const contentType = (isAudioOrVideoMime(remoteCT) ? remoteCT : (uploadHint.mimeType || 'application/octet-stream'));
        formData.append('file', remote.data, { filename: guessedName, contentType });
      } else {
        const fileStream = fssync.createReadStream(localPath);
        formData.append('file', fileStream, { filename: path.basename(localPath), contentType: uploadHint.mimeType || 'application/octet-stream' });
      }
      formData.append('model', model);
      if (language) formData.append('language', language);
      if (prompt) formData.append('prompt', prompt);

      const headers = { Authorization: `Bearer ${apiKey}` };

      logger.info?.('av_transcribe:api_call', { label: 'PLUGIN', url: `${baseUrl}/audio/transcriptions`, model, language, source: isUrl ? 'url' : 'file', mode: 'single' });
      const response = await postWithRetry(`${baseUrl}/audio/transcriptions`, formData, timeoutMs, retries, retryBaseMs, headers);
      logger.info?.('av_transcribe:complete', { label: 'PLUGIN' });
      const raw = response.data;
      if (usingTemp) { try { fssync.unlinkSync(localPath); } catch {} }
      const normalized = normalizeTranscribeOutput(raw, {
        model,
        file: filePath,
        chunks: 1,
        source: isUrl ? 'url' : 'file',
        languageHint: language,
      });
      return { success: true, code: 'OK', data: normalized };
    }

    // 分片并发处理
    const chunks = buildChunks(fileSize, chunkSizeBytes, chunkOverlapBytes);
    logger.info?.('av_transcribe:chunking', { label: 'PLUGIN', fileSize, chunks: chunks.length, chunkSizeBytes, chunkOverlapBytes, concurrency: maxConcurrency });

    const worker = async (c) => {
      const FormData = (await import('form-data')).default;
      const formData = new FormData();
      let filename = 'audio_chunk_' + (c.index + 1);
      let contentType = uploadHint.mimeType || 'application/octet-stream';

      if (isUrl && !usingTemp) {
        const rangeHeader = { Range: `bytes=${c.start}-${c.end - 1}`, ...fetchHeaders };
        const resp = await httpClient.get(filePath, { responseType: 'stream', headers: rangeHeader, timeout: timeoutMs, maxBodyLength: Infinity });
        try { filename = path.basename(new URL(filePath).pathname) || filename; } catch {}
        const rangedCT = normalizeMimeType(resp.headers?.['content-type'] || '');
        if (isAudioOrVideoMime(rangedCT)) contentType = rangedCT;
        formData.append('file', resp.data, { filename, contentType });
      } else {
        try { filename = path.basename(localPath).replace(/(\.[^./\\]+)?$/, `_chunk_${c.index + 1}$1`); } catch {}
        const stream = fssync.createReadStream(localPath, { start: c.start, end: c.end - 1 });
        formData.append('file', stream, { filename, contentType });
      }

      formData.append('model', model);
      if (language) formData.append('language', language);
      const addition = ` (音频第${c.index + 1}部分，共${chunks.length}部分，请确保转录完整准确)`;
      const chunkPrompt = chunks.length > 1 ? (prompt ? `${prompt}${addition}` : addition) : (prompt || '');
      if (chunkPrompt) formData.append('prompt', chunkPrompt);

      const headers = { Authorization: `Bearer ${apiKey}` };

      const res = await postWithRetry(`${baseUrl}/audio/transcriptions`, formData, timeoutMs, retries, retryBaseMs, headers);
      const data = res.data;
      // 归一化每片结果
      let text = '';
      let lang = '';
      if (data && typeof data === 'object') {
        text = String(data.text || '').trim();
        lang = String(data.language || '').trim();
      } else if (typeof data === 'string') {
        text = data;
      }
      return { index: c.index, text, language: lang };
    };

    let results;
    try {
      results = await mapLimit(chunks, maxConcurrency, worker);
    } catch (err) {
      logger.warn?.('av_transcribe:chunk_parallel_error', { error: toErrInfo(err) });
      // Fallback: sequential processing
      results = await mapLimit(chunks, 1, worker);
    }

    // 排序拼接
    const ordered = results.slice().sort((a, b) => a.index - b.index);
    const combinedText = ordered.map(r => r.text).filter(Boolean).join('\n');
    const combinedLang = pickLanguage(ordered.map(r => r.language));

    logger.info?.('av_transcribe:complete', { label: 'PLUGIN', chunks: chunks.length });
    if (usingTemp) { try { fssync.unlinkSync(localPath); } catch {} }

    const normalized = normalizeTranscribeOutput([combinedText, combinedLang], {
      model,
      file: filePath,
      chunks: chunks.length,
      source: isUrl ? 'url' : 'file',
      languageHint: language,
    });
    return { success: true, code: 'OK', data: normalized };
    
  } catch (e) {
    logger.error?.('av_transcribe:error', {
      label: 'PLUGIN',
      error: String(e?.message || e),
      detail: toErrInfo(e),
      stack: e?.stack
    });

    const isTimeout = isTimeoutError(e);
    const code = isTimeout ? 'TIMEOUT' : 'ERR';
    const kind = isTimeout ? 'TIMEOUT' : 'ERR';
    const isUrl = String(filePath || '').startsWith('http://') || String(filePath || '').startsWith('https://');
    return { success: false, code, error: String(e?.message || e), advice: buildAdvice(kind, { tool: 'av_transcribe', file: filePath, source: isUrl ? 'url' : 'file' }) };
  }
}

export default async function handler(args = {}, options = {}) {
  const rawArgs = (args && typeof args === 'object') ? args : {};
  const { files: _files, ...baseArgs } = rawArgs;

  const files = Array.isArray(_files) ? _files.map((v) => String(v || '').trim()).filter(Boolean) : [];
  const file = String(rawArgs.file || '').trim();
  const inputs = files.length ? files : (file ? [file] : []);

  if (!inputs.length) {
    return fail('file/files 不能为空', 'INVALID', { advice: buildAdvice('INVALID', { tool: 'av_transcribe' }) });
  }

  if (inputs.length === 1) {
    const out = await legacyHandler({ ...baseArgs, file: inputs[0] }, options);
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

  const results = [];
  for (const f of inputs) {
    const out = await legacyHandler({ ...baseArgs, file: f }, options);
    if (out && typeof out === 'object' && typeof out.success === 'boolean') {
      results.push({ file: f, ...out });
    } else {
      results.push({ file: f, success: true, code: 'OK', data: out });
    }
  }

  return ok({ mode: 'batch', results });
}
