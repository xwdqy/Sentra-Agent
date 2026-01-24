import { Component, type PropsWithChildren, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { fetchConfigs, fetchFileContent, saveFileContent, saveModuleConfig, savePluginConfig } from '../../services/api.ts';
import { testProviderModels } from '../../services/llmProvidersApi.ts';
import type { ConfigData, EnvVariable } from '../../types/config.ts';
import type { ToastMessage } from '../Toast';
import { getDisplayName } from '../../utils/icons.tsx';
import { OpenAI as OpenAIIcon } from '@lobehub/icons';
import { Button, Checkbox, Collapse, Descriptions, Empty, Form, Input, InputNumber, List, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography, Upload } from 'antd';
import styles from './ModelProvidersManager.module.css';
import modelVendorMap from './modelVendorMap.json';
import llmEnvMapping from './llmEnvMapping.json';
import {
  ApiOutlined,
  AudioOutlined,
  AppstoreOutlined,
  ArrowLeftOutlined,
  BgColorsOutlined,
  BulbOutlined,
  CheckOutlined,
  ClockCircleOutlined,
  CodeOutlined,
  CopyOutlined,
  CustomerServiceOutlined,
  DeleteOutlined,
  DownOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  FileTextOutlined,
  GlobalOutlined,
  KeyOutlined,
  LaptopOutlined,
  LineChartOutlined,
  LinkOutlined,
  LockOutlined,
  MessageOutlined,
  NumberOutlined,
  PictureOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  SaveOutlined,
  SearchOutlined,
  SettingOutlined,
  ShopOutlined,
  SlidersOutlined,
  SoundOutlined,
  SwapOutlined,
  SyncOutlined,
  UnorderedListOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  TranslationOutlined,
  UploadOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import { useDevice } from '../../hooks/useDevice';
import { storage } from '../../utils/storage';

// ProviderType is intentionally extensible: new vendors can be added via JSON/UX without changing TS.
type ProviderType = string;

type Provider = {
  id: string;
  name: string;
  type: ProviderType;
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  apiKeyHeader: string;
  apiKeyPrefix: string;
  icon?: CustomIconRef | null;
};

type CustomIconRef =
  | { type: 'lobe'; iconName: string }
  | { type: 'upload'; dataUrl: string };

function parseCsvValue(raw: string) {
  return String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function formatCsvValue(values: string[]) {
  return (Array.isArray(values) ? values : [])
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .join(',');
}

function parseMultiTextValue(raw: string) {
  return String(raw || '')
    .split(/[\n\r,]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function formatMultiTextValue(values: string[]) {
  return (Array.isArray(values) ? values : [])
    .map(s => String(s || '').trim())
    .filter(Boolean)
    .join(',');
}

type ModelsCacheEntry = {
  fetchedAt: number;
  models: any[];
};

type ModelsCache = Record<string, ModelsCacheEntry>;

const STORAGE_KEY = 'sentra_llm_providers';
const STORAGE_MODELS_KEY = 'sentra_llm_provider_models_cache';

type LlmModuleName = '.' | 'sentra-mcp' | 'sentra-rag';
type LlmModuleOption = { name: LlmModuleName; label: string };

type LlmConfigTabName = LlmModuleName | 'mcp-plugins';
type LlmConfigTabOption = { name: LlmConfigTabName; label: string };

const LLM_MODULES: LlmModuleOption[] = [
  { name: '.', label: '主程序' },
  { name: 'sentra-mcp', label: 'MCP' },
  { name: 'sentra-rag', label: 'RAG' },
];

const LLM_TABS: LlmConfigTabOption[] = [
  ...LLM_MODULES,
  { name: 'mcp-plugins', label: '本地插件' },
];

type EnvValueType = 'string' | 'number' | 'boolean' | 'enum';
type EnvFieldMeta = { type: EnvValueType; description: string; options?: string[] };

function parseEnvMeta(comment?: string): EnvFieldMeta | null {
  if (!comment) return null;
  const lines = comment.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  let type: EnvValueType | undefined;
  let options: string[] | undefined;
  const descLines: string[] = [];

  for (const raw of lines) {
    const line = raw.replace(/^#+\s*/, '');
    const lower = line.toLowerCase();

    if (lower.startsWith('type:')) {
      const val = line.slice(line.indexOf(':') + 1).trim().toLowerCase();
      if (val === 'number' || val === 'int' || val === 'integer') type = 'number';
      else if (val === 'boolean' || val === 'bool') type = 'boolean';
      else if (val === 'enum') type = 'enum';
      else type = 'string';
      continue;
    }

    if (lower.startsWith('options:')) {
      const val = line.slice(line.indexOf(':') + 1).trim();
      const parsed = val.split(/[|,]/).map(s => s.trim()).filter(Boolean);
      if (parsed.length > 0) {
        options = parsed;
        if (!type) type = 'enum';
      }
      continue;
    }

    if (lower.startsWith('range:')) continue;
    descLines.push(line);
  }

  const resolvedType: EnvValueType = type || (options?.length ? 'enum' : 'string');
  const description = descLines.join(' ').trim();
  return { type: resolvedType, description, options };
}

function isTruthyString(v: string) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

type LlmMapping = {
  version: number;
  modules: Record<string, { label?: string; profiles: LlmProfile[] }>;
};

type LlmCondition = { key: string; op: '==' | '!='; value: string };
type LlmItemKind = 'base_url' | 'api_key' | 'model' | 'boolean' | 'number' | 'enum' | 'text';
type LlmModelScope = 'chat' | 'embedding' | 'rerank' | 'any';
type LlmItemValueFormat = 'csv';
type LlmItem = {
  key: string;
  group: string;
  kind: LlmItemKind;
  picker?: 'model';
  modelScope?: LlmModelScope;
  options?: string[];
  advanced?: boolean;
  multiple?: boolean;
  valueFormat?: LlmItemValueFormat;
};
type LlmProfile = { key: string; label?: string; when?: LlmCondition[]; items: LlmItem[] };

function envGroupOrder(label: string) {
  if (label === '对话') return 0;
  if (label === '向量') return 1;
  if (label === '重排序') return 2;
  return 99;
}

function llmKindPriority(kind: LlmItemKind) {
  if (kind === 'boolean') return 0;
  if (kind === 'base_url') return 1;
  if (kind === 'api_key') return 2;
  if (kind === 'model') return 3;
  if (kind === 'enum') return 4;
  if (kind === 'number') return 5;
  return 9;
}

function isSensitiveKeyKind(kind: LlmItemKind, key: string) {
  if (kind === 'api_key') return true;
  const up = String(key || '').toUpperCase();
  return up.includes('API_KEY') || up.endsWith('_KEY') || up.endsWith('_TOKEN');
}

function getEnvValue(varsMap: Map<string, EnvVariable>, key: string) {
  return String(varsMap.get(key)?.value ?? '').trim();
}

function evalLlmConditions(when: LlmCondition[] | undefined, varsMap: Map<string, EnvVariable>) {
  const conds = Array.isArray(when) ? when : [];
  return conds.every(c => {
    const left = getEnvValue(varsMap, c.key);
    const right = String(c.value ?? '');
    if (c.op === '==') return left === right;
    return left !== right;
  });
}

function safeStringify(value: any) {
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return String(v);
      return v;
    });
  } catch {
    try {
      return String(value);
    } catch {
      return '';
    }
  }
}

function normalizeBaseUrl(url: string) {
  const u = String(url || '').trim();
  return u.replace(/\/+$/, '');
}

function normalizeBaseUrlV1(url: string) {
  const u = normalizeBaseUrl(url);
  if (!u) return u;
  const lower = u.toLowerCase();
  if (lower.endsWith('/v1')) return u;
  return `${u}/v1`;
}

function isValidElementType(type: any) {
  if (!type) return false;
  if (typeof type === 'string' || typeof type === 'function') return true;
  if (typeof type !== 'object') return false;

  const t = (type as any).$$typeof;
  const memo = Symbol.for('react.memo');
  const forwardRef = Symbol.for('react.forward_ref');
  const lazy = Symbol.for('react.lazy');
  const context = Symbol.for('react.context');
  const provider = Symbol.for('react.provider');
  const consumer = Symbol.for('react.consumer');
  return t === memo || t === forwardRef || t === lazy || t === context || t === provider || t === consumer;
}

const LLM_MAPPING_STATIC: LlmMapping = llmEnvMapping as any;
const LLM_ENV_MAPPING_FILE = 'sentra-config-ui/src/components/ModelProvidersManager/llmEnvMapping.json';
const MODEL_OVERRIDES_LOCAL_FILE = 'sentra-config-ui/.sentra/modelOverrides.local.json';

type ModelMatchKind = 'any' | 'exact' | 'prefix' | 'suffix' | 'contains';
type ModelVendorRule = {
  key: string;
  label: string;
  iconName: string;
  match: { kind: ModelMatchKind; value: string }[];
};

type CapabilityRule = {
  key: string;
  label: string;
  priority?: number;
  order?: number;
  requireAbsentKeys?: string[];
  match: ({ kind: ModelMatchKind; value: string } | { kind: ModelMatchKind; value: string }[])[];
  exclude?: ({ kind: ModelMatchKind; value: string } | { kind: ModelMatchKind; value: string }[])[];
};

type CapabilityMeta = {
  key: string;
  label?: string;
  icon?: string;
  theme?: { fg?: string; bg?: string; border?: string };
};

type ModelVendor = { key: string; label: string; iconName: string };

const LOBE_ICON_STATIC_MAP: Record<string, any> = {
  
};

let LOBE_ICON_FULL_LIB: Record<string, any> | null = null;
let LOBE_ICON_FULL_KEY_BY_LOWER: Map<string, string> | null = null;
let LOBE_ICON_FULL_VALID_KEYS: string[] | null = null;

function ensureLobeIconsLoaded() {
  if (LOBE_ICON_FULL_LIB) return Promise.resolve();
  return import('@lobehub/icons').then((mod) => {
    const lib = ((mod as any) || {}) as Record<string, any>;
    const merged: Record<string, any> = { ...(LOBE_ICON_STATIC_MAP as any), ...(lib as any) };
    LOBE_ICON_FULL_LIB = merged;

    const m = new Map<string, string>();
    for (const k of Object.keys(merged)) m.set(k.toLowerCase(), k);
    LOBE_ICON_FULL_KEY_BY_LOWER = m;

    const keys = Object.keys(merged);
    LOBE_ICON_FULL_VALID_KEYS = keys.filter((k) => {
      const v = (merged as any)[k];
      if (!v) return false;
      const color = (v as any)?.Color;
      return isValidElementType(color) || isValidElementType(v);
    });
  });
}

const modelVendorRules: ModelVendorRule[] = Array.isArray((modelVendorMap as any)?.rules) ? (modelVendorMap as any).rules : [];
const capabilityRules: CapabilityRule[] = Array.isArray((modelVendorMap as any)?.capabilityRules) ? (modelVendorMap as any).capabilityRules : [];
const capabilityMeta: CapabilityMeta[] = Array.isArray((modelVendorMap as any)?.capabilityMeta) ? (modelVendorMap as any).capabilityMeta : [];
const capabilityMetaMap = new Map<string, CapabilityMeta>(capabilityMeta.map(m => [String(m.key), m]));

function matchRule(hay: { id: string; owned: string }, rule: { kind: ModelMatchKind; value: string }) {
  const v = String(rule.value || '').toLowerCase();
  if (rule.kind === 'any') return true;
  if (!v) return false;

  // 约定：
  // - exact/prefix/suffix：主要用于 model.id（也允许 owned_by 命中）
  // - contains：同时在 id/owned_by 中搜索
  if (rule.kind === 'exact') return hay.id === v || hay.owned === v;
  if (rule.kind === 'prefix') return hay.id.startsWith(v) || hay.owned.startsWith(v);
  if (rule.kind === 'suffix') return hay.id.endsWith(v) || hay.owned.endsWith(v);
  return hay.id.includes(v) || hay.owned.includes(v);
}

function matchCapabilityEntry(hay: { id: string; owned: string }, entry: CapabilityRule['match'][number]) {
  if (Array.isArray(entry)) {
    // AND group
    return entry.every(x => matchRule(hay, x));
  }
  return matchRule(hay, entry);
}

function inferModelCapabilities(modelId: string): { key: string; label: string }[] {
  const id = String(modelId || '').toLowerCase();
  if (!id) return [];
  const hay = { id: id.trim(), owned: '' };
  const uniq = new Map<string, { label: string; order: number }>();

  const sortedRules = capabilityRules
    .map((r, idx) => ({ ...r, __idx: idx, priority: typeof r.priority === 'number' ? r.priority : 0 }))
    .sort((a, b) => (b.priority - a.priority) || (a.__idx - b.__idx));

  for (const r of sortedRules) {
    const matches = Array.isArray(r.match) ? r.match : [];
    if (!matches.some(m => matchCapabilityEntry(hay, m))) continue;

    const excludes = Array.isArray(r.exclude) ? r.exclude : [];
    if (excludes.some(e => matchCapabilityEntry(hay, e))) continue;

    const requireAbsentKeys = Array.isArray(r.requireAbsentKeys) ? r.requireAbsentKeys : [];
    if (requireAbsentKeys.some(k => uniq.has(String(k)))) continue;

    const key = String(r.key);
    const metaLabel = capabilityMetaMap.get(key)?.label;
    const label = String(metaLabel || r.label || r.key);
    const order = typeof r.order === 'number' ? r.order : 100;
    if (!uniq.has(key)) uniq.set(key, { label, order });
  }

  const ordered = Array.from(uniq.entries()).map(([key, v]) => ({ key, label: v.label, order: v.order }));
  ordered.sort((a, b) => (a.order - b.order) || a.key.localeCompare(b.key));
  return ordered.map(({ order: _o, ...rest }) => rest);
}

function safeInferModelCapabilities(modelId: string) {
  const id = String(modelId || '').trim();
  if (!id) return [] as any[];
  const cached = (safeInferModelCapabilities as any)._cache as Map<string, any[]> | undefined;
  if (cached && cached.has(id)) return cached.get(id) as any[];
  try {
    const res = inferModelCapabilities(id);
    const map = cached || new Map<string, any[]>();
    map.set(id, res as any);
    (safeInferModelCapabilities as any)._cache = map;
    return res;
  } catch (e) {
    return [];
  }
}

function capTheme(capKey: string): { fg: string; bg: string; border: string } {
  const key = String(capKey || '');
  const t = capabilityMetaMap.get(key)?.theme;
  const fg = t?.fg;
  const bg = t?.bg;
  const border = t?.border;
  if (fg && bg && border) return { fg, bg, border };
  return { fg: 'var(--mpm-muted)', bg: 'var(--mpm-input-bg)', border: 'var(--mpm-input-border)' };
}

function capStyleVars(capKey: string) {
  const t = capTheme(capKey);
  return { ['--cap-fg' as any]: t.fg, ['--cap-bg' as any]: t.bg, ['--cap-border' as any]: t.border } as any;
}

const CAPABILITY_ICON_MAP: Record<string, ReactNode> = {
  chatbubble: <MessageOutlined />,
  eye: <EyeOutlined />,
  globe: <GlobalOutlined />,
  mic: <AudioOutlined />,
  eye_outline: <EyeOutlined />,
  image: <PictureOutlined />,
  brush: <BgColorsOutlined />,
  music: <CustomerServiceOutlined />,
  volume: <SoundOutlined />,
  play: <PlayCircleOutlined />,
  videocam: <VideoCameraOutlined />,
  layers: <AppstoreOutlined />,
  shuffle: <SwapOutlined />,
  bulb: <BulbOutlined />,
  pulse: <LineChartOutlined />,
  code: <CodeOutlined />,
  tool: <ToolOutlined />,
  json: <FileTextOutlined />,
  time: <ClockCircleOutlined />,
  shield: <SafetyCertificateOutlined />,
  language: <TranslationOutlined />,
  laptop: <LaptopOutlined />,
};

function CapabilityIcon(props: { capKey: string }) {
  const icon = capabilityMetaMap.get(String(props.capKey))?.icon;
  const Comp = icon ? CAPABILITY_ICON_MAP[String(icon)] : null;
  return Comp || <OpenAIIcon size={16} />;
}

function inferModelScopeFromItem(it: LlmItem): LlmModelScope {
  if (it.modelScope) return it.modelScope;
  const g = String(it.group || '').toLowerCase();
  if (g.includes('向量') || g.includes('embedding')) return 'embedding';
  if (g.includes('重排序') || g.includes('rerank')) return 'rerank';
  return 'chat';
}

function modelInScope(modelId: string, scope: LlmModelScope) {
  if (scope === 'any') return true;
  const caps = safeInferModelCapabilities(modelId).map(c => c.key);
  if (scope === 'embedding') return caps.includes('embedding');
  if (scope === 'rerank') return caps.includes('rerank');
  // chat
  return caps.includes('chat') && !caps.includes('embedding') && !caps.includes('rerank');
}

function inferModelVendor(model: any, fallback: ModelVendor): ModelVendor {
  const id = (model?.id != null ? String(model.id) : '').toLowerCase();
  const owned = (model?.owned_by != null ? String(model.owned_by) : '').toLowerCase();
  const hay = { id: id.trim(), owned: owned.trim() };

  for (const r of modelVendorRules) {
    const matches = Array.isArray(r.match) ? r.match : [];
    if (matches.some(m => matchRule(hay, m))) {
      return { key: r.key, label: r.label, iconName: r.iconName };
    }
  }
  return fallback;
}

function safeInferModelVendor(model: any, fallback: ModelVendor): ModelVendor {
  try {
    return inferModelVendor(model, fallback);
  } catch (e) {
    try {
      // eslint-disable-next-line no-console
      console.warn('[ModelProvidersManager] inferModelVendor failed', { model, error: e });
    } catch {
      // ignore
    }
    return fallback;
  }
}

class BrandLogoErrorBoundary extends Component<
  PropsWithChildren<{ fallback: ReactNode; resetKey: string }>,
  { hasError: boolean }
> {
  state: { hasError: boolean } = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      // eslint-disable-next-line react/no-did-update-set-state
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children as any;
  }
}

function BrandLogo(props: { iconName: string; size: number }) {
  const getComp = (name: string) => {
    const raw = String(name || '').trim();
    if (!raw) return null;

    const lib = (LOBE_ICON_FULL_LIB || LOBE_ICON_STATIC_MAP) as any;
    const direct = lib?.[raw];
    const lowerMap = LOBE_ICON_FULL_KEY_BY_LOWER;
    const ciKey = !direct ? lowerMap?.get(raw.toLowerCase()) : undefined;
    const icon = (direct || (ciKey ? lib[ciKey] : undefined)) as any;
    if (!icon) return null;
    const color = (icon as any)?.Color;
    if (isValidElementType(color)) return color;
    if (isValidElementType(icon)) return icon;
    return null;
  };

  const Comp = props.iconName ? getComp(props.iconName) : null;
  const ultimateFallback = <OpenAIIcon size={props.size} />;
  if (!Comp && props.iconName && LOBE_ICON_FULL_LIB) {
    try {
      // eslint-disable-next-line no-console
      console.warn('[ModelProvidersManager] missing Lobe icon export', { iconName: props.iconName });
    } catch {
      // ignore
    }
  }

  return (
    <BrandLogoErrorBoundary fallback={ultimateFallback} resetKey={`${props.iconName}:${props.size}`}>
      {Comp ? <Comp size={props.size} /> : ultimateFallback}
    </BrandLogoErrorBoundary>
  );
}

function CustomIcon(props: { icon: CustomIconRef; size: number }) {
  if (props.icon.type === 'upload') {
    return (
      <img
        src={props.icon.dataUrl}
        alt=""
        style={{ width: props.size, height: props.size, borderRadius: 999, objectFit: 'cover', display: 'block' }}
      />
    );
  }
  return <BrandLogo iconName={props.icon.iconName} size={props.size} />;
}

function toPascalCase(s: string) {
  return String(s || '')
    .split(/[^a-zA-Z0-9]+/g)
    .filter(Boolean)
    .map(p => p.slice(0, 1).toUpperCase() + p.slice(1))
    .join('');
}

function inferProviderIconName(type: ProviderType) {
  const raw = String(type || '').trim();
  const t = raw.toLowerCase();
  if (!t) return '';

  // Prefer explicit mapping from modelVendorMap.json rules.
  const directRule = modelVendorRules.find(r => String(r.key || '').toLowerCase() === t);
  if (directRule?.iconName) return directRule.iconName;

  // Common aliases (historical provider type names).
  const alias: Record<string, string> = {
    open_ai: 'openai',
    openai_compatible: 'openai',
    azure_openai: 'azure',
    azureopenai: 'azure',
    msazure: 'azure',

    anthropic_ai: 'anthropic',

    google: 'gemini',
    googleai: 'gemini',
    google_genai: 'gemini',
    vertex: 'gemini',
    vertexai: 'gemini',

    tongyi: 'qwen',
    aliyun: 'qwen',
    alibaba: 'qwen',

    zhipu: 'chatglm',

    baidu: 'wenxin',

    tencent: 'hunyuan',

    open_router: 'openrouter',
    openrouter_ai: 'openrouter',

    x_ai: 'xai',

    llama: 'meta',
  };
  const aliasKey = alias[t];
  if (aliasKey) {
    const aliasRule = modelVendorRules.find(r => String(r.key || '').toLowerCase() === aliasKey);
    if (aliasRule?.iconName) return aliasRule.iconName;
  }

  // Fallback: best-effort convert provider type to a PascalCase icon export name.
  const pascal = toPascalCase(raw);
  return pascal || '';
}

function ProviderLogo(props: { type: ProviderType }) {
  return <BrandLogo iconName={inferProviderIconName(props.type)} size={18} />;
}

function makeLobeIconChoices(query: string) {
  const q = String(query || '').trim().toLowerCase();
  const keys = (LOBE_ICON_FULL_VALID_KEYS || Object.keys(LOBE_ICON_STATIC_MAP));
  const filtered = q ? keys.filter(k => k.toLowerCase().includes(q)) : keys;
  return filtered.slice(0, 120);
}

function providerTypeFallbackVendor(type: ProviderType): ModelVendor {
  const raw = String(type || '').trim();
  const t = raw.toLowerCase();
  const fallback: ModelVendor = { key: 'custom', label: 'Custom', iconName: inferProviderIconName(type) || '' };
  if (!t) return fallback;

  const directRule = modelVendorRules.find(r => String(r.key || '').toLowerCase() === t);
  if (directRule) return { key: directRule.key, label: directRule.label, iconName: directRule.iconName };

  const alias: Record<string, string> = {
    tongyi: 'qwen',
    zhipu: 'chatglm',
  };
  const aliasKey = alias[t];
  if (aliasKey) {
    const aliasRule = modelVendorRules.find(r => String(r.key || '').toLowerCase() === aliasKey);
    if (aliasRule) return { key: aliasRule.key, label: aliasRule.label, iconName: aliasRule.iconName };
  }

  return fallback;
}

export default function ModelProvidersManager(props: { addToast: (type: ToastMessage['type'], title: string, message?: string) => void }) {
  const addToast = props.addToast;

  const MODELS_COLLAPSE_KEY = 'mpm_models_collapsed';

  const { isMobile, isTablet } = useDevice();
  const isCompact = isMobile || isTablet;

  const selectNotFound = <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无选项" />;
  const selectPopupStyles = { popup: { root: { minWidth: 240 } } } as const;
  const [mobilePane, setMobilePane] = useState<'list' | 'detail'>('list');
  const [mobileSection, setMobileSection] = useState<'provider' | 'config' | 'models'>('provider');

  const [modelsCollapsed, setModelsCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MODELS_COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const [llmMappingState, setLlmMappingState] = useState<LlmMapping>(() => LLM_MAPPING_STATIC);
  const [llmMappingLoading, setLlmMappingLoading] = useState(false);

  const [localModelOverrides, setLocalModelOverrides] = useState<Record<string, any>>({});

  const loadLlmMappingFromFile = useCallback(async () => {
    setLlmMappingLoading(true);
    try {
      const file = await fetchFileContent(LLM_ENV_MAPPING_FILE);
      if (file?.isBinary) throw new Error('配置文件不是文本');
      const raw = String(file?.content || '');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.modules) {
        throw new Error('配置文件缺少 modules 字段');
      }
      setLlmMappingState(parsed as any);
    } catch (e: any) {
      // fallback to bundled JSON
      setLlmMappingState(LLM_MAPPING_STATIC);
    } finally {
      setLlmMappingLoading(false);
    }
  }, []);

  const loadLocalModelOverridesFromFile = useCallback(async () => {
    try {
      const file = await fetchFileContent(MODEL_OVERRIDES_LOCAL_FILE);
      if (file?.isBinary) throw new Error('配置文件不是文本');
      const raw = String(file?.content || '').trim();
      if (!raw) {
        setLocalModelOverrides({});
        return;
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        setLocalModelOverrides({});
        return;
      }
      setLocalModelOverrides(parsed as any);
    } catch {
      setLocalModelOverrides({});
    }
  }, []);

  const saveLocalModelOverridesToFile = useCallback(async (next: any) => {
    const text = JSON.stringify(next || {}, null, 2);
    JSON.parse(text);
    await saveFileContent(MODEL_OVERRIDES_LOCAL_FILE, text + '\n');
    setLocalModelOverrides(next || {});
  }, []);

  const [providerSearch, setProviderSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const rightRef = useRef<HTMLDivElement | null>(null);

  const [configData, setConfigData] = useState<ConfigData | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [llmTab, setLlmTab] = useState<LlmConfigTabName>('.');
  const [llmModule, setLlmModule] = useState<LlmModuleName>('.');
  const [llmDrafts, setLlmDrafts] = useState<Record<string, EnvVariable[]>>({});
  const [llmDirty, setLlmDirty] = useState<Record<string, boolean>>({});
  const [llmSaving, setLlmSaving] = useState(false);
  const [llmGroupCollapsed, setLlmGroupCollapsed] = useState<Record<string, boolean>>({});
  const [showSecretsInEnv, setShowSecretsInEnv] = useState(false);
  const [showAdvancedLlm, setShowAdvancedLlm] = useState(false);

  const [providerEditorOpen, setProviderEditorOpen] = useState(false);
  const [providerEditorMode, setProviderEditorMode] = useState<'add' | 'edit'>('add');
  const [providerEditorTargetId, setProviderEditorTargetId] = useState<string | null>(null);
  const [providerEditorIcon, setProviderEditorIcon] = useState<CustomIconRef | null>(null);
  const [providerEditorForm] = Form.useForm<Pick<Provider, 'name' | 'type' | 'enabled' | 'baseUrl' | 'apiKey' | 'apiKeyHeader' | 'apiKeyPrefix'>>();
  const providerEditorType = Form.useWatch('type', providerEditorForm);

  const [mcpPluginName, setMcpPluginName] = useState<string>('');
  const [mcpPluginDrafts, setMcpPluginDrafts] = useState<Record<string, EnvVariable[]>>({});
  const [mcpPluginDirty, setMcpPluginDirty] = useState<Record<string, boolean>>({});
  const [mcpPluginSaving, setMcpPluginSaving] = useState(false);
  const [mcpPluginGroupCollapsed, setMcpPluginGroupCollapsed] = useState<Record<string, boolean>>({});
  const [mcpPluginShowAllVars, setMcpPluginShowAllVars] = useState(false);

  const isMcpPluginLlmKey = useCallback((key0: string) => {
    const up = String(key0 || '').toUpperCase();
    if (!up) return false;
    if (up.includes('BASE_URL')) return true;
    if (up.includes('API_KEY') || up.endsWith('_KEY') || up.endsWith('_TOKEN')) return true;
    if (up.endsWith('_MODEL') || up === 'MODEL') return true;
    return false;
  }, []);

  const [providers, setProviders] = useState<Provider[]>(() => {
    const stored = storage.getJson<Provider[]>(STORAGE_KEY, { fallback: [] });
    if (Array.isArray(stored) && stored.length) {
      return stored.map(p => ({
        id: String((p as any).id || uuidv4()),
        name: String((p as any).name || '未命名供应商'),
        type: (String((p as any).type || 'custom') as ProviderType),
        enabled: (p as any).enabled !== false,
        baseUrl: String((p as any).baseUrl || ''),
        apiKey: String((p as any).apiKey || ''),
        apiKeyHeader: String((p as any).apiKeyHeader || 'Authorization'),
        apiKeyPrefix: String((p as any).apiKeyPrefix || 'Bearer '),
        icon: (p as any).icon || null,
      }));
    }
    return [
      {
        id: uuidv4(),
        name: 'OpenAI',
        type: 'openai',
        enabled: true,
        baseUrl: 'https://api.openai.com',
        apiKey: '',
        apiKeyHeader: 'Authorization',
        apiKeyPrefix: 'Bearer ',
        icon: null,
      },
      {
        id: uuidv4(),
        name: '兼容 OpenAI (本地/自建)',
        type: 'custom',
        enabled: true,
        baseUrl: 'http://127.0.0.1:8000',
        apiKey: '',
        apiKeyHeader: 'Authorization',
        apiKeyPrefix: 'Bearer ',
        icon: null,
      },
    ];
  });

  const [modelsCache, setModelsCache] = useState<ModelsCache>(() => {
    const stored = storage.getJson<ModelsCache>(STORAGE_MODELS_KEY, { fallback: {} as any });
    return stored && typeof stored === 'object' ? stored : ({} as any);
  });

  const [activeId, setActiveId] = useState<string>(() => (providers[0]?.id ? providers[0].id : ''));
  const [busy, setBusy] = useState(false);
  const [busyProviderId, setBusyProviderId] = useState<string | null>(null);

  useEffect(() => {
    storage.setJson(STORAGE_KEY, providers);
  }, [providers]);

  const loadConfigData = useCallback(async () => {
    setConfigLoading(true);
    try {
      const data = await fetchConfigs();
      setConfigData(data);
    } catch (e: any) {
      addToast('error', '加载配置失败', e?.message ? String(e.message) : String(e));
    } finally {
      setConfigLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    loadConfigData();
  }, [loadConfigData]);

  useEffect(() => {
    loadLlmMappingFromFile();
  }, [loadLlmMappingFromFile]);

  useEffect(() => {
    loadLocalModelOverridesFromFile();
  }, [loadLocalModelOverridesFromFile]);

  useEffect(() => {
    try {
      storage.setJson(STORAGE_MODELS_KEY, modelsCache);
    } catch {
      // ignore
    }
  }, [modelsCache]);

  useEffect(() => {
    if (providers.length === 0) {
      setActiveId('');
      return;
    }
    if (!activeId || !providers.some(p => p.id === activeId)) {
      setActiveId(providers[0].id);
    }
  }, [activeId, providers]);

  const activeProvider = useMemo(() => providers.find(p => p.id === activeId) || null, [activeId, providers]);
  const activeProviderType: ProviderType = (activeProvider as any)?.type || 'custom';

  const updateActive = useCallback((patch: Partial<Provider>) => {
    if (!activeProvider) return;
    setProviders(prev => prev.map(p => p.id === activeProvider.id ? { ...p, ...patch } : p));
  }, [activeProvider]);

  const removeProvider = useCallback((id: string) => {
    const targetId = String(id || '').trim();
    if (!targetId) return;
    setProviders(prev => {
      const next = prev.filter(px => px.id !== targetId);
      // keep activeId valid
      try {
        if (activeId === targetId) {
          const nextId = next[0]?.id || '';
          setActiveId(nextId);
        }
      } catch {
        // ignore
      }
      return next;
    });
    setModelsCache(prev => {
      const next = { ...prev };
      delete next[targetId];
      return next;
    });
  }, [activeId]);

  const openAddProvider = useCallback(() => {
    setProviderEditorMode('add');
    setProviderEditorTargetId(null);
    setProviderEditorIcon(null);
    providerEditorForm.setFieldsValue({
      name: '新供应商',
      type: 'custom',
      enabled: true,
      baseUrl: '',
      apiKey: '',
      apiKeyHeader: 'Authorization',
      apiKeyPrefix: 'Bearer ',
    });
    setProviderEditorOpen(true);
  }, [providerEditorForm]);

  const openEditProvider = useCallback((id: string) => {
    const p = providers.find(x => x.id === id);
    if (!p) return;
    setProviderEditorMode('edit');
    setProviderEditorTargetId(p.id);
    setProviderEditorIcon(p.icon ? (p.icon as any) : null);
    providerEditorForm.setFieldsValue({
      name: p.name,
      type: p.type,
      enabled: p.enabled,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      apiKeyHeader: p.apiKeyHeader,
      apiKeyPrefix: p.apiKeyPrefix,
    });
    setProviderEditorOpen(true);
  }, [providerEditorForm, providers]);

  const saveProviderEditor = useCallback(async () => {
    const values = await providerEditorForm.validateFields();
    const payload = {
      name: String(values.name || '').trim() || '未命名供应商',
      type: String(values.type || '').trim() || 'custom',
      enabled: Boolean(values.enabled),
      baseUrl: String(values.baseUrl || '').trim(),
      apiKey: String(values.apiKey || ''),
      apiKeyHeader: String(values.apiKeyHeader || 'Authorization'),
      apiKeyPrefix: String(values.apiKeyPrefix || 'Bearer '),
      icon: providerEditorIcon,
    };

    if (providerEditorMode === 'add') {
      const id = uuidv4();
      const p: Provider = { id, ...payload };
      setProviders(prev => [p, ...prev]);
      setActiveId(id);
      setProviderEditorOpen(false);
      return;
    }

    const id = providerEditorTargetId;
  if (!id) return;
  setProviders(prev => prev.map(px => (px.id === id ? { ...px, ...payload } : px)));
  setProviderEditorOpen(false);
  }, [providerEditorForm, providerEditorIcon, providerEditorMode, providerEditorTargetId]);

  const runTestModels = useCallback(async () => {
    if (!activeProvider) return;

    const baseUrl = normalizeBaseUrlV1(activeProvider.baseUrl);
    if (!baseUrl) {
      addToast('error', '请填写 API Base URL');
      return;
    }

    setBusy(true);
    setBusyProviderId(activeProvider.id);

    try {
      const data = await testProviderModels({
        baseUrl,
        apiKey: activeProvider.apiKey,
        apiKeyHeader: 'Authorization',
        apiKeyPrefix: 'Bearer ',
        debug: true,
      });

      const models = Array.isArray((data as any)?.models) ? (data as any).models : [];
      setModelsCache(prev => ({
        ...prev,
        [activeProvider.id]: {
          fetchedAt: Date.now(),
          models,
        }
      }));

      addToast('success', '检测成功', `已获取 ${models.length} 个模型`);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      addToast('error', '检测失败', msg);
    } finally {
      setBusy(false);
      setBusyProviderId((prev) => (prev === activeProvider.id ? null : prev));
    }
  }, [activeProvider, addToast]);

  const runTestModelsForProvider = useCallback(async (providerId: string) => {
    const p = providers.find(x => x.id === providerId);
    if (!p) return;

    const baseUrl = normalizeBaseUrlV1(p.baseUrl);
    if (!baseUrl) {
      addToast('error', '请填写 API Base URL');
      return;
    }

    setBusy(true);
    setBusyProviderId(p.id);

    try {
      const data = await testProviderModels({
        baseUrl,
        apiKey: p.apiKey,
        apiKeyHeader: 'Authorization',
        apiKeyPrefix: 'Bearer ',
        debug: true,
      });

      const models = Array.isArray((data as any)?.models) ? (data as any).models : [];
      setModelsCache(prev => ({
        ...prev,
        [p.id]: {
          fetchedAt: Date.now(),
          models,
        }
      }));

      addToast('success', '检索成功', `${p.name || '供应商'}：已获取 ${models.length} 个模型`);
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : String(e);
      addToast('error', '检索失败', msg);
    } finally {
      setBusy(false);
      setBusyProviderId((prev) => (prev === p.id ? null : prev));
    }
  }, [addToast, providers]);

  const activeModelsEntry = activeProvider ? modelsCache[activeProvider.id] : undefined;
  const activeModels = Array.isArray(activeModelsEntry?.models) ? activeModelsEntry?.models : [];
  const activeModelIds = useMemo(() => {
    if (!activeModels || !Array.isArray(activeModels)) return [];
    return activeModels
      .map(m => (m?.id != null ? String(m.id) : ''))
      .filter(Boolean);
  }, [activeModels]);

  const filteredProviders = useMemo(() => {
    const term = providerSearch.trim().toLowerCase();
    if (!term) return providers;
    return providers.filter(p => {
      const name = (p?.name || '').toLowerCase();
      const url = (p?.baseUrl || '').toLowerCase();
      return name.includes(term) || url.includes(term);
    });
  }, [providers, providerSearch]);

  const providerTypeOptions = useMemo(() => {
    const labelOf = (k0: string) => {
      const k = String(k0 || '').trim();
      const lower = k.toLowerCase();
      const known: Record<string, string> = {
        custom: '自定义',
        openai: 'OpenAI 兼容',
        azure: 'Azure OpenAI',
        gemini: 'Gemini',
        anthropic: 'Anthropic',
        qwen: '通义千问',
        wenxin: '文心一言',
        hunyuan: '混元',
        chatglm: '智谱 ChatGLM',
        openrouter: 'OpenRouter',
        xai: 'xAI',
        ollama: 'Ollama',
      };
      const fromRules = modelVendorRules.find(r => String(r.key || '').toLowerCase() === lower)?.label;
      const baseLabel = String(fromRules || known[lower] || k || lower);
      if (!k) return baseLabel;
      if (baseLabel.toLowerCase() === lower) return k;
      return `${baseLabel}（${k}）`;
    };

    const set = new Set<string>();
    set.add('custom');
    set.add('openai');
    for (const r of modelVendorRules) {
      const k = String((r as any)?.key || '').trim();
      if (k) set.add(k);
    }
    return Array.from(set.values()).sort((a, b) => a.localeCompare(b)).map(k => ({ value: k, label: labelOf(k) }));
  }, []);

  const llmModuleConfig = useMemo(() => {
    return configData?.modules?.find(x => x.name === llmModule) || null;
  }, [configData, llmModule]);

  const llmDraftVars = useMemo(() => {
    return llmDrafts[llmModule] || (Array.isArray(llmModuleConfig?.variables) ? llmModuleConfig!.variables : []);
  }, [llmDrafts, llmModule, llmModuleConfig]);

  const llmVarsMap = useMemo(() => {
    const m = new Map<string, EnvVariable>();
    for (const v of llmDraftVars) m.set(v.key, v);
    return m;
  }, [llmDraftVars]);

  const llmModuleMapping = useMemo(() => {
    const mm = (llmMappingState?.modules as any)?.[llmModule];
    return mm || null;
  }, [llmModule, llmMappingState]);

  const modelOverrides = useMemo(() => {
    const ui = (llmMappingState as any)?.ui || {};
    const mo = ui?.modelOverrides;
    return mo && typeof mo === 'object' ? mo : {};
  }, [llmMappingState]);

  const mergedModelOverrides = useMemo(() => {
    const base = (modelOverrides && typeof modelOverrides === 'object') ? modelOverrides : {};
    const local = (localModelOverrides && typeof localModelOverrides === 'object') ? localModelOverrides : {};
    const merged: Record<string, any> = {};
    for (const k of Object.keys(base)) merged[k] = { ...(base as any)[k] };
    for (const k of Object.keys(local)) {
      const bv = merged[k];
      const lv = (local as any)[k];
      if (bv && typeof bv === 'object' && lv && typeof lv === 'object') merged[k] = { ...bv, ...lv };
      else merged[k] = lv;
    }
    return merged;
  }, [localModelOverrides, modelOverrides]);

  const pluginModelConstraints = useMemo(() => {
    const ui = (llmMappingState as any)?.ui || {};
    const pmc = ui?.pluginModelConstraints;
    return pmc && typeof pmc === 'object' ? pmc : {};
  }, [llmMappingState]);

  const getModelOverride = useCallback((providerId: string, modelId: string) => {
    const byProvider = (mergedModelOverrides as any)?.[providerId];
    if (!byProvider || typeof byProvider !== 'object') return null;
    const entry = byProvider?.[modelId];
    if (!entry || typeof entry !== 'object') return null;
    return entry as { icon?: CustomIconRef; caps?: string[] };
  }, [mergedModelOverrides]);

  const getPluginModelRequireCaps = useCallback((pluginName: string, envKey: string) => {
    const p = (pluginModelConstraints as any)?.[String(pluginName || '')];
    if (!p || typeof p !== 'object') return [] as string[];
    const entry = p?.[String(envKey || '')];
    if (!entry || typeof entry !== 'object') return [] as string[];
    const caps = (entry as any)?.requireCaps;
    if (!Array.isArray(caps)) return [] as string[];
    return caps.map(String).map(s => s.trim()).filter(Boolean);
  }, [pluginModelConstraints]);

  const modelHasCaps = useCallback((providerId: string | null, modelId: string, requireCaps: string[]) => {
    const required = Array.isArray(requireCaps) ? requireCaps : [];
    if (required.length === 0) return true;
    const ov = providerId ? getModelOverride(providerId, modelId) : null;
    const caps = (ov?.caps && ov.caps.length)
      ? ov.caps.map(String)
      : safeInferModelCapabilities(modelId).map(c => String(c.key));
    return required.every(k => caps.includes(String(k)));
  }, [getModelOverride]);

  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [modelSettingsModelId, setModelSettingsModelId] = useState('');
  const [modelSettingsProviderId, setModelSettingsProviderId] = useState('');
  const [modelSettingsIcon, setModelSettingsIcon] = useState<CustomIconRef | null>(null);
  const [modelSettingsCaps, setModelSettingsCaps] = useState<string[]>([]);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [iconPickerTarget, setIconPickerTarget] = useState<'model' | 'provider'>('model');
  const [lobeIconLibReady, setLobeIconLibReady] = useState(false);
  const [iconSearch, setIconSearch] = useState('');
  const [capabilitySearch, setCapabilitySearch] = useState('');
  const [capabilityView, setCapabilityView] = useState<'all' | 'selected' | 'inferred' | 'unselected'>('all');
  const [capabilityCategory, setCapabilityCategory] = useState<string>('all');

  const inferredModelSettingsCaps = useMemo(() => {
    if (!modelSettingsModelId) return [] as string[];
    return safeInferModelCapabilities(modelSettingsModelId).map(c => String(c.key));
  }, [modelSettingsModelId]);

  const capabilityChoices = useMemo(() => {
    const uniq = new Map<string, string>();
    for (const r of capabilityRules) {
      if (!r?.key) continue;
      uniq.set(String(r.key), String(r.label || r.key));
    }
    return Array.from(uniq.entries()).map(([key, label]) => ({ key, label }));
  }, []);

  const capabilityLabelByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of capabilityChoices) m.set(String(c.key), String(c.label || c.key));
    return m;
  }, [capabilityChoices]);

  const toggleModelSettingsCap = useCallback((key: string) => {
    const k = String(key || '').trim();
    if (!k) return;
    setModelSettingsCaps((prev) => {
      const next = new Set(prev.map(String));
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return Array.from(next);
    });
  }, []);

  const filteredCapabilityChoices = useMemo(() => {
    const q = String(capabilitySearch || '').trim().toLowerCase();
    const inferred = new Set(inferredModelSettingsCaps.map(String));
    const selected = new Set(modelSettingsCaps.map(String));

    const categoryOf = (capKey: string) => {
      const k = String(capKey || '').toLowerCase();
      if (k === 'chat' || k === 'reasoning' || k === 'long_context' || k === 'translation') return '核心';
      if (k === 'moderation') return '安全';
      if (k === 'local') return '本地';
      if (k === 'realtime') return '实时';
      if (k.includes('vision') || k.includes('image')) return '图像/视觉';
      if (k.includes('audio') || k.includes('speech') || k.includes('music')) return '音频';
      if (k.includes('video')) return '视频';
      if (k === 'web') return '联网';
      if (k === 'embedding' || k === 'rerank') return '向量/检索';
      if (k === 'function_call' || k === 'json_mode' || k === 'code') return '工具/结构化';
      return '其他';
    };

    return capabilityChoices.filter((c) => {
      const k0 = String(c.key);
      const k = k0.toLowerCase();
      const l = String(c.label || '').toLowerCase();
      if (q && !(k.includes(q) || l.includes(q))) return false;
      if (capabilityCategory !== 'all' && categoryOf(k0) !== capabilityCategory) return false;
      if (capabilityView === 'selected') return selected.has(k0);
      if (capabilityView === 'unselected') return !selected.has(k0);
      if (capabilityView === 'inferred') return inferred.has(k0);
      return true;
    });
  }, [capabilityCategory, capabilityChoices, capabilitySearch, capabilityView, inferredModelSettingsCaps, modelSettingsCaps]);

  const capabilityCategoryOptions = useMemo(() => {
    const categoryOf = (capKey: string) => {
      const k = String(capKey || '').toLowerCase();
      if (k === 'chat' || k === 'reasoning' || k === 'long_context' || k === 'translation') return '核心';
      if (k === 'moderation') return '安全';
      if (k === 'local') return '本地';
      if (k === 'realtime') return '实时';
      if (k.includes('vision') || k.includes('image')) return '图像/视觉';
      if (k.includes('audio') || k.includes('speech') || k.includes('music')) return '音频';
      if (k.includes('video')) return '视频';
      if (k === 'web') return '联网';
      if (k === 'embedding' || k === 'rerank') return '向量/检索';
      if (k === 'function_call' || k === 'json_mode' || k === 'code') return '工具/结构化';
      return '其他';
    };

    const counts = new Map<string, number>();
    for (const c of capabilityChoices) {
      const cat = categoryOf(String(c.key));
      counts.set(cat, (counts.get(cat) || 0) + 1);
    }

    const cats = Array.from(counts.entries())
      .sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
      .map(([cat, n]) => ({ value: cat, label: `${cat} (${n})` }));
    return [{ value: 'all', label: `全部 (${capabilityChoices.length})` }, ...cats];
  }, [capabilityChoices]);

  const capabilityViewCounts = useMemo(() => {
    const all = capabilityChoices.length;
    const selected = modelSettingsCaps.length;
    const inferred = new Set(inferredModelSettingsCaps.map(String));
    const inferredCount = Array.from(inferred.values()).length;
    const unselected = Math.max(0, all - selected);
    return { all, selected, inferred: inferredCount, unselected };
  }, [capabilityChoices.length, inferredModelSettingsCaps, modelSettingsCaps.length]);

  const capGridCols = isCompact ? 3 : 5;
  const capGridRows = useMemo(() => {
    const rows: { key: string; cells: any[] }[] = [];
    for (let i = 0; i < filteredCapabilityChoices.length; i += capGridCols) {
      rows.push({ key: `r${i}`, cells: filteredCapabilityChoices.slice(i, i + capGridCols) as any[] });
    }
    return rows;
  }, [capGridCols, filteredCapabilityChoices]);

  const capGridColumns = useMemo(() => {
    const inferred = new Set(inferredModelSettingsCaps.map(String));
    return Array.from({ length: capGridCols }).map((_, idx) => ({
      key: `c${idx}`,
      render: (_v: any, rec: any) => {
        const cap = (rec?.cells || [])[idx];
        if (!cap) return null;
        const capKey = String(cap.key);
        const on = modelSettingsCaps.includes(capKey);
        const hint = inferred.has(capKey) && !on;
        return (
          <div
            className={[styles.capPill, on ? styles.capPillOn : styles.capPillOff].filter(Boolean).join(' ')}
            style={capStyleVars(capKey)}
            role="button"
            tabIndex={0}
            onClick={() => toggleModelSettingsCap(capKey)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleModelSettingsCap(capKey);
              }
            }}
          >
            <Checkbox
              checked={on}
              onChange={() => toggleModelSettingsCap(capKey)}
              onClick={(e) => {
                try { (e as any).stopPropagation(); } catch {}
              }}
            />
            <span className={styles.capPillIcon} aria-label={capKey}><CapabilityIcon capKey={capKey} /></span>
            <span className={styles.capPillLabel}>{String(cap.label || cap.key)}</span>
            {hint ? <span className={styles.capPillHint}><BulbOutlined /> 推断</span> : null}
          </div>
        );
      }
    }));
  }, [capGridCols, inferredModelSettingsCaps, modelSettingsCaps, toggleModelSettingsCap]);

  const lobeIconChoices = useMemo(() => {
    if (!iconPickerOpen) return [] as string[];
    return makeLobeIconChoices(iconSearch);
  }, [iconPickerOpen, iconSearch, lobeIconLibReady]);

  useEffect(() => {
    if (!iconPickerOpen) return;
    if (LOBE_ICON_FULL_LIB) {
      if (!lobeIconLibReady) setLobeIconLibReady(true);
      return;
    }
    void ensureLobeIconsLoaded().then(() => {
      setLobeIconLibReady(true);
    });
  }, [iconPickerOpen, lobeIconLibReady]);

  useEffect(() => {
    if (LOBE_ICON_FULL_LIB) {
      if (!lobeIconLibReady) setLobeIconLibReady(true);
      return;
    }
    let canceled = false;
    const nav = navigator as any;
    const mem = typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null;
    const cores = typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null;
    const lowEnd = (mem != null && mem <= 4) || (cores != null && cores <= 4);
    if (lowEnd) return;

    const ric = (window as any).requestIdleCallback as undefined | ((cb: () => void) => number);
    const cic = (window as any).cancelIdleCallback as undefined | ((id: number) => void);
    const id = ric
      ? ric(() => {
        void ensureLobeIconsLoaded().then(() => {
          if (!canceled) setLobeIconLibReady(true);
        });
      })
      : window.setTimeout(() => {
        void ensureLobeIconsLoaded().then(() => {
          if (!canceled) setLobeIconLibReady(true);
        });
      }, 120);

    return () => {
      canceled = true;
      if (ric && cic) cic(id as any);
      else window.clearTimeout(id as any);
    };
  }, [lobeIconLibReady]);

  const openModelSettings = useCallback((providerId: string, modelId: string) => {
    setModelSettingsProviderId(providerId);
    setModelSettingsModelId(modelId);
    const ov = getModelOverride(providerId, modelId);
    setModelSettingsIcon((ov?.icon as any) || null);
    if (Array.isArray(ov?.caps)) {
      setModelSettingsCaps(ov!.caps!.map(String));
    } else {
      setModelSettingsCaps(safeInferModelCapabilities(modelId).map(c => String(c.key)));
    }
    setModelSettingsOpen(true);
  }, [getModelOverride]);

  const saveModelSettings = useCallback(async () => {
    try {
      const next = JSON.parse(JSON.stringify(localModelOverrides || {}));
      if (!next[modelSettingsProviderId] || typeof next[modelSettingsProviderId] !== 'object') {
        next[modelSettingsProviderId] = {};
      }

      const caps = modelSettingsCaps && modelSettingsCaps.length ? Array.from(new Set(modelSettingsCaps.map(String))) : [];
      const icon = modelSettingsIcon || null;

      if (!icon && caps.length === 0) {
        try {
          delete next[modelSettingsProviderId][modelSettingsModelId];
        } catch {
          // ignore
        }
      } else {
        next[modelSettingsProviderId][modelSettingsModelId] = {
          icon: icon || undefined,
          caps: caps.length ? caps : undefined,
        };
      }

      await saveLocalModelOverridesToFile(next);
      addToast('success', '已保存', '模型自定义已写入本地覆盖文件（.sentra/modelOverrides.local.json）');
      setModelSettingsOpen(false);
      setIconPickerOpen(false);
    } catch (e: any) {
      addToast('error', '保存失败', e?.message ? String(e.message) : String(e));
    }
  }, [addToast, localModelOverrides, modelSettingsCaps, modelSettingsIcon, modelSettingsModelId, modelSettingsProviderId, saveLocalModelOverridesToFile]);
  const llmActiveProfile = useMemo(() => {
    const profiles: LlmProfile[] = Array.isArray(llmModuleMapping?.profiles) ? llmModuleMapping.profiles : [];
    if (!profiles.length) return null;

    for (const p of profiles) {
      if (!p?.when || p.when.length === 0) return p;
      if (evalLlmConditions(p.when, llmVarsMap)) return p;
    }
    return profiles[0] || null;
  }, [llmModuleMapping, llmVarsMap]);

  const activeMcpPluginConfig = useMemo(() => {
    const ps = Array.isArray(configData?.plugins) ? configData!.plugins : [];
    return ps.find(p => p.name === mcpPluginName) || null;
  }, [configData?.plugins, mcpPluginName]);

  const mcpPluginDisplayName = useMemo(() => {
    const raw = (activeMcpPluginConfig as any)?.displayName ?? (activeMcpPluginConfig as any)?.title;
    return raw != null ? String(raw) : '';
  }, [activeMcpPluginConfig]);

  const mcpPluginOptions = useMemo(() => {
    const ps = Array.isArray(configData?.plugins) ? configData!.plugins : [];
    const opts = ps.map((p: any) => {
      const name = String(p?.name || '').trim();
      const label = name ? (getDisplayName(name) || name) : '';
      return { name, label };
    }).filter(o => o.name);
    opts.sort((a, b) => a.label.localeCompare(b.label));
    return opts;
  }, [configData?.plugins]);

  const activeMcpPluginVars = useMemo(() => {
    if (!mcpPluginName) return [];
    const draft = mcpPluginDrafts[mcpPluginName];
    if (Array.isArray(draft) && draft.length) return draft;
    return Array.isArray(activeMcpPluginConfig?.variables) ? activeMcpPluginConfig!.variables : [];
  }, [activeMcpPluginConfig, mcpPluginDrafts, mcpPluginName]);

  const mcpPluginVarsMap = useMemo(() => {
    const map = new Map<string, EnvVariable>();
    for (const v of activeMcpPluginVars) map.set(v.key, v);
    return map;
  }, [activeMcpPluginVars]);

  const updateMcpPluginVar = useCallback((key: string, value: string) => {
    if (!mcpPluginName) return;
    setMcpPluginDrafts(prev => {
      const cur = Array.isArray(prev[mcpPluginName]) ? prev[mcpPluginName] : (Array.isArray(activeMcpPluginConfig?.variables) ? activeMcpPluginConfig!.variables : []);
      const next = cur.map(v => ({ ...v }));
      const idx = next.findIndex(v => v.key === key);
      if (idx >= 0) next[idx] = { ...next[idx], value };
      else next.push({ key, value });
      return { ...prev, [mcpPluginName]: next };
    });
    setMcpPluginDirty(prev => ({ ...prev, [mcpPluginName]: true }));
  }, [activeMcpPluginConfig, mcpPluginName]);

  const saveMcpPlugin = useCallback(async () => {
    if (!mcpPluginName) return;
    const vars = mcpPluginDrafts[mcpPluginName];
    if (!Array.isArray(vars) || vars.length === 0) return;
    setMcpPluginSaving(true);
    try {
      await savePluginConfig(mcpPluginName, vars);
      addToast('success', '已保存', `sentra-mcp/plugins/${mcpPluginName} / .env`);
      setMcpPluginDirty(prev => ({ ...prev, [mcpPluginName]: false }));
      await loadConfigData();
    } catch (e: any) {
      addToast('error', '保存失败', e?.message ? String(e.message) : String(e));
    } finally {
      setMcpPluginSaving(false);
    }
  }, [addToast, loadConfigData, mcpPluginDrafts, mcpPluginName]);

  const mcpPluginItems = useMemo(() => {
    const vars = Array.isArray(activeMcpPluginVars) ? activeMcpPluginVars : [];
    const visible = mcpPluginShowAllVars ? vars : vars.filter(v => isMcpPluginLlmKey(v.key));

    const inferGroup = (k: string) => {
      const up = String(k || '').toUpperCase();
      const p = mcpPluginDisplayName || mcpPluginName;
      if (up.startsWith('PLUGIN_')) return `MCP 插件 / ${p} / 基础`;
      if (up.includes('VISION')) return `MCP 插件 / ${p} / Vision`;
      if (up.includes('BASE_URL') || up.includes('API_KEY') || up.endsWith('_MODEL') || up === 'MODEL') return `MCP 插件 / ${p} / LLM`;
      return `MCP 插件 / ${p} / 其他`;
    };

    const inferKind = (k: string, meta: EnvFieldMeta | null): LlmItemKind => {
      const up = String(k || '').toUpperCase();
      if (up.includes('BASE_URL')) return 'base_url';
      if (up.includes('API_KEY') || up.endsWith('_KEY') || up.endsWith('_TOKEN')) return 'api_key';
      if (up.endsWith('_MODEL') || up === 'MODEL') return 'model';
      if (meta?.type === 'boolean') return 'boolean';
      if (meta?.type === 'number') return 'number';
      if (meta?.type === 'enum') return 'enum';
      return 'text';
    };

    const items: LlmItem[] = [];
    for (const v of visible) {
      const key = String(v?.key || '').trim();
      if (!key) continue;
      const meta = parseEnvMeta(v?.comment);
      const kind = inferKind(key, meta);
      const item: LlmItem = { key, group: inferGroup(key), kind };
      if (kind === 'enum' && meta?.options?.length) item.options = meta.options;
      if (kind === 'model') {
        item.picker = 'model';
        item.modelScope = 'any';
      }
      items.push(item);
    }
    return items;
  }, [activeMcpPluginVars, isMcpPluginLlmKey, mcpPluginDisplayName, mcpPluginName, mcpPluginShowAllVars]);

  const fillMcpPluginSecretsFromActiveProvider = useCallback(() => {
    if (!activeProvider || !mcpPluginName) return;
    const baseUrl = normalizeBaseUrlV1(activeProvider.baseUrl);
    const apiKey = String(activeProvider.apiKey || '');
    if (!baseUrl && !apiKey) return;

    const vars = Array.isArray(activeMcpPluginVars) ? activeMcpPluginVars : [];
    const baseUrlKeys = vars
      .map(v => String(v?.key || '').trim())
      .filter(k => k && k.toUpperCase().includes('BASE_URL'));
    const apiKeyKeys = vars
      .map(v => String(v?.key || '').trim())
      .filter(k => {
        const up = k.toUpperCase();
        return up && (up.includes('API_KEY') || up.endsWith('_KEY') || up.endsWith('_TOKEN'));
      });
    if (baseUrlKeys.length === 0 && apiKeyKeys.length === 0) return;

    setMcpPluginDrafts(prev => {
      const cur = Array.isArray(prev[mcpPluginName])
        ? prev[mcpPluginName]
        : (Array.isArray(activeMcpPluginConfig?.variables) ? activeMcpPluginConfig!.variables : []);
      const map = new Map<string, EnvVariable>();
      for (const v of cur) map.set(v.key, { ...v });

      if (baseUrl) {
        for (const k of baseUrlKeys) {
          const v = map.get(k) || { key: k, value: '' };
          map.set(k, { ...v, value: baseUrl });
        }
      }
      if (apiKey) {
        for (const k of apiKeyKeys) {
          const v = map.get(k) || { key: k, value: '' };
          map.set(k, { ...v, value: apiKey });
        }
      }

      return { ...prev, [mcpPluginName]: Array.from(map.values()) };
    });
    setMcpPluginDirty(prev => ({ ...prev, [mcpPluginName]: true }));
  }, [activeMcpPluginConfig, activeMcpPluginVars, activeProvider, mcpPluginName]);

  const mcpPluginGroupedItems = useMemo(() => {
    const visibleItems = mcpPluginItems.slice().sort((a, b) => {
      const g = a.group.localeCompare(b.group);
      if (g !== 0) return g;
      return llmKindPriority(a.kind) - llmKindPriority(b.kind);
    });
    const groups = new Map<string, LlmItem[]>();
    for (const it of visibleItems) {
      if (!groups.has(it.group)) groups.set(it.group, []);
      groups.get(it.group)!.push(it);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [mcpPluginItems]);

  const llmVisibleItems = useMemo(() => {
    const items: LlmItem[] = Array.isArray(llmActiveProfile?.items) ? llmActiveProfile!.items : [];
    return items
      .filter(it => showAdvancedLlm || !it.advanced)
      .slice()
      .sort((a, b) => {
        const og = envGroupOrder(a.group) - envGroupOrder(b.group);
        if (og !== 0) return og;
        const ok = llmKindPriority(a.kind) - llmKindPriority(b.kind);
        if (ok !== 0) return ok;
        return a.key.localeCompare(b.key);
      });
  }, [llmActiveProfile, showAdvancedLlm]);

  const llmHasAdvancedItems = useMemo(() => {
    const items: LlmItem[] = Array.isArray(llmActiveProfile?.items) ? llmActiveProfile!.items : [];
    return items.some(it => !!it.advanced);
  }, [llmActiveProfile]);

  const llmGroupedItems = useMemo(() => {
    const groups = new Map<string, LlmItem[]>();
    for (const it of llmVisibleItems) {
      if (!groups.has(it.group)) groups.set(it.group, []);
      groups.get(it.group)!.push(it);
    }
    return Array.from(groups.entries()).sort((a, b) => envGroupOrder(a[0]) - envGroupOrder(b[0]));
  }, [llmVisibleItems]);

  const collapseAllLlmGroups = useCallback(() => {
    setLlmGroupCollapsed(prev => {
      const next = { ...prev };
      for (const [g] of llmGroupedItems) {
        const k = `${llmModule}:${g}`;
        next[k] = true;
      }
      return next;
    });
  }, [llmGroupedItems, llmModule]);

  const expandAllLlmGroups = useCallback(() => {
    setLlmGroupCollapsed(prev => {
      const next = { ...prev };
      for (const [g] of llmGroupedItems) {
        const k = `${llmModule}:${g}`;
        next[k] = false;
      }
      return next;
    });
  }, [llmGroupedItems, llmModule]);

  const collapseAllMcpPluginGroups = useCallback(() => {
    if (!mcpPluginName) return;
    setMcpPluginGroupCollapsed(prev => {
      const next = { ...prev };
      for (const [g] of mcpPluginGroupedItems) {
        const k = `plugin:${mcpPluginName}:${g}`;
        next[k] = true;
      }
      return next;
    });
  }, [mcpPluginGroupedItems, mcpPluginName]);

  const expandAllMcpPluginGroups = useCallback(() => {
    if (!mcpPluginName) return;
    setMcpPluginGroupCollapsed(prev => {
      const next = { ...prev };
      for (const [g] of mcpPluginGroupedItems) {
        const k = `plugin:${mcpPluginName}:${g}`;
        next[k] = false;
      }
      return next;
    });
  }, [mcpPluginGroupedItems, mcpPluginName]);

  const updateLlmVar = useCallback((key: string, value: string) => {
    setLlmDrafts(prev => {
      const cur = Array.isArray(prev[llmModule]) ? prev[llmModule] : (Array.isArray(llmModuleConfig?.variables) ? llmModuleConfig!.variables : []);
      const next = cur.map(v => ({ ...v }));
      const idx = next.findIndex(v => v.key === key);
      if (idx >= 0) next[idx] = { ...next[idx], value };
      else next.push({ key, value });
      return { ...prev, [llmModule]: next };
    });
    setLlmDirty(prev => ({ ...prev, [llmModule]: true }));
  }, [llmModule, llmModuleConfig]);

  const quickFillGroupFromProvider = useCallback((group: string) => {
    if (!activeProvider) {
      addToast('error', '未选择供应商', '请先在左侧选择一个供应商');
      return;
    }

    const baseUrl = normalizeBaseUrlV1(activeProvider.baseUrl);
    const apiKey = String(activeProvider.apiKey || '').trim();
    if (!baseUrl && !apiKey) {
      addToast('error', '供应商未配置', '请先配置 BaseURL / API Key');
      return;
    }

    const items: LlmItem[] = Array.isArray(llmActiveProfile?.items) ? llmActiveProfile!.items : [];
    const targets = items.filter(it => it.group === group && (it.kind === 'base_url' || it.kind === 'api_key'));
    if (targets.length === 0) {
      addToast('error', '该分组无可配置项');
      return;
    }

    setLlmDrafts(prev => {
      const cur = Array.isArray(prev[llmModule]) ? prev[llmModule] : (Array.isArray(llmModuleConfig?.variables) ? llmModuleConfig!.variables : []);
      const map = new Map<string, EnvVariable>();
      for (const v of cur) map.set(v.key, { ...v });

      for (const it of targets) {
        if (it.kind === 'base_url' && baseUrl) {
          const v = map.get(it.key) || { key: it.key, value: '' };
          map.set(it.key, { ...v, value: baseUrl });
        }
        if (it.kind === 'api_key' && apiKey) {
          const v = map.get(it.key) || { key: it.key, value: '' };
          map.set(it.key, { ...v, value: apiKey });
        }
      }

      return { ...prev, [llmModule]: Array.from(map.values()) };
    });
    setLlmDirty(prev => ({ ...prev, [llmModule]: true }));
  }, [activeProvider, addToast, llmActiveProfile, llmModule, llmModuleConfig]);

  const fillLlmSecretsFromActiveProvider = useCallback(() => {
    if (!activeProvider) return;
    const baseUrl = normalizeBaseUrlV1(activeProvider.baseUrl);
    const apiKey = String(activeProvider.apiKey || '');
    if (!baseUrl && !apiKey) return;

    const items: LlmItem[] = Array.isArray(llmActiveProfile?.items) ? llmActiveProfile!.items : [];
    const baseUrlKeys = items.filter(it => it.kind === 'base_url').map(it => it.key);
    const apiKeyKeys = items.filter(it => it.kind === 'api_key').map(it => it.key);

    setLlmDrafts(prev => {
      const cur = Array.isArray(prev[llmModule]) ? prev[llmModule] : (Array.isArray(llmModuleConfig?.variables) ? llmModuleConfig!.variables : []);
      const map = new Map<string, EnvVariable>();
      for (const v of cur) map.set(v.key, { ...v });

      if (baseUrl) {
        for (const k of baseUrlKeys) {
          const v = map.get(k) || { key: k, value: '' };
          map.set(k, { ...v, value: baseUrl });
        }
      }

      if (apiKey) {
        for (const k of apiKeyKeys) {
          const v = map.get(k) || { key: k, value: '' };
          map.set(k, { ...v, value: apiKey });
        }
      }

      const next = Array.from(map.values());
      return { ...prev, [llmModule]: next };
    });
    setLlmDirty(prev => ({ ...prev, [llmModule]: true }));
  }, [activeProvider, llmActiveProfile, llmModule, llmModuleConfig]);

  const saveLlmModule = useCallback(async () => {
    const vars = llmDrafts[llmModule];
    if (!Array.isArray(vars) || vars.length === 0) return;
    setLlmSaving(true);
    try {
      await saveModuleConfig(llmModule, vars);
      addToast('success', '已保存', `${llmModule} / .env`);
      setLlmDirty(prev => ({ ...prev, [llmModule]: false }));
      await loadConfigData();
    } catch (e: any) {
      addToast('error', '保存失败', e?.message ? String(e.message) : String(e));
    } finally {
      setLlmSaving(false);
    }
  }, [addToast, llmDrafts, llmModule, loadConfigData]);

  const filteredModels = useMemo(() => {
    const term = modelSearch.trim().toLowerCase();
    if (!term) return activeModels;
    return activeModels.filter(m => {
      const id = (m?.id != null ? String(m.id) : '').toLowerCase();
      const owned = (m?.owned_by != null ? String(m.owned_by) : '').toLowerCase();
      return id.includes(term) || owned.includes(term);
    });
  }, [activeModels, modelSearch]);

  const groupedModels = useMemo(() => {
    const fallback = providerTypeFallbackVendor(activeProviderType);
    const groups = new Map<string, { vendor: ModelVendor; models: any[] }>();

    for (const m of filteredModels) {
      const vendor = safeInferModelVendor(m, fallback);
      const key = vendor.key || vendor.label || 'models';
      if (!groups.has(key)) groups.set(key, { vendor, models: [] });
      groups.get(key)!.models.push(m);
    }

    return Array.from(groups.values()).sort((a, b) => a.vendor.label.localeCompare(b.vendor.label));
  }, [activeProviderType, filteredModels]);

  const expandedVendorKeys = useMemo(() => {
    const keys = groupedModels.map(g => String(g.vendor.key || g.vendor.label || 'models'));
    // When searching, auto-expand matched groups (groupedModels is already filtered by search).
    if (String(modelSearch || '').trim()) return keys;
    // Default: treat undefined as collapsed.
    return keys.filter(k => collapsedGroups[k] === false);
  }, [groupedModels, collapsedGroups, modelSearch]);

  const formatModelTitle = (m: any) => {
    const id = m?.id != null ? String(m.id) : '';
    const owned = m?.owned_by != null ? String(m.owned_by) : '';
    if (id && owned) return `${id} (${owned})`;
    return id || owned || safeStringify(m);
  };

  useEffect(() => {
    if (!isCompact) return;
    if (activeProvider) setMobilePane('detail');
    else setMobilePane('list');
  }, [isCompact, activeId]);

  useEffect(() => {
    if (!isCompact) return;
    setMobileSection('provider');
  }, [isCompact, activeId]);

  return (
    <div className={[styles.root, isCompact ? styles.mobileRoot : ''].filter(Boolean).join(' ')}>
      <div className={[styles.sidebar, (isCompact && mobilePane === 'detail') ? styles.mobileHidden : ''].filter(Boolean).join(' ')}>
        <div className={styles.sidebarHeader}>
          <div className={styles.sidebarTitle}>供应商</div>
        </div>

        <div className={styles.providerSearchRow}>
          <Input
            className={styles.providerSearchInput}
            value={providerSearch}
            onChange={(e) => setProviderSearch(e.target.value)}
            placeholder="搜索供应商 / Base URL"
            allowClear
            prefix={<SearchOutlined />}
            size="small"
          />
        </div>

        <div className={styles.providerListScroll}>
          <List
            className={styles.providerListAntd}
            dataSource={filteredProviders}
            split={false}
            locale={{
              emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无供应商" />,
            }}
            renderItem={(p) => {
              const active = p.id === activeId;
              const tooltipTitle = (
                <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                  <div style={{ fontWeight: 650 }}>{p.name || '未命名'}</div>
                  <div style={{ opacity: 0.85 }}>{p.baseUrl || '未配置 Base URL'}</div>
                </div>
              );

              return (
                <List.Item
                  className={[styles.providerListItem, active ? styles.providerListItemActive : ''].filter(Boolean).join(' ')}
                  onClick={() => {
                    setActiveId(p.id);
                    if (isCompact) setMobilePane('detail');
                  }}
                >
                  <div className={styles.providerListItemInner}>
                    <div className={styles.providerMain}>
                      <div className={styles.logoRound}>
                        {p.icon ? (
                          <CustomIcon icon={p.icon as any} size={18} />
                        ) : (
                          <ProviderLogo type={p.type} />
                        )}
                      </div>

                      <div className={styles.providerText}>
                        <Typography.Text
                          className={styles.providerNameText}
                          ellipsis={{ tooltip: tooltipTitle }}
                        >
                          {p.name || '未命名'}
                        </Typography.Text>
                      </div>
                    </div>

                    <div className={styles.providerRowActions}>
                      <Switch
                        size="small"
                        checked={p.enabled}
                        onChange={(next) => setProviders(prev => prev.map(x => x.id === p.id ? { ...x, enabled: next } : x))}
                        onClick={(_checked, e) => {
                          try { (e as any)?.stopPropagation?.(); } catch {}
                        }}
                      />
                      <Button
                        size="small"
                        type="text"
                        icon={<SyncOutlined />}
                        loading={busy && busyProviderId === p.id}
                        disabled={busy && busyProviderId !== p.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          void runTestModelsForProvider(p.id);
                        }}
                        title="刷新"
                      />
                      <Button
                        size="small"
                        type="text"
                        icon={<SettingOutlined />}
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditProvider(p.id);
                        }}
                        title="编辑供应商"
                      />
                      <Popconfirm
                        title="删除供应商"
                        description={(
                          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                            <div>确定删除供应商「{p.name || '未命名'}」？</div>
                            <div style={{ marginTop: 6 }}>此操作会同时清空该供应商的模型缓存。</div>
                          </div>
                        )}
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => removeProvider(p.id)}
                      >
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          onClick={(e) => e.stopPropagation()}
                          title="删除供应商"
                        />
                      </Popconfirm>
                    </div>
                  </div>
                </List.Item>
              );
            }}
          />
        </div>

        <div className={styles.addBar}>
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openAddProvider} block>
            添加供应商
          </Button>
        </div>
      </div>

      <div className={[styles.right, isCompact ? styles.rightMobile : '', (isCompact && mobilePane === 'list') ? styles.mobileHidden : ''].filter(Boolean).join(' ')} ref={rightRef}>
        {isCompact ? (
          <div className={styles.mobileBackRow}>
            <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => setMobilePane('list')}>
              供应商
            </Button>
            <div className={styles.mobileBackTitle}>{activeProvider?.name || '模型供应商'}</div>
          </div>
        ) : null}

        {isCompact && activeProvider ? (
          <div className={styles.mobileTopPanel}>
            <Segmented
              size="middle"
              block
              value={mobileSection}
              className={styles.mobileSectionSegmented}
              options={[
                {
                  label: (
                    <span className={styles.mobileSectionLabel}>
                      <ShopOutlined />
                      <span>供应商</span>
                    </span>
                  ),
                  value: 'provider',
                },
                {
                  label: (
                    <span className={styles.mobileSectionLabel}>
                      <SettingOutlined />
                      <span>配置中心</span>
                    </span>
                  ),
                  value: 'config',
                },
                {
                  label: (
                    <span className={styles.mobileSectionLabel}>
                      <UnorderedListOutlined />
                      <span>模型</span>
                    </span>
                  ),
                  value: 'models',
                },
              ]}
              onChange={(v) => setMobileSection(v as any)}
            />

            <div className={styles.mobileProviderActions}>
              <Space size={8} wrap align="center">
                <Space size={6} align="center">
                  <Switch checked={activeProvider.enabled} onChange={(next) => updateActive({ enabled: next })} size="small" />
                  <span style={{ fontSize: 12, fontWeight: 800, opacity: 0.85 }}>启用</span>
                </Space>

                <Button
                  onClick={() => openEditProvider(activeProvider.id)}
                  icon={<SettingOutlined />}
                  size="small"
                >
                  编辑
                </Button>

                <Popconfirm
                  title="删除供应商"
                  description={(
                    <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                      <div>确定删除供应商「{activeProvider.name || '未命名'}」？</div>
                      <div style={{ marginTop: 6 }}>此操作会同时清空该供应商的模型缓存。</div>
                    </div>
                  )}
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => removeProvider(activeProvider.id)}
                >
                  <Button danger icon={<DeleteOutlined />} size="small">删除</Button>
                </Popconfirm>
              </Space>
            </div>
          </div>
        ) : null}
        {!activeProvider ? (
          <div className={styles.emptyState}>
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先新增或选择一个供应商" />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: isCompact ? 12 : 16, width: '100%' }}>
            {!isCompact ? (
              <div className={styles.header}>
                <div>
                  <div className={styles.headerTitle}>模型供应商管理</div>
                  <div className={styles.headerSub}>统一管理供应商、连接信息与模型列表</div>
                </div>
                <div className={styles.toolbar}>
                  <Space size={8} wrap align="center">
                    <Space size={6} align="center">
                      <Switch checked={activeProvider.enabled} onChange={(next) => updateActive({ enabled: next })} size="small" />
                      <span style={{ fontSize: 12, fontWeight: 800, opacity: 0.85 }}>启用</span>
                    </Space>

                    <Button
                      onClick={() => openEditProvider(activeProvider.id)}
                      icon={<SettingOutlined />}
                      size="small"
                    >
                      编辑
                    </Button>

                    <Popconfirm
                      title="删除供应商"
                      description={(
                        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
                          <div>确定删除供应商「{activeProvider.name || '未命名'}」？</div>
                          <div style={{ marginTop: 6 }}>此操作会同时清空该供应商的模型缓存。</div>
                        </div>
                      )}
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => removeProvider(activeProvider.id)}
                    >
                      <Button danger icon={<DeleteOutlined />} size="small">删除</Button>
                    </Popconfirm>
                  </Space>
                </div>
              </div>
            ) : null}

            {(!isCompact || mobileSection === 'provider') ? (
            <div className={styles.card}>
              <div className={styles.cardTitleRow}>
                <div className={styles.cardTitle}>供应商设置</div>
                <div className={styles.cardMeta}>用于连接与鉴权</div>
              </div>

              <div className={styles.formGridSingle}>
                <div className={styles.field}>
                  <div className={styles.fieldLabel}>API 密钥</div>
                  <Input.Password
                    className={styles.antdInput}
                    value={activeProvider.apiKey}
                    onChange={(e) => updateActive({ apiKey: e.target.value })}
                    placeholder="sk-..."
                    visibilityToggle
                  />
                </div>

                <div className={styles.field}>
                  <div className={styles.fieldLabel}>API 地址</div>
                  <Input
                    className={styles.antdInput}
                    value={activeProvider.baseUrl}
                    onChange={(e) => updateActive({ baseUrl: e.target.value })}
                    onBlur={(e) => updateActive({ baseUrl: normalizeBaseUrlV1(e.target.value) })}
                    placeholder="https://api.openai.com"
                  />
                </div>
              </div>
            </div>
            ) : null}

            {(!isCompact || mobileSection === 'models') ? (
            <div className={styles.card}>
              <div className={styles.modelsHeader}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Button
                      size="small"
                      type="text"
                      icon={modelsCollapsed ? <RightOutlined /> : <DownOutlined />}
                      onClick={() => {
                        setModelsCollapsed(prev => {
                          const next = !prev;
                          try { localStorage.setItem(MODELS_COLLAPSE_KEY, next ? '1' : '0'); } catch {}
                          return next;
                        });
                      }}
                      aria-label={modelsCollapsed ? '展开模型列表' : '折叠模型列表'}
                      title={modelsCollapsed ? '展开' : '折叠'}
                    />
                    <div className={styles.cardTitle}>模型</div>
                    <span className={styles.badgeOff}>{filteredModels.length}</span>
                  </div>
                  <div className={styles.cardMeta}>
                    {activeModelsEntry?.fetchedAt ? `更新时间：${new Date(activeModelsEntry.fetchedAt).toLocaleString()}` : '尚未获取（点击右侧刷新）'}
                  </div>
                </div>
                <div className={[styles.modelsHeaderActions, isCompact ? styles.modelsHeaderActionsMobile : ''].filter(Boolean).join(' ')}>
                  <Button
                    type="primary"
                    icon={<ReloadOutlined />}
                    onClick={runTestModels}
                    loading={busy}
                    size="small"
                    block={isCompact}
                  >
                    {busy ? '刷新中...' : '刷新'}
                  </Button>

                  <Input
                    className={[styles.antdInput, styles.modelsSearch].filter(Boolean).join(' ')}
                    value={modelSearch}
                    onChange={(e) => setModelSearch(e.target.value)}
                    placeholder="搜索模型id或供应商"
                    allowClear
                    prefix={<SearchOutlined />}
                    size="small"
                  />
                </div>
              </div>

              {!modelsCollapsed ? (
                <div className={styles.modelsBodyScroll}>
                  {filteredModels.length === 0 ? (
                    <>
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模型数据，点击“刷新”获取" />
                    </>
                  ) : (
                    <BrandLogoErrorBoundary
                      resetKey={`models:${activeProvider?.id || ''}:${activeModelsEntry?.fetchedAt || 0}`}
                      fallback={<div className={styles.errorBox}>模型列表渲染失败，请重新刷新或切换供应商。</div>}
                    >
                      <Collapse
                        className={styles.modelsCollapse}
                        size="small"
                        destroyOnHidden
                        activeKey={expandedVendorKeys}
                        onChange={(keys) => {
                          const arr = Array.isArray(keys) ? keys.map(String) : [String(keys || '')].filter(Boolean);
                          setCollapsedGroups(prev => {
                            const next: Record<string, boolean> = { ...prev };
                            const allKeys = groupedModels.map(g => String(g.vendor.key || g.vendor.label || 'models'));
                            for (const k of allKeys) {
                              next[k] = !arr.includes(k);
                            }
                            return next;
                          });
                        }}
                        items={groupedModels.map(({ vendor, models: ms }) => {
                          const key = String(vendor.key || vendor.label || 'models');
                          const expanded = expandedVendorKeys.includes(key);
                          return {
                            key,
                            label: (
                              <div className={styles.modelGroupHeaderAntd}>
                                <div className={styles.groupHeaderLeft}>
                                  <span className={styles.logoRound} style={{ width: 22, height: 22 }}>
                                    <BrandLogo iconName={vendor.iconName} size={16} />
                                  </span>
                                  <span className={styles.vendorLabel}>{vendor.label}</span>
                                  <span className={styles.badgeOff}>{ms.length}</span>
                                </div>
                              </div>
                            ),
                            children: expanded ? (
                              <Table
                                className={styles.modelAntdList}
                                dataSource={ms}
                                rowKey={(m) => {
                                  const rawId = (m as any)?.id ?? (m as any)?.model ?? (m as any)?.name;
                                  const id = rawId != null ? String(rawId).trim() : '';
                                  return id ? id : formatModelTitle(m);
                                }}
                                pagination={false}
                                size="small"
                                showHeader={false}
                                columns={[
                                  {
                                    key: 'row',
                                    render: (_: any, m: any) => {
                                      if (!activeProvider) return null;
                                      const inferred = safeInferModelVendor(m, providerTypeFallbackVendor(activeProviderType));
                                      const title = m?.id != null ? String(m.id) : formatModelTitle(m);
                                      const override = getModelOverride(activeProvider.id, title);
                                      const caps = (override?.caps && override.caps.length)
                                        ? override.caps.map((k: string) => ({ key: k, label: k }))
                                        : safeInferModelCapabilities(title);

                                      return (
                                        <div className={styles.modelRow}>
                                          <div className={styles.modelRowMeta}>
                                            <div className={styles.logoRound}>
                                              {override?.icon ? (
                                                <CustomIcon icon={override.icon as any} size={18} />
                                              ) : (
                                                <BrandLogo iconName={inferred.iconName} size={18} />
                                              )}
                                            </div>
                                            <div style={{ minWidth: 0 }}>
                                              <div className={styles.modelTitle}>{title}</div>
                                              <div className={styles.modelCaps}>
                                                {caps.map((cap: any) => (
                                                  <Tooltip key={cap.key} title={cap.label}>
                                                    <span
                                                      className={styles.modelCapIcon}
                                                      style={capStyleVars(cap.key)}
                                                      aria-label={cap.key}
                                                    >
                                                      <CapabilityIcon capKey={cap.key} />
                                                    </span>
                                                  </Tooltip>
                                                ))}
                                              </div>
                                            </div>
                                          </div>

                                          <div className={styles.modelRowActions}>
                                            <Button
                                              key="settings"
                                              size="small"
                                              type="text"
                                              icon={<SettingOutlined />}
                                              onClick={() => openModelSettings(activeProvider.id, title)}
                                            />
                                            <Button
                                              key="copy"
                                              size="small"
                                              type="text"
                                              icon={<CopyOutlined />}
                                              onClick={(e) => {
                                                try { (e as any)?.stopPropagation?.(); } catch {}
                                                navigator.clipboard?.writeText(String(title || ''))
                                                  .then(() => addToast('success', '已复制', String(title || '')))
                                                  .catch((err) => addToast('error', '复制失败', String((err as any)?.message || err)));
                                              }}
                                            />
                                          </div>
                                        </div>
                                      );
                                    },
                                  },
                                ]}
                              />
                            ) : null,
                          };
                        })}
                      />
                    </BrandLogoErrorBoundary>
                  )}
                </div>
              ) : null}
            </div>
            ) : null}

            {(!isCompact || mobileSection === 'config') ? (
            <div className={styles.card}>
              <div className={styles.cardTitleRow}>
                <div style={{ minWidth: 0 }}>
                  <Typography.Title level={5} style={{ margin: 0, fontSize: 14 }}>
                    LLM 配置中心
                  </Typography.Title>
                  <Descriptions size="small" column={1} colon={false} style={{ marginTop: 6 }}>
                    <Descriptions.Item label="说明">
                      {configLoading
                        ? '加载配置中...'
                        : (llmTab === 'mcp-plugins'
                          ? '配置 sentra-mcp/plugins 本地插件环境变量'
                          : (llmMappingLoading ? '加载映射中...' : '按模块编辑所有 LLM 相关环境变量'))}
                    </Descriptions.Item>
                    <Descriptions.Item label="目标">
                      {llmTab === 'mcp-plugins' ? 'sentra-mcp/plugins' : String(llmModule || '')}
                    </Descriptions.Item>
                    <Descriptions.Item label="状态">
                      <Space size={6} wrap>
                        <Tag color={configLoading ? 'processing' : 'success'}>{configLoading ? '配置加载中' : '配置就绪'}</Tag>
                        {llmTab === 'mcp-plugins'
                          ? null
                          : <Tag color={llmMappingLoading ? 'processing' : 'default'}>{llmMappingLoading ? '映射加载中' : '映射就绪'}</Tag>}
                      </Space>
                    </Descriptions.Item>
                  </Descriptions>
                </div>
                <div className={styles.llmTopRight}>
                  <Tabs
                    size="small"
                    activeKey={String(llmTab)}
                    className={styles.llmTabsAntd}
                    onChange={(k) => {
                      const next = k as LlmConfigTabName;
                      setLlmTab(next);
                      if (next !== 'mcp-plugins') setLlmModule(next);
                    }}
                    items={LLM_TABS.map(m => ({ key: m.name, label: m.label }))}
                  />
                </div>
              </div>

              <div className={styles.llmToolbar}>
                <div className={styles.llmToolbarLeft}>
                  <Button
                    size="small"
                    icon={<ReloadOutlined />}
                    onClick={loadConfigData}
                    disabled={configLoading || llmSaving || mcpPluginSaving}
                    title="重新加载配置"
                  >
                    刷新
                  </Button>

                  {llmTab === 'mcp-plugins' ? (
                    <>
                      <Button
                        size="small"
                        onClick={() => setMcpPluginShowAllVars(s => !s)}
                        disabled={mcpPluginSaving}
                      >
                        {mcpPluginShowAllVars ? '仅显示 LLM 字段' : '显示全部字段'}
                      </Button>

                      <Tooltip title="一键把当前供应商的 BaseURL(/v1) / API Key 填入插件内所有 *_BASE_URL/*_API_KEY 字段">
                        <Button
                          size="small"
                          icon={<ThunderboltOutlined />}
                          onClick={fillMcpPluginSecretsFromActiveProvider}
                          disabled={!activeProvider || mcpPluginSaving || !mcpPluginName}
                        >
                          一键配置
                        </Button>
                      </Tooltip>

                      <Select
                        className={styles.antdSelect}
                        size="small"
                        value={mcpPluginName || undefined}
                        onChange={(v) => setMcpPluginName(String(v || ''))}
                        options={mcpPluginOptions.map((o) => ({ value: o.name, label: o.label }))}
                        showSearch={{ optionFilterProp: 'label' }}
                        allowClear
                        placeholder="选择 MCP 插件"
                        disabled={mcpPluginSaving}
                        notFoundContent={selectNotFound}
                        styles={selectPopupStyles}
                        popupMatchSelectWidth={false}
                        style={{ width: 220, maxWidth: '100%' }}
                      />
                    </>
                  ) : (
                    <Tooltip title="一键把当前供应商的 BaseURL(/v1) / API Key 填入本模块支持的 BaseURL/API_KEY 字段">
                      <Button
                        size="small"
                        icon={<ThunderboltOutlined />}
                        onClick={fillLlmSecretsFromActiveProvider}
                        disabled={!activeProvider || llmSaving}
                      >
                        一键配置
                      </Button>
                    </Tooltip>
                  )}

                  <Button
                    size="small"
                    icon={showSecretsInEnv ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                    onClick={() => setShowSecretsInEnv(s => !s)}
                    disabled={llmSaving || mcpPluginSaving}
                  >
                    {showSecretsInEnv ? '隐藏密钥' : '显示密钥'}
                  </Button>

                  {(String(llmTab) !== 'mcp-plugins' && llmHasAdvancedItems) ? (
                    <Tooltip title="显示/隐藏 JSON 映射中标记为 advanced 的参数">
                      <Button
                        size="small"
                        icon={<SlidersOutlined />}
                        type={showAdvancedLlm ? 'primary' : 'default'}
                        onClick={() => setShowAdvancedLlm(s => !s)}
                        disabled={llmSaving}
                        aria-label="高级参数"
                      >
                        {showAdvancedLlm ? '隐藏高级参数' : '高级参数'}
                      </Button>
                    </Tooltip>
                  ) : null}

                  {llmTab === 'mcp-plugins' ? (
                    <>
                      <Tooltip title="收起全部分组">
                        <Button
                          size="small"
                          onClick={collapseAllMcpPluginGroups}
                          disabled={!mcpPluginName || mcpPluginSaving}
                          aria-label="收起全部分组"
                        >
                          全部收起
                        </Button>
                      </Tooltip>
                      <Tooltip title="展开全部分组">
                        <Button
                          size="small"
                          onClick={expandAllMcpPluginGroups}
                          disabled={!mcpPluginName || mcpPluginSaving}
                          aria-label="展开全部分组"
                        >
                          全部展开
                        </Button>
                      </Tooltip>
                    </>
                  ) : (
                    <>
                      <Tooltip title="收起全部分组">
                        <Button
                          size="small"
                          onClick={collapseAllLlmGroups}
                          disabled={llmSaving || configLoading}
                          aria-label="收起全部分组"
                        >
                          全部收起
                        </Button>
                      </Tooltip>
                      <Tooltip title="展开全部分组">
                        <Button
                          size="small"
                          onClick={expandAllLlmGroups}
                          disabled={llmSaving || configLoading}
                          aria-label="展开全部分组"
                        >
                          全部展开
                        </Button>
                      </Tooltip>
                    </>
                  )}
                </div>
                <Tooltip title={llmTab === 'mcp-plugins' ? (mcpPluginName ? '保存' : '请选择插件') : '写入该模块 .env'}>
                  <Button
                    type="primary"
                    size="small"
                    icon={<SaveOutlined />}
                    onClick={llmTab === 'mcp-plugins' ? saveMcpPlugin : saveLlmModule}
                    loading={llmTab === 'mcp-plugins' ? mcpPluginSaving : llmSaving}
                    disabled={llmTab === 'mcp-plugins'
                      ? (!mcpPluginName || !mcpPluginDirty[mcpPluginName])
                      : (configLoading || !llmDirty[llmModule])}
                    aria-label="保存"
                  >
                    保存
                  </Button>
                </Tooltip>
              </div>

              {llmTab === 'mcp-plugins' ? (
                !mcpPluginName ? (
                  <div className={styles.cardMeta}>未选择插件。</div>
                ) : mcpPluginItems.length === 0 ? (
                  <div className={styles.cardMeta}>该插件暂无可配置项（可能没有 .env.example）。</div>
                ) : (
                  <BrandLogoErrorBoundary
                    resetKey={`mcpPlugin:${mcpPluginName}:${mcpPluginShowAllVars ? 'all' : 'llm'}`}
                    fallback={<div className={styles.errorBox}>插件配置渲染失败，请刷新或切换插件。</div>}
                  >
                    <div className={styles.llmGroups}>
                      {mcpPluginGroupedItems.map(([g, items]) => {
                        const k = `plugin:${mcpPluginName}:${g}`;
                        const collapsed = mcpPluginGroupCollapsed[k] !== false;
                        return (
                          <div className={styles.llmGroup} key={k}>
                            <div className={styles.llmGroupHeader}>
                              <div className={styles.llmGroupHeaderLeft}>
                                <div className={styles.llmGroupTitle}>{g}</div>
                                <span className={styles.badgeOff}>{items.length}</span>
                              </div>
                              <div className={styles.llmGroupHeaderRight}>
                                <Button
                                  size="small"
                                  type="text"
                                  icon={collapsed ? <RightOutlined /> : <DownOutlined />}
                                  onClick={() => setMcpPluginGroupCollapsed(prev => ({ ...prev, [k]: prev[k] === false ? true : false }))}
                                  aria-label={collapsed ? '展开' : '折叠'}
                                  title={collapsed ? '展开' : '折叠'}
                                />
                              </div>
                            </div>

                            {!collapsed ? (
                              <Table
                                className={styles.envListAntd}
                                dataSource={items}
                                rowKey={(r) => String((r as any).key || '')}
                                pagination={false}
                                size="small"
                                showHeader={false}
                                columns={[
                                  {
                                    key: 'row',
                                    render: (_: any, it: any) => {
                                      const v = mcpPluginVarsMap.get(it.key);
                                      const meta = parseEnvMeta(v?.comment);
                                      const desc = meta?.description || '';
                                      const displayName = String(v?.displayName ?? '').trim();
                                      const value = String(v?.value ?? '');
                                      const hasCnName = Boolean(displayName);
                                      const type: EnvValueType = (it.kind === 'boolean' ? 'boolean' : (it.kind === 'number' ? 'number' : (it.kind === 'enum' ? 'enum' : 'string')));
                                      const isSecret = isSensitiveKeyKind(it.kind, it.key);

                                      const kindTag = (() => {
                                        if (it.kind === 'api_key') return <Tag icon={<KeyOutlined />} color="red">密钥</Tag>;
                                        if (it.kind === 'base_url') return <Tag icon={<LinkOutlined />} color="blue">Base URL</Tag>;
                                        if (it.kind === 'boolean') return <Tag icon={<CheckOutlined />} color="green">开关</Tag>;
                                        if (it.kind === 'number') return <Tag icon={<NumberOutlined />} color="gold">数字</Tag>;
                                        if (it.kind === 'enum') return <Tag icon={<AppstoreOutlined />} color="purple">选项</Tag>;
                                        if (it.kind === 'model') return <Tag icon={<ApiOutlined />} color="cyan">模型</Tag>;
                                        return <Tag>文本</Tag>;
                                      })();

                                      const secretTag = isSecret ? <Tag icon={<LockOutlined />} color="volcano">敏感</Tag> : null;
                                      const requiredTag = /必填|required/i.test(desc) ? <Tag color="magenta">必填</Tag> : null;

                                      const control = (
                                        it.kind === 'boolean' ? (
                                          <Switch
                                            aria-label={it.key}
                                            checked={isTruthyString(value)}
                                            onChange={(next) => updateMcpPluginVar(it.key, next ? 'true' : 'false')}
                                            size="small"
                                          />
                                        ) : it.kind === 'enum' ? (
                                          <Select
                                            className={styles.antdSelect}
                                            value={value}
                                            onChange={(next) => updateMcpPluginVar(it.key, String(next ?? ''))}
                                            options={(Array.isArray(it.options) && it.options.length ? it.options : (Array.isArray(meta?.options) ? meta!.options! : [])).map((op: string) => ({ value: op, label: op }))}
                                            showSearch
                                            allowClear
                                            notFoundContent={selectNotFound}
                                            styles={selectPopupStyles}
                                            popupMatchSelectWidth={false}
                                          />
                                        ) : it.kind === 'model' ? (
                                          <Select
                                            className={styles.antdSelect}
                                            mode="tags"
                                            showSearch
                                            allowClear
                                            tokenSeparators={[',']}
                                            value={value ? [value] : []}
                                            placeholder={activeProvider ? (activeModelIds.length ? '选择/搜索模型（回车确认）' : '请先检测供应商模型') : '请先选择供应商'}
                                            options={(activeProvider ? activeModelIds
                                              .filter(id => modelInScope(id, inferModelScopeFromItem(it)))
                                              .filter(id => {
                                                const requireCaps = getPluginModelRequireCaps(mcpPluginName, it.key);
                                                return modelHasCaps(activeProvider.id, id, requireCaps);
                                              })
                                              .map(id => ({ value: id, label: id })) : [])}
                                            notFoundContent={selectNotFound}
                                            styles={selectPopupStyles}
                                            popupMatchSelectWidth={false}
                                            onChange={(vals) => {
                                              const list = Array.isArray(vals) ? vals.map(vx => String(vx || '').trim()).filter(Boolean) : [];
                                              const next = list.length ? list[list.length - 1] : '';
                                              updateMcpPluginVar(it.key, next);
                                            }}
                                          />
                                        ) : it.kind === 'text' && /whitelist/i.test(it.key) ? (
                                          <Select
                                            className={styles.antdSelect}
                                            mode="tags"
                                            showSearch
                                            allowClear
                                            tokenSeparators={[',']}
                                            value={parseMultiTextValue(value)}
                                            placeholder="输入多个值（回车/逗号）"
                                            notFoundContent={selectNotFound}
                                            styles={selectPopupStyles}
                                            popupMatchSelectWidth={false}
                                            onChange={(vals) => {
                                              const list = Array.isArray(vals) ? vals.map(vx => String(vx || '').trim()).filter(Boolean) : [];
                                              updateMcpPluginVar(it.key, formatMultiTextValue(list));
                                            }}
                                          />
                                        ) : it.kind === 'base_url' ? (
                                          <Input
                                            className={styles.antdInput}
                                            value={value}
                                            onChange={(e) => updateMcpPluginVar(it.key, e.target.value)}
                                            onBlur={(e) => updateMcpPluginVar(it.key, normalizeBaseUrlV1(e.target.value))}
                                            type="text"
                                            placeholder="https://.../v1"
                                          />
                                        ) : (
                                          <Input
                                            className={styles.antdInput}
                                            value={value}
                                            onChange={(e) => updateMcpPluginVar(it.key, e.target.value)}
                                            type={isSecret && !showSecretsInEnv ? 'password' : (type === 'number' ? 'number' : 'text')}
                                            placeholder={it.kind === 'api_key' ? 'sk-...' : undefined}
                                          />
                                        )
                                      );

                                      return (
                                        <div className={styles.envRow}>
                                          <div className={styles.envLeft}>
                                            <Tooltip
                                              trigger={isCompact ? ['click'] : ['hover']}
                                              placement="topLeft"
                                              title={(
                                                <div className={styles.tooltipKeyRow}>
                                                  <span className={styles.tooltipKeyText}>{it.key}</span>
                                                </div>
                                              )}
                                            >
                                              <div className={styles.envName}>{hasCnName ? displayName : '未提供中文名称'}</div>
                                            </Tooltip>
                                            {desc ? <div className={styles.envDesc}>{desc}</div> : null}
                                            <div className={styles.envMetaTags}>
                                              {requiredTag}
                                              {secretTag}
                                              {kindTag}
                                            </div>
                                          </div>
                                          <div className={styles.envRight}>{control}</div>
                                        </div>
                                      );
                                    },
                                  },
                                ]}
                              />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </BrandLogoErrorBoundary>
                )
              ) : (!llmModuleConfig ? (
                <div className={styles.cardMeta}>该模块未找到配置。</div>
              ) : !llmModuleMapping || !llmActiveProfile ? (
                <div className={styles.cardMeta}>该模块未配置 LLM 映射规则（请更新 llmEnvMapping.json）。</div>
              ) : llmVisibleItems.length === 0 ? (
                <div className={styles.cardMeta}>当前模式下没有可配置项（可能被条件规则隐藏）。</div>
              ) : (
                <div className={styles.llmGroups}>
                  {llmGroupedItems.map(([g, items]) => {
                    const k = `${llmModule}:${g}`;
                    const collapsed = llmGroupCollapsed[k] !== false;
                    return (
                      <div className={styles.llmGroup} key={k}>
                        <div className={styles.llmGroupHeader}>
                          <div className={styles.llmGroupHeaderLeft}>
                            <div className={styles.llmGroupTitle}>{g}</div>
                            <span className={styles.badgeOff}>{items.length}</span>
                          </div>
                          <div className={styles.llmGroupHeaderRight}>
                            <Tooltip title="一键配置该分组 BaseURL/Key">
                              <Button
                                size="small"
                                type="text"
                                icon={<ThunderboltOutlined />}
                                onClick={() => quickFillGroupFromProvider(g)}
                                disabled={llmSaving}
                              />
                            </Tooltip>

                            <Button
                              size="small"
                              type="text"
                              icon={collapsed ? <RightOutlined /> : <DownOutlined />}
                              onClick={() => setLlmGroupCollapsed(prev => ({ ...prev, [k]: prev[k] === false ? true : false }))}
                              aria-label={collapsed ? '展开' : '折叠'}
                              title={collapsed ? '展开' : '折叠'}
                            />
                          </div>
                        </div>

                        {!collapsed ? (
                          <Table
                            className={styles.envListAntd}
                            dataSource={items}
                            rowKey={(r) => String((r as any).key || '')}
                            pagination={false}
                            size="small"
                            showHeader={false}
                            columns={[
                              {
                                key: 'row',
                                render: (_: any, it: any) => {
                                  const v = llmVarsMap.get(it.key);
                                  const meta = parseEnvMeta(v?.comment);
                                  const desc = meta?.description || '';
                                  const displayName = String(v?.displayName ?? '').trim();
                                  const value = String(v?.value ?? '');
                                  const hasCnName = Boolean(displayName);
                                  const type: EnvValueType = (it.kind === 'boolean' ? 'boolean' : (it.kind === 'number' ? 'number' : (it.kind === 'enum' ? 'enum' : 'string')));
                                  const isSecret = isSensitiveKeyKind(it.kind, it.key);
                                  const isModelMultiCsv = it.kind === 'model' && it.picker === 'model' && it.multiple === true && it.valueFormat === 'csv';

                                  const kindTag = (() => {
                                    if (it.kind === 'api_key') return <Tag icon={<KeyOutlined />} color="red">密钥</Tag>;
                                    if (it.kind === 'base_url') return <Tag icon={<LinkOutlined />} color="blue">Base URL</Tag>;
                                    if (it.kind === 'boolean') return <Tag icon={<CheckOutlined />} color="green">开关</Tag>;
                                    if (it.kind === 'number') return <Tag icon={<NumberOutlined />} color="gold">数字</Tag>;
                                    if (it.kind === 'enum') return <Tag icon={<AppstoreOutlined />} color="purple">选项</Tag>;
                                    if (it.kind === 'model') return <Tag icon={<ApiOutlined />} color="cyan">模型</Tag>;
                                    return <Tag>文本</Tag>;
                                  })();

                                  const secretTag = isSecret ? <Tag icon={<LockOutlined />} color="volcano">敏感</Tag> : null;
                                  const requiredTag = /必填|required/i.test(desc) ? <Tag color="magenta">必填</Tag> : null;

                                  const control = (
                                    it.kind === 'boolean' ? (
                                      <Switch
                                        aria-label={it.key}
                                        checked={isTruthyString(value)}
                                        onChange={(next) => updateLlmVar(it.key, next ? 'true' : 'false')}
                                        size="small"
                                      />
                                    ) : it.kind === 'enum' ? (
                                      <Select
                                        className={styles.antdSelect}
                                        value={value}
                                        onChange={(next) => updateLlmVar(it.key, String(next ?? ''))}
                                        options={(Array.isArray(it.options) && it.options.length ? it.options : (Array.isArray(meta?.options) ? meta!.options! : [])).map((op: string) => ({ value: op, label: op }))}
                                        showSearch
                                        allowClear
                                        notFoundContent={selectNotFound}
                                        styles={selectPopupStyles}
                                        popupMatchSelectWidth={false}
                                      />
                                    ) : it.kind === 'model' ? (
                                      <Select
                                        className={styles.antdSelect}
                                        mode="tags"
                                        showSearch
                                        allowClear
                                        tokenSeparators={[',']}
                                        value={isModelMultiCsv ? parseCsvValue(value) : (value ? [value] : [])}
                                        placeholder={activeProvider ? (activeModelIds.length ? (isModelMultiCsv ? '选择/搜索多个模型（回车确认）' : '选择/搜索模型（回车确认）') : '请先检测供应商模型') : '请先选择供应商'}
                                        options={(activeProvider ? activeModelIds
                                          .filter(id => modelInScope(id, inferModelScopeFromItem(it)))
                                          .map(id => ({ value: id, label: id })) : [])}
                                        notFoundContent={selectNotFound}
                                        styles={selectPopupStyles}
                                        popupMatchSelectWidth={false}
                                        onChange={(vals) => {
                                          const list = Array.isArray(vals) ? vals.map(vx => String(vx || '').trim()).filter(Boolean) : [];
                                          if (isModelMultiCsv) {
                                            updateLlmVar(it.key, formatCsvValue(Array.from(new Set(list))));
                                            return;
                                          }
                                          const next = list.length ? list[list.length - 1] : '';
                                          updateLlmVar(it.key, next);
                                        }}
                                      />
                                    ) : it.kind === 'text' && /whitelist/i.test(it.key) ? (
                                      <Select
                                        className={styles.antdSelect}
                                        mode="tags"
                                        showSearch
                                        allowClear
                                        tokenSeparators={[',']}
                                        value={parseMultiTextValue(value)}
                                        placeholder="输入多个值（回车/逗号）"
                                        notFoundContent={selectNotFound}
                                        styles={selectPopupStyles}
                                        popupMatchSelectWidth={false}
                                        onChange={(vals) => {
                                          const list = Array.isArray(vals) ? vals.map(vx => String(vx || '').trim()).filter(Boolean) : [];
                                          updateLlmVar(it.key, formatMultiTextValue(list));
                                        }}
                                      />
                                    ) : it.kind === 'number' || type === 'number' ? (
                                      <InputNumber
                                        style={{ width: '100%' }}
                                        value={Number.isFinite(Number(value)) ? Number(value) : null}
                                        onChange={(next) => updateLlmVar(it.key, next == null ? '' : String(next))}
                                        placeholder="请输入数字"
                                      />
                                    ) : it.kind === 'api_key' ? (
                                      <Input
                                        className={styles.antdInput}
                                        value={value}
                                        onChange={(e) => updateLlmVar(it.key, e.target.value)}
                                        type={isSecret && !showSecretsInEnv ? 'password' : 'text'}
                                        placeholder="sk-..."
                                      />
                                    ) : it.kind === 'base_url' ? (
                                      <Input
                                        className={styles.antdInput}
                                        value={value}
                                        onChange={(e) => updateLlmVar(it.key, e.target.value)}
                                        onBlur={(e) => updateLlmVar(it.key, normalizeBaseUrlV1(e.target.value))}
                                        type="text"
                                        placeholder="https://.../v1"
                                      />
                                    ) : (
                                      <Input
                                        className={styles.antdInput}
                                        value={value}
                                        onChange={(e) => updateLlmVar(it.key, e.target.value)}
                                        type={isSecret && !showSecretsInEnv ? 'password' : 'text'}
                                      />
                                    )
                                  );

                                  return (
                                    <div className={styles.envRow}>
                                      <div className={styles.envLeft}>
                                        <Tooltip
                                          trigger={isCompact ? ['click'] : ['hover']}
                                          placement="topLeft"
                                          title={(
                                            <div className={styles.tooltipKeyRow}>
                                              <span className={styles.tooltipKeyText}>{it.key}</span>
                                            </div>
                                          )}
                                        >
                                          <div className={styles.envName}>{hasCnName ? displayName : '未提供中文名称'}</div>
                                        </Tooltip>
                                        {desc ? <div className={styles.envDesc}>{desc}</div> : null}
                                        <div className={styles.envMetaTags}>
                                          {requiredTag}
                                          {secretTag}
                                          {kindTag}
                                        </div>
                                      </div>
                                      <div className={styles.envRight}>{control}</div>
                                    </div>
                                  );
                                },
                              },
                            ]}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            ) : null}

            <Modal
              title="模型设置"
              open={modelSettingsOpen}
              onCancel={() => { setModelSettingsOpen(false); setIconPickerOpen(false); }}
              onOk={() => void saveModelSettings()}
              okText="保存"
              cancelText="取消"
              width={820}
              className={styles.modelSettingsModal}
              destroyOnHidden={false}
            >
              <div className={styles.modelSettingsHeaderRow}>
                <span className={styles.logoRound} style={{ width: 34, height: 34 }}>
                  {modelSettingsIcon ? (
                    <CustomIcon icon={modelSettingsIcon} size={20} />
                  ) : (
                    <BrandLogo iconName={safeInferModelVendor({ id: modelSettingsModelId }, providerTypeFallbackVendor(activeProviderType)).iconName} size={20} />
                  )}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div className={styles.modelSettingsModelId}>{modelSettingsModelId}</div>
                  <div className={styles.modelSettingsSub}>自定义图标与能力，将写入本地覆盖文件</div>
                </div>
              </div>

              <Tabs
                className={styles.modelSettingsTabs}
                items={[
                  {
                    key: 'appearance',
                    label: '外观',
                    children: (
                      <>
                        <div className={styles.modelSettingsActionsRow}>
                          <Tooltip title="选择图标（Lobe Icons）">
                            <Button
                              type="text"
                              size="small"
                              icon={<BgColorsOutlined />}
                              onClick={() => {
                                setIconPickerTarget('model');
                                setIconPickerOpen(true);
                              }}
                            />
                          </Tooltip>
                          <Upload
                            accept="image/*"
                            showUploadList={false}
                            beforeUpload={(file) => {
                              const f = file as any;
                              const reader = new FileReader();
                              reader.onload = () => {
                                const dataUrl = String(reader.result || '');
                                if (!dataUrl.startsWith('data:image/')) {
                                  addToast('error', '图片格式不支持');
                                  return;
                                }
                                setModelSettingsIcon({ type: 'upload', dataUrl });
                              };
                              reader.readAsDataURL(f);
                              return false;
                            }}
                          >
                            <Tooltip title="上传图片">
                              <Button type="text" size="small" icon={<UploadOutlined />} />
                            </Tooltip>
                          </Upload>
                          <Tooltip title="清除自定义图标">
                            <Button
                              type="text"
                              danger
                              size="small"
                              icon={<DeleteOutlined />}
                              onClick={() => setModelSettingsIcon(null)}
                            />
                          </Tooltip>
                        </div>
                      </>
                    )
                  },
                  {
                    key: 'caps',
                    label: '能力',
                    children: (
                      <>
                        <div className={styles.capSelectedBar}>
                          <div className={styles.capSelectedLeft}>
                            <div className={styles.capSelectedTitle}>已选能力</div>
                            <div className={styles.capSelectedCount}>{modelSettingsCaps.length}</div>
                          </div>
                          <div className={styles.capSelectedTags}>
                            {modelSettingsCaps.slice(0, 40).map((k) => (
                              <Tag
                                key={k}
                                closable
                                onClose={(e) => {
                                  e.preventDefault();
                                  toggleModelSettingsCap(k);
                                }}
                                className={styles.capSelectedTag}
                                style={capStyleVars(k)}
                              >
                                {capabilityLabelByKey.get(String(k)) || String(k)}
                              </Tag>
                            ))}
                          </div>
                        </div>

                        <div className={styles.modelSettingsCapToolbarAntd}>
                          <Input
                            className={styles.antdInput}
                            value={capabilitySearch}
                            onChange={(e) => setCapabilitySearch(e.target.value)}
                            placeholder="搜索能力，例如 vision / web / embedding"
                            allowClear
                            prefix={<SearchOutlined />}
                          />

                          <Select
                            className={styles.antdSelect}
                            value={capabilityCategory}
                            onChange={(v) => setCapabilityCategory(String(v || 'all'))}
                            options={capabilityCategoryOptions}
                            placeholder="按类别"
                            style={{ width: 160 }}
                          />
                          <Segmented
                            className={styles.capSegmented}
                            value={capabilityView}
                            onChange={(v) => setCapabilityView(String(v) as any)}
                            options={[
                              { label: `全部(${capabilityViewCounts.all})`, value: 'all' },
                              { label: `已选(${capabilityViewCounts.selected})`, value: 'selected' },
                              { label: `推断(${capabilityViewCounts.inferred})`, value: 'inferred' },
                              { label: `未选(${capabilityViewCounts.unselected})`, value: 'unselected' },
                            ]}
                          />
                          <div className={styles.modelSettingsCapToolbarBtns}>
                            <Button size="small" onClick={() => setModelSettingsCaps(inferredModelSettingsCaps)}>按推断</Button>
                            <Button size="small" onClick={() => setModelSettingsCaps(capabilityChoices.map(c => c.key))}>全选</Button>
                            <Button size="small" onClick={() => setModelSettingsCaps([])}>清空</Button>
                          </div>
                        </div>

                        <Table
                          className={styles.capGridTable}
                          size="small"
                          pagination={false}
                          showHeader={false}
                          tableLayout="fixed"
                          scroll={{ y: isCompact ? 360 : 420 }}
                          dataSource={capGridRows}
                          rowKey={(r) => String((r as any).key)}
                          columns={capGridColumns as any}
                        />
                      </>
                    )
                  }
                ]}
              />
            </Modal>

            <Modal
              title="选择图标（Lobe Icons）"
              open={iconPickerOpen}
              onCancel={() => setIconPickerOpen(false)}
              footer={null}
              width={760}
              className={styles.iconPickerModal}
            >
              <Input
                className={styles.antdInput}
                value={iconSearch}
                onChange={(e) => setIconSearch(e.target.value)}
                placeholder="搜索图标名，例如 OpenAI / Gemini / Qwen"
                allowClear
                prefix={<SearchOutlined />}
              />
              <div className={styles.iconGrid}>
                {!lobeIconLibReady ? (
                  <div className={styles.cardMeta} style={{ padding: 8 }}>加载图标库中...</div>
                ) : null}
                {lobeIconChoices.map((name) => (
                  <Button
                    key={name}
                    type="text"
                    size="small"
                    className={styles.iconGridBtn}
                    onClick={() => {
                      if (iconPickerTarget === 'provider') setProviderEditorIcon({ type: 'lobe', iconName: name });
                      else setModelSettingsIcon({ type: 'lobe', iconName: name });
                      setIconPickerOpen(false);
                    }}
                    title={name}
                  >
                    <BrandLogo iconName={name} size={20} />
                    <span className={styles.iconGridName}>{name}</span>
                  </Button>
                ))}
              </div>
            </Modal>
          </div>
        )}
      </div>

      <Modal
        title={providerEditorMode === 'add' ? '添加供应商' : '编辑供应商'}
        open={providerEditorOpen}
        onCancel={() => setProviderEditorOpen(false)}
        onOk={() => void saveProviderEditor()}
        okText="保存"
        cancelText="取消"
      >
        <Form
          form={providerEditorForm}
          layout="vertical"
          initialValues={{ enabled: true, apiKeyHeader: 'Authorization', apiKeyPrefix: 'Bearer ' }}
        >
          <Form.Item label="供应商图标" extra="可选：优先显示自定义图标（仅保存在浏览器本地）">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
              <span className={styles.logoRound} style={{ width: 34, height: 34 }}>
                {providerEditorIcon ? (
                  <CustomIcon icon={providerEditorIcon} size={20} />
                ) : (
                  <ProviderLogo type={String(providerEditorType || 'custom')} />
                )}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Tooltip title="选择图标（Lobe Icons）">
                  <Button
                    type="text"
                    size="small"
                    icon={<BgColorsOutlined />}
                    onClick={() => {
                      setIconPickerTarget('provider');
                      setIconPickerOpen(true);
                    }}
                  />
                </Tooltip>
                <Upload
                  accept="image/*"
                  showUploadList={false}
                  beforeUpload={(file) => {
                    const f = file as any;
                    const reader = new FileReader();
                    reader.onload = () => {
                      const dataUrl = String(reader.result || '');
                      if (!dataUrl.startsWith('data:image/')) {
                        addToast('error', '图片格式不支持');
                        return;
                      }
                      setProviderEditorIcon({ type: 'upload', dataUrl });
                    };
                    reader.readAsDataURL(f);
                    return false;
                  }}
                >
                  <Tooltip title="上传图片">
                    <Button type="text" size="small" icon={<UploadOutlined />} />
                  </Tooltip>
                </Upload>
                <Tooltip title="清除自定义图标">
                  <Button
                    type="text"
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    onClick={() => setProviderEditorIcon(null)}
                  />
                </Tooltip>
              </div>
            </div>
          </Form.Item>
          <Form.Item label="供应商名称" name="name" rules={[{ required: true, message: '请输入供应商名称' }]}>
            <Input placeholder="例如：OpenAI / Gemini / 自建服务" />
          </Form.Item>
          <Form.Item label="供应商类型" name="type" rules={[{ required: true, message: '请选择供应商类型' }]}>
            <Select
              options={providerTypeOptions}
              showSearch={{ optionFilterProp: 'label' }}
              placeholder="例如：openai / gemini / custom"
            />
          </Form.Item>
          <Form.Item label="是否启用" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item label="API 地址（Base URL）" name="baseUrl" extra="建议填写到域名根：例如 https://api.openai.com（会在需要时补全 /v1）">
            <Input placeholder="https://api.openai.com" />
          </Form.Item>
          <Form.Item label="API 密钥（API Key）" name="apiKey" extra="不会上传到服务器，仅保存在浏览器本地">
            <Input.Password placeholder="sk-..." visibilityToggle />
          </Form.Item>
          <Form.Item label="API Key 请求头（Header）" name="apiKeyHeader" extra="通常保持默认：Authorization">
            <Input placeholder="Authorization" />
          </Form.Item>
          <Form.Item label="API Key 前缀（Prefix）" name="apiKeyPrefix" extra="通常保持默认：Bearer（注意末尾空格）">
            <Input placeholder="Bearer " />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
