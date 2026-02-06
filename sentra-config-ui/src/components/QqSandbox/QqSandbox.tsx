import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './QqSandbox.module.css';
import { storage } from '../../utils/storage';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { App as AntdApp, Button, Drawer, Dropdown, Modal, Tag, Tooltip } from 'antd';
import { ConversationList } from './ConversationList';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { RightPanel } from './RightPanel';
import { SettingsDrawer } from './SettingsDrawer';
import { useQqRuntimeConfig } from './useQqRuntimeConfig';
import { useQqPersistence } from './useQqPersistence';
import { useQqUiHeartbeat } from './useQqUiHeartbeat';
import { useQqWsConnection } from './useQqWsConnection';
import type { Conversation, FormattedMessage } from './QqSandbox.types';
import {
  ApiOutlined,
  DisconnectOutlined,
  LeftOutlined,
  MessageOutlined,
  SettingOutlined,
  SyncOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';

const BASIC_EMOJIS = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '😭', '😡', '🤔', '😴',
  '👍', '👎', '👏', '🙏', '💪', '🔥', '❤️', '💔', '🎉', '✨', '🌟', '💯',
  '🙈', '🙉', '🙊', '🍻', '🍜', '☕', '⚡', '🎁', '📌', '✅', '❌',
];

function nowMsFromMsg(m: FormattedMessage) {
  const t = Number(m?.time || 0);
  return Number.isFinite(t) && t > 0 ? t * 1000 : Date.now();
}

function formatTimeShort(ms: number) {
  try {
    const d = new Date(ms);
    const HH = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${HH}:${mm}`;
  } catch {
    return '';
  }
}

function stripAnsi(input: string) {
  try {
    const s = String(input ?? '');
    return s
      .replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '')
      .replace(/\u001b\][^\u0007]*\u0007/g, '')
      .replace(/\u001b\][^\u001b]*\u001b\\/g, '')
      .replace(/\u001b\([0-9A-Za-z]/g, '')
      .replace(/\u001b\)[0-9A-Za-z]/g, '')
      .replace(/\r\n/g, '\n');
  } catch {
    return String(input ?? '');
  }
}

function summarizeScriptError(raw: string) {
  const txt = stripAnsi(String(raw ?? '')).trim();
  const lower = txt.toLowerCase();
  const portMatch = txt.match(/Port\s+(\d+)\s+is\s+already\s+in\s+use\b/i);
  if (portMatch && portMatch[1]) {
    const pidMatch = txt.match(/PID\s+(\d+)/i);
    const imgMatch = txt.match(/\(([^)]+)\)/);
    const port = portMatch[1];
    const pid = pidMatch?.[1] ? `（PID ${pidMatch[1]}）` : '';
    const img = imgMatch?.[1] ? ` ${imgMatch[1]}` : '';
    return `端口 ${port} 已被占用${pid}${img}。请关闭占用进程，或在 NC沙盒 设置中修改 STREAM_PORT/REVERSE_PORT 后重试。`;
  }
  if (lower.includes('pm2 not found')) return '未找到 pm2。请先安装 pm2，或确保项目 node_modules/.bin 中存在 pm2。';
  if (lower.includes('no package manager found')) return '未检测到包管理器（pnpm/npm/yarn）。请先安装或配置 PACKAGE_MANAGER。';
  if (lower.includes('ecosystem file not found')) return '缺少 ecosystem 配置文件，无法启动 NC沙盒。请检查项目文件是否完整。';
  if (lower.includes('timeout')) return '执行超时：可能正在安装依赖或构建。建议等待更久或稍后重试。';
  return '';
}

async function copyTextToClipboard(text: string) {
  const t = String(text ?? '');
  if (!t) return;
  try {
    await navigator.clipboard.writeText(t);
    return;
  } catch {
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch {
  }
}

function formatConvoTime(ms: number) {
  try {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms);
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (sameDay) return formatTimeShort(ms);

    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    const isYesterday = d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate();
    if (isYesterday) return '昨天';

    const diffDays = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
    if (diffDays >= 1 && diffDays <= 6) {
      try {
        const wk = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(d);
        return wk;
      } catch {
        const map = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        return map[d.getDay()] || '';
      }
    }

    const MM = String(d.getMonth() + 1).padStart(2, '0');
    const DD = String(d.getDate()).padStart(2, '0');
    return `${MM}/${DD}`;
  } catch {
    return '';
  }
}

function pickInitials(s: string) {
  const t = String(s || '').trim();
  if (!t) return '?';
  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0].slice(0, 1) + parts[1].slice(0, 1)).toUpperCase();
}

function buildConversationKey(
  m: FormattedMessage,
  opts?: { fallbackActiveGroupId?: number },
): { key: string; kind: 'group' | 'private'; targetId: number; title: string } {
  if (m.type === 'group') {
    const anyM: any = m as any;
    const gidRaw =
      m.group_id ??
      anyM.groupId ??
      anyM.groupID ??
      anyM.group?.group_id ??
      anyM.group?.id ??
      anyM.target_id ??
      anyM.targetId;
    let gid = Number(gidRaw || 0);
    if (!Number.isFinite(gid) || gid <= 0) gid = Number(opts?.fallbackActiveGroupId || 0);

    const titleRaw =
      m.group_name ??
      anyM.group_name ??
      anyM.groupName ??
      anyM.group?.group_name ??
      anyM.group?.name;
    const title = String(titleRaw || (gid ? `群 ${gid}` : '群聊'));
    return { key: `g:${gid || 0}`, kind: 'group', targetId: gid || 0, title };
  }

  const anyM: any = m as any;
  const peerId = Number(m.peer_id || 0) || Number(anyM.peerId || 0) || Number(m.sender_id || 0);
  const title = String(m.sender_name || (peerId ? `QQ ${peerId}` : '私聊'));
  return { key: `p:${peerId || 0}`, kind: 'private', targetId: peerId || 0, title };
}

function stripNoisyMetaLines(raw: string): string {
  const s = String(raw || '');
  if (!s) return '';

  // Common agent-produced headers like:
  // "消息ID: ... | 会话: ... | 群聊 | 群名: ... | 群号: ... | 发送者: ..."
  // And follow-up lines like "发送了一张图片:".
  const lines = s.split(/\r?\n/);
  const kept: string[] = [];
  let strippedAny = false;

  for (const line of lines) {
    const l = String(line || '').trimEnd();
    const lTrim = l.trim();
    if (!lTrim) {
      kept.push('');
      continue;
    }

    const noisy =
      /^消息ID\s*:/i.test(lTrim) ||
      /^会话\s*:/i.test(lTrim) ||
      /^群聊\b/i.test(lTrim) ||
      /^私聊\b/i.test(lTrim) ||
      /^群名\s*:/i.test(lTrim) ||
      /^群号\s*:/i.test(lTrim) ||
      /^发送者\s*:/i.test(lTrim) ||
      /^发送了一张图片\s*:?/i.test(lTrim) ||
      /^发送了\s*\d+\s*张图片\s*:?/i.test(lTrim);

    if (noisy) {
      strippedAny = true;
      continue;
    }

    kept.push(l);
  }

  const out = kept.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const out2 = out
    // Strip markdown image syntax (images are rendered in attachments grid)
    .replace(/!\[[^\]]*\]\([^\)]+\)/g, '')
    // Strip markdown links that point to local files (we render files separately)
    .replace(/\[[^\]]+\]\(file:\/\/\/[^\)]+\)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // If we stripped and ended up empty, drop it (these lines are noise)
  if ((strippedAny || out2 !== out) && !out2) return '';
  return out2;
}

function stripCqTags(raw: string): string {
  const s = String(raw || '');
  if (!s) return '';
  return s
    .replace(/\[CQ:image,[^\]]+\]/gi, '')
    .replace(/\[CQ:file,[^\]]+\]/gi, '')
    .replace(/\[CQ:record,[^\]]+\]/gi, '')
    .replace(/\[CQ:video,[^\]]+\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hasOnlyCqMedia(text: string): boolean {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const cleaned = stripCqTags(raw).trim();
  if (cleaned) return false;
  return (
    /\[CQ:image,[^\]]+\]/i.test(raw) ||
    /\[CQ:file,[^\]]+\]/i.test(raw) ||
    /\[CQ:record,[^\]]+\]/i.test(raw) ||
    /\[CQ:video,[^\]]+\]/i.test(raw)
  );
}

function uniqStrings(arr: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of arr) {
    const k = String(s || '');
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function normalizeLocalFileUrlToPath(input: string): string {
  const s0 = String(input || '').trim();
  if (!s0) return '';
  if (!/^file:\/\//i.test(s0)) return s0;
  try {
    const u = new URL(s0);
    if (u.protocol !== 'file:') return s0;
    let p = u.pathname || '';
    try { p = decodeURIComponent(p); } catch { }
    if (p.startsWith('/') && /^[a-zA-Z]:[\\/]/.test(p.slice(1))) p = p.slice(1);
    return p;
  } catch {
    let p = s0.replace(/^file:\/\//i, '');
    try { p = decodeURIComponent(p); } catch { }
    if (p.startsWith('/') && /^[a-zA-Z]:[\\/]/.test(p.slice(1))) p = p.slice(1);
    return p;
  }
}

function inferNapcatCachedImagePath(file: string): string {
  const f = String(file || '').trim();
  if (!f) return '';
  if (/^file:\/\//i.test(f)) return normalizeLocalFileUrlToPath(f);
  if (/^[a-zA-Z]:[\\/]/.test(f) || f.startsWith('/') || f.startsWith('\\')) return f;
  return '';
}

function inferNapcatCachedFilePath(file: string): string {
  const f = String(file || '').trim();
  if (!f) return '';
  if (/^file:\/\//i.test(f)) return normalizeLocalFileUrlToPath(f);
  if (/^[a-zA-Z]:[\\/]/.test(f) || f.startsWith('/') || f.startsWith('\\')) return f;
  return '';
}

function parseCqImageCandidates(raw: string): Array<{ url?: string; path?: string; summary?: string }> {
  const s = String(raw || '');
  if (!s) return [];
  const out: Array<{ url?: string; path?: string; summary?: string }> = [];
  const re = /\[CQ:image,([^\]]+)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const body = String(m[1] || '');
    const kv: Record<string, string> = {};
    for (const part of body.split(',')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim();
      let v = part.slice(idx + 1).trim();
      try { v = decodeURIComponent(v); } catch { }
      if (k) kv[k] = v;
    }
    const url = String(kv.url || '').trim();
    const file = String(kv.file || '').trim();
    const path = String(kv.path || '').trim();
    const summaryRaw = String(kv.summary || '').trim();
    const subType = String(kv.sub_type || '').trim();
    const summary = summaryRaw || (subType === '1' ? '[动画表情]' : '[图片]');

    const localFromFile = inferNapcatCachedImagePath(file);

    const pickedPath = path || localFromFile;
    const pickedUrl = url || (file && /^https?:\/\//i.test(file) ? file : '');
    if (pickedUrl || pickedPath) out.push({ url: pickedUrl || undefined, path: pickedPath || undefined, summary: summary || undefined });
  }
  return out;
}

function parseCqFileCandidates(raw: string): Array<{ url?: string; path?: string; name?: string }> {
  const s = String(raw || '');
  if (!s) return [];
  const out: Array<{ url?: string; path?: string; name?: string }> = [];
  const re = /\[CQ:file,([^\]]+)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const body = String(m[1] || '');
    const kv: Record<string, string> = {};
    for (const part of body.split(',')) {
      const idx = part.indexOf('=');
      if (idx <= 0) continue;
      const k = part.slice(0, idx).trim();
      let v = part.slice(idx + 1).trim();
      try { v = decodeURIComponent(v); } catch { }
      if (k) kv[k] = v;
    }
    const url = String(kv.url || '').trim();
    const file = String(kv.file || '').trim();
    const path = String(kv.path || '').trim();
    const name = String(kv.name || kv.filename || file || '').trim();
    const localFromFile = inferNapcatCachedFilePath(file);
    const pickedPath = path || localFromFile;
    const pickedUrl = url || (file && /^https?:\/\//i.test(file) ? file : '');
    if (pickedUrl || pickedPath || name) out.push({ url: pickedUrl || undefined, path: pickedPath || undefined, name: name || undefined });
  }
  return out;
}

function asPlainPreview(m: FormattedMessage) {
  const cqImgs = parseCqImageCandidates(String((m as any)?.text || '') + '\n' + String((m as any)?.summary || '') + '\n' + String((m as any)?.objective || ''));
  if (cqImgs.length > 0) return cqImgs[0]?.summary || '[图片]';
  const cqFiles = parseCqFileCandidates(String((m as any)?.text || '') + '\n' + String((m as any)?.summary || '') + '\n' + String((m as any)?.objective || ''));
  if (cqFiles.length > 0) return cqFiles[0]?.name || '[文件]';

  const t = stripNoisyMetaLines(stripCqTags(String(m.text || ''))).trim();
  if (t) return t;
  const imgs = Array.isArray(m.images) ? m.images : [];
  if (imgs.length > 0) return imgs[0]?.summary || '[图片]';
  return stripNoisyMetaLines(stripCqTags(String(m.summary || ''))).trim() || '[消息]';
}

function formatSenderDisplay(m: FormattedMessage, isMe: boolean): { displayName: string; roleLabel: string } {
  const baseName = String((m as any)?.sender_name || (m as any)?.sender_id || '').trim();
  const cardName = String((m as any)?.sender_card || '').trim();
  const displayName = isMe
    ? '我'
    : (cardName && baseName && cardName !== baseName ? `${cardName}(${baseName})` : (cardName || baseName || String((m as any)?.sender_id || '')));

  const role = String((m as any)?.sender_role || '').toLowerCase();
  const roleLabel = role === 'owner' ? '群主' : (role === 'admin' ? '管理员' : '');
  return { displayName, roleLabel };
}

function avatarUrlForUser(userId: number) {
  const id = Number(userId || 0);
  if (!Number.isFinite(id) || id <= 0) return '';
  return `https://q1.qlogo.cn/g?b=qq&nk=${id}&s=640`;
}

function avatarUrlForGroup(groupId: number) {
  const id = Number(groupId || 0);
  if (!Number.isFinite(id) || id <= 0) return '';
  return `https://p.qlogo.cn/gh/${id}/${id}/100`;
}

function toPlainSingleLine(s: string) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[*_`>#\-\[\]()+!]/g, '')
    .trim();
}

export function QqSandbox() {
  const { message: antdMessage } = AntdApp.useApp();
  const token =
    storage.getString('sentra_auth_token', { backend: 'session', fallback: '' }) ||
    storage.getString('sentra_auth_token', { backend: 'local', fallback: '' });

  const { uiRuntimeConfigVer, qqLimitsRef } = useQqRuntimeConfig();

  const avatarBrokenRef = useRef(new Map<string, number>());
  const [, forceAvatarBrokenVer] = useState(0);
  const isAvatarBroken = useCallback((key: string) => {
    const k = String(key || '');
    if (!k) return false;
    const ts = avatarBrokenRef.current.get(k);
    if (!ts) return false;
    // Auto-retry after a while to avoid "permanent default avatar".
    const TTL_MS = 60 * 1000;
    if (Date.now() - ts > TTL_MS) {
      try { avatarBrokenRef.current.delete(k); } catch { }
      return false;
    }
    return true;
  }, []);
  const markAvatarBroken = useCallback((key: string) => {
    const k = String(key || '');
    if (!k) return;
    if (avatarBrokenRef.current.has(k)) return;
    avatarBrokenRef.current.set(k, Date.now());
    forceAvatarBrokenVer((v) => v + 1);
  }, []);
  const avatarKey = useCallback((kind: 'user' | 'group', id: number) => {
    const n = Number(id || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    return kind === 'group' ? `g:${n}` : `u:${n}`;
  }, []);

  const [defaultStreamPort, setDefaultStreamPort] = useState<number>(0);
  const [napcatEnvPath, setNapcatEnvPath] = useState<string>('');

  const [streamPort, setStreamPort] = useState<number>(() => {
    const v = storage.getNumber('sentra_qq_sandbox_stream_port', { fallback: 0 });
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [statusText, setStatusText] = useState('');
  const [proxyDiag, setProxyDiag] = useState('');
  const [showDev, setShowDev] = useState(false);
  const [syncSource, setSyncSource] = useState<'recent' | 'groups' | 'friends' | 'all'>('recent');
  const [sidebarMode, setSidebarMode] = useState<'chats' | 'contacts'>('chats');
  const [contactsTab, setContactsTab] = useState<'groups' | 'friends'>('groups');
  const [search, setSearch] = useState('');

  const [isNarrow, setIsNarrow] = useState(() => {
    try { return window.innerWidth < 920; } catch { return false; }
  });
  const [mobileMembersOpen, setMobileMembersOpen] = useState(false);
  const [mobilePage, setMobilePage] = useState<'list' | 'chat'>('list');

  useEffect(() => {
    const onResize = () => {
      try { setIsNarrow(window.innerWidth < 920); } catch { }
    };
    try {
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    } catch {
      return;
    }
  }, []);

  const [forwardExpand, setForwardExpand] = useState<Record<string, boolean>>({});

  const onFormattedMessageRef = useRef<null | ((m: FormattedMessage) => void)>(null);
  const incomingFormattedQueueRef = useRef<FormattedMessage[]>([]);
  const selfIdRef = useRef<number>(0);
  const lastPrivateTargetRef = useRef<number>(0);

  const userCacheRef = useRef(new Map<number, { title: string; avatarUrl?: string; ts: number }>());
  const groupCacheRef = useRef(new Map<number, { title: string; avatarUrl?: string; ts: number }>());
  const memberCacheRef = useRef(new Map<string, { title: string; ts: number }>());
  const groupMembersCacheRef = useRef(new Map<number, { ts: number; list: any[] }>());
  const [mentionVersion, setMentionVersion] = useState(0);
  const [memberListVersion, setMemberListVersion] = useState(0);
  const [membersBusy, setMembersBusy] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');

  const [convoMap, setConvoMap] = useState<Record<string, Conversation>>({});
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const activeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isNarrow) return;
    if (!activeKey) {
      setMobilePage('list');
    }
  }, [activeKey, isNarrow]);

  const [sendText, setSendText] = useState('');
  const [replyDraft, setReplyDraft] = useState<null | { messageId: number; senderName: string; text: string }>(null);
  const [draftMentions, setDraftMentions] = useState<Array<{ uid: number; title: string }>>([]);
  const draftMentionsRef = useRef<Array<{ uid: number; title: string }>>([]);

  const [pendingAttachments, setPendingAttachments] = useState<Array<{ id: string; kind: 'image' | 'file'; file: File; name: string; size: number; previewUrl?: string }>>([]);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null!);
  const composerToolbarRef = useRef<HTMLDivElement>(null!);
  const textareaRef = useRef<any>(null);

  const [imgPreviewSrc, setImgPreviewSrc] = useState<string>('');
  const [imgPreviewOpen, setImgPreviewOpen] = useState(false);

  const [sendHotkey, setSendHotkey] = useState<'enter' | 'ctrl_enter' | 'shift_enter'>(() => {
    const v = String(storage.getString('sentra_qq_sandbox_send_hotkey', { fallback: 'enter' }) || '').trim();
    if (v === 'ctrl_enter' || v === 'shift_enter' || v === 'enter') return v;
    return 'enter';
  });

  useEffect(() => {
    try {
      storage.setString('sentra_qq_sandbox_send_hotkey', String(sendHotkey), 'local');
    } catch {
    }
  }, [sendHotkey]);

  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiTab, setEmojiTab] = useState('emoji');
  const [stickersLoading, setStickersLoading] = useState(false);
  const [stickers, setStickers] = useState<Array<{ filename: string; description: string; enabled?: boolean; tags?: string[] }>>([]);
  const stickersLoadedAtRef = useRef(0);

  const buildEmojiStickerUrl = useCallback((filename: string, opts?: { thumb?: boolean }) => {
    const fn = String(filename || '').trim();
    if (!fn) return '';
    try {
      const u = new URL(`${window.location.origin}/api/emoji-stickers/image`);
      u.searchParams.set('filename', fn);
      if (opts?.thumb) {
        u.searchParams.set('thumb', '1');
        u.searchParams.set('maxDim', '72');
        u.searchParams.set('quality', '75');
      }
      if (token) u.searchParams.set('token', token);
      return u.toString();
    } catch {
      const q = new URLSearchParams();
      q.set('filename', fn);
      if (opts?.thumb) {
        q.set('thumb', '1');
        q.set('maxDim', '72');
        q.set('quality', '75');
      }
      if (token) q.set('token', token);
      return `/api/emoji-stickers/image?${q.toString()}`;
    }
  }, [token]);

  const loadStickers = useCallback(async (force?: boolean) => {
    const now = Date.now();
    if (!force && stickers.length > 0 && now - stickersLoadedAtRef.current < 15_000) return;
    if (stickersLoading) return;
    setStickersLoading(true);
    try {
      const h: Record<string, string> = {};
      if (token) h['x-auth-token'] = token;
      const r = await fetch('/api/emoji-stickers/items', { headers: h });
      const data: any = await r.json().catch(() => ({}));
      const items = Array.isArray(data?.items) ? data.items : [];
      const next = items
        .map((it: any) => ({
          filename: String(it?.filename || '').trim(),
          description: String(it?.description || '').trim(),
          enabled: it?.enabled !== false,
          tags: Array.isArray(it?.tags) ? it.tags.map((t: any) => String(t || '').trim()).filter(Boolean) : [],
        }))
        .filter((it: any) => !!it.filename && it.enabled !== false);
      setStickers(next);
      stickersLoadedAtRef.current = Date.now();
    } catch {
      setStickers([]);
    } finally {
      setStickersLoading(false);
    }
  }, [stickers.length, stickersLoading, token]);

  const addPendingAttachment = useCallback((file: File, kind: 'image' | 'file') => {
    const f = file;
    if (!f) return;
    const name = String(f.name || '').trim() || (kind === 'image' ? 'image.png' : 'file');
    const size = Number(f.size || 0);
    const id = `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const previewUrl = kind === 'image' ? (() => {
      try { return URL.createObjectURL(f); } catch { return undefined; }
    })() : undefined;
    setPendingAttachments((prev) => [...(prev || []), { id, kind, file: f, name, size, previewUrl }]);
  }, []);

  useEffect(() => {
    draftMentionsRef.current = draftMentions;
  }, [draftMentions]);

  const defaultRenderPageSize = useMemo(() => {
    return Math.max(20, Math.min(2000, Math.trunc(qqLimitsRef.current.renderPageSize || 120)));
  }, [uiRuntimeConfigVer]);

  const defaultRenderPageStep = useMemo(() => {
    return Math.max(10, Math.min(2000, Math.trunc(qqLimitsRef.current.renderPageStep || 120)));
  }, [uiRuntimeConfigVer]);

  const [renderLimit, setRenderLimit] = useState(defaultRenderPageSize);

  useEffect(() => {
    // When config changes (hot reload), keep render page size consistent.
    setRenderLimit(defaultRenderPageSize);
  }, [defaultRenderPageSize]);
  const lastRenderKeyRef = useRef<string>('');
  const mdCacheRef = useRef(new Map<string, string>());
  const mdCacheVerRef = useRef<number>(-1);

  const [napcatBusy, setNapcatBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);

  const [scriptFailOpen, setScriptFailOpen] = useState(false);
  const [scriptFailTitle, setScriptFailTitle] = useState('');
  const [scriptFailSummary, setScriptFailSummary] = useState('');
  const [scriptFailLog, setScriptFailLog] = useState('');
  const [scriptFailRawLog, setScriptFailRawLog] = useState('');

  const hydratedRef = useRef(false);
  const [rightPanelOpen, setRightPanelOpen] = useState<boolean>(() => {
    const v = storage.getString('sentra_qq_sandbox_right_panel_open', { fallback: '1' });
    return v !== '0';
  });

  useQqPersistence({
    hydratedRef,
    selfIdRef,
    qqLimitsRef,
    activeKey,
    setActiveKey,
    convoMap,
    setConvoMap,
    sendText,
    setSendText,
    pendingAttachments,
  });

  const buildRawFileUrl = useCallback((p: string, opts?: { download?: boolean }) => {
    const path = String(p || '').trim();
    if (!path) return '';
    try {
      const u = new URL(`${window.location.origin}/api/files/raw`);
      u.searchParams.set('path', path);
      if (token) u.searchParams.set('token', token);
      if (opts?.download) u.searchParams.set('download', '1');
      return u.toString();
    } catch {
      const q = new URLSearchParams();
      q.set('path', path);
      if (token) q.set('token', token);
      if (opts?.download) q.set('download', '1');
      return `/api/files/raw?${q.toString()}`;
    }
  }, [token]);

  const fetchSandboxConfig = useCallback(async () => {
    const hasStored = (() => {
      try {
        return localStorage.getItem('sentra_qq_sandbox_stream_port') != null;
      } catch {
        return false;
      }
    })();

    const headers: Record<string, string> = {};
    if (token) headers['x-auth-token'] = token;

    try {
      const r = await fetch('/api/qq/sandbox/config', { headers });
      if (!r.ok) return null;
      const cfg: any = await r.json();
      if (!cfg) return null;
      const p = Number(cfg?.streamPort || 0);
      setDefaultStreamPort(Number.isFinite(p) && p > 0 ? Math.trunc(p) : 0);
      setNapcatEnvPath(String(cfg?.envPath || ''));
      if (!hasStored && (!Number.isFinite(streamPort) || streamPort <= 0) && Number.isFinite(p) && p > 0) {
        setStreamPort(Math.trunc(p));
      }
      return cfg;
    } catch {
      return null;
    }
  }, [streamPort, token]);

  const authHeaders = useMemo(() => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h['x-auth-token'] = token;
    return h;
  }, [token]);

  useQqUiHeartbeat({ authHeaders, scope: 'qq_sandbox', intervalMs: 15_000 });

  const sleep = useCallback((ms: number) => new Promise<void>((r) => setTimeout(r, ms)), []);

  const runScriptAndWait = useCallback(async (url: string, args: string[], title: string, timeoutMs = 60_000) => {
    if (napcatBusy) return;
    setNapcatBusy(true);
    const hide = antdMessage.loading({ content: `${title}...`, duration: 0 });
    try {
      const res = await fetch(url, { method: 'POST', headers: authHeaders, body: JSON.stringify({ args }) });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success || !data?.processId) {
        const msg = String(data?.message || data?.error || `HTTP ${res.status}`);
        throw new Error(msg);
      }
      const pid = String(data.processId);
      const startedAt = Date.now();
      let lastStatus: any = null;
      while (true) {
        if (Date.now() - startedAt > timeoutMs) throw new Error('timeout');
        const stRes = await fetch(`/api/scripts/status/${encodeURIComponent(pid)}`, { headers: authHeaders });
        if (stRes.status === 404) throw new Error('process_not_found');
        const st: any = await stRes.json().catch(() => ({}));
        lastStatus = st;
        if (st && (st.exitCode != null || st.endTime != null)) break;
        await sleep(650);
      }

      if (lastStatus && lastStatus.exitCode != null && Number(lastStatus.exitCode) !== 0) {
        const lines = Array.isArray(lastStatus.output) ? lastStatus.output : [];
        const tail = lines.slice(Math.max(0, lines.length - 80)).join('');
        const msg = tail ? `exitCode=${String(lastStatus.exitCode)}\n\n${tail}` : `exitCode=${String(lastStatus.exitCode)}`;
        throw new Error(msg);
      }
      antdMessage.success(`${title}完成`);
    } catch (e: any) {
      const rawMsg = String(e?.message || e);
      const cleaned = stripAnsi(rawMsg);
      const summary = summarizeScriptError(cleaned);
      const msg = cleaned === 'timeout'
        ? 'timeout（可能在安装依赖/构建，首次启动建议等待更久）'
        : cleaned;
      setScriptFailTitle(`${title}失败`);
      setScriptFailSummary(summary);
      setScriptFailLog(msg);
      setScriptFailRawLog(rawMsg);
      setScriptFailOpen(true);
      antdMessage.error(`${title}失败`);
    } finally {
      hide();
      setNapcatBusy(false);
    }
  }, [antdMessage, authHeaders, napcatBusy, sleep]);

  const normalizeMediaUrl = useCallback((u?: string, p?: string, opts?: { download?: boolean }) => {
    const path = String(p || '').trim();
    if (path) return buildRawFileUrl(path, opts);
    const url = String(u || '').trim();
    if (url && (/^https?:\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:'))) return url;
    return '';
  }, [buildRawFileUrl]);

  const normalizeHttpUrl = useCallback((input?: string): string => {
    const s0 = String(input || '').trim();
    if (!s0) return '';
    if (/^https?:\/\//i.test(s0) || s0.startsWith('data:') || s0.startsWith('blob:')) return s0;
    if (s0.startsWith('//')) return `https:${s0}`;
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[\/]|$)/i.test(s0)) {
      return `https://${s0}`;
    }
    return '';
  }, []);

  const isLocalPathLike = useCallback((input?: string): boolean => {
    const s = String(input || '').trim();
    if (!s) return false;
    if (/^https?:\/\//i.test(s) || s.startsWith('data:') || s.startsWith('blob:') || s.startsWith('//')) return false;
    if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
    if (s.startsWith('\\\\')) return true;
    if (s.startsWith('/') || s.startsWith('\\')) return true;
    if (s.includes('sentra-adapter/napcat/cache')) return true;
    return false;
  }, []);

  const normalizeCardImageSrc = useCallback((raw?: string): string => {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^file:\/\//i.test(s)) {
      let p = s.replace(/^file:\/\//i, '');
      try { p = decodeURIComponent(p); } catch { }
      if (p.startsWith('/') && /^[a-zA-Z]:[\\/]/.test(p.slice(1))) {
        p = p.slice(1);
      }
      return buildRawFileUrl(p);
    }
    const http = normalizeHttpUrl(s);
    if (http) return http;
    if (isLocalPathLike(s)) return buildRawFileUrl(s);
    return '';
  }, [buildRawFileUrl, isLocalPathLike, normalizeHttpUrl]);

  const rewriteMdUrl = useCallback((href?: string, opts?: { download?: boolean }) => {
    const s0 = String(href || '').trim();
    if (!s0) return '';
    if (/^https?:\/\//i.test(s0) || s0.startsWith('data:') || s0.startsWith('blob:')) return s0;
    const http2 = normalizeHttpUrl(s0);
    if (http2) return http2;
    if (/^file:\/\//i.test(s0)) {
      let p = s0.replace(/^file:\/\//i, '');
      try { p = decodeURIComponent(p); } catch { }
      if (p.startsWith('/') && /^[a-zA-Z]:[\\/]/.test(p.slice(1))) {
        p = p.slice(1);
      }
      return buildRawFileUrl(p, opts);
    }

    let p = s0;
    try { p = decodeURIComponent(p); } catch { }
    return buildRawFileUrl(p, opts);
  }, [buildRawFileUrl, normalizeHttpUrl]);

  const pickFirstImageUrl = useCallback((m: FormattedMessage) => {
    try {
      const imgs = Array.isArray(m.images) ? m.images : [];
      if (imgs.length > 0) {
        const first: any = imgs[0] as any;
        const p = String(first?.cache_path || first?.path || '') || inferNapcatCachedImagePath(String(first?.file || first?.name || ''));
        const u = normalizeMediaUrl(String(first?.url || ''), p);
        if (u) return u;
      }
    } catch {
    }
    try {
      const segs = Array.isArray((m as any)?.segments) ? (m as any).segments : [];
      for (const s of segs) {
        const t = String(s?.type || '');
        if (t !== 'image') continue;
        const d: any = s?.data || {};
        const p = String(d?.cache_path || d?.path || '') || inferNapcatCachedImagePath(String(d?.file || d?.name || ''));
        const u = normalizeMediaUrl(String(d?.url || ''), p);
        if (u) return u;
      }
    } catch {
    }
    try {
      const list = parseCqImageCandidates(String((m as any)?.text || '') + '\n' + String((m as any)?.summary || '') + '\n' + String((m as any)?.objective || ''));
      for (const it of list) {
        const u = normalizeMediaUrl(it?.url, it?.path);
        if (u) return u;
      }
    } catch {
    }
    try {
      const md = String((m as any)?.objective || (m as any)?.summary || (m as any)?.text || '');
      const match = md.match(/!\[[^\]]*\]\(([^)]+)\)/);
      if (match && match[1]) {
        const raw = String(match[1] || '').trim();
        if (!raw) return '';
        if (/^https?:\/\//i.test(raw) || raw.startsWith('data:') || raw.startsWith('blob:')) return raw;
        if (/^file:\/\//i.test(raw)) {
          let p = raw.replace(/^file:\/\//i, '');
          try { p = decodeURIComponent(p); } catch { }
          if (p.startsWith('/') && /^[a-zA-Z]:[\\/]/.test(p.slice(1))) {
            p = p.slice(1);
          }
          const u = buildRawFileUrl(p, { download: false });
          if (u) return u;
          return '';
        }
        const p = (() => {
          try { return decodeURIComponent(raw); } catch { return raw; }
        })();
        const u = buildRawFileUrl(p, { download: false });
        if (u) return u;
      }
    } catch {
    }
    return '';
  }, [buildRawFileUrl, normalizeMediaUrl]);

  useEffect(() => {
    if (Number.isFinite(streamPort) && streamPort > 0) {
      storage.setNumber('sentra_qq_sandbox_stream_port', streamPort);
    }
  }, [token, streamPort, defaultStreamPort]);

  useEffect(() => {
    try { storage.setString('sentra_qq_sandbox_right_panel_open', rightPanelOpen ? '1' : '0'); } catch { }
  }, [rightPanelOpen]);

  const onManualDisconnectCleanup = useCallback(() => {
    try {
      setRenderLimit(defaultRenderPageSize);
      mdCacheRef.current.clear();
      userCacheRef.current.clear();
      groupCacheRef.current.clear();
      memberCacheRef.current.clear();
      groupMembersCacheRef.current.clear();
      setMemberListVersion((v) => v + 1);
      setMentionVersion((v) => v + 1);
      lastPrivateTargetRef.current = 0;
      setDraftMentions([]);
    } catch {
    }
  }, [defaultRenderPageSize]);

  const enqueueIncomingFormattedMessage = useCallback((m: FormattedMessage) => {
    try {
      incomingFormattedQueueRef.current.push(m);
    } catch {
    }
  }, []);

  useEffect(() => {
    // Ensure the WS hook always has a safe handler even before the real handler is installed.
    onFormattedMessageRef.current = enqueueIncomingFormattedMessage;
  }, [enqueueIncomingFormattedMessage]);

  const { connectBusy, connectAndWait, disconnect, rpc } = useQqWsConnection({
    token,
    streamPort,
    defaultStreamPort,
    fetchSandboxConfig,
    antdMessage,
    setStatus,
    setStatusText,
    setProxyDiag,
    onFormattedMessageRef,
    onManualDisconnectCleanup,
  });

  useEffect(() => {
    if (!activeKey) return;
    if (lastRenderKeyRef.current !== activeKey) {
      lastRenderKeyRef.current = activeKey;
      setRenderLimit(defaultRenderPageSize);
    }
  }, [activeKey]);

  useEffect(() => {
    if (mdCacheVerRef.current !== mentionVersion) {
      mdCacheVerRef.current = mentionVersion;
      mdCacheRef.current.clear();
    }
  }, [mentionVersion]);

  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  useEffect(() => {
    try {
      messagesEndRef.current?.scrollIntoView({ block: 'end' });
    } catch {
      // ignore
    }
  }, [activeKey, convoMap]);

  const conversations = useMemo(() => {
    const list = Object.values(convoMap);
    list.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0));
    const q = String(search || '').trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => `${c.title} ${c.targetId}`.toLowerCase().includes(q));
  }, [convoMap, search]);

  const contactConversations = useMemo(() => {
    const list = Object.values(convoMap)
      .filter((c) => (contactsTab === 'groups' ? c.kind === 'group' : c.kind === 'private'));
    list.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN'));
    const q = String(search || '').trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => `${c.title} ${c.targetId}`.toLowerCase().includes(q));
  }, [contactsTab, convoMap, search]);

  const active = useMemo(() => {
    if (!activeKey) return null;
    return convoMap[activeKey] || null;
  }, [activeKey, convoMap]);

  const loadGroupMembers = useCallback(async (groupId: number, opts?: { force?: boolean }) => {
    const gid = Number(groupId || 0);
    if (!Number.isFinite(gid) || gid <= 0) return;
    const now = Date.now();
    const cached = groupMembersCacheRef.current.get(gid);
    if (!opts?.force && cached && now - cached.ts < 5 * 60 * 1000) return;
    if (membersBusy) return;
    setMembersBusy(true);
    try {
      const resp = await rpc({ type: 'sdk', path: 'group.memberList', args: [gid] });
      const arr: any[] = resp?.data || resp?.members || resp || [];
      if (Array.isArray(arr)) {
        groupMembersCacheRef.current.set(gid, { ts: now, list: arr });
        setMemberListVersion((v) => v + 1);
      }
    } catch {
    } finally {
      setMembersBusy(false);
    }
  }, [membersBusy, rpc]);

  const ensureUserInfo = useCallback(async (userId: number) => {
    const id = Number(userId || 0);
    if (!Number.isFinite(id) || id <= 0) return;
    const cached = userCacheRef.current.get(id);
    const now = Date.now();
    if (cached && now - cached.ts < 10 * 60 * 1000) return;
    try {
      const resp = await rpc({ type: 'sdk', path: 'user.info', args: [id, false] });
      const data: any = resp?.data ?? resp;
      const title = String(data?.remark || data?.nickname || data?.user_name || `QQ ${id}`);
      const avatarUrl = avatarUrlForUser(id);
      userCacheRef.current.set(id, { title, avatarUrl, ts: now });
      setConvoMap((prev) => {
        const key = `p:${id}`;
        const existing = prev[key];
        if (!existing) return prev;
        if (existing.title === title && existing.avatarUrl === avatarUrl) return prev;
        return { ...prev, [key]: { ...existing, title, avatarUrl } };
      });
    } catch {
    }
  }, [rpc]);

  const ensureGroupMemberInfo = useCallback(async (groupId: number, userId: number) => {
    const gid = Number(groupId || 0);
    const uid = Number(userId || 0);
    if (!Number.isFinite(gid) || gid <= 0) return;
    if (!Number.isFinite(uid) || uid <= 0) return;
    const key = `g:${gid}:u:${uid}`;
    const cached = memberCacheRef.current.get(key);
    const now = Date.now();
    if (cached && now - cached.ts < 10 * 60 * 1000) return;
    try {
      const resp = await rpc({ type: 'sdk', path: 'group.memberInfo', args: [gid, uid, false] });
      const data: any = resp?.data ?? resp;
      const title = String(data?.card || data?.nickname || data?.user_name || `QQ ${uid}`);
      memberCacheRef.current.set(key, { title, ts: now });
      setMentionVersion((v) => v + 1);
    } catch {
    }
  }, [rpc]);

  const formatAtDisplay = useCallback((m: FormattedMessage, qqAny: any) => {
    const qq = String(qqAny ?? '').trim();
    if (!qq) return '@';
    if (qq === 'all') return '@全体成员';
    const uid = Number(qq);
    if (!Number.isFinite(uid) || uid <= 0) return `@${qq}`;

    const gid = Number(m.group_id || 0);
    if (m.type === 'group' && Number.isFinite(gid) && gid > 0) {
      const key = `g:${gid}:u:${uid}`;
      const cached = memberCacheRef.current.get(key);
      if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return `@${cached.title}`;
      void ensureGroupMemberInfo(gid, uid);
      return `@${cached?.title || uid}`;
    }

    const cached = userCacheRef.current.get(uid);
    if (cached && Date.now() - cached.ts < 10 * 60 * 1000) return `@${cached.title}`;
    void ensureUserInfo(uid);
    return `@${cached?.title || uid}`;
  }, [ensureGroupMemberInfo, ensureUserInfo]);

  const copyText = useCallback(async (text: string) => {
    const t = String(text || '');
    if (!t) return;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(t);
        setStatusText('已复制');
        return;
      }
    } catch {
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setStatusText('已复制');
    } catch {
      setStatusText('复制失败');
    }
  }, []);

  const copyImageFromUrl = useCallback(async (url: string) => {
    const raw = String(url || '').trim();
    if (!raw) return;
    const u = (() => {
      const s0 = String(raw || '').trim();
      if (!s0) return '';
      if (/^https?:\/\//i.test(s0) || s0.startsWith('data:') || s0.startsWith('blob:')) return s0;
      if (/^file:\/\//i.test(s0)) {
        let p = s0.replace(/^file:\/\//i, '');
        try { p = decodeURIComponent(p); } catch { }
        if (p.startsWith('/') && /^[a-zA-Z]:[\\/]/.test(p.slice(1))) p = p.slice(1);
        return buildRawFileUrl(p, { download: false });
      }
      // If it's a bare path, route through /api/files/raw
      return buildRawFileUrl(s0, { download: false });
    })();
    if (!u) return;
    try {
      const res = await fetch(u, { headers: authHeaders, credentials: 'include', cache: 'no-store' });
      if (!res.ok) {
        const ct = String(res.headers.get('content-type') || '');
        throw new Error(`HTTP ${res.status}${ct ? ` (${ct})` : ''}`);
      }
      const blob = await res.blob();
      const anyWin: any = window as any;
      const ClipboardItemCtor = anyWin?.ClipboardItem;
      if (navigator.clipboard && ClipboardItemCtor) {
        try {
          const item = new ClipboardItemCtor({ [blob.type || 'image/png']: blob });
          await (navigator.clipboard as any).write([item]);
          setStatusText('图片已复制');
          return;
        } catch (e) {
          setStatusText(`复制图片失败（权限/环境限制），已复制图片链接`);
          await copyText(u);
          return;
        }
      }
      setStatusText('当前环境不支持复制图片，已复制图片链接');
      await copyText(u);
    } catch (e) {
      setStatusText(`复制图片失败: ${String((e as any)?.message || e)}`);
      try {
        await copyText(u);
      } catch {
      }
    }
  }, [authHeaders, buildRawFileUrl, copyText]);

  const ensureGroupInfo = useCallback(async (groupId: number) => {
    const id = Number(groupId || 0);
    if (!Number.isFinite(id) || id <= 0) return;
    const cached = groupCacheRef.current.get(id);
    const now = Date.now();
    if (cached && now - cached.ts < 10 * 60 * 1000) return;
    try {
      const resp = await rpc({ type: 'sdk', path: 'group.info', args: [id, false] });
      const data: any = resp?.data ?? resp;
      const title = String(data?.group_name || `群 ${id}`);
      const avatarUrl = avatarUrlForGroup(id);
      groupCacheRef.current.set(id, { title, avatarUrl, ts: now });
      setConvoMap((prev) => {
        const key = `g:${id}`;
        const existing = prev[key];
        if (!existing) return prev;
        if (existing.title === title && existing.avatarUrl === avatarUrl) return prev;
        return { ...prev, [key]: { ...existing, title, avatarUrl } };
      });
    } catch {
    }
  }, [rpc]);

  const handleFormattedMessage = useCallback((m: FormattedMessage) => {
    if (!m) return;

    if (Number.isFinite(Number(m.self_id)) && Number(m.self_id) > 0) {
      selfIdRef.current = Number(m.self_id);
      try { storage.setNumber('sentra_qq_sandbox_self_id', selfIdRef.current, 'local'); } catch { }
    }

    const info = (() => {
      if (m.type !== 'private') {
        const fallbackActiveGroupId = (() => {
          const ak = String(activeKeyRef.current || '');
          if (!ak.startsWith('g:')) return 0;
          const n = Number(ak.slice(2));
          return Number.isFinite(n) && n > 0 ? n : 0;
        })();
        return buildConversationKey(m, { fallbackActiveGroupId });
      }
      const selfId = Number(m.self_id || 0);
      const senderId = Number(m.sender_id || 0);
      const hint = Number(lastPrivateTargetRef.current || 0);
      if (selfId > 0 && senderId === selfId && hint > 0) {
        const peerId = Number(m.peer_id || 0) || hint;
        const title = `QQ ${peerId}`;
        return { key: `p:${peerId}`, kind: 'private' as const, targetId: peerId, title };
      }
      return buildConversationKey(m);
    })();

    const ms = nowMsFromMsg(m);
    const basePreview = toPlainSingleLine(stripNoisyMetaLines(asPlainPreview(m)));
    const selfId = Number(m.self_id || selfIdRef.current || 0);
    const isMe = selfId > 0 ? Number(m.sender_id) === selfId : false;
    const { displayName, roleLabel } = formatSenderDisplay(m, isMe);
    const senderLabel = roleLabel && info.kind === 'group' && !isMe ? `${displayName}[${roleLabel}]` : displayName;
    const preview = info.kind === 'group' ? `${senderLabel}: ${basePreview || '[消息]'}` : (basePreview || '[消息]');

    try {
      if (info.kind === 'group') void ensureGroupInfo(info.targetId);
      else void ensureUserInfo(info.targetId);
    } catch {
    }

    setConvoMap((prev) => {
      const existing = prev[info.key];
      const nextMessages = existing ? [...existing.messages] : [];
      nextMessages.push(m);

      const isActive = activeKeyRef.current === info.key;
      const MAX_ACTIVE = qqLimitsRef.current.maxActiveMessages;
      const MAX_INACTIVE = qqLimitsRef.current.maxInactiveMessages;
      const maxKeep = isActive ? MAX_ACTIVE : MAX_INACTIVE;
      if (nextMessages.length > maxKeep) {
        nextMessages.splice(0, nextMessages.length - maxKeep);
      }

      const unread = existing
        ? (isActive ? 0 : Math.min(999, (existing.unread || 0) + 1))
        : (isActive ? 0 : 1);

      const avatarUrl = existing?.avatarUrl || (info.kind === 'group' ? avatarUrlForGroup(info.targetId) : avatarUrlForUser(info.targetId));

      return {
        ...prev,
        [info.key]: {
          key: info.key,
          kind: info.kind,
          targetId: info.targetId,
          title: existing?.title || info.title,
          avatarUrl,
          lastTime: ms,
          lastPreview: preview,
          unread,
          messages: nextMessages,
        },
      };
    });

    try {
      const MAX_MD_CACHE = 800;
      const TRIM_TO = 600;
      if (mdCacheRef.current.size > MAX_MD_CACHE) {
        const drop = mdCacheRef.current.size - TRIM_TO;
        let i = 0;
        for (const k of mdCacheRef.current.keys()) {
          mdCacheRef.current.delete(k);
          i += 1;
          if (i >= drop) break;
        }
      }
    } catch {
    }
  }, [ensureGroupInfo, ensureUserInfo]);

  useEffect(() => {
    onFormattedMessageRef.current = handleFormattedMessage;
    try {
      const q = incomingFormattedQueueRef.current;
      if (q.length) {
        incomingFormattedQueueRef.current = [];
        for (const mm of q) {
          try { handleFormattedMessage(mm); } catch { }
        }
      }
    } catch {
    }
  }, [handleFormattedMessage]);

  const syncRecentContacts = useCallback(async () => {
    if (syncBusy) return;
    try {
      setSyncBusy(true);
      setStatusText('同步最近会话...');
      const resp = await rpc({ type: 'sdk', path: 'message.recentContact', args: [{}] });
      const items: any[] = resp?.data || resp?.items || resp || [];
      if (!Array.isArray(items)) {
        setStatusText('最近会话已加载');
        return;
      }
      // Only create placeholder conversations; messages come from realtime/history.
      setConvoMap((prev) => {
        const next = { ...prev };
        for (const it of items) {
          const kindRaw = String(it?.type || it?.message_type || it?.chat_type || '').toLowerCase();
          const targetId = Number(it?.group_id || it?.user_id || it?.peer_id || it?.id || 0);
          if (!Number.isFinite(targetId) || targetId <= 0) continue;
          const kind: 'group' | 'private' = kindRaw.includes('group') ? 'group' : 'private';
          const key = kind === 'group' ? `g:${targetId}` : `p:${targetId}`;
          if (next[key]) continue;
          next[key] = {
            key,
            kind,
            targetId,
            title: kind === 'group' ? `群 ${targetId}` : `QQ ${targetId}`,
            avatarUrl: kind === 'group' ? avatarUrlForGroup(targetId) : avatarUrlForUser(targetId),
            lastTime: 0,
            lastPreview: '',
            unread: 0,
            messages: [],
          };
        }
        return next;
      });
      try {
        const ids = items
          .map((it) => {
            const kindRaw = String(it?.type || it?.message_type || it?.chat_type || '').toLowerCase();
            const targetId = Number(it?.group_id || it?.user_id || it?.peer_id || it?.id || 0);
            const kind: 'group' | 'private' = kindRaw.includes('group') ? 'group' : 'private';
            return { kind, targetId };
          })
          .filter((x) => Number.isFinite(x.targetId) && x.targetId > 0);
        for (const x of ids.slice(0, 50)) {
          if (x.kind === 'group') void ensureGroupInfo(x.targetId);
          else void ensureUserInfo(x.targetId);
        }
      } catch {
      }
      setStatusText('最近会话已加载');
    } catch (e) {
      setStatusText(`同步失败: ${String((e as any)?.message || e)}`);
      try { antdMessage.error('同步失败'); } catch { }
    } finally {
      setSyncBusy(false);
    }
  }, [antdMessage, ensureGroupInfo, ensureUserInfo, rpc, syncBusy]);

  const syncGroups = useCallback(async () => {
    if (syncBusy) return;
    try {
      setSyncBusy(true);
      setStatusText('同步群列表...');
      const resp = await rpc({ type: 'sdk', path: 'group.list', args: [] });
      const arr: any[] = resp?.data || [];
      if (!Array.isArray(arr)) {
        setStatusText('群列表已加载');
        return;
      }
      setConvoMap((prev) => {
        const next = { ...prev };
        for (const g of arr) {
          const gid = Number(g?.group_id || g?.id || 0);
          if (!Number.isFinite(gid) || gid <= 0) continue;
          const key = `g:${gid}`;
          const title = String(g?.group_name || `群 ${gid}`);
          if (next[key]) {
            const avatarUrl = avatarUrlForGroup(gid);
            if (title && (next[key].title !== title || next[key].avatarUrl !== avatarUrl)) next[key] = { ...next[key], title, avatarUrl };
            continue;
          }
          next[key] = { key, kind: 'group', targetId: gid, title, avatarUrl: avatarUrlForGroup(gid), lastTime: 0, lastPreview: '', unread: 0, messages: [] };
        }
        return next;
      });
      setStatusText('群列表已加载');
      try {
        for (const g of arr.slice(0, 100)) {
          const gid = Number(g?.group_id || g?.id || 0);
          if (Number.isFinite(gid) && gid > 0) void ensureGroupInfo(gid);
        }
      } catch {
      }
    } catch (e) {
      setStatusText(`同步群列表失败: ${String((e as any)?.message || e)}`);
      try { antdMessage.error('同步失败'); } catch { }
    } finally {
      setSyncBusy(false);
    }
  }, [antdMessage, ensureGroupInfo, rpc, syncBusy]);

  const syncFriends = useCallback(async () => {
    if (syncBusy) return;
    try {
      setSyncBusy(true);
      setStatusText('同步好友列表...');
      const resp = await rpc({ type: 'sdk', path: 'user.friendList', args: [] });
      const arr: any[] = resp?.data || [];
      if (!Array.isArray(arr)) {
        setStatusText('好友列表已加载');
        return;
      }
      setConvoMap((prev) => {
        const next = { ...prev };
        for (const f of arr) {
          const uid = Number(f?.user_id || f?.id || 0);
          if (!Number.isFinite(uid) || uid <= 0) continue;
          const key = `p:${uid}`;
          const title = String(f?.remark || f?.nickname || `QQ ${uid}`);
          if (next[key]) {
            const avatarUrl = avatarUrlForUser(uid);
            if (title && (next[key].title !== title || next[key].avatarUrl !== avatarUrl)) next[key] = { ...next[key], title, avatarUrl };
            continue;
          }
          next[key] = { key, kind: 'private', targetId: uid, title, avatarUrl: avatarUrlForUser(uid), lastTime: 0, lastPreview: '', unread: 0, messages: [] };
        }
        return next;
      });
      setStatusText('好友列表已加载');
      try {
        for (const f of arr.slice(0, 120)) {
          const uid = Number(f?.user_id || f?.id || 0);
          if (Number.isFinite(uid) && uid > 0) void ensureUserInfo(uid);
        }
      } catch {
      }
    } catch (e) {
      setStatusText(`同步好友列表失败: ${String((e as any)?.message || e)}`);
      try { antdMessage.error('同步失败'); } catch { }
    } finally {
      setSyncBusy(false);
    }
  }, [antdMessage, ensureUserInfo, rpc, syncBusy]);

  const clearComposer = useCallback(() => {
    try {
      for (const a of pendingAttachments) {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      }
    } catch {
    }
    setPendingAttachments([]);
    setSendText('');
    setReplyDraft(null);
    setDraftMentions([]);
  }, [pendingAttachments]);

  const syncBySource = useCallback(async () => {
    if (syncSource === 'recent') return syncRecentContacts();
    if (syncSource === 'groups') return syncGroups();
    if (syncSource === 'friends') return syncFriends();
    await syncRecentContacts();
    await syncGroups();
    await syncFriends();
  }, [syncFriends, syncGroups, syncRecentContacts, syncSource]);

  useEffect(() => {
    // Disabled: do not auto-load history or group members on conversation click.
    // Realtime messages will populate the view; right panel has manual refresh.
    return;
  }, []);

  const markRead = useCallback((key: string) => {
    setConvoMap((prev) => {
      const c = prev[key];
      if (!c) return prev;
      return { ...prev, [key]: { ...c, unread: 0 } };
    });
  }, []);

  const sendMessage = useCallback(async () => {
    const c = active;
    if (!c) return;
    if (status !== 'connected') return;
    const kind = c.kind;
    const targetId = Number(c.targetId || 0);
    const rawText = String(sendText || '');
    const text = rawText.trim();
    const hasPending = Array.isArray(pendingAttachments) && pendingAttachments.length > 0;
    if (!Number.isFinite(targetId) || targetId <= 0) return;
    if (!text && !hasPending) return;

    if (kind === 'private') {
      lastPrivateTargetRef.current = targetId;
    }

    const buildSegmentsFromDraft = (rawText2: string) => {
      const txt0 = String(rawText2 || '');
      if (!txt0.trim()) return [] as any[];
      if (kind !== 'group') return [{ type: 'text', data: { text: txt0 } }];
      const mentions = Array.isArray(draftMentionsRef.current) ? draftMentionsRef.current : [];
      const tokens = mentions
        .map((m) => ({ uid: Number(m.uid || 0), token: `@${String(m.title || '').trim()}` }))
        .filter((x) => x.uid > 0 && x.token.length > 1);
      if (tokens.length === 0) return [{ type: 'text', data: { text: txt0 } }];

      let rest = txt0;
      const segs: any[] = [];
      while (rest) {
        let best: null | { idx: number; uid: number; token: string } = null;
        for (const t of tokens) {
          const idx = rest.indexOf(t.token);
          if (idx < 0) continue;
          if (!best || idx < best.idx || (idx === best.idx && t.token.length > best.token.length)) {
            best = { idx, uid: t.uid, token: t.token };
          }
        }
        if (!best) {
          segs.push({ type: 'text', data: { text: rest } });
          break;
        }
        if (best.idx > 0) {
          segs.push({ type: 'text', data: { text: rest.slice(0, best.idx) } });
        }
        segs.push({ type: 'at', data: { qq: String(best.uid) } });
        rest = rest.slice(best.idx + best.token.length);
      }
      return segs;
    };

    const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('read_failed'));
      fr.onload = () => resolve(String(fr.result || ''));
      fr.readAsDataURL(file);
    });

    const uploadToCache = async (file: File, kind2: 'image' | 'file') => {
      const name = String(file?.name || '').trim() || (kind2 === 'image' ? 'image.png' : 'file');
      const max = 25 * 1024 * 1024;
      if (Number(file?.size || 0) > max) throw new Error('file_too_large');
      const dataUrl = await readAsDataUrl(file);
      const res = await fetch('/api/qq/sandbox/upload', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ filename: name, dataUrl, kind: kind2 }),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || !data?.success || !data?.path) {
        throw new Error(String(data?.error || `HTTP ${res.status}`));
      }
      return String(data.path || '');
    };

    try {
      const segments: any[] = buildSegmentsFromDraft(rawText);
      const images = (pendingAttachments || []).filter((a) => a.kind === 'image');
      const files = (pendingAttachments || []).filter((a) => a.kind === 'file');
      const savedImagePaths: string[] = [];
      const savedFileNames: string[] = [];

      if (images.length > 0) {
        setStatusText('上传图片...');
        for (const img of images) {
          const p = await uploadToCache(img.file, 'image');
          if (!p) continue;
          savedImagePaths.push(p);
          segments.push({ type: 'image', data: { file: p } });
        }
      }

      if (segments.length > 0) {
        setStatusText('发送中...');
        if (replyDraft?.messageId) {
          if (kind === 'group') {
            await rpc({ type: 'sdk', path: 'send.groupReply', args: [targetId, replyDraft.messageId, segments] });
          } else {
            await rpc({ type: 'sdk', path: 'send.privateReply', args: [targetId, replyDraft.messageId, segments] });
          }
        } else {
          if (kind === 'group') {
            await rpc({ type: 'sdk', path: 'send.group', args: [targetId, segments] });
          } else {
            await rpc({ type: 'sdk', path: 'send.private', args: [targetId, segments] });
          }
        }
      }

      if (files.length > 0) {
        setStatusText('上传文件...');
        for (const f of files) {
          const p = await uploadToCache(f.file, 'file');
          const name = String(f.name || f.file?.name || '').trim() || 'file';
          if (!p) continue;
          savedFileNames.push(name);
          segments.push({ type: 'file', data: { file: p, name } });
          if (kind === 'group') await rpc({ type: 'sdk', path: 'file.uploadGroup', args: [targetId, p, name] });
          else await rpc({ type: 'sdk', path: 'file.uploadPrivate', args: [targetId, p, name] });
        }
      }

      const previewText = (() => {
        if (text) return text;
        const hasImg = savedImagePaths.length > 0;
        const hasFile = savedFileNames.length > 0;
        if (hasImg && hasFile) return '[图片+文件]';
        if (hasImg) return savedImagePaths.length > 1 ? `[图片] ${savedImagePaths.length} 张` : '[图片]';
        if (hasFile) {
          if (savedFileNames.length === 1) return `[文件] ${savedFileNames[0]}`;
          return `[文件] ${savedFileNames.length} 个`;
        }
        return '';
      })();

      const selfId = selfIdRef.current;
      const echo: FormattedMessage = {
        message_id: Number(Date.now()),
        time: Math.floor(Date.now() / 1000),
        time_str: '',
        type: kind === 'group' ? 'group' : 'private',
        self_id: selfId > 0 ? selfId : undefined,
        peer_id: kind === 'private' ? targetId : undefined,
        sender_id: selfId > 0 ? selfId : 0,
        sender_name: '我',
        sender_card: '我',
        group_id: kind === 'group' ? targetId : undefined,
        group_name: kind === 'group' ? `群 ${targetId}` : undefined,
        text,
        summary: text,
        objective: '',
        images: [],
      };
      (echo as any).segments = segments;
      if (savedImagePaths.length > 0) (echo as any).images = savedImagePaths.map((p: string) => ({ path: p, cache_path: p, url: '' }));
      const key = kind === 'group' ? `g:${targetId}` : `p:${targetId}`;
      const ms = nowMsFromMsg(echo);
      setConvoMap((prev) => {
        const existing = prev[key];
        const nextMessages = existing ? [...existing.messages] : [];
        nextMessages.push(echo);
        const MAX_ACTIVE = qqLimitsRef.current.maxActiveMessages;
        if (nextMessages.length > MAX_ACTIVE) nextMessages.splice(0, nextMessages.length - MAX_ACTIVE);
        const title = existing?.title || (kind === 'group' ? `群 ${targetId}` : `QQ ${targetId}`);
        const avatarUrl = existing?.avatarUrl || (kind === 'group' ? avatarUrlForGroup(targetId) : avatarUrlForUser(targetId));
        return {
          ...prev,
          [key]: {
            key,
            kind,
            targetId,
            title,
            avatarUrl,
            lastTime: ms,
            lastPreview: previewText,
            unread: activeKeyRef.current === key ? 0 : (existing?.unread || 0),
            messages: nextMessages,
          },
        };
      });

      setSendText('');
      setReplyDraft(null);
      setDraftMentions([]);
      try {
        for (const a of pendingAttachments) {
          if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
        }
      } catch {
      }
      setPendingAttachments([]);
      setStatusText('已发送');
    } catch (e) {
      setStatusText(`发送失败: ${String((e as any)?.message || e)}`);
    }
  }, [active, authHeaders, pendingAttachments, replyDraft, rpc, sendText, status]);

  const insertTextAtCursor = useCallback((insert: string) => {
    const el = (textareaRef.current?.resizableTextArea?.textArea || textareaRef.current?.textArea || textareaRef.current) as HTMLTextAreaElement | undefined;
    const ins = String(insert || '');
    if (!ins) return;
    if (!el) {
      setSendText((prev) => `${prev}${ins}`);
      return;
    }
    const start = Number.isFinite(el.selectionStart) ? el.selectionStart : el.value.length;
    const end = Number.isFinite(el.selectionEnd) ? el.selectionEnd : el.value.length;
    const prevValue = String(sendText || '');
    const next = prevValue.slice(0, start) + ins + prevValue.slice(end);
    setSendText(next);
    requestAnimationFrame(() => {
      try {
        el.focus();
        const pos = start + ins.length;
        el.setSelectionRange(pos, pos);
      } catch {
      }
    });
  }, [sendText]);

  const addStickerToDraft = useCallback(async (filename: string) => {
    const url = buildEmojiStickerUrl(filename);
    if (!url) return;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('fetch_failed');
      const blob = await r.blob();
      const file = new File([blob], String(filename || 'sticker.png'), { type: blob.type || 'image/png' });
      addPendingAttachment(file, 'image');
      setEmojiOpen(false);
    } catch {
      try { antdMessage.error('表情加载失败'); } catch { }
    }
  }, [addPendingAttachment, antdMessage, buildEmojiStickerUrl]);

  const insertAtMember = useCallback((m: any) => {
    const mm: any = m?.data || m;
    const uid = Number(mm?.user_id || 0);
    const nickname = String(mm?.nickname || '');
    const card = String(mm?.card || '');
    const title = card || nickname || (uid ? String(uid) : '');
    if (!title) return;
    insertTextAtCursor(`@${title} `);
    if (Number.isFinite(uid) && uid > 0) {
      setDraftMentions((prev) => {
        const key = `${uid}:${title}`;
        const next = [...(prev || [])];
        if (!next.some((x) => `${x.uid}:${x.title}` === key)) next.push({ uid, title });
        return next;
      });
    }
  }, [insertTextAtCursor]);

  const activeMessages = useMemo(() => {
    return active ? active.messages : [];
  }, [active]);

  const activeGroupMembers = useMemo(() => {
    if (!active || active.kind !== 'group') return [] as any[];
    const gid = Number(active.targetId || 0);
    const cached = groupMembersCacheRef.current.get(gid);
    const list = Array.isArray(cached?.list) ? cached!.list : [];
    const q = String(memberSearch || '').trim().toLowerCase();
    const filtered = !q ? list : list.filter((m: any) => {
      const uid = String(m?.user_id ?? m?.data?.user_id ?? '');
      const nickname = String(m?.nickname ?? m?.data?.nickname ?? '');
      const card = String(m?.card ?? m?.data?.card ?? '');
      const title = `${uid} ${nickname} ${card}`.toLowerCase();
      return title.includes(q);
    });

    const roleRank = (rawRole: string) => {
      const r = String(rawRole || '').toLowerCase();
      if (r === 'owner' || r === 'group_owner' || r.includes('owner')) return 0;
      if (r === 'admin' || r === 'administrator' || r.includes('admin')) return 1;
      return 2;
    };

    const nameOf = (m: any) => {
      const mm: any = m?.data || m;
      const uid = Number(mm?.user_id || 0);
      const nickname = String(mm?.nickname || '').trim();
      const card = String(mm?.card || '').trim();
      return (card || nickname || (uid ? String(uid) : '')).trim();
    };

    const next = [...filtered];
    next.sort((a: any, b: any) => {
      const ra = roleRank(String((a?.data || a)?.role || ''));
      const rb = roleRank(String((b?.data || b)?.role || ''));
      if (ra !== rb) return ra - rb;
      const na = nameOf(a);
      const nb = nameOf(b);
      const c = na.localeCompare(nb, 'zh-CN');
      if (c !== 0) return c;
      const ua = Number((a?.data || a)?.user_id || 0);
      const ub = Number((b?.data || b)?.user_id || 0);
      return ua - ub;
    });
    return next;
  }, [active, memberListVersion, memberSearch]);

  const activeGroupInfo = useMemo(() => {
    if (!active || active.kind !== 'group') return null as null | { title: string; avatarUrl?: string };
    const gid = Number(active.targetId || 0);
    const cached = groupCacheRef.current.get(gid);
    if (cached) return cached;
    if (Number.isFinite(gid) && gid > 0) void ensureGroupInfo(gid);
    return { title: active.title, avatarUrl: avatarUrlForGroup(gid) };
  }, [active, ensureGroupInfo]);

  function renderMarkdown(md: string) {
    const raw = String(md || '');
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => {
            const href = rewriteMdUrl((props as any)?.href, { download: false }) || String((props as any)?.href || '');
            const openHref = () => {
              const u = String(href || '').trim();
              if (!u) return;
              try { window.open(u, '_blank', 'noopener,noreferrer'); } catch { }
            };
            const copyHref = async () => {
              const u = String(href || '').trim();
              if (!u) return;
              try {
                await copyText(u);
                setStatusText('链接已复制');
              } catch {
              }
            };
            return (
              <Dropdown
                trigger={['contextMenu']}
                menu={{
                  items: [
                    { key: 'open', label: '打开链接' },
                    { key: 'copy', label: '复制链接' },
                  ],
                  onClick: ({ key }) => {
                    if (key === 'open') openHref();
                    if (key === 'copy') void copyHref();
                  },
                }}
              >
                <a
                  {...props}
                  href={href || undefined}
                  className={styles.mdLink}
                  rel="noreferrer"
                  target="_blank"
                  onClick={(e) => {
                    e.preventDefault();
                    openHref();
                  }}
                >
                  {children}
                </a>
              </Dropdown>
            );
          },
          img: () => null,
        }}
      >
        {raw}
      </ReactMarkdown>
    );
  }

  function renderAttachments(m: FormattedMessage) {
    const segs = Array.isArray((m as any)?.segments) ? (m as any).segments : [];
    const cqImages = parseCqImageCandidates(String((m as any)?.text || '') + '\n' + String((m as any)?.summary || '') + '\n' + String((m as any)?.objective || ''));
    const segImages = segs
      .filter((s: any) => String(s?.type || '') === 'image')
      .map((s: any) => ({
        url: String(s?.data?.url || ''),
        path: String(s?.data?.cache_path || s?.data?.path || '') || inferNapcatCachedImagePath(String(s?.data?.file || s?.data?.name || '')),
        summary: String(s?.data?.file || s?.data?.name || ''),
      }));

    const baseImages = (Array.isArray(m.images) ? (m.images as any[]) : []).map((x: any) => ({
      url: String(x?.url || ''),
      path: String(x?.cache_path || x?.path || '') || inferNapcatCachedImagePath(String(x?.file || x?.name || x?.summary || '')),
      summary: String(x?.summary || x?.file || x?.name || ''),
    }));

    const imgs = [...baseImages, ...segImages, ...cqImages];
    const videos = Array.isArray(m.videos) ? m.videos : [];
    const records = Array.isArray(m.records) ? m.records : [];
    const cqFiles = parseCqFileCandidates(String((m as any)?.text || '') + '\n' + String((m as any)?.summary || '') + '\n' + String((m as any)?.objective || ''));
    const segFiles = segs
      .filter((s: any) => String(s?.type || '') === 'file')
      .map((s: any) => ({
        url: String(s?.data?.url || ''),
        path: String(s?.data?.cache_path || s?.data?.path || '') || inferNapcatCachedFilePath(String(s?.data?.file || s?.data?.name || '')),
        name: String(s?.data?.name || s?.data?.file || s?.data?.file_id || ''),
      }));

    const files = [...(Array.isArray(m.files) ? m.files : []), ...segFiles, ...cqFiles];
    const forwards = Array.isArray(m.forwards) ? m.forwards : [];
    const cards = Array.isArray(m.cards) ? m.cards : [];

    const imgUrls = uniqStrings(
      imgs
        .map((x) => normalizeMediaUrl((x as any)?.url as any, (x as any)?.path))
        .filter((u) => !!u) as string[],
    );

    const videoUrls = uniqStrings(
      videos
        .map((x) => normalizeMediaUrl((x as any)?.url, (x as any)?.path))
        .filter((u) => !!u) as string[],
    );

    const recordUrls = uniqStrings(
      records
        .map((x) => normalizeMediaUrl((x as any)?.url, (x as any)?.path))
        .filter((u) => !!u) as string[],
    );

    const fileItems = (() => {
      const out: Array<{ name: string; url: string }> = [];
      const seen = new Set<string>();
      for (const x of files) {
        const name = String((x as any)?.name || (x as any)?.file_id || (x as any)?.path || (x as any)?.url || '文件');
        const url = normalizeMediaUrl((x as any)?.url, (x as any)?.path, { download: true });
        const k = `${name}__${url}`;
        if (!name) continue;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ name, url });
      }
      return out;
    })();

    const cardItems = cards
      .map((c) => {
        const type = String(c?.type || 'card');
        const title = String(c?.title || c?.preview || '卡片');
        const url = String(c?.url || '').trim();
        const content = String(c?.content || '');
        const image = String(c?.image || '').trim();
        const source = String((c as any)?.source || '');
        const raw = (c as any)?.raw;
        const isJsonLike = type === 'json' || type === 'app';
        const hasCover = !!image;
        const variant: 'large' | 'compact' = isJsonLike && hasCover ? 'large' : 'compact';
        return { type, title, url, content, image, source, raw, variant };
      })
      .filter((x) => x.title);

    const forwardItems = forwards
      .map((f, idx) => ({
        key: `${m.message_id}-fwd-${idx}`,
        count: Number(f?.count || 0),
        preview: Array.isArray(f?.preview) ? f.preview : [],
        nodes: Array.isArray((f as any)?.nodes) ? (f as any).nodes : [],
      }))
      .filter((x) => x.count > 0 || x.preview.length > 0 || x.nodes.length > 0);

    const hasAny = imgUrls.length || videoUrls.length || recordUrls.length || fileItems.length || cardItems.length || forwardItems.length;
    if (!hasAny) return null;

    return (
      <div className={styles.attachments}>
        {imgUrls.length > 0 && (
          <div className={styles.imgGrid}>
            {imgUrls.slice(0, 9).map((u: string) => (
              <Dropdown
                key={u}
                trigger={['contextMenu']}
                menu={{
                  items: [
                    {
                      key: 'open',
                      label: '查看大图',
                      onClick: () => {
                        setImgPreviewSrc(u);
                        setImgPreviewOpen(true);
                      },
                    },
                    {
                      key: 'copy_img',
                      label: '复制图片',
                      onClick: () => void copyImageFromUrl(u),
                    },
                    {
                      key: 'copy_link',
                      label: '复制图片链接',
                      onClick: () => void copyText(u),
                    },
                    {
                      key: 'open_tab',
                      label: '新标签页打开',
                      onClick: () => {
                        try { window.open(u, '_blank', 'noopener,noreferrer'); } catch { }
                      },
                    },
                  ],
                }}
              >
                <img
                  src={u}
                  alt=""
                  className={styles.msgImgThumb}
                  loading="lazy"
                  onClick={() => {
                    setImgPreviewSrc(u);
                    setImgPreviewOpen(true);
                  }}
                />
              </Dropdown>
            ))}
          </div>
        )}

        {videoUrls.map((u: string) => (
          <video key={u} className={styles.msgVideo} src={u} controls preload="metadata" />
        ))}

        {recordUrls.map((u: string) => (
          <audio key={u} className={styles.msgAudio} src={u} controls preload="none" />
        ))}

        {fileItems.length > 0 && (
          <div className={styles.fileList}>
            {fileItems.slice(0, 6).map((f) => (
              <Dropdown
                key={`${f.name}-${f.url}`}
                trigger={['contextMenu']}
                menu={{
                  items: [
                    {
                      key: 'open',
                      label: '打开/下载',
                      onClick: () => {
                        const u = String(f.url || '').trim();
                        if (!u) return;
                        try { window.open(u, '_blank', 'noopener,noreferrer'); } catch { }
                      },
                    },
                    {
                      key: 'copy',
                      label: '复制链接',
                      onClick: () => {
                        const u = String(f.url || '').trim();
                        if (!u) return;
                        void copyText(u);
                      },
                    },
                  ],
                }}
              >
                <a
                  className={styles.fileCard}
                  href={f.url || undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  <div className={styles.fileName}>{f.name}</div>
                  <div className={styles.fileMeta}>{f.url ? '打开' : '无URL'}</div>
                </a>
              </Dropdown>
            ))}
          </div>
        )}

        {forwardItems.length > 0 && (
          <div className={styles.forwardList}>
            {forwardItems.slice(0, 3).map((f) => {
              const expanded = !!forwardExpand[f.key];
              const canExpand = (f.nodes?.length || 0) > 0;
              return (
                <div key={f.key} className={styles.forwardCard}>
                  <div className={styles.forwardHeader}>
                    <div className={styles.forwardTitle}>转发消息 {f.count ? `(${f.count})` : ''}</div>
                    {canExpand && (
                      <Button
                        className={styles.forwardToggle}
                        type="link"
                        onClick={() => setForwardExpand((prev) => ({ ...prev, [f.key]: !prev[f.key] }))}
                      >
                        {expanded ? '收起' : '展开'}
                      </Button>
                    )}
                  </div>

                  {!expanded && (
                    <>
                      {f.preview.slice(0, 4).map((line, i) => (
                        <div key={i} className={styles.forwardLine}>{line}</div>
                      ))}
                    </>
                  )}

                  {expanded && (
                    <div className={styles.forwardNodes}>
                      {(f.nodes || []).slice(0, 30).map((n: any, idx: number) => {
                        const name = String(n?.sender_name || n?.nickname || n?.sender_id || '');
                        const txt = String(n?.message_text || '').trim();
                        const line = `${name ? `${name}: ` : ''}${txt || '[消息]'}`;
                        return (
                          <div key={idx} className={styles.forwardNodeLine}>
                            {toPlainSingleLine(line)}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {cardItems.length > 0 && (
          <div className={styles.cardList}>
            {cardItems.slice(0, 3).map((c, idx) => (
              <Dropdown
                key={idx}
                trigger={['contextMenu']}
                menu={{
                  items: [
                    {
                      key: 'open',
                      label: '打开链接',
                      onClick: () => {
                        const u0 = String(c.url || '').trim();
                        const u = normalizeHttpUrl(u0) || u0;
                        if (!u) return;
                        try { window.open(u, '_blank', 'noopener,noreferrer'); } catch { }
                      },
                    },
                    {
                      key: 'copy',
                      label: '复制链接',
                      onClick: () => {
                        const u0 = String(c.url || '').trim();
                        const u = normalizeHttpUrl(u0) || u0;
                        if (!u) return;
                        void copyText(u);
                      },
                    },
                    {
                      key: 'copy_raw',
                      label: '复制卡片RAW',
                      onClick: () => {
                        const r = (c as any)?.raw;
                        const s = typeof r === 'string' ? r : (() => {
                          try { return JSON.stringify(r); } catch { return String(r ?? ''); }
                        })();
                        if (!String(s || '').trim()) return;
                        void copyText(String(s));
                      },
                    },
                  ],
                }}
              >
                {c.variant === 'large' ? (
                  <a className={styles.cardItemLarge} href={normalizeHttpUrl(c.url) || c.url || undefined} target="_blank" rel="noreferrer">
                    <div className={styles.cardLargeHeader}>
                      <div className={styles.cardLargeTitle}>{c.title}</div>
                      {c.content ? <div className={styles.cardLargeDesc}>{c.content}</div> : null}
                    </div>
                    {(() => {
                      const imgRaw = String(c.image || '').trim();
                      const imgSrc = imgRaw ? normalizeCardImageSrc(imgRaw) : '';
                      if (!imgSrc) return null;
                      return (
                        <div className={styles.cardLargeCover}>
                          <img
                            className={styles.cardLargeCoverImg}
                            src={imgSrc}
                            alt=""
                            loading="lazy"
                            onError={(e) => {
                              try {
                                const el = (e.currentTarget as any);
                                const wrap = el?.parentElement as any;
                                if (wrap) wrap.style.display = 'none';
                              } catch {
                              }
                            }}
                          />
                        </div>
                      );
                    })()}
                    <div className={styles.cardLargeFooter}>
                      <div className={styles.cardLargeSource}>
                        {c.source || (c.type === 'app' || c.type === 'json' ? 'QQ小程序' : '')}
                      </div>
                    </div>
                  </a>
                ) : (
                  <a className={styles.cardItem} href={normalizeHttpUrl(c.url) || c.url || undefined} target="_blank" rel="noreferrer">
                    <div className={styles.cardRow}>
                      <div className={styles.cardMain}>
                        <div className={styles.cardTitle}>{c.title}</div>
                        {c.content ? <div className={styles.cardContent}>{c.content}</div> : null}
                        {c.source ? <div className={styles.cardSource}>{c.source}</div> : null}
                      </div>
                      {(() => {
                        const imgRaw = String(c.image || '').trim();
                        if (!imgRaw) return null;
                        const imgSrc = normalizeCardImageSrc(imgRaw);
                        if (!imgSrc) return null;
                        return (
                          <img
                            className={styles.cardThumb}
                            src={imgSrc}
                            alt=""
                            loading="lazy"
                            onError={(e) => {
                              try {
                                const el = e.currentTarget as any;
                                el.style.display = 'none';
                              } catch {
                              }
                            }}
                          />
                        );
                      })()}
                    </div>
                  </a>
                )}
              </Dropdown>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderReplyBox(m: FormattedMessage) {
    const r: any = (m as any)?.reply;
    if (!r || (!String(r?.text || '').trim() && !r?.media)) return null;
    const who = String(r?.sender_name || r?.sender_id || '');
    const txt = toPlainSingleLine(stripCqTags(String(r?.text || '')));

    const media = r?.media || {};
    const rm: FormattedMessage = {
      message_id: Number(`9${Date.now()}${Math.random().toString(16).slice(2, 6)}`.slice(0, 15)),
      time: 0,
      time_str: '',
      type: m.type,
      sender_id: Number(r?.sender_id || 0),
      sender_name: who || '引用消息',
      text: txt,
      summary: '',
      segments: [],
      images: Array.isArray(media?.images) ? media.images : [],
      videos: Array.isArray(media?.videos) ? media.videos : [],
      records: Array.isArray(media?.records) ? media.records : [],
      files: Array.isArray(media?.files) ? media.files : [],
      cards: Array.isArray(media?.cards) ? media.cards : [],
      forwards: Array.isArray(media?.forwards) ? media.forwards : [],
    };

    return (
      <div className={styles.replyBox}>
        <div className={styles.replyTitle}>回复 {who}</div>
        {txt ? <div className={styles.replyText}>{txt}</div> : null}
        <div className={styles.replyAttachments}>{renderAttachments(rm)}</div>
      </div>
    );
  }

  const buildMessageMarkdown = useCallback((m: FormattedMessage) => {
    const cards = Array.isArray((m as any)?.cards) ? (m as any).cards : [];
    const stripCardRedundant = (input: string) => {
      const raw = String(input || '');
      if (!raw.trim()) return raw;
      if (!cards.length) return raw;
      const titles = cards
        .map((c: any) => String(c?.title || c?.preview || '').trim())
        .filter(Boolean);
      const lines = raw.split(/\r?\n/);
      const kept: string[] = [];
      for (const line of lines) {
        const t = String(line || '').trim();
        if (!t) {
          kept.push('');
          continue;
        }
        const isRedundantPrefix =
          /^简介\s*[:：]/.test(t) ||
          /^我正在看/.test(t) ||
          /^我在看/.test(t);
        if (isRedundantPrefix) continue;
        if (titles.some((tt: string) => tt && (t === tt || t.includes(tt)))) {
          continue;
        }
        kept.push(line);
      }
      return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    };
    const segs = Array.isArray(m.segments) ? m.segments : [];
    if (!segs.length) {
      const raw = String(m.text || '').trim() ? String(m.text) : String(m.summary || '');
      const cleaned = stripCqTags(raw);
      const cleaned2 = stripCardRedundant(cleaned);
      if (cleaned2) return cleaned2;
      if (hasOnlyCqMedia(raw)) return '';
      return stripCardRedundant(raw);
    }
    const parts: string[] = [];
    for (const s of segs) {
      const t = String(s?.type || '');
      const d: any = s?.data || {};
      if (t === 'text') parts.push(String(d?.text ?? ''));
      else if (t === 'at') {
        parts.push(formatAtDisplay(m, d?.qq));
      } else if (t === 'face') {
        const faceText = String(d?.text || '').trim();
        const faceId = String(d?.id ?? '').trim();
        parts.push(faceText ? `[${faceText}]` : (faceId ? `[表情${faceId}]` : '[表情]'));
      }
    }
    const out = parts.join('');
    if (out.trim()) return stripCardRedundant(out);
    const raw = String(m.summary || '').trim() ? String(m.summary) : String(m.text || '');
    const cleaned = stripCqTags(raw);
    const cleaned2 = stripCardRedundant(cleaned);
    if (cleaned2) return cleaned2;
    if (hasOnlyCqMedia(raw)) return '';
    return stripCardRedundant(raw || '[消息]');
  }, [formatAtDisplay, mentionVersion, normalizeMediaUrl]);

  const getMessageMarkdown = useCallback((m: FormattedMessage, msgKey: string) => {
    const cached = mdCacheRef.current.get(msgKey);
    if (cached != null) return cached;
    const v = stripNoisyMetaLines(buildMessageMarkdown(m));
    mdCacheRef.current.set(msgKey, v);
    return v;
  }, [buildMessageMarkdown]);

  const scriptFailDisplayLog = (scriptFailLog && scriptFailLog.trim())
    ? scriptFailLog
    : (scriptFailRawLog || '(无日志输出)');

  return (
    <div className={styles.wrap}>
      <Modal
        open={scriptFailOpen}
        centered
        destroyOnHidden
        className={styles.scriptFailModal}
        title={scriptFailTitle}
        onCancel={() => setScriptFailOpen(false)}
        footer={
          <div className={styles.scriptFailFooter}>
            <Button onClick={() => void copyTextToClipboard(scriptFailDisplayLog)}>复制日志</Button>
            <Button type="primary" onClick={() => setScriptFailOpen(false)}>关闭</Button>
          </div>
        }
      >
        {scriptFailSummary ? <div className={styles.scriptFailSummary}>{scriptFailSummary}</div> : null}
        <pre className={styles.scriptFailLog}>{scriptFailDisplayLog}</pre>
      </Modal>

      <Modal
        open={imgPreviewOpen}
        footer={null}
        centered
        destroyOnHidden
        className={styles.previewModal}
        onCancel={() => setImgPreviewOpen(false)}
        afterClose={() => setImgPreviewSrc('')}
        styles={{ body: { padding: 0 } }}
      >
        <div className={styles.previewWrap}>
          {imgPreviewSrc ? (
            <img className={styles.previewImg} src={imgPreviewSrc} alt="" />
          ) : null}
        </div>
      </Modal>

      <SettingsDrawer
        showDev={showDev}
        setShowDev={setShowDev}
        napcatEnvPath={napcatEnvPath}
        streamPort={streamPort}
        defaultStreamPort={defaultStreamPort}
        setStreamPort={setStreamPort}
        napcatBusy={napcatBusy}
        onStartNapcat={() => void runScriptAndWait('/api/scripts/napcat', ['start', '--no-logs'], '启动 NC沙盒', 10 * 60_000)}
        onStopNapcat={() => void runScriptAndWait('/api/scripts/napcat', ['pm2-stop', '--no-logs'], '停止 NC沙盒', 90_000)}
        onUseDefaultPort={() => {
          if (defaultStreamPort > 0) setStreamPort(defaultStreamPort);
        }}
        onClearPortOverride={() => {
          try { storage.remove('sentra_qq_sandbox_stream_port'); } catch { }
          setStreamPort(defaultStreamPort > 0 ? defaultStreamPort : 0);
        }}
      />

      {isNarrow ? (
        mobilePage === 'list' ? (
          <>
            <div className={styles.mobileTopBar}>
              <div className={styles.mobileTopTitle}>QQ 沙盒</div>
            </div>

            <ConversationList
              sidebarMode={sidebarMode}
              status={status}
              syncBusy={syncBusy}
              syncSource={syncSource}
              contactsTab={contactsTab}
              search={search}
              activeKey={activeKey}
              conversations={conversations}
              contactConversations={contactConversations}
              formatConvoTime={formatConvoTime}
              isAvatarBroken={isAvatarBroken}
              avatarKey={avatarKey}
              markAvatarBroken={markAvatarBroken}
              pickInitials={pickInitials}
              setSearch={setSearch}
              setSidebarMode={setSidebarMode}
              setContactsTab={setContactsTab}
              setSyncSource={setSyncSource}
              syncGroups={syncGroups}
              syncFriends={syncFriends}
              setActiveKey={setActiveKey}
              markRead={markRead}
              ensureGroupInfo={ensureGroupInfo}
              loadGroupMembers={(gid) => void loadGroupMembers(gid)}
              syncBySource={() => void syncBySource()}
              onSelectConversation={(c) => {
                if (c.kind === 'private') lastPrivateTargetRef.current = c.targetId;
                setMobilePage('chat');
              }}
            />

            <div className={styles.mobileTabBar}>
              <button
                type="button"
                className={`${styles.mobileTabBtn} ${sidebarMode === 'chats' ? styles.mobileTabBtnActive : ''}`}
                onClick={() => {
                  setMobilePage('list');
                  setSidebarMode('chats');
                  setSyncSource('recent');
                  if (status === 'connected') void syncRecentContacts();
                }}
              >
                <MessageOutlined className={styles.mobileTabIcon} />
                <span>消息</span>
              </button>

              <button
                type="button"
                className={`${styles.mobileTabBtn} ${sidebarMode === 'contacts' ? styles.mobileTabBtnActive : ''}`}
                onClick={() => {
                  setMobilePage('list');
                  setSidebarMode('contacts');
                  if (status !== 'connected') return;
                  if (contactsTab === 'groups') {
                    setSyncSource('groups');
                    void syncGroups();
                  } else {
                    setSyncSource('friends');
                    void syncFriends();
                  }
                }}
              >
                <UserOutlined className={styles.mobileTabIcon} />
                <span>联系人</span>
              </button>

              <button
                type="button"
                className={styles.mobileTabBtn}
                onClick={() => setShowDev(true)}
              >
                <SettingOutlined className={styles.mobileTabIcon} />
                <span>设置</span>
              </button>
            </div>
          </>
        ) : (
          <>
            <div className={styles.main}>
              <div className={styles.mainHeader}>
                <div className={styles.headerLeft}>
                  <div className={styles.mobileBackRow}>
                    <Button
                      size="small"
                      type="text"
                      className={styles.headerIconBtn}
                      icon={<LeftOutlined />}
                      onClick={() => setMobilePage('list')}
                    />
                    <div className={styles.title}>{active ? active.title : 'QQ 沙盒'}</div>
                  </div>
                  <div className={styles.subStatus}>
                    {statusText ? statusText : ''}
                    {statusText && proxyDiag ? ' · ' : ''}
                    {proxyDiag ? proxyDiag : ''}
                  </div>
                </div>

                <div className={styles.headerRight}>
                  <Tag className={styles.statusTag} color={status === 'connected' ? 'green' : status === 'connecting' ? 'blue' : status === 'error' ? 'red' : 'default'}>
                    {status === 'connected' ? '在线' : status === 'connecting' ? '连接中' : status === 'error' ? '错误' : '离线'}
                  </Tag>

                  <Tooltip title={status === 'connected' ? '已连接' : '连接'}>
                    <Button
                      size="small"
                      type="text"
                      className={styles.headerIconBtn}
                      icon={<ApiOutlined />}
                      disabled={connectBusy || status === 'connected'}
                      loading={connectBusy || status === 'connecting'}
                      onClick={() => void connectAndWait()}
                    />
                  </Tooltip>

                  {active && active.kind === 'group' ? (
                    <Tooltip title={mobileMembersOpen ? '关闭群成员' : '打开群成员'}>
                      <Button
                        size="small"
                        type="text"
                        className={styles.headerIconBtn}
                        icon={<TeamOutlined />}
                        disabled={!active}
                        onClick={() => setMobileMembersOpen((v) => !v)}
                      />
                    </Tooltip>
                  ) : null}

                  <Tooltip title="断开连接">
                    <Button size="small" type="text" className={styles.headerIconBtn} icon={<DisconnectOutlined />} disabled={status !== 'connected'} onClick={() => disconnect()} />
                  </Tooltip>
                  <Tooltip title="设置">
                    <Button size="small" type="text" className={styles.headerIconBtn} icon={<SettingOutlined />} onClick={() => setShowDev(true)} />
                  </Tooltip>
                </div>
              </div>

              <div className={styles.messages}>
                <MessageList
                  active={active}
                  activeMessages={activeMessages}
                  renderLimit={renderLimit}
                  defaultRenderPageStep={defaultRenderPageStep}
                  setRenderLimit={setRenderLimit}
                  messagesEndRef={messagesEndRef}
                  hoverKey={hoverKey}
                  setHoverKey={setHoverKey}
                  selfId={Number(selfIdRef.current || 0)}
                  avatarUrlForUser={avatarUrlForUser}
                  isAvatarBroken={isAvatarBroken}
                  avatarKey={avatarKey}
                  markAvatarBroken={markAvatarBroken}
                  pickInitials={pickInitials}
                  formatTimeShort={formatTimeShort}
                  nowMsFromMsg={nowMsFromMsg}
                  formatSenderDisplay={formatSenderDisplay}
                  pickFirstImageUrl={pickFirstImageUrl}
                  getMessageMarkdown={getMessageMarkdown}
                  toPlainSingleLine={toPlainSingleLine}
                  parseCqImageCandidates={parseCqImageCandidates}
                  copyText={copyText}
                  copyImageFromUrl={copyImageFromUrl}
                  setReplyDraft={setReplyDraft}
                  renderMarkdown={renderMarkdown}
                  renderAttachments={renderAttachments}
                  renderReplyBox={renderReplyBox}
                />
              </div>

              <Composer
                status={status}
                active={active}
                replyDraft={replyDraft}
                setReplyDraft={setReplyDraft}
                composerToolbarRef={composerToolbarRef}
                textareaRef={textareaRef}
                emojiOpen={emojiOpen}
                setEmojiOpen={setEmojiOpen}
                emojiTab={emojiTab}
                setEmojiTab={setEmojiTab}
                basicEmojis={BASIC_EMOJIS}
                loadStickers={loadStickers}
                stickersLoading={stickersLoading}
                stickers={stickers}
                buildEmojiStickerUrl={buildEmojiStickerUrl}
                addStickerToDraft={addStickerToDraft}
                addPendingAttachment={addPendingAttachment}
                pendingAttachments={pendingAttachments}
                setPendingAttachments={setPendingAttachments}
                setImgPreviewSrc={setImgPreviewSrc}
                setImgPreviewOpen={setImgPreviewOpen}
                sendText={sendText}
                setSendText={setSendText}
                insertTextAtCursor={insertTextAtCursor}
                sendHotkey={sendHotkey}
                setSendHotkey={setSendHotkey}
                membersBusy={membersBusy}
                loadGroupMembers={loadGroupMembers}
                clearComposer={clearComposer}
                sendMessage={sendMessage}
              />
            </div>

            {active && active.kind === 'group' ? (
              <Drawer
                title="群成员"
                placement="right"
                open={!!active && active.kind === 'group' && mobileMembersOpen}
                onClose={() => setMobileMembersOpen(false)}
                size="large"
                styles={{ wrapper: { width: '92vw', maxWidth: '92vw' }, body: { padding: 0 } }}
              >
                <RightPanel
                  active={active}
                  rightPanelOpen={true}
                  activeGroupInfo={activeGroupInfo}
                  activeGroupMembers={activeGroupMembers}
                  membersBusy={membersBusy}
                  memberSearch={memberSearch}
                  setMemberSearch={setMemberSearch}
                  insertAtMember={insertAtMember}
                  isAvatarBroken={isAvatarBroken}
                  avatarKey={avatarKey}
                  markAvatarBroken={markAvatarBroken}
                  avatarUrlForUser={avatarUrlForUser}
                />
              </Drawer>
            ) : null}
          </>
        )
      ) : (
        <>
          <div className={styles.nav}>
            <div className={styles.navTop}>QQ</div>
            <div className={styles.navGroup}>
              <Tooltip title="消息">
                <Button
                  className={styles.navBtn}
                  type="text"
                  icon={<MessageOutlined />}
                  disabled={status !== 'connected' || syncBusy}
                  loading={syncBusy && syncSource === 'recent'}
                  onClick={() => {
                    setSidebarMode('chats');
                    setSyncSource('recent');
                    void syncRecentContacts();
                  }}
                />
              </Tooltip>

              <Tooltip title="联系人">
                <Button
                  className={styles.navBtn}
                  type="text"
                  icon={<UserOutlined />}
                  disabled={status !== 'connected'}
                  onClick={() => {
                    setSidebarMode('contacts');
                    if (contactsTab === 'groups') {
                      setSyncSource('groups');
                      void syncGroups();
                    } else {
                      setSyncSource('friends');
                      void syncFriends();
                    }
                  }}
                />
              </Tooltip>

              <Tooltip title="同步">
                <Button className={styles.navBtn} type="text" icon={<SyncOutlined />} disabled={status !== 'connected' || syncBusy} loading={syncBusy} onClick={() => { void syncBySource(); }} />
              </Tooltip>
              <Tooltip title="设置"><Button className={styles.navBtn} type="text" icon={<SettingOutlined />} onClick={() => setShowDev((v) => !v)} /></Tooltip>
            </div>
            <div className={styles.navBottom}>
              <Tooltip title="连接">
                <Button
                  className={styles.navBtn}
                  type="text"
                  disabled={status === 'connecting'}
                  loading={status === 'connecting'}
                  icon={<ApiOutlined />}
                  onClick={() => void connectAndWait()}
                />
              </Tooltip>
            </div>
          </div>

          <ConversationList
            sidebarMode={sidebarMode}
            status={status}
            syncBusy={syncBusy}
            syncSource={syncSource}
            contactsTab={contactsTab}
            search={search}
            activeKey={activeKey}
            conversations={conversations}
            contactConversations={contactConversations}
            formatConvoTime={formatConvoTime}
            isAvatarBroken={isAvatarBroken}
            avatarKey={avatarKey}
            markAvatarBroken={markAvatarBroken}
            pickInitials={pickInitials}
            setSearch={setSearch}
            setSidebarMode={setSidebarMode}
            setContactsTab={setContactsTab}
            setSyncSource={setSyncSource}
            syncGroups={syncGroups}
            syncFriends={syncFriends}
            setActiveKey={setActiveKey}
            markRead={markRead}
            ensureGroupInfo={ensureGroupInfo}
            loadGroupMembers={(gid) => void loadGroupMembers(gid)}
            syncBySource={() => void syncBySource()}
            onSelectConversation={(c) => {
              if (c.kind === 'private') lastPrivateTargetRef.current = c.targetId;
            }}
          />

          <div className={styles.main}>
            <div className={styles.mainHeader}>
              <div className={styles.headerLeft}>
                <div className={styles.title}>{active ? active.title : 'QQ 沙盒'}</div>
                <div className={styles.subStatus}>
                  {statusText ? statusText : ''}
                  {statusText && proxyDiag ? ' · ' : ''}
                  {proxyDiag ? proxyDiag : ''}
                </div>
              </div>

              <div className={styles.headerRight}>
                <Tag className={styles.statusTag} color={status === 'connected' ? 'green' : status === 'connecting' ? 'blue' : status === 'error' ? 'red' : 'default'}>
                  {status === 'connected' ? '在线' : status === 'connecting' ? '连接中' : status === 'error' ? '错误' : '离线'}
                </Tag>

                <Tooltip title={status === 'connected' ? '已连接' : '连接'}>
                  <Button
                    size="small"
                    type="text"
                    className={styles.headerIconBtn}
                    icon={<ApiOutlined />}
                    disabled={connectBusy || status === 'connected'}
                    loading={connectBusy || status === 'connecting'}
                    onClick={() => void connectAndWait()}
                  />
                </Tooltip>

                {active && active.kind === 'group' ? (
                  <Tooltip title={rightPanelOpen ? '关闭群成员' : '打开群成员'}>
                    <Button
                      size="small"
                      type="text"
                      className={styles.headerIconBtn}
                      icon={<TeamOutlined />}
                      disabled={!active}
                      onClick={() => setRightPanelOpen((v) => !v)}
                    />
                  </Tooltip>
                ) : null}

                <Tooltip title="断开连接">
                  <Button size="small" type="text" className={styles.headerIconBtn} icon={<DisconnectOutlined />} disabled={status !== 'connected'} onClick={() => disconnect()} />
                </Tooltip>
                <Tooltip title="设置">
                  <Button size="small" type="text" className={styles.headerIconBtn} icon={<SettingOutlined />} onClick={() => setShowDev(true)} />
                </Tooltip>
              </div>
            </div>

            <div className={styles.messages}>
              <MessageList
                active={active}
                activeMessages={activeMessages}
                renderLimit={renderLimit}
                defaultRenderPageStep={defaultRenderPageStep}
                setRenderLimit={setRenderLimit}
                messagesEndRef={messagesEndRef}
                hoverKey={hoverKey}
                setHoverKey={setHoverKey}
                selfId={Number(selfIdRef.current || 0)}
                avatarUrlForUser={avatarUrlForUser}
                isAvatarBroken={isAvatarBroken}
                avatarKey={avatarKey}
                markAvatarBroken={markAvatarBroken}
                pickInitials={pickInitials}
                formatTimeShort={formatTimeShort}
                nowMsFromMsg={nowMsFromMsg}
                formatSenderDisplay={formatSenderDisplay}
                pickFirstImageUrl={pickFirstImageUrl}
                getMessageMarkdown={getMessageMarkdown}
                toPlainSingleLine={toPlainSingleLine}
                parseCqImageCandidates={parseCqImageCandidates}
                copyText={copyText}
                copyImageFromUrl={copyImageFromUrl}
                setReplyDraft={setReplyDraft}
                renderMarkdown={renderMarkdown}
                renderAttachments={renderAttachments}
                renderReplyBox={renderReplyBox}
              />
            </div>

            <Composer
              status={status}
              active={active}
              replyDraft={replyDraft}
              setReplyDraft={setReplyDraft}
              composerToolbarRef={composerToolbarRef}
              textareaRef={textareaRef}
              emojiOpen={emojiOpen}
              setEmojiOpen={setEmojiOpen}
              emojiTab={emojiTab}
              setEmojiTab={setEmojiTab}
              basicEmojis={BASIC_EMOJIS}
              loadStickers={loadStickers}
              stickersLoading={stickersLoading}
              stickers={stickers}
              buildEmojiStickerUrl={buildEmojiStickerUrl}
              addStickerToDraft={addStickerToDraft}
              addPendingAttachment={addPendingAttachment}
              pendingAttachments={pendingAttachments}
              setPendingAttachments={setPendingAttachments}
              setImgPreviewSrc={setImgPreviewSrc}
              setImgPreviewOpen={setImgPreviewOpen}
              sendText={sendText}
              setSendText={setSendText}
              insertTextAtCursor={insertTextAtCursor}
              sendHotkey={sendHotkey}
              setSendHotkey={setSendHotkey}
              membersBusy={membersBusy}
              loadGroupMembers={loadGroupMembers}
              clearComposer={clearComposer}
              sendMessage={sendMessage}
            />
          </div>

          {active ? (
            <RightPanel
              active={active}
              rightPanelOpen={rightPanelOpen}
              activeGroupInfo={activeGroupInfo}
              activeGroupMembers={activeGroupMembers}
              membersBusy={membersBusy}
              memberSearch={memberSearch}
              setMemberSearch={setMemberSearch}
              insertAtMember={insertAtMember}
              isAvatarBroken={isAvatarBroken}
              avatarKey={avatarKey}
              markAvatarBroken={markAvatarBroken}
              avatarUrlForUser={avatarUrlForUser}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
