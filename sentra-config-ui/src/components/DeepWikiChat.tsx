import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './DeepWikiChat.module.css';
import { getAuthHeaders } from '../services/api';
import { fetchFileContent, fetchFileTree, type FileNode } from '../services/fileApi';
import { IoAttachOutline, IoChevronDown, IoChevronForward, IoClose, IoDocumentText, IoFolder, IoFolderOpen, IoSearch } from 'react-icons/io5';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { v4 as uuidv4 } from 'uuid';
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  updateConversation,
  type Conversation,
  type ConversationState,
} from '../services/deepwikiApi';

type Role = 'user' | 'assistant' | 'system' | 'error';

interface ChatMessageMeta {
  projectRefs?: ProjectFileRef[];
  localFiles?: Array<{ name: string; size: number }>;
  agentTrace?: AgentTraceItem[];
  agentEvents?: AgentEvent[];
  rawSentraXml?: string;
  actionRequired?: boolean;
  pendingToolCalls?: Array<{ name: string; args: Record<string, any> }>;
  pendingToolsXml?: string;
  agentStateId?: string;
}

type AgentEventType =
  | 'plan'
  | 'tool_start'
  | 'tool_result'
  | 'action_required'
  | 'final'
  | 'info'
  | 'error';

interface AgentEvent {
  type: AgentEventType;
  loop?: number;
  tool?: string;
  args?: Record<string, any>;
  success?: boolean;
  data?: any;
  text?: string;
  at?: number;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  meta?: ChatMessageMeta;
}

interface UploadedFile {
  id: string;
  file: File;
}

interface ProjectFileRef {
  path: string;
  name: string;
}

interface AgentTraceItem {
  loop: number;
  model_output: string;
  need_tools: boolean | null;
  sentra_tools_xml?: string;
  tool_calls?: Array<{ name: string; args: Record<string, any> }>;
  tool_results_xml?: string;
}

interface ConfirmDialogState {
  open: boolean;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  destructive?: boolean;
  onConfirm?: () => void;
}

function nowLabel() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

const ScrollArea = React.forwardRef<HTMLDivElement, { className?: string; children: React.ReactNode; onScroll?: React.UIEventHandler<HTMLDivElement> }>(
  ({ className, children, onScroll }, ref) => {
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const draggingRef = useRef<{ startY: number; startTop: number } | null>(null);
    const [thumb, setThumb] = useState<{ top: number; height: number; visible: boolean }>({ top: 0, height: 24, visible: false });

    const recompute = useCallback(() => {
      const el = viewportRef.current;
      if (!el) return;
      const ch = el.clientHeight;
      const sh = el.scrollHeight;
      if (!ch || !sh || sh <= ch + 1) {
        setThumb(t => ({ ...t, top: 0, height: 24, visible: false }));
        return;
      }
      const ratio = ch / sh;
      const height = Math.max(24, Math.round(ch * ratio));
      const maxTop = ch - height;
      const top = Math.min(maxTop, Math.max(0, Math.round((el.scrollTop / (sh - ch)) * maxTop)));
      setThumb({ top, height, visible: true });
    }, []);

    useEffect(() => {
      recompute();
      const onResize = () => recompute();
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }, [recompute]);

    const handleScroll: React.UIEventHandler<HTMLDivElement> = (e) => {
      onScroll?.(e);
      recompute();
    };

    const setRefs = (node: HTMLDivElement | null) => {
      viewportRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref && typeof ref === 'object') (ref as any).current = node;
    };

    const onThumbMouseDown: React.MouseEventHandler<HTMLDivElement> = (e) => {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = { startY: e.clientY, startTop: thumb.top };
      const onMove = (ev: MouseEvent) => {
        const el = viewportRef.current;
        const drag = draggingRef.current;
        if (!el || !drag) return;
        const ch = el.clientHeight;
        const sh = el.scrollHeight;
        if (sh <= ch) return;
        const maxTop = Math.max(1, ch - thumb.height);
        const nextTop = Math.min(maxTop, Math.max(0, drag.startTop + (ev.clientY - drag.startY)));
        const ratio = nextTop / maxTop;
        el.scrollTop = ratio * (sh - ch);
      };
      const onUp = () => {
        draggingRef.current = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    return (
      <div className={`${styles.scrollArea} ${className || ''}`.trim()}>
        <div className={styles.scrollAreaViewport} ref={setRefs} onScroll={handleScroll}>
          {children}
        </div>
        {thumb.visible && (
          <div className={styles.scrollAreaTrack} aria-hidden="true">
            <div
              className={styles.scrollAreaThumb}
              style={{ height: `${thumb.height}px`, transform: `translateY(${thumb.top}px)` }}
              onMouseDown={onThumbMouseDown}
            />
          </div>
        )}
      </div>
    );
  }
);

ScrollArea.displayName = 'ScrollArea';

function extractText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join(' ');
  }
  if (typeof content === 'object' && typeof (content as any).content === 'string') {
    return (content as any).content;
  }
  return String(content);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isTextLikeFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  const name = file.name.toLowerCase();
  const exts = [
    '.txt', '.md', '.markdown', '.log', '.json', '.yaml', '.yml',
    '.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java',
    '.c', '.cpp', '.h', '.cs', '.sql', '.html', '.css', '.scss',
    '.less', '.sh', '.bat', '.ps1', '.toml', '.ini', '.conf', '.env',
  ];
  return exts.some(ext => name.endsWith(ext));
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(typeof reader.result === 'string' ? reader.result : '');
    };
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsText(file, 'utf-8');
  });
}

interface DeepWikiChatProps {
  theme: 'light' | 'dark';
}

export const DeepWikiChat: React.FC<DeepWikiChatProps> = ({ theme }) => {
  const initialWelcome: ChatMessage = useMemo(() => ({
    id: 'welcome',
    role: 'assistant',
    content: '欢迎使用 DeepWiki · Sentra Agent 文档助手。可以向我提问安装部署、配置说明、插件开发等问题，我会尽量用简洁明确的方式回答。',
    createdAt: nowLabel(),
  }), []);

  const [messages, setMessages] = useState<ChatMessage[]>(() => [initialWelcome]);
  const [input, setInput] = useState('');
  const [editingUserMessageId, setEditingUserMessageId] = useState<string>('');
  const [streamEnabled, setStreamEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('sentra_deepwiki_stream');
      return saved ? saved === 'true' : true;
    } catch {
      return true;
    }
  });

  const messagesWrapperRef = useRef<HTMLDivElement | null>(null);
  const autoScrollRef = useRef(true);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);

  const scrollToBottomInstant = useCallback(() => {
    const el = messagesWrapperRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const updateAutoScrollFlag = useCallback(() => {
    const el = messagesWrapperRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = distance <= 80;
    if (next !== autoScrollRef.current) {
      autoScrollRef.current = next;
      setAutoScrollEnabled(next);
    }
  }, []);

  const maybeAutoScroll = useCallback(() => {
    if (!autoScrollRef.current) return;
    // Wait for React to flush DOM updates.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToBottomInstant();
      });
    });
  }, [scrollToBottomInstant]);
  const [agentModeEnabled, setAgentModeEnabled] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('sentra_deepwiki_agent_mode');
      return saved ? saved === 'true' : false;
    } catch {
      return false;
    }
  });
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [projectRefs, setProjectRefs] = useState<ProjectFileRef[]>([]);
  const [refModalOpen, setRefModalOpen] = useState(false);
  const [refSearch, setRefSearch] = useState('');
  const [refLoading, setRefLoading] = useState(false);
  const [refFlatNodes, setRefFlatNodes] = useState<FileNode[]>([]);
  const [refTreeRoot, setRefTreeRoot] = useState<FileNode[]>([]);
  const [refSelected, setRefSelected] = useState<Record<string, boolean>>({});
  const [refExpanded, setRefExpanded] = useState<Record<string, boolean>>({});

  const [convModalOpen, setConvModalOpen] = useState(false);
  const [convLoading, setConvLoading] = useState(false);
  const [conversations, setConversations] = useState<Array<Pick<Conversation, 'id' | 'title' | 'createdAt' | 'updatedAt'>>>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>('');
  const [activeConversationTitle, setActiveConversationTitle] = useState<string>('');
  const [titleLocked, setTitleLocked] = useState<boolean>(false);
  const [convSearch, setConvSearch] = useState('');
  const [editingConvId, setEditingConvId] = useState<string>('');
  const [editingTitle, setEditingTitle] = useState<string>('');
  const cursorRefState = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const skipPersistRef = useRef(false);
  const persistTimerRef = useRef<number | null>(null);

  const [agentTraceByMsgId, setAgentTraceByMsgId] = useState<Record<string, AgentTraceItem[]>>({});
  const [lastAgentTraceMsgId, setLastAgentTraceMsgId] = useState<string>('');
  const [traceModalOpen, setTraceModalOpen] = useState(false);
  const [traceModalMsgId, setTraceModalMsgId] = useState<string>('');

  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>({
    open: false,
    title: '',
    message: '',
    confirmText: '确认',
    cancelText: '取消',
    destructive: false,
  });

  const openConfirm = useCallback((opts: Omit<ConfirmDialogState, 'open'>) => {
    setConfirmDialog({ ...opts, open: true });
  }, []);

  const closeConfirm = useCallback(() => {
    setConfirmDialog(prev => ({ ...prev, open: false }));
  }, []);

  const extractXmlTag = useCallback((text: string, tag: string): string => {
    const re = new RegExp(`<\\s*${tag}\\s*>([\\s\\S]*?)<\\s*\\/\\s*${tag}\\s*>`, 'i');
    const m = String(text || '').match(re);
    return m ? String(m[1] || '').trim() : '';
  }, []);

  const parseSentraResultBlocks = useCallback((xml: string): Array<{ tool: string; success: boolean; raw: string }> => {
    const text = String(xml || '');
    const blocks: Array<{ tool: string; success: boolean; raw: string }> = [];
    const re = /<sentra-result\b[^>]*>[\s\S]*?<\/sentra-result>/gi;
    const matches = text.match(re) || [];
    for (const b of matches) {
      const tool = (b.match(/\btool\s*=\s*"([^"]+)"/i)?.[1] || '').trim();
      const success = (b.match(/\bsuccess\s*=\s*"(true|false)"/i)?.[1] || 'false').toLowerCase() === 'true';
      blocks.push({ tool, success, raw: b });
    }
    return blocks;
  }, []);

  const extractTypedParam = useCallback((xml: string, name: string): string => {
    const text = String(xml || '');
    const re = new RegExp(`<parameter\\s+name="${name}">\\s*<(string|number|boolean|null)>([\\s\\S]*?)<\\/\\1>\\s*<\\/parameter>`, 'i');
    const m = text.match(re);
    return m ? String(m[2] || '').trim() : '';
  }, []);

  const buildEventsFromTrace = useCallback((trace: AgentTraceItem[]): AgentEvent[] => {
    const list = Array.isArray(trace) ? trace : [];
    const out: AgentEvent[] = [];
    for (const t of list) {
      const loop = Number(t.loop || 0) || undefined;
      const plan = extractXmlTag(t.model_output || '', 'plan');
      if (plan) {
        out.push({ type: 'plan', loop, text: plan, at: Date.now() });
      }

      const calls = Array.isArray((t as any).tool_calls) ? ((t as any).tool_calls as any[]) : [];
      for (const c of calls) {
        const tool = String(c?.name || '').trim();
        if (!tool) continue;
        out.push({ type: 'tool_start', loop, tool, args: (c?.args && typeof c.args === 'object') ? c.args : {}, at: Date.now() });
      }

      const resultsXml = String((t as any).tool_results_xml || '');
      if (resultsXml.trim()) {
        const blocks = parseSentraResultBlocks(resultsXml);
        if (blocks.length > 0) {
          for (const b of blocks) {
            out.push({ type: 'tool_result', loop, tool: b.tool || undefined, success: b.success, data: { raw: b.raw }, at: Date.now() });
          }
        } else {
          out.push({ type: 'info', loop, text: '工具返回结果（未解析）', data: { raw: resultsXml }, at: Date.now() });
        }
      }
    }
    return out;
  }, [extractXmlTag, parseSentraResultBlocks]);

  const formatConvTime = (ts?: number) => {
    if (!ts) return '';
    const d = new Date(ts);
    const yyyy = String(d.getFullYear());
    const mon = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mon}-${day} ${hh}:${mm}`;
  };

  const visibleConversations = useMemo(() => {
    const q = convSearch.trim().toLowerCase();
    const list = q
      ? conversations.filter(c => (c.title || '').toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
      : conversations;
    return [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }, [conversations, convSearch]);

  const scrollToBottom = useCallback(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, []);

  useEffect(() => {
    if (autoScrollRef.current) scrollToBottom();
  }, [messages, typing, scrollToBottom]);

  const loadConversationList = useCallback(async () => {
    const list = await listConversations();
    setConversations(list);
    return list;
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    skipPersistRef.current = true;
    try {
      const conv = await getConversation(id);
      setActiveConversationId(conv.id);
      setActiveConversationTitle(conv.title || '新对话');
      const loadedMsgs = conv.messages && conv.messages.length > 0 ? conv.messages : [initialWelcome];
      setMessages(loadedMsgs);

      // restore agent trace from persisted message meta
      const traceMap: Record<string, AgentTraceItem[]> = {};
      let lastTraceId = '';
      for (const m of loadedMsgs) {
        const trace = (m as any)?.meta?.agentTrace;
        if (Array.isArray(trace) && trace.length > 0) {
          traceMap[m.id] = trace as AgentTraceItem[];
          lastTraceId = m.id;
        }
      }
      setAgentTraceByMsgId(traceMap);
      setLastAgentTraceMsgId(lastTraceId);
      const draft = (conv.state as ConversationState | undefined)?.draft || '';
      setInput(draft);
      const cursor = (conv.state as ConversationState | undefined)?.cursor;
      setTitleLocked(!!(conv.state as ConversationState | undefined)?.titleLocked);
      if (cursor && typeof cursor.start === 'number' && typeof cursor.end === 'number') {
        cursorRefState.current = { start: cursor.start, end: cursor.end };
      }
    } finally {
      skipPersistRef.current = false;
    }
  }, [initialWelcome]);

  const createNewConversation = useCallback(async () => {
    setConvLoading(true);
    try {
      const id = uuidv4().replace(/-/g, '');
      const conv = await createConversation(id, '新对话');
      await loadConversationList();
      await loadConversation(conv.id);
      try { localStorage.setItem('sentra_deepwiki_active_conversation', conv.id); } catch { }
    } finally {
      setConvLoading(false);
    }
  }, [loadConversation, loadConversationList]);

  const renameConversation = useCallback(async (id: string, title: string) => {
    const nextTitle = title.trim().slice(0, 60) || '新对话';
    await updateConversation(id, { title: nextTitle, state: { titleLocked: true } as any });
    if (id === activeConversationId) {
      setActiveConversationTitle(nextTitle);
      setTitleLocked(true);
    }
    await loadConversationList();
  }, [activeConversationId, loadConversationList]);

  const switchConversation = useCallback(async (id: string) => {
    if (!id || id === activeConversationId) return;
    setConvLoading(true);
    try {
      await loadConversation(id);
      try { localStorage.setItem('sentra_deepwiki_active_conversation', id); } catch { }
    } finally {
      setConvLoading(false);
    }
  }, [activeConversationId, loadConversation]);

  const handleDeleteConversation = useCallback(async (id: string) => {
    if (!id) return;
    await deleteConversation(id);
    const list = await loadConversationList();
    if (id === activeConversationId) {
      if (list.length > 0) {
        await loadConversation(list[0].id);
      } else {
        await createNewConversation();
      }
    }
  }, [activeConversationId, createNewConversation, loadConversation, loadConversationList]);

  useEffect(() => {
    const boot = async () => {
      setConvLoading(true);
      try {
        const list = await loadConversationList();
        let nextId = '';
        try {
          nextId = localStorage.getItem('sentra_deepwiki_active_conversation') || '';
        } catch { }
        if (nextId && list.some(c => c.id === nextId)) {
          await loadConversation(nextId);
          return;
        }
        if (list.length > 0) {
          await loadConversation(list[0].id);
          return;
        }
        await createNewConversation();
      } finally {
        setConvLoading(false);
      }
    };
    void boot();
  }, [createNewConversation, loadConversation, loadConversationList]);

  useEffect(() => {
    if (!textareaRef.current) return;
    const t = textareaRef.current;
    const { start, end } = cursorRefState.current;
    if (typeof start === 'number' && typeof end === 'number') {
      try {
        t.setSelectionRange(start, end);
      } catch { }
    }
  }, [activeConversationId]);

  useEffect(() => {
    if (!activeConversationId) return;
    if (skipPersistRef.current) return;

    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current);
    }

    persistTimerRef.current = window.setTimeout(() => {
      const state: ConversationState = {
        draft: input,
        cursor: cursorRefState.current,
        titleLocked,
      };

      const titleSource = messages.find(m => m.role === 'user')?.content || '';
      const autoTitle = titleSource.trim() ? titleSource.trim().slice(0, 24) : '新对话';
      const nextTitle = titleLocked ? (activeConversationTitle || autoTitle) : autoTitle;

      void updateConversation(activeConversationId, { title: nextTitle, messages, state })
        .then(() => {
          setActiveConversationTitle(nextTitle);
          return loadConversationList();
        })
        .catch((e) => {
          // keep silent in UI, but do not swallow completely
          // eslint-disable-next-line no-console
          console.warn('[DeepWikiChat] persist conversation failed:', e);
        });
    }, 600);

    return () => {
      if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
    };
  }, [activeConversationId, activeConversationTitle, input, loadConversationList, messages, titleLocked]);

  const canSend = useMemo(() => input.trim().length > 0 && !sending, [input, sending]);

  const handleToggleStream = () => {
    setStreamEnabled(prev => {
      const next = !prev;
      try { localStorage.setItem('sentra_deepwiki_stream', String(next)); } catch { }
      return next;
    });
  };

  const handleToggleAgentMode = () => {
    setAgentModeEnabled(prev => {
      const next = !prev;
      try { localStorage.setItem('sentra_deepwiki_agent_mode', String(next)); } catch { }
      return next;
    });
  };

  const handleFileInputChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const list = e.target.files;
    if (!list) return;
    const next: UploadedFile[] = [];
    for (let i = 0; i < list.length; i++) {
      const f = list.item(i);
      if (!f) continue;
      next.push({ id: `${Date.now()}_${i}_${f.name}`, file: f });
    }
    if (next.length > 0) {
      setFiles(prev => [...prev, ...next]);
    }
    // 允许重复选择同一文件
    e.target.value = '';
  };

  const handleRemoveFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const handlePaste: React.ClipboardEventHandler<HTMLTextAreaElement> = (e) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const images: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) images.push(f);
      }
    }
    if (images.length === 0) return;
    e.preventDefault();
    setFiles(prev => [
      ...prev,
      ...images.map((img, idx) => ({ id: `${Date.now()}_paste_${idx}_${img.name || 'pasted.png'}`, file: img })),
    ]);
  };

  const handleRemoveProjectRef = (path: string) => {
    setProjectRefs(prev => prev.filter(r => r.path !== path));
  };

  const buildTree = (items: FileNode[]): FileNode[] => {
    const map: Record<string, FileNode> = {};
    const roots: FileNode[] = [];
    for (const item of items) {
      map[item.path] = { ...item, children: [] };
    }
    for (const item of items) {
      const node = map[item.path];
      const parts = item.path.split('/');
      if (parts.length === 1) {
        roots.push(node);
      } else {
        const parentPath = parts.slice(0, -1).join('/');
        if (map[parentPath]) {
          map[parentPath].children = map[parentPath].children || [];
          map[parentPath].children!.push(node);
        } else {
          roots.push(node);
        }
      }
    }
    const sortNodes = (nodes: FileNode[]) => {
      nodes.sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'directory' ? -1 : 1;
      });
      for (const n of nodes) {
        if (n.children && n.children.length > 0) sortNodes(n.children);
      }
    };
    sortNodes(roots);
    return roots;
  };

  const openRefModal = async () => {
    const init: Record<string, boolean> = {};
    for (const r of projectRefs) init[r.path] = true;
    setRefSelected(init);
    setRefSearch('');
    setRefModalOpen(true);

    if (refFlatNodes.length > 0) return;
    setRefLoading(true);
    try {
      const tree = await fetchFileTree();
      setRefFlatNodes(tree);
      setRefTreeRoot(buildTree(tree));
      setRefExpanded(prev => ({ ...prev }));
    } catch (e) {
      handleErrorMessage('读取项目文件列表失败，请先确认已登录且后端服务正常。');
    } finally {
      setRefLoading(false);
    }
  };

  const refFiles = useMemo(() => refFlatNodes.filter(n => n.type === 'file'), [refFlatNodes]);

  const filteredRefFiles = useMemo(() => {
    const q = refSearch.trim().toLowerCase();
    const list = q
      ? refFiles.filter(n => n.path.toLowerCase().includes(q) || n.name.toLowerCase().includes(q))
      : refFiles;
    return list.slice(0, 800);
  }, [refFiles, refSearch]);

  const applyRefSelection = () => {
    const selectedPaths = Object.keys(refSelected).filter(p => refSelected[p]);
    const map = new Map(refFiles.map(n => [n.path, n] as const));
    const next = selectedPaths
      .map(p => map.get(p))
      .filter(Boolean)
      .map(n => ({ path: (n as FileNode).path, name: (n as FileNode).name }));
    setProjectRefs(next);
    setRefModalOpen(false);
  };

  const buildOpenAIMessagesFromHistory = (historyMessages: ChatMessage[], userContent: string, imageUrls: string[]) => {
    const buildAgentXmlContext = (m: ChatMessage): string => {
      if (!agentModeEnabled) return '';
      if (!m || m.role !== 'assistant') return '';
      const trace = (m.meta as any)?.agentTrace;
      if (!Array.isArray(trace) || trace.length === 0) return '';

      const parts: string[] = [];
      for (const t of trace) {
        if (t?.sentra_tools_xml && String(t.sentra_tools_xml).trim()) {
          parts.push(String(t.sentra_tools_xml).trim());
        }
        if (t?.tool_results_xml && String(t.tool_results_xml).trim()) {
          parts.push(String(t.tool_results_xml).trim());
        }
      }
      const joined = parts.join('\n\n').trim();
      if (!joined) return '';

      const maxChars = 14000;
      if (joined.length <= maxChars) return joined;
      return joined.slice(joined.length - maxChars);
    };

    const history = historyMessages.map((m) => {
      const role = m.role === 'error' ? 'assistant' : m.role;
      const base = String(m.content || '');
      const agentXml = buildAgentXmlContext(m);
      const content = agentXml ? (base ? `${base}\n\n${agentXml}` : agentXml) : base;
      return { role, content };
    });

    const userMessageContent: any =
      imageUrls.length > 0
        ? [
          { type: 'text', text: userContent },
          ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
        ]
        : userContent;

    return [
      {
        role: 'system',
        content:
          '你是 Sentra Agent 项目的 DeepWiki 文档助手，熟悉项目结构、配置文件和常见问题。请用简洁、有条理的中文回答用户问题，必要时给出分步操作和注意事项。',
      },
      ...history,
      { role: 'user', content: userMessageContent },
    ];
  };

  const handleErrorMessage = (text: string) => {
    const msg: ChatMessage = {
      id: `err_${Date.now()}`,
      role: 'error',
      content: text,
      createdAt: nowLabel(),
    };
    setMessages(prev => [...prev, msg]);
  };

  const buildUserPayloadFromStoredMessage = useCallback(async (msg: ChatMessage): Promise<{ userContent: string; imageUrls: string[] }> => {
    const content = (msg.content || '').trim();
    const imageUrls: string[] = [];
    const blocks: string[] = [];

    const refs = msg.meta?.projectRefs || [];
    if (refs.length > 0) {
      const loaded = await Promise.all(
        refs.map(async (r) => {
          try {
            const data = await fetchFileContent(r.path);
            if (data.isBinary) {
              if (typeof data.content === 'string' && data.content.startsWith('data:image/')) {
                imageUrls.push(data.content);
              }
              return { ...r, isBinary: true, snippet: '' };
            }
            const text = String(data.content || '');
            const snippet = text.length > 6000 ? text.slice(0, 6000) + '\n...[内容截断]' : text;
            return { ...r, isBinary: false, snippet };
          } catch {
            return { ...r, isBinary: false, snippet: '' };
          }
        })
      );

      const refText = loaded
        .map((r, idx) => {
          const header = `【引用文件 ${idx + 1}：${r.path}${r.isBinary ? '（图片/二进制，内容未附加）' : ''}】`;
          return r.snippet ? `${header}\n${r.snippet}` : header;
        })
        .join('\n\n');

      blocks.push(`我引用了项目中的一些文件，请结合这些内容回答后面的问题（部分内容可能已被截断）：\n\n${refText}`);
    }

    const userContent = blocks.length > 0 ? `${blocks.join('\n\n')}\n\n【我的问题】\n${content}` : content;
    return { userContent, imageUrls: imageUrls.slice(0, 6) };
  }, []);

  const updateMessageContent = (id: string, content: string) => {
    updateAutoScrollFlag();
    setMessages(prev => prev.map(m => {
      if (m.id !== id) return m;
      const raw = String(content ?? '');
      const hasSentra = /<\s*sentra[-_\w]*\b/i.test(raw);
      const finalOnly = hasSentra ? extractXmlTag(raw, 'sentra-final') : '';
      if (finalOnly) {
        return {
          ...m,
          content: finalOnly,
          meta: {
            ...(m.meta || {}),
            rawSentraXml: (m.meta as any)?.rawSentraXml || raw,
          },
        };
      }
      if (hasSentra) {
        return {
          ...m,
          content: '已生成工具调用计划/执行过程（正文已隐藏 XML）。请查看下方工具确认区域或打开 Agent 日志。',
          meta: {
            ...(m.meta || {}),
            rawSentraXml: (m.meta as any)?.rawSentraXml || raw,
          },
        };
      }
      return { ...m, content: raw };
    }));
    maybeAutoScroll();
  };

  const appendAgentEvent = useCallback((assistantId: string, ev: any) => {
    if (!assistantId) return;
    setMessages(prev => prev.map(m => {
      if (m.id !== assistantId) return m;
      const nextEv: AgentEvent = {
        type: (ev?.type as AgentEventType) || 'info',
        loop: typeof ev?.loop === 'number' ? ev.loop : undefined,
        tool: typeof ev?.tool === 'string' ? ev.tool : undefined,
        args: ev?.args && typeof ev.args === 'object' ? ev.args : undefined,
        success: typeof ev?.success === 'boolean' ? ev.success : undefined,
        data: ev?.data,
        text: typeof ev?.text === 'string' ? ev.text : undefined,
        at: typeof ev?.at === 'number' ? ev.at : Date.now(),
      };
      const cur = Array.isArray(m.meta?.agentEvents) ? m.meta?.agentEvents : [];
      return {
        ...m,
        meta: {
          ...(m.meta || {}),
          agentEvents: [...cur, nextEv],
        },
      };
    }));
  }, []);

  const deleteMessageById = useCallback((id: string) => {
    if (!id || id === 'welcome') return;
    setMessages(prev => {
      const idx = prev.findIndex(m => m.id === id);
      if (idx < 0) return prev;
      const next = prev.slice();
      const target = next[idx];
      next.splice(idx, 1);
      if (target?.role === 'user') {
        const after = next[idx];
        if (after && after.role === 'assistant' && after.id !== 'welcome') {
          next.splice(idx, 1);
          setAgentTraceByMsgId((cur) => {
            const copy = { ...cur };
            delete copy[after.id];
            return copy;
          });
        }
      }
      setAgentTraceByMsgId((cur) => {
        const copy = { ...cur };
        delete copy[id];
        return copy;
      });
      return next;
    });
  }, []);

  const retryAssistantMessage = useCallback(async (assistantMsgId: string) => {
    if (!assistantMsgId) return;
    if (sending) return;
    const idx = messages.findIndex(m => m.id === assistantMsgId);
    if (idx < 0) return;

    // clear old trace on retry
    setAgentTraceByMsgId(prev => {
      const copy = { ...prev };
      delete copy[assistantMsgId];
      return copy;
    });

    const userIdx = (() => {
      for (let i = idx - 1; i >= 0; i -= 1) {
        if (messages[i].role === 'user') return i;
      }
      return -1;
    })();
    if (userIdx < 0) return;

    const userMsg = messages[userIdx];
    const historyMessages = messages.slice(0, userIdx);

    setMessages(prev => {
      const assistantIndex = prev.findIndex(m => m.id === assistantMsgId);
      if (assistantIndex < 0) return prev;
      const next = prev.slice(0, assistantIndex + 1);
      return next.map(m => (m.id === assistantMsgId ? { ...m, content: '', meta: { ...(m.meta || {}), agentTrace: undefined } } : m));
    });

    let userContent = userMsg.content;
    let imageUrls: string[] = [];
    try {
      const built = await buildUserPayloadFromStoredMessage(userMsg);
      userContent = built.userContent;
      imageUrls = built.imageUrls;
    } catch {
      // ignore
    }

    setSending(true);
    setTyping(true);

    const payload: any = {
      messages: buildOpenAIMessagesFromHistory(historyMessages, userContent, imageUrls),
      stream: streamEnabled,
    };

    if (agentModeEnabled) {
      payload.agent_mode = 'deepwiki_sentra_xml';
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const headers = getAuthHeaders();

    try {
      if (streamEnabled) {
        await sendStream(payload, headers, controller, assistantMsgId);
      } else {
        await sendOnce(payload, headers, controller, assistantMsgId);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        handleErrorMessage('已取消本次请求。');
      } else {
        handleErrorMessage(`请求失败：${err?.message || String(err)}`);
      }
    } finally {
      setSending(false);
      setTyping(false);
      abortRef.current = null;
    }
  }, [agentModeEnabled, buildOpenAIMessagesFromHistory, buildUserPayloadFromStoredMessage, messages, sending, streamEnabled]);

  const startEditUserMessage = useCallback((id: string) => {
    const msg = messages.find(m => m.id === id);
    if (!msg || msg.role !== 'user') return;
    setEditingUserMessageId(id);
    setInput(msg.content);
    window.setTimeout(() => {
      try { textareaRef.current?.focus(); } catch { }
    }, 0);
  }, [messages]);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const el = document.createElement('textarea');
        el.value = text;
        el.style.position = 'fixed';
        el.style.left = '-9999px';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        return true;
      } catch {
        return false;
      }
    }
  };

  const MarkdownCode: React.FC<{ inline?: boolean; className?: string; children?: React.ReactNode; node?: any }> = ({ inline, className, children, node }) => {
    const raw = String(children ?? '').replace(/\n$/, '');
    const match = /language-([\w-]+)/.exec(className || '');
    const lang = match?.[1] || '';
    const [copied, setCopied] = useState(false);

    const looksLikeInline = !raw.includes('\n') && raw.trim().length > 0 && raw.trim().length <= 200;
    const isInline = inline === true || (inline == null && !className && looksLikeInline);

    if (isInline) {
      return <code className={styles.inlineCode}>{children}</code>;
    }

    const lineCount = raw.split('\n').filter(l => l.length > 0).length;
    const isShortSingleLine = lineCount <= 1 && raw.trim().length > 0 && raw.trim().length <= 80;
    const isProbablyIndentedCode = !lang && !className;
    const startColumn = typeof node?.position?.start?.column === 'number' ? node.position.start.column : 1;
    const renderAsCompactLine = isShortSingleLine && isProbablyIndentedCode && startColumn > 1;

    if (renderAsCompactLine) {
      return (
        <div className={styles.codeLine}>
          <code className={styles.codeLineText}>{raw.trim()}</code>
          <button
            type="button"
            className={styles.codeLineCopy}
            onClick={async () => {
              const ok = await copyToClipboard(raw.trim());
              if (ok) {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 900);
              }
            }}
            title="复制"
          >
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      );
    }

    return (
      <div className={styles.codeBlock}>
        <div className={styles.codeHeader}>
          <span className={styles.codeLang}>{lang || 'code'}</span>
          <button
            type="button"
            className={styles.codeCopy}
            onClick={async () => {
              const ok = await copyToClipboard(raw);
              if (ok) {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 900);
              }
            }}
          >
            {copied ? '已复制' : '复制'}
          </button>
        </div>
        <pre className={styles.codePre}><code>{raw}</code></pre>
      </div>
    );
  };

  const preprocessMarkdown = (input: string): string => {
    const text = String(input ?? '');
    if (!text.trim()) return '';

    const hasFence = /```/.test(text);
    if (hasFence) return text;

    const trim = text.trim();

    // Fence Sentra XML fragments ONLY (do not wrap the entire message if it contains normal prose).
    const hasSentra = /<\s*sentra[-_\w]*\b[^>]*>/i.test(text);
    if (hasSentra) {
      // If the whole message is basically XML, fence all.
      if (/^<\s*sentra[-_\w]*\b/i.test(trim)) {
        return `\n\n\`\`\`xml\n${trim}\n\`\`\`\n`;
      }

      let replaced = text;
      // First: full blocks <sentra-x>...</sentra-x>
      replaced = replaced.replace(
        /<\s*(sentra[-_\w]*)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi,
        (m) => `\n\n\`\`\`xml\n${m.trim()}\n\`\`\`\n\n`
      );
      // Second: self-closing tags
      replaced = replaced.replace(
        /<\s*(sentra[-_\w]*)\b[^>]*\/\s*>/gi,
        (m) => `\n\n\`\`\`xml\n${m.trim()}\n\`\`\`\n\n`
      );

      // If we changed anything, return it.
      if (replaced !== text) return replaced;

      // Last resort: fence only the lines that contain sentra tags.
      const lines = text.replace(/\r\n/g, '\n').split('\n');
      const out: string[] = [];
      for (const ln of lines) {
        if (/<\s*sentra[-_\w]*\b/i.test(ln)) {
          out.push('```xml');
          out.push(ln);
          out.push('```');
        } else {
          out.push(ln);
        }
      }
      return out.join('\n');
    }

    // Heuristic: only wrap as code when it is very likely code.
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    const lineCount = nonEmpty.length;

    // Avoid wrapping normal markdown prose/lists.
    const proseHints = nonEmpty.filter((l) => /^\s*(-|\*|\d+\.)\s+/.test(l) || /^\s*#{1,6}\s+/.test(l)).length;
    if (proseHints >= Math.max(2, Math.floor(lineCount * 0.35))) return text;

    const keywordLines = nonEmpty.filter((l) => /^\s*(const|let|var|function|class|if|for|while|return|import|export)\b/.test(l)).length;
    const strongSymbols = nonEmpty.filter((l) => /[{};]/.test(l) || /=>/.test(l)).length;
    const assignLike = nonEmpty.filter((l) => /\w\s*(=|:|\+=|-=|\*=|\/=)\s*\S/.test(l)).length;
    const longLineCount = nonEmpty.filter((l) => l.length >= 80).length;

    const looksLikeCode =
      lineCount >= 10 &&
      (keywordLines >= 2 || strongSymbols >= 3 || (assignLike >= 4 && (assignLike / Math.max(1, lineCount)) >= 0.35) || longLineCount >= 4);

    if (looksLikeCode) {
      return `\n\n\`\`\`\n${trim}\n\`\`\`\n`;
    }

    return text;
  };

  const renderAgentTimeline = (msg: ChatMessage, compact: boolean) => {
    const fromEvents = Array.isArray(msg.meta?.agentEvents) ? (msg.meta?.agentEvents as AgentEvent[]) : [];
    const events = fromEvents.length > 0
      ? fromEvents
      : (Array.isArray(msg.meta?.agentTrace) ? buildEventsFromTrace(msg.meta?.agentTrace as AgentTraceItem[]) : []);
    if (!events || events.length === 0) return null;

    const parseTypedStringArray = (xml: string, name: string): string[] => {
      const text = String(xml || '');
      const m = text.match(new RegExp(`<parameter\\s+name="${name}">\\s*<array>([\\s\\S]*?)<\\/array>\\s*<\\/parameter>`, 'i'));
      if (!m) return [];
      const body = String(m[1] || '');
      const items = body.match(/<string>[\s\S]*?<\/string>/gi) || [];
      return items.map(s => String(s.replace(/<\/?string>/gi, '')).trim()).filter(Boolean);
    };

    const parseAppliedOps = (xml: string): Array<{ op: string; key?: string; valuePreview?: string }> => {
      const text = String(xml || '');
      const m = text.match(/<parameter\s+name="applied">\s*<array>([\s\S]*?)<\/array>\s*<\/parameter>/i);
      if (!m) return [];
      const body = String(m[1] || '');
      const objects = body.match(/<object>[\s\S]*?<\/object>/gi) || [];
      const out: Array<{ op: string; key?: string; valuePreview?: string }> = [];
      for (const obj of objects) {
        const op = extractTypedParam(obj, 'op') || '';
        const key = extractTypedParam(obj, 'key') || '';
        const valuePreview = extractTypedParam(obj, 'value_preview') || '';
        if (op) out.push({ op, key: key || undefined, valuePreview: valuePreview || undefined });
      }
      return out;
    };

    const renderToolResultSummary = (tool: string, raw: string) => {
      const path = extractTypedParam(raw, 'path');
      const changedRaw = extractTypedParam(raw, 'changed');
      const changed = changedRaw.toLowerCase() === 'true' ? 'true' : changedRaw.toLowerCase() === 'false' ? 'false' : '';

      const warnings = parseTypedStringArray(raw, 'warnings');
      const appliedOps = tool === 'edit_file' ? parseAppliedOps(raw) : [];

      if (tool === 'edit_file') {
        return (
          <div className={styles.agentEventSummary}>
            {path && <div className={styles.agentEventSummaryLine}><span className={styles.agentEventKey}>file</span><span className={styles.agentEventVal}>{path}</span></div>}
            {changed && <div className={styles.agentEventSummaryLine}><span className={styles.agentEventKey}>changed</span><span className={styles.agentEventVal}>{changed}</span></div>}

            {appliedOps.length > 0 && (
              <div className={styles.agentEventSummaryLine}>
                <span className={styles.agentEventKey}>applied</span>
                <span
                  className={styles.agentEventVal}
                  title={appliedOps
                    .map(a => {
                      const base = `${a.op}${a.key ? ` ${a.key}` : ''}`;
                      return a.valuePreview != null && a.valuePreview !== '' ? `${base}=${a.valuePreview}` : base;
                    })
                    .join('\n')}
                >
                  {appliedOps.slice(0, 3).map(a => {
                    const base = `${a.op}${a.key ? ` ${a.key}` : ''}`;
                    return a.valuePreview != null && a.valuePreview !== '' ? `${base}=${a.valuePreview}` : base;
                  }).join(', ')}{appliedOps.length > 3 ? ` +${appliedOps.length - 3}` : ''}
                </span>
              </div>
            )}

            {warnings.length > 0 && (
              <div className={styles.agentEventSummaryLine}>
                <span className={styles.agentEventKey}>warnings</span>
                <span className={styles.agentEventVal} title={warnings.join('\n')}>
                  {warnings.slice(0, 2).join(', ')}{warnings.length > 2 ? ` +${warnings.length - 2}` : ''}
                </span>
              </div>
            )}
          </div>
        );
      }
      if (tool === 'read_file') {
        return path ? (
          <div className={styles.agentEventSummary}>
            <div className={styles.agentEventSummaryLine}><span className={styles.agentEventKey}>file</span><span className={styles.agentEventVal}>{path}</span></div>
          </div>
        ) : null;
      }
      if (tool === 'list_dir') {
        return path ? (
          <div className={styles.agentEventSummary}>
            <div className={styles.agentEventSummaryLine}><span className={styles.agentEventKey}>dir</span><span className={styles.agentEventVal}>{path}</span></div>
          </div>
        ) : null;
      }
      return null;
    };

    return (
      <div className={compact ? styles.agentTimelineCompact : styles.agentTimeline}>
        {events.map((ev, idx) => {
          const key = `${ev.type}_${ev.loop || 0}_${ev.tool || ''}_${idx}`;
          const isError = ev.type === 'error' || (ev.type === 'tool_result' && ev.success === false);
          const statusClass = isError ? styles.agentEventStatusError : (ev.type === 'tool_result' && ev.success === true) ? styles.agentEventStatusOk : styles.agentEventStatusInfo;
          const title = ev.type === 'plan'
            ? `Plan${ev.loop ? ` · 第 ${ev.loop} 轮` : ''}`
            : ev.type === 'tool_start'
              ? `正在调用 ${ev.tool || 'tool'}`
              : ev.type === 'tool_result'
                ? `${ev.tool || 'tool'} ${ev.success ? '成功' : '失败'}`
                : ev.type === 'action_required'
                  ? '等待确认工具执行'
                  : ev.type === 'final'
                    ? '完成'
                    : (ev.text ? ev.text : '事件');

          const rawResult = typeof ev?.data?.raw === 'string' ? String(ev.data.raw) : '';

          return (
            <div key={key} className={`${styles.agentEventItem} ${isError ? styles.agentEventItemError : ''}`}>
              <div className={styles.agentEventRail} aria-hidden="true">
                <div className={`${styles.agentEventDot} ${isError ? styles.agentEventDotError : ''}`} />
                <div className={styles.agentEventLine} />
              </div>
              <div className={styles.agentEventCard}>
                <div className={styles.agentEventHeader}>
                  <div className={styles.agentEventTitle}>{title}</div>
                  <span className={`${styles.agentEventStatus} ${statusClass}`}>{isError ? 'error' : ev.type === 'tool_result' ? (ev.success ? 'ok' : 'error') : ev.type === 'tool_start' ? 'running' : 'info'}</span>
                </div>

                {ev.type === 'plan' && ev.text && (
                  <div className={styles.agentEventPlan}>{ev.text}</div>
                )}

                {ev.type === 'tool_start' && (
                  <details className={styles.agentEventDetails} open={!compact}>
                    <summary className={styles.agentEventDetailsSummary}>参数</summary>
                    <pre className={styles.agentEventPre}><code>{JSON.stringify(ev.args || {}, null, 2)}</code></pre>
                  </details>
                )}

                {ev.type === 'tool_result' && (
                  <>
                    {ev.tool && rawResult && renderToolResultSummary(ev.tool, rawResult)}
                    <details className={styles.agentEventDetails} open={false}>
                      <summary className={styles.agentEventDetailsSummary}>查看原始结果</summary>
                      <pre className={styles.agentEventPre}><code>{rawResult || ''}</code></pre>
                    </details>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const send = async () => {
    const content = input.trim();
    if (!content || sending) return;

    const attachments = files.slice();
    const projectFileRefs = projectRefs.slice();

    // 构造带附件说明的 userContent
    let userContent = content;

    const blocks: string[] = [];
    const imageUrls: string[] = [];

    if (projectFileRefs.length > 0) {
      const refs = await Promise.all(
        projectFileRefs.map(async (r) => {
          try {
            const data = await fetchFileContent(r.path);
            if (data.isBinary) {
              if (typeof data.content === 'string' && data.content.startsWith('data:image/')) {
                imageUrls.push(data.content);
              }
              return { ...r, isBinary: true, snippet: '' };
            }
            const text = String(data.content || '');
            const snippet = text.length > 6000 ? text.slice(0, 6000) + '\n...[内容截断]' : text;
            return { ...r, isBinary: false, snippet };
          } catch {
            return { ...r, isBinary: false, snippet: '' };
          }
        })
      );

      const refText = refs
        .map((r, idx) => {
          const header = `【引用文件 ${idx + 1}：${r.path}${r.isBinary ? '（图片/二进制，内容未附加）' : ''}】`;
          return r.snippet ? `${header}\n${r.snippet}` : header;
        })
        .join('\n\n');

      blocks.push(`我引用了项目中的一些文件，请结合这些内容回答后面的问题（部分内容可能已被截断）：\n\n${refText}`);
    }

    if (attachments.length > 0) {
      const summaries = await Promise.all(
        attachments.map(async (item) => {
          const { file } = item;
          if (file.type && file.type.startsWith('image/')) {
            try {
              if (file.size <= 10 * 1024 * 1024) {
                const dataUrl = await readFileAsDataUrl(file);
                if (dataUrl) imageUrls.push(dataUrl);
              }
            } catch {
              // ignore image read error
            }
          }
          let snippet = '';
          if (isTextLikeFile(file) && file.size <= 512 * 1024) {
            try {
              const text = await readFileAsText(file);
              snippet =
                text.length > 4000 ? text.slice(0, 4000) + '\n...[内容截断]' : text;
            } catch {
              // ignore read error
            }
          }
          return { name: file.name, size: file.size, snippet };
        })
      );

      const attachText = summaries
        .map((a, idx) => {
          const header = `【附件 ${idx + 1}：${a.name}，${formatSize(a.size)}】`;
          return a.snippet ? `${header}\n${a.snippet}` : header;
        })
        .join('\n\n');

      const intro =
        '我附加了一些本地文件，请结合这些内容回答后面的问题（部分内容可能已被截断）：';
      blocks.push(`${intro}\n\n${attachText}`);
    }

    if (blocks.length > 0) {
      userContent = `${blocks.join('\n\n')}\n\n【我的问题】\n${content}`;
    }

    const assistantId = `a_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const userMeta: ChatMessageMeta | undefined =
      attachments.length > 0 || projectFileRefs.length > 0
        ? {
          projectRefs: projectFileRefs,
          localFiles: attachments.map(a => ({ name: a.file.name, size: a.file.size })),
        }
        : undefined;

    const assistantPlaceholder: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: nowLabel(),
    };

    let historyMessagesForPayload = messages;
    let userContentForPayload = userContent;

    if (editingUserMessageId) {
      const editId = editingUserMessageId;
      const idx = messages.findIndex(m => m.id === editId);
      if (idx >= 0) {
        const prevUser = messages[idx];
        const updatedUser: ChatMessage = {
          ...prevUser,
          role: 'user',
          content,
          createdAt: nowLabel(),
          meta: userMeta || prevUser.meta,
        };

        const nextMessages: ChatMessage[] = [...messages.slice(0, idx), updatedUser, assistantPlaceholder];
        setMessages(nextMessages);
        historyMessagesForPayload = nextMessages.slice(0, idx);
        userContentForPayload = userContent;
      }
      setEditingUserMessageId('');
    } else {
      const id = `u_${Date.now()}`;
      const userMsg: ChatMessage = {
        id,
        role: 'user',
        content,
        createdAt: nowLabel(),
        meta: userMeta,
      };
      setMessages(prev => [...prev, userMsg, assistantPlaceholder]);
    }

    setInput('');
    setSending(true);
    setTyping(true);

    const payload: any = {
      messages: buildOpenAIMessagesFromHistory(historyMessagesForPayload, userContentForPayload, imageUrls.slice(0, 6)),
      stream: streamEnabled,
    };

    if (agentModeEnabled) {
      payload.agent_mode = 'deepwiki_sentra_xml';
    }

    const controller = new AbortController();
    abortRef.current = controller;

    const headers = getAuthHeaders();

    try {
      if (streamEnabled) {
        await sendStream(payload, headers, controller, assistantId);
      } else {
        await sendOnce(payload, headers, controller, assistantId);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        handleErrorMessage('已取消本次请求。');
      } else {
        handleErrorMessage(`请求失败：${err?.message || String(err)}`);
      }
    } finally {
      setSending(false);
      setTyping(false);
      abortRef.current = null;
      setFiles([]);
    }
  };

  async function sendOnce(payload: any, headers: Record<string, string>, controller: AbortController, assistantId: string) {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      let text: string;
      try {
        text = await res.text();
      } catch {
        text = `HTTP ${res.status}`;
      }
      throw new Error(text);
    }

    let data: any;
    try {
      data = await res.json();
    } catch (e) {
      throw new Error('解析响应失败');
    }

    const trace = data?.agent_trace;
    if (Array.isArray(trace)) {
      setAgentTraceByMsgId(prev => ({ ...prev, [assistantId]: trace as AgentTraceItem[] }));
      setLastAgentTraceMsgId(assistantId);

      setMessages(prev => prev.map(m => (m.id === assistantId
        ? {
          ...m,
          meta: {
            ...(m.meta || {}),
            agentTrace: trace as AgentTraceItem[],
            agentEvents: Array.isArray((m.meta as any)?.agentEvents)
              ? (m.meta as any).agentEvents
              : buildEventsFromTrace(trace as AgentTraceItem[]),
          },
        }
        : m)));
    }

    if (Array.isArray(data?.agent_events)) {
      const evs = data.agent_events as any[];
      setMessages(prev => prev.map(m => (m.id === assistantId
        ? { ...m, meta: { ...(m.meta || {}), agentEvents: evs as any } }
        : m)));
      setLastAgentTraceMsgId(assistantId);
    }

    const actionRequired = !!data?.action_required;
    const pendingToolCalls = data?.pending_tool_calls;
    const pendingToolsXml = data?.pending_tools_xml;
    const agentStateId = typeof data?.agent_state_id === 'string' ? data.agent_state_id : '';
    if (actionRequired && Array.isArray(pendingToolCalls)) {
      setMessages(prev => prev.map(m => (m.id === assistantId
        ? {
          ...m,
          meta: {
            ...(m.meta || {}),
            actionRequired: true,
            pendingToolCalls: pendingToolCalls as any,
            pendingToolsXml: typeof pendingToolsXml === 'string' ? pendingToolsXml : undefined,
            agentStateId: agentStateId || (m.meta as any)?.agentStateId,
          },
        }
        : m)));
    }

    const choice = data?.choices?.[0];
    const content = extractText(choice?.message?.content ?? choice?.delta?.content ?? '');
    updateMessageContent(assistantId, content || '[空回复]');
  }

  async function sendStream(payload: any, headers: Record<string, string>, controller: AbortController, assistantId: string) {
    const res = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!res.ok) {
      let text: string;
      try {
        text = await res.text();
      } catch {
        text = `HTTP ${res.status}`;
      }
      throw new Error(text);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      updateMessageContent(assistantId, text);
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let finalContent = '';
    let latestTrace: any = null;
    let latestAgentEvents: any = null;
    let latestActionRequired: boolean = false;
    let latestPendingToolCalls: any = null;
    let latestPendingToolsXml: any = null;
    let latestAgentStateId: any = null;

    const extractDeltaText = (parsed: any): { text: string; isFull: boolean } => {
      const choice = parsed?.choices?.[0];

      const deltaCandidate =
        choice?.delta?.content ??
        choice?.delta?.text ??
        choice?.text ??
        choice?.message?.content ??
        parsed?.content;

      const text = extractText(deltaCandidate);
      const isFull = !!choice?.message?.content && !choice?.delta;
      return { text, isFull };
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const dataStr = trimmed.startsWith('data:') ? trimmed.replace(/^data:\s*/, '') : trimmed;
        if (!dataStr || dataStr === '[DONE]') continue;

        // Some providers may send raw JSON lines without SSE prefix.
        if (!dataStr.startsWith('{') && !dataStr.startsWith('[')) continue;

        try {
          const parsed = JSON.parse(dataStr);
          if (parsed?.dw_event) {
            appendAgentEvent(assistantId, parsed.dw_event);
          }
          if (Array.isArray(parsed?.agent_events)) {
            latestAgentEvents = parsed.agent_events;
          }
          if (Array.isArray(parsed?.agent_trace)) {
            latestTrace = parsed.agent_trace;
          }
          if (parsed?.action_required != null) {
            latestActionRequired = !!parsed.action_required;
          }
          if (Array.isArray(parsed?.pending_tool_calls)) {
            latestPendingToolCalls = parsed.pending_tool_calls;
          }
          if (typeof parsed?.pending_tools_xml === 'string') {
            latestPendingToolsXml = parsed.pending_tools_xml;
          }
          if (typeof parsed?.agent_state_id === 'string') {
            latestAgentStateId = parsed.agent_state_id;
          }
          const { text, isFull } = extractDeltaText(parsed);
          if (!text) continue;
          if (isFull) {
            finalContent = text;
          } else {
            finalContent += text;
          }
          updateMessageContent(assistantId, finalContent);
        } catch {
          // ignore single bad chunk
        }
      }
    }

    if (Array.isArray(latestTrace)) {
      setAgentTraceByMsgId(prev => ({ ...prev, [assistantId]: latestTrace as AgentTraceItem[] }));
      setLastAgentTraceMsgId(assistantId);
      setMessages(prev => prev.map(m => (m.id === assistantId
        ? {
          ...m,
          meta: {
            ...(m.meta || {}),
            agentTrace: latestTrace as AgentTraceItem[],
            agentEvents: Array.isArray((m.meta as any)?.agentEvents)
              ? (m.meta as any).agentEvents
              : buildEventsFromTrace(latestTrace as AgentTraceItem[]),
          },
        }
        : m)));
    }

    if (Array.isArray(latestAgentEvents)) {
      const evs = latestAgentEvents as any[];
      setMessages(prev => prev.map(m => (m.id === assistantId
        ? { ...m, meta: { ...(m.meta || {}), agentEvents: evs as any } }
        : m)));
      setLastAgentTraceMsgId(assistantId);
    }

    if (latestActionRequired && Array.isArray(latestPendingToolCalls)) {
      setMessages(prev => prev.map(m => (m.id === assistantId
        ? {
          ...m,
          meta: {
            ...(m.meta || {}),
            actionRequired: true,
            pendingToolCalls: latestPendingToolCalls as any,
            pendingToolsXml: typeof latestPendingToolsXml === 'string' ? latestPendingToolsXml : undefined,
            agentStateId: typeof latestAgentStateId === 'string' ? latestAgentStateId : (m.meta as any)?.agentStateId,
          },
        }
        : m)));
    }

    if (!finalContent) {
      updateMessageContent(assistantId, '[空回复]');
    }
  }

  const handleCancel = () => {
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch { }
    }
  };

  const clearCurrentConversation = () => {
    if (!activeConversationId) return;
    openConfirm({
      title: '清空对话',
      message: '确定清空当前对话内容吗？（会话本身保留）',
      confirmText: '清空',
      cancelText: '取消',
      destructive: true,
      onConfirm: () => {
        setEditingUserMessageId('');
        setMessages([initialWelcome]);
        setInput('');
        setFiles([]);
        setProjectRefs([]);
        setRefSelected({});
        setAgentTraceByMsgId({});
        setLastAgentTraceMsgId('');
      },
    });
  };

  const openTrace = (msgId: string) => {
    if (!msgId) return;
    setTraceModalMsgId(msgId);
    setTraceModalOpen(true);
  };

  const findPrevUserMessage = useCallback((assistantMsgId: string): ChatMessage | null => {
    const idx = messages.findIndex(m => m.id === assistantMsgId);
    if (idx < 0) return null;
    for (let i = idx - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') return messages[i];
    }
    return null;
  }, [messages]);

  const confirmPendingTools = useCallback(async (assistantMsgId: string) => {
    if (!assistantMsgId) return;
    if (sending) return;

    const assistantMsg = messages.find(m => m.id === assistantMsgId);
    if (!assistantMsg || assistantMsg.role !== 'assistant') return;
    const pendingToolCalls = assistantMsg.meta?.pendingToolCalls;
    const pendingToolsXml = assistantMsg.meta?.pendingToolsXml;
    const agentStateId = assistantMsg.meta?.agentStateId;
    if (!Array.isArray(pendingToolCalls) || pendingToolCalls.length === 0) return;

    const userMsg = findPrevUserMessage(assistantMsgId);
    if (!userMsg) return;
    const idx = messages.findIndex(m => m.id === userMsg.id);
    if (idx < 0) return;
    const historyMessages = messages.slice(0, idx);

    let userContent = userMsg.content;
    let imageUrls: string[] = [];
    try {
      const built = await buildUserPayloadFromStoredMessage(userMsg);
      userContent = built.userContent;
      imageUrls = built.imageUrls;
    } catch {
      // ignore
    }

    // clear placeholder content + mark actionRequired false to avoid double-confirm
    setMessages(prev => prev.map(m => (m.id === assistantMsgId
      ? {
        ...m,
        content: '',
        meta: {
          ...(m.meta || {}),
          actionRequired: false,
        },
      }
      : m)));

    setSending(true);
    setTyping(true);

    const payload: any = {
      messages: buildOpenAIMessagesFromHistory(historyMessages, userContent, imageUrls),
      stream: streamEnabled,
      agent_mode: 'deepwiki_sentra_xml',
      agent_state_id: agentStateId || undefined,
      tool_confirmation: {
        required: true,
        confirmed: true,
        toolCalls: pendingToolCalls,
        toolsXml: pendingToolsXml || '',
      },
    };

    const controller = new AbortController();
    abortRef.current = controller;
    const headers = getAuthHeaders();

    try {
      if (streamEnabled) {
        await sendStream(payload, headers, controller, assistantMsgId);
      } else {
        await sendOnce(payload, headers, controller, assistantMsgId);
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        handleErrorMessage('已取消本次请求。');
      } else {
        handleErrorMessage(`请求失败：${err?.message || String(err)}`);
      }
    } finally {
      setSending(false);
      setTyping(false);
      abortRef.current = null;
    }
  }, [buildOpenAIMessagesFromHistory, buildUserPayloadFromStoredMessage, findPrevUserMessage, messages, sending, streamEnabled]);

  const cancelPendingTools = useCallback((assistantMsgId: string) => {
    if (!assistantMsgId) return;
    setMessages(prev => prev.map(m => (m.id === assistantMsgId
      ? {
        ...m,
        content: (m.content || '') + (m.content ? '\n\n' : '') + '已取消本次工具执行。',
        meta: {
          ...(m.meta || {}),
          actionRequired: false,
          pendingToolCalls: undefined,
          pendingToolsXml: undefined,
        },
      }
      : m)));
  }, []);

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) {
        void send();
      }
    }
  };

  const RefTreeNode: React.FC<{ node: FileNode; level: number }> = ({ node, level }) => {
    const isDir = node.type === 'directory';
    const expanded = !!refExpanded[node.path];
    const toggle = () => {
      if (!isDir) return;
      setRefExpanded(prev => ({ ...prev, [node.path]: !prev[node.path] }));
    };

    if (isDir) {
      return (
        <div className={styles.refTreeNode}>
          <div
            className={styles.refTreeRow}
            style={{ paddingLeft: `${level * 14 + 10}px` }}
            onClick={toggle}
          >
            <span className={styles.refTreeCaret}>
              {expanded ? <IoChevronDown size={14} /> : <IoChevronForward size={14} />}
            </span>
            <span className={styles.refTreeIcon}><IoFolder size={16} /></span>
            <span className={styles.refTreeName}>{node.name}</span>
          </div>
          {expanded && node.children && node.children.length > 0 && (
            <div>
              {node.children.map(child => (
                <RefTreeNode key={child.path} node={child} level={level + 1} />
              ))}
            </div>
          )}
        </div>
      );
    }

    return (
      <label className={styles.refTreeRow} style={{ paddingLeft: `${level * 14 + 34}px` }}>
        <input
          type="checkbox"
          checked={!!refSelected[node.path]}
          onChange={(e) => {
            const checked = e.target.checked;
            setRefSelected(prev => ({ ...prev, [node.path]: checked }));
          }}
        />
        <span className={styles.refTreeIcon}><IoDocumentText size={16} /></span>
        <span className={styles.refTreeName}>{node.name}</span>
      </label>
    );
  };

  return (
    <div className={styles.root} data-theme={theme}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <span className={styles.headerTitle}>DeepWiki 文档助手</span>
          <span className={styles.headerBadge}>
            <span className={styles.badgeDot} />
            在线
          </span>
          <button
            type="button"
            className={styles.convButton}
            onClick={() => setConvModalOpen(true)}
            disabled={convLoading}
            title="对话管理"
          >
            {activeConversationTitle || conversations.find(c => c.id === activeConversationId)?.title || '对话'}
          </button>
          <button
            type="button"
            className={styles.headerIconButton}
            onClick={() => {
              if (!activeConversationId) return;
              openConfirm({
                title: '删除对话',
                message: '确定删除当前对话吗？该操作不可恢复。',
                confirmText: '删除',
                cancelText: '取消',
                destructive: true,
                onConfirm: () => {
                  void handleDeleteConversation(activeConversationId);
                },
              });
            }}
            title="删除当前对话"
            disabled={!activeConversationId || convLoading}
          >
            ✕
          </button>
          <button
            type="button"
            className={styles.headerIconButton}
            onClick={clearCurrentConversation}
            title="清空当前对话"
            disabled={!activeConversationId || convLoading}
          >
            ⌫
          </button>
        </div>
        <div className={styles.headerRight}>
          <button
            type="button"
            className={styles.headerIconButton}
            onClick={() => openTrace(lastAgentTraceMsgId)}
            title="查看 Agent 执行日志"
            disabled={!lastAgentTraceMsgId}
          >
            ≡
          </button>
          <button
            type="button"
            className={`${styles.toggleStream} ${streamEnabled ? styles.toggleOn : ''}`}
            onClick={handleToggleStream}
          >
            <span style={{ fontSize: 12 }}>流式输出</span>
            <span className={styles.toggleDotTrack}>
              <span className={styles.toggleDotThumb} />
            </span>
          </button>
          <button
            type="button"
            className={`${styles.toggleStream} ${agentModeEnabled ? styles.toggleOn : ''}`}
            onClick={handleToggleAgentMode}
            title="启用 DeepWiki Sentra-XML Agent（支持 read_file/write_file 工具链）"
          >
            <span style={{ fontSize: 12 }}>Agent 模式</span>
            <span className={styles.toggleDotTrack}>
              <span className={styles.toggleDotThumb} />
            </span>
          </button>
        </div>
      </div>

      <div className={styles.body}>
        <ScrollArea className={styles.messagesWrapper} ref={messagesWrapperRef} onScroll={updateAutoScrollFlag}>
          <div className={styles.messagesList}>
            {messages.map(msg => (
              <div
                key={msg.id}
                className={`${styles.messageRow} ${msg.role === 'user' ? styles.messageRowUser : styles.messageRowAssistant}`}
              >
                {msg.role !== 'user' && (
                  <div className={styles.avatar} aria-hidden="true">
                    DW
                  </div>
                )}

                <div
                  className={`${styles.bubble} ${msg.role === 'user'
                    ? styles.bubbleUser
                    : msg.role === 'error'
                      ? styles.bubbleError
                      : styles.bubbleAssistant
                    }`}
                >
                  <div className={`${styles.bubbleHeader} ${msg.role === 'user' ? styles.bubbleHeaderUser : ''}`}>
                    <span className={styles.bubbleAuthor}>
                      {msg.role === 'user' ? '你' : 'DeepWiki'}
                    </span>
                    <div className={styles.bubbleHeaderRight}>
                      <span className={styles.bubbleTime}>{msg.createdAt}</span>
                      {msg.id !== 'welcome' && (
                        <div className={styles.msgActions}>
                          {msg.role === 'user' && (
                            <button
                              type="button"
                              className={styles.msgActionBtn}
                              onClick={() => startEditUserMessage(msg.id)}
                              title="编辑并重新发送"
                              disabled={sending}
                            >
                              编辑
                            </button>
                          )}
                          {msg.role === 'assistant' && (
                            <button
                              type="button"
                              className={styles.msgActionBtn}
                              onClick={() => void retryAssistantMessage(msg.id)}
                              title="重试"
                              disabled={sending}
                            >
                              重试
                            </button>
                          )}
                          {msg.role === 'assistant' && !!agentTraceByMsgId[msg.id] && (
                            <button
                              type="button"
                              className={styles.msgActionBtn}
                              onClick={() => openTrace(msg.id)}
                              title="查看本条回复的 Agent 日志"
                              disabled={sending}
                            >
                              日志
                            </button>
                          )}
                          <button
                            type="button"
                            className={styles.msgActionBtn}
                            onClick={() => {
                              openConfirm({
                                title: '删除消息',
                                message: '确定删除这条消息吗？',
                                confirmText: '删除',
                                cancelText: '取消',
                                destructive: true,
                                onConfirm: () => {
                                  deleteMessageById(msg.id);
                                },
                              });
                            }}
                            title="删除"
                            disabled={sending}
                          >
                            删除
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {msg.role === 'user' && msg.meta && (
                    <div className={styles.bubbleMeta}>
                      {msg.meta.projectRefs && msg.meta.projectRefs.length > 0 && (
                        <div className={styles.metaSection}>
                          <div className={styles.metaLabel}>引用</div>
                          <div className={styles.metaChips}>
                            {msg.meta.projectRefs.map(r => (
                              <span key={r.path} className={styles.metaChip} title={r.path}>
                                {r.path}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {msg.meta.localFiles && msg.meta.localFiles.length > 0 && (
                        <div className={styles.metaSection}>
                          <div className={styles.metaLabel}>附件</div>
                          <div className={styles.metaChips}>
                            {msg.meta.localFiles.map((f, idx) => (
                              <span key={`${f.name}_${idx}`} className={styles.metaChip} title={f.name}>
                                {f.name}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  <div className={styles.bubbleContent}>
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        code: (props: any) => <MarkdownCode {...props} />,
                        pre: (props: any) => <div className={styles.mdPreWrap}>{props.children}</div>,
                      }}
                    >
                      {preprocessMarkdown(msg.content || '')}
                    </ReactMarkdown>

                    {msg.role === 'assistant' && typeof msg.meta?.rawSentraXml === 'string' && msg.meta.rawSentraXml.trim() && (
                      <details className={styles.inlineTraceRaw}>
                        <summary className={styles.inlineTraceRawSummary}>Debug（原始 Sentra XML）</summary>
                        <pre className={styles.inlineTracePre}><code>{msg.meta.rawSentraXml}</code></pre>
                      </details>
                    )}

                    {msg.role === 'assistant' && msg.meta?.actionRequired && Array.isArray(msg.meta?.pendingToolCalls) && msg.meta.pendingToolCalls.length > 0 && (
                      <div className={styles.toolConfirmCard}>
                        <div className={styles.toolConfirmTitle}>将执行以下工具（需确认）</div>
                        <div className={styles.toolConfirmList}>
                          {msg.meta.pendingToolCalls.map((c, idx) => (
                            <div key={`${c.name}_${idx}`} className={styles.toolConfirmItem}>
                              <div className={styles.toolConfirmName}>{c.name}</div>
                              <pre className={styles.toolConfirmPre}><code>{JSON.stringify(c.args || {}, null, 2)}</code></pre>
                            </div>
                          ))}
                        </div>

                        {typeof msg.meta.pendingToolsXml === 'string' && msg.meta.pendingToolsXml.trim() && (
                          <details className={styles.toolConfirmXml}>
                            <summary className={styles.toolConfirmXmlSummary}>查看本次工具 XML</summary>
                            <pre className={styles.toolConfirmXmlPre}><code>{msg.meta.pendingToolsXml}</code></pre>
                          </details>
                        )}

                        <div className={styles.toolConfirmActions}>
                          <button
                            type="button"
                            className={styles.toolConfirmBtnPrimary}
                            onClick={() => void confirmPendingTools(msg.id)}
                            disabled={sending}
                          >
                            确认执行
                          </button>
                          <button
                            type="button"
                            className={styles.toolConfirmBtn}
                            onClick={() => cancelPendingTools(msg.id)}
                            disabled={sending}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}

                    {msg.role === 'assistant' && (
                      (Array.isArray(msg.meta?.agentEvents) && msg.meta.agentEvents.length > 0) ||
                      (Array.isArray(msg.meta?.agentTrace) && msg.meta.agentTrace.length > 0)
                    ) && (
                      <details className={styles.inlineTrace}>
                        <summary className={styles.inlineTraceSummary}>Agent 日志</summary>
                        <div className={styles.inlineTraceBody}>
                          {renderAgentTimeline(msg, true)}
                          <div className={styles.inlineTraceFooter}>
                            <button type="button" className={styles.inlineTraceOpenBtn} onClick={() => openTrace(msg.id)}>
                              打开完整日志
                            </button>
                          </div>
                        </div>
                      </details>
                    )}
                  </div>
                </div>

                {msg.role === 'user' && (
                  <div className={styles.avatarUser} aria-hidden="true">
                    你
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        {typing && (
          <div className={styles.typingRow}>
            DeepWiki 正在思考中
            <div className={styles.typingDots}>
              <div className={styles.typingDot} />
              <div className={styles.typingDot} />
              <div className={styles.typingDot} />
            </div>
          </div>
        )}

        {!autoScrollEnabled && (
          <button
            type="button"
            className={styles.scrollToBottom}
            onClick={() => {
              autoScrollRef.current = true;
              setAutoScrollEnabled(true);
              scrollToBottomInstant();
            }}
          >
            回到底部
          </button>
        )}

        <div className={styles.inputArea}>
          <div
            className={`${styles.inputBox} ${inputFocused ? styles.inputBoxFocused : ''}`}
          >
            {projectRefs.length > 0 && (
              <div className={styles.attachmentsRow}>
                {projectRefs.map(r => (
                  <div key={r.path} className={`${styles.attachmentChip} ${styles.refChip}`}>
                    <span className={styles.attachmentName}>{r.path}</span>
                    <button
                      type="button"
                      className={styles.attachmentRemove}
                      onClick={() => handleRemoveProjectRef(r.path)}
                      title="移除引用"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            {files.length > 0 && (
              <div className={styles.attachmentsRow}>
                {files.map(f => (
                  <div key={f.id} className={styles.attachmentChip}>
                    <span className={styles.attachmentName}>{f.file.name}</span>
                    <span className={styles.attachmentSize}>{formatSize(f.file.size)}</span>
                    <button
                      type="button"
                      className={styles.attachmentRemove}
                      onClick={() => handleRemoveFile(f.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              className={styles.hiddenFileInput}
              multiple
              accept="text/*,.txt,.md,.markdown,.log,.json,.yaml,.yml,.xml,.csv,.ini,.conf,.env,.toml,.js,.ts,.tsx,.jsx,.py,.go,.rs,.java,.c,.cpp,.h,.cs,.sql,.html,.css,.scss,.less,.sh,.bat,.ps1"
              onChange={handleFileInputChange}
            />
            <textarea
              ref={textareaRef}
              className={styles.textarea}
              placeholder="请输入要查询的文档问题，例如：如何配置 NapCat 适配器？"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onSelect={(e) => {
                const t = e.currentTarget;
                cursorRefState.current = { start: t.selectionStart || 0, end: t.selectionEnd || 0 };
              }}
              onKeyUp={(e) => {
                const t = e.currentTarget;
                cursorRefState.current = { start: t.selectionStart || 0, end: t.selectionEnd || 0 };
              }}
            />
            <div className={styles.inputFooter}>
              <div className={styles.hint}>Enter 发送，Shift + Enter 换行</div>
              <div className={styles.actions}>
                <button
                  type="button"
                  onClick={() => void openRefModal()}
                  className={`${styles.iconButton} ${styles.refButton}`}
                  title="引用项目文件"
                >
                  <IoFolderOpen size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className={`${styles.iconButton} ${styles.attachButton}`}
                  title="附加本地文件"
                >
                  <IoAttachOutline size={16} />
                </button>
                {sending && (
                  <button
                    type="button"
                    onClick={handleCancel}
                    className={`${styles.iconButton} ${styles.cancelButton}`}
                  >
                    ✕
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => { if (canSend) void send(); }}
                  disabled={!canSend}
                  className={`${styles.iconButton} ${styles.sendButton}`}
                >
                  ➤
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {refModalOpen && (
        <div className={styles.refModalOverlay} onClick={() => setRefModalOpen(false)}>
          <div className={styles.refModal} onClick={e => e.stopPropagation()}>
            <div className={styles.refModalHeader}>
              <div className={styles.refModalTitle}>引用项目文件</div>
              <button
                type="button"
                className={styles.refModalClose}
                onClick={() => setRefModalOpen(false)}
                title="关闭"
              >
                <IoClose size={18} />
              </button>
            </div>

            <div className={styles.refSearchRow}>
              <IoSearch className={styles.refSearchIcon} />
              <input
                className={styles.refSearchInput}
                value={refSearch}
                onChange={(e) => setRefSearch(e.target.value)}
                placeholder="搜索文件路径..."
                spellCheck={false}
              />
            </div>

            <div className={styles.refList}>
              {refLoading ? (
                <div className={styles.refEmpty}>加载中...</div>
              ) : refSearch.trim() ? (
                filteredRefFiles.length === 0 ? (
                  <div className={styles.refEmpty}>未找到匹配文件</div>
                ) : (
                  filteredRefFiles.map((n) => (
                    <label key={n.path} className={styles.refItem}>
                      <input
                        type="checkbox"
                        checked={!!refSelected[n.path]}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setRefSelected(prev => ({ ...prev, [n.path]: checked }));
                        }}
                      />
                      <span className={styles.refItemPath}>{n.path}</span>
                    </label>
                  ))
                )
              ) : refTreeRoot.length === 0 ? (
                <div className={styles.refEmpty}>未找到匹配文件</div>
              ) : (
                <div className={styles.refTreeRoot}>
                  {refTreeRoot.map((n) => (
                    <RefTreeNode key={n.path} node={n} level={0} />
                  ))}
                </div>
              )}
            </div>

            <div className={styles.refFooter}>
              <div className={styles.refFooterHint}>
                已选择 {Object.keys(refSelected).filter(k => refSelected[k]).length} 个
              </div>
              <div className={styles.refFooterActions}>
                <button
                  type="button"
                  className={styles.refBtn}
                  onClick={() => setRefModalOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={`${styles.refBtn} ${styles.refBtnPrimary}`}
                  onClick={applyRefSelection}
                >
                  确认引用
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {convModalOpen && (
        <div className={styles.refModalOverlay} onClick={() => setConvModalOpen(false)}>
          <div className={styles.convModal} onClick={e => e.stopPropagation()}>
            <div className={styles.refModalHeader}>
              <div className={styles.refModalTitle}>对话</div>
              <button
                type="button"
                className={styles.refModalClose}
                onClick={() => setConvModalOpen(false)}
              >
                <IoClose size={18} />
              </button>
            </div>

            <div className={styles.convSearchRow}>
              <IoSearch className={styles.refSearchIcon} />
              <input
                className={styles.refSearchInput}
                value={convSearch}
                onChange={(e) => setConvSearch(e.target.value)}
                placeholder="搜索对话标题..."
                spellCheck={false}
              />
            </div>

            <div className={styles.convTopRow}>
              <button
                type="button"
                className={`${styles.refBtn} ${styles.refBtnPrimary}`}
                onClick={() => void createNewConversation()}
                disabled={convLoading}
              >
                新建对话
              </button>
            </div>

            <div className={styles.convList}>
              {visibleConversations.length === 0 ? (
                <div className={styles.refEmpty}>暂无对话</div>
              ) : (
                visibleConversations.map(c => (
                  <div
                    key={c.id}
                    className={`${styles.convItem} ${c.id === activeConversationId ? styles.convItemActive : ''}`}
                    onClick={() => void switchConversation(c.id)}
                  >
                    <div className={styles.convItemMain}>
                      {editingConvId === c.id ? (
                        <input
                          className={styles.convTitleInput}
                          value={editingTitle}
                          autoFocus
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              void renameConversation(c.id, editingTitle).finally(() => {
                                setEditingConvId('');
                                setEditingTitle('');
                              });
                            }
                            if (e.key === 'Escape') {
                              setEditingConvId('');
                              setEditingTitle('');
                            }
                          }}
                          onBlur={() => {
                            void renameConversation(c.id, editingTitle).finally(() => {
                              setEditingConvId('');
                              setEditingTitle('');
                            });
                          }}
                        />
                      ) : (
                        <div className={styles.convItemTitle}>{c.title || '新对话'}</div>
                      )}
                      <div className={styles.convItemSub}>最后更新 {formatConvTime(c.updatedAt)}</div>
                    </div>
                    <div className={styles.convItemRight}>
                      <button
                        type="button"
                        className={styles.convEdit}
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingConvId(c.id);
                          setEditingTitle(c.title || '');
                        }}
                        title="重命名"
                      >
                        ✎
                      </button>
                      <button
                        type="button"
                        className={styles.convDelete}
                        onClick={(e) => {
                          e.stopPropagation();
                          openConfirm({
                            title: '删除对话',
                            message: '确定删除这个对话吗？该操作不可恢复。',
                            confirmText: '删除',
                            cancelText: '取消',
                            destructive: true,
                            onConfirm: () => {
                              void handleDeleteConversation(c.id);
                            },
                          });
                        }}
                        title="删除"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {traceModalOpen && (
        <div className={styles.refModalOverlay} onClick={() => setTraceModalOpen(false)}>
          <div className={styles.traceModal} onClick={e => e.stopPropagation()}>
            <div className={styles.refModalHeader}>
              <div className={styles.refModalTitle}>Agent 执行日志</div>
              <button
                type="button"
                className={styles.refModalClose}
                onClick={() => setTraceModalOpen(false)}
                title="关闭"
              >
                <IoClose size={18} />
              </button>
            </div>
            <ScrollArea className={styles.traceBody}>
              {(() => {
                const msg = messages.find(m => m.id === traceModalMsgId);
                if (!msg) return <div className={styles.traceEmpty}>暂无日志</div>;
                const hasAny =
                  (Array.isArray(msg.meta?.agentEvents) && msg.meta.agentEvents.length > 0) ||
                  (Array.isArray(msg.meta?.agentTrace) && msg.meta.agentTrace.length > 0) ||
                  (Array.isArray(agentTraceByMsgId[traceModalMsgId]) && agentTraceByMsgId[traceModalMsgId].length > 0);

                if (!hasAny) return <div className={styles.traceEmpty}>暂无日志</div>;

                const merged: ChatMessage = {
                  ...msg,
                  meta: {
                    ...(msg.meta || {}),
                    agentTrace: Array.isArray(msg.meta?.agentTrace)
                      ? msg.meta?.agentTrace
                      : (Array.isArray(agentTraceByMsgId[traceModalMsgId]) ? agentTraceByMsgId[traceModalMsgId] : undefined),
                  },
                };

                return (
                  <>
                    {renderAgentTimeline(merged, false)}
                    {typeof merged.meta?.rawSentraXml === 'string' && merged.meta.rawSentraXml.trim() && (
                      <details className={styles.traceSection} open={false}>
                        <summary className={styles.traceSectionTitle}>Debug（原始 Sentra XML）</summary>
                        <pre className={styles.tracePre}><code>{merged.meta.rawSentraXml}</code></pre>
                      </details>
                    )}
                  </>
                );
              })()}
            </ScrollArea>
          </div>
        </div>
      )}

      {confirmDialog.open && (
        <div className={styles.confirmOverlay} onClick={closeConfirm}>
          <div className={styles.confirmModal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.confirmHeader}>
              <div className={styles.confirmTitle}>{confirmDialog.title}</div>
              <button type="button" className={styles.confirmClose} onClick={closeConfirm} title="关闭">
                <IoClose size={18} />
              </button>
            </div>
            <div className={styles.confirmBody}>{confirmDialog.message}</div>
            <div className={styles.confirmActions}>
              <button type="button" className={styles.confirmBtn} onClick={closeConfirm}>
                {confirmDialog.cancelText}
              </button>
              <button
                type="button"
                className={confirmDialog.destructive ? styles.confirmBtnDanger : styles.confirmBtnPrimary}
                onClick={() => {
                  const fn = confirmDialog.onConfirm;
                  closeConfirm();
                  try { fn && fn(); } catch { }
                }}
              >
                {confirmDialog.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
