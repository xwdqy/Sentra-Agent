import { Component, type PropsWithChildren, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { v4 as uuidv4 } from 'uuid';
import { fetchConfigs, fetchFileContent, saveFileContent, saveModuleConfig, savePluginConfig } from '../../services/api.ts';
import { testProviderModels } from '../../services/llmProvidersApi.ts';
import type { ConfigData, EnvVariable } from '../../types/config.ts';
import type { ToastMessage } from '../Toast';
import { getDisplayName } from '../../utils/icons.tsx';
import styles from './ModelProvidersManager.module.css';
import modelVendorMap from './modelVendorMap.json';
import llmEnvMapping from './llmEnvMapping.json';
import * as LobeIcons from '@lobehub/icons';
import { IoAdd, IoBulbOutline, IoChatbubbleEllipsesOutline, IoChevronBack, IoChevronDown, IoChevronForward, IoCheckmarkOutline, IoCodeSlashOutline, IoConstructOutline, IoCopyOutline, IoDocumentTextOutline, IoEyeOffOutline, IoEyeOutline, IoFlashOutline, IoGlobeOutline, IoImageOutline, IoLayersOutline, IoLaptopOutline, IoLanguageOutline, IoMicOutline, IoMusicalNotesOutline, IoPlayCircleOutline, IoPulseOutline, IoRefresh, IoSave, IoSearch, IoSettingsOutline, IoShieldCheckmarkOutline, IoShuffleOutline, IoTimeOutline, IoTrashOutline, IoVideocamOutline, IoBrushOutline, IoVolumeHighOutline } from 'react-icons/io5';
import { AiOutlineEye } from 'react-icons/ai';
import { useDevice } from '../../hooks/useDevice';

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

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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
  Ai21: (LobeIcons as any).Ai21,
  AlibabaCloud: (LobeIcons as any).AlibabaCloud,
  Anthropic: (LobeIcons as any).Anthropic,
  Anyscale: (LobeIcons as any).Anyscale,
  Aws: (LobeIcons as any).Aws,
  Azure: (LobeIcons as any).Azure,
  BAAI: (LobeIcons as any).BAAI,
  Baichuan: (LobeIcons as any).Baichuan,
  Baidu: (LobeIcons as any).Baidu,
  Cerebras: (LobeIcons as any).Cerebras,
  ChatGLM: (LobeIcons as any).ChatGLM,
  Cloudflare: (LobeIcons as any).Cloudflare,
  Cohere: (LobeIcons as any).Cohere,
  Dbrx: (LobeIcons as any).Dbrx,
  DeepInfra: (LobeIcons as any).DeepInfra,
  DeepSeek: (LobeIcons as any).DeepSeek,
  Doubao: (LobeIcons as any).Doubao,
  Fireworks: (LobeIcons as any).Fireworks,
  Gemini: (LobeIcons as any).Gemini,
  Github: (LobeIcons as any).Github,
  Groq: (LobeIcons as any).Groq,
  HuggingFace: (LobeIcons as any).HuggingFace,
  Hunyuan: (LobeIcons as any).Hunyuan,
  IBM: (LobeIcons as any).IBM,
  IFlyTekCloud: (LobeIcons as any).IFlyTekCloud,
  InternLM: (LobeIcons as any).InternLM,
  Jina: (LobeIcons as any).Jina,
  Kling: (LobeIcons as any).Kling,
  LeptonAI: (LobeIcons as any).LeptonAI,
  LmStudio: (LobeIcons as any).LmStudio,
  Meta: (LobeIcons as any).Meta,
  Microsoft: (LobeIcons as any).Microsoft,
  Minimax: (LobeIcons as any).Minimax,
  Mistral: (LobeIcons as any).Mistral,
  Moonshot: (LobeIcons as any).Moonshot,
  Novita: (LobeIcons as any).Novita,
  Nvidia: (LobeIcons as any).Nvidia,
  Ollama: (LobeIcons as any).Ollama,
  OpenAI: (LobeIcons as any).OpenAI,
  OpenRouter: (LobeIcons as any).OpenRouter,
  Perplexity: (LobeIcons as any).Perplexity,
  Qwen: (LobeIcons as any).Qwen,
  Replicate: (LobeIcons as any).Replicate,
  SambaNova: (LobeIcons as any).SambaNova,
  SenseNova: (LobeIcons as any).SenseNova,
  SiliconCloud: (LobeIcons as any).SiliconCloud,
  Stability: (LobeIcons as any).Stability,
  Stepfun: (LobeIcons as any).Stepfun,
  Suno: (LobeIcons as any).Suno,
  TencentCloud: (LobeIcons as any).TencentCloud,
  Together: (LobeIcons as any).Together,
  Volcengine: (LobeIcons as any).Volcengine,
  Voyage: (LobeIcons as any).Voyage,
  Wenxin: (LobeIcons as any).Wenxin,
  XAI: (LobeIcons as any).XAI,
  Yi: (LobeIcons as any).Yi,
};

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
  try {
    return inferModelCapabilities(modelId);
  } catch (e) {
    try {
      // eslint-disable-next-line no-console
      console.warn('[ModelProvidersManager] inferModelCapabilities failed', { modelId, error: e });
    } catch {
      // ignore
    }
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
  chatbubble: <IoChatbubbleEllipsesOutline />,
  eye: <AiOutlineEye />,
  globe: <IoGlobeOutline />,
  mic: <IoMicOutline />,
  eye_outline: <IoEyeOutline />,
  image: <IoImageOutline />,
  brush: <IoBrushOutline />,
  music: <IoMusicalNotesOutline />,
  volume: <IoVolumeHighOutline />,
  play: <IoPlayCircleOutline />,
  videocam: <IoVideocamOutline />,
  layers: <IoLayersOutline />,
  shuffle: <IoShuffleOutline />,
  bulb: <IoBulbOutline />,
  pulse: <IoPulseOutline />,
  code: <IoCodeSlashOutline />,
  tool: <IoConstructOutline />,
  json: <IoDocumentTextOutline />,
  time: <IoTimeOutline />,
  shield: <IoShieldCheckmarkOutline />,
  language: <IoLanguageOutline />,
  laptop: <IoLaptopOutline />,
};

function CapabilityIcon(props: { capKey: string }) {
  const icon = capabilityMetaMap.get(String(props.capKey))?.icon;
  const Comp = icon ? CAPABILITY_ICON_MAP[String(icon)] : null;
  return Comp || <IoFlashOutline />;
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

function ModelOptionRow(props: {
  modelId: string;
  providerType: ProviderType;
  override?: { icon?: CustomIconRef; caps?: string[] } | null;
  onPick: (id: string) => void;
}) {
  const vendor = safeInferModelVendor({ id: props.modelId }, providerTypeFallbackVendor(props.providerType));
  const caps = props.override?.caps && props.override.caps.length
    ? props.override.caps.map(k => ({ key: k, label: k }))
    : safeInferModelCapabilities(props.modelId);
  return (
    <button
      type="button"
      className={styles.modelDropdownItem}
      onMouseDown={(e) => {
        e.preventDefault();
        props.onPick(props.modelId);
      }}
      title={props.modelId}
    >
      <span className={styles.modelDropdownItemLeft}>
        <span className={styles.modelInputLeftIcon}>
          {props.override?.icon ? (
            <CustomIcon icon={props.override.icon as any} size={16} />
          ) : (
            <BrandLogo iconName={vendor.iconName} size={16} />
          )}
        </span>
        <span className={styles.modelDropdownItemText}>{props.modelId}</span>
      </span>
      <span className={styles.modelInputCaps}>
        {caps.map(c => (
          <span
            key={c.key}
            className={styles.modelCapIcon}
            style={capStyleVars(c.key)}
            title={c.label}
            aria-label={c.key}
          >
            <CapabilityIcon capKey={c.key} />
          </span>
        ))}
      </span>
    </button>
  );
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
  const lib = { ...(LOBE_ICON_STATIC_MAP as any), ...(((LobeIcons as any) || {}) as any) };
  const getComp = (name: string) => {
    const direct = lib?.[name];
    const ciKey = !direct
      ? Object.keys(lib).find(k => k.toLowerCase() === String(name || '').toLowerCase())
      : undefined;
    const icon = (direct || (ciKey ? lib[ciKey] : undefined)) as any;
    if (!icon) return null;
    const color = (icon as any)?.Color;
    if (isValidElementType(color)) return color;
    if (isValidElementType(icon)) return icon;
    return null;
  };

  const Comp = props.iconName ? getComp(props.iconName) : null;
  const ultimateFallback = <IoFlashOutline size={props.size} />;
  if (!Comp && props.iconName) {
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
  const lib = { ...(LOBE_ICON_STATIC_MAP as any), ...(((LobeIcons as any) || {}) as any) };
  const q = String(query || '').trim().toLowerCase();
  const keys = Object.keys(lib);
  const filtered = q ? keys.filter(k => k.toLowerCase().includes(q)) : keys;
  return filtered
    .filter(k => {
      const v = lib[k];
      if (!v) return false;
      const color = (v as any)?.Color;
      return isValidElementType(color) || isValidElementType(v);
    })
    .slice(0, 120);
}

function Switch(props: { checked: boolean; onChange: (next: boolean) => void; ariaLabel: string; onClickCapture?: React.MouseEventHandler }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.ariaLabel}
      className={styles.switch}
      onClickCapture={props.onClickCapture}
      onClick={(e) => {
        e.stopPropagation();
        props.onChange(!props.checked);
      }}
    >
      <span className={[styles.switchTrack, props.checked ? styles.switchTrackOn : ''].filter(Boolean).join(' ')}>
        <span className={[styles.switchThumb, props.checked ? styles.switchThumbOn : ''].filter(Boolean).join(' ')} />
      </span>
    </button>
  );
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

  const { isMobile, isTablet } = useDevice();
  const isCompact = isMobile || isTablet;
  const [mobilePane, setMobilePane] = useState<'list' | 'detail'>('list');
  const [mobileSection, setMobileSection] = useState<'provider' | 'config' | 'models'>('provider');

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
  const [showApiKey, setShowApiKey] = useState(false);
  const [multiModelDrafts, setMultiModelDrafts] = useState<Record<string, string>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [editingProviderName, setEditingProviderName] = useState('');
  const [draggingProviderId, setDraggingProviderId] = useState<string | null>(null);
  const [dragOverProviderId, setDragOverProviderId] = useState<string | null>(null);
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
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);

  const [mcpPluginName, setMcpPluginName] = useState<string>('');
  const [mcpPluginDrafts, setMcpPluginDrafts] = useState<Record<string, EnvVariable[]>>({});
  const [mcpPluginDirty, setMcpPluginDirty] = useState<Record<string, boolean>>({});
  const [mcpPluginSaving, setMcpPluginSaving] = useState(false);
  const [mcpPluginGroupCollapsed, setMcpPluginGroupCollapsed] = useState<Record<string, boolean>>({});
  const [mcpPluginShowAllVars, setMcpPluginShowAllVars] = useState(false);

  const [mcpPluginPickerOpen, setMcpPluginPickerOpen] = useState(false);
  const [mcpPluginPickerSearch, setMcpPluginPickerSearch] = useState('');
  const mcpPluginComboRef = useRef<HTMLDivElement | null>(null);
  const mcpPluginMenuRef = useRef<HTMLDivElement | null>(null);
  const [mcpPluginMenuPos, setMcpPluginMenuPos] = useState<{ left: number; top: number; width: number } | null>(null);

  const [providers, setProviders] = useState<Provider[]>(() => {
    const stored = safeJsonParse<Provider[]>(localStorage.getItem(STORAGE_KEY), []);
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
      },
    ];
  });

  const [modelsCache, setModelsCache] = useState<ModelsCache>(() => {
    const stored = safeJsonParse<ModelsCache>(localStorage.getItem(STORAGE_MODELS_KEY), {} as any);
    return stored && typeof stored === 'object' ? stored : ({} as any);
  });

  const [activeId, setActiveId] = useState<string>(() => (providers[0]?.id ? providers[0].id : ''));
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(providers));
    } catch {
      // ignore
    }
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
    if (!configData?.modules) return;
    setLlmDrafts(prev => {
      const next = { ...prev };
      for (const mo of LLM_MODULES) {
        const m = configData.modules.find(x => x.name === mo.name);
        if (!m) continue;
        if (llmDirty[mo.name]) continue;
        next[mo.name] = (Array.isArray(m.variables) ? m.variables : []).map(v => ({ ...v }));
      }
      return next;
    });
  }, [configData, llmDirty]);

  const isMcpPluginLlmKey = useCallback((key: string) => {
    const k = String(key || '').toUpperCase();
    if (!k) return false;
    if (k.startsWith('PLUGIN_')) return true;
    if (k.includes('BASE_URL') || k.includes('API_KEY') || k.endsWith('_MODEL') || k === 'MODEL') return true;
    if (k.includes('VISION')) return true;
    return false;
  }, []);

  const mcpPluginCandidates = useMemo(() => {
    const ps = Array.isArray(configData?.plugins) ? configData!.plugins : [];
    return ps
      .filter(p => Array.isArray(p.variables) && p.variables.some(v => isMcpPluginLlmKey(v.key)))
      .map(p => p.name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }, [configData?.plugins, isMcpPluginLlmKey]);

  const mcpPluginDisplayName = useMemo(() => {
    if (!mcpPluginName) return '';
    return getDisplayName(mcpPluginName);
  }, [mcpPluginName]);

  const mcpPluginOptions = useMemo(() => {
    const opts = mcpPluginCandidates.map(n => ({ name: n, label: getDisplayName(n) }));
    return opts.sort((a, b) => {
      const x = a.label.localeCompare(b.label, 'zh-Hans-CN');
      if (x !== 0) return x;
      return a.name.localeCompare(b.name);
    });
  }, [mcpPluginCandidates]);

  const mcpPluginFilteredOptions = useMemo(() => {
    const t = mcpPluginPickerSearch.trim().toLowerCase();
    if (!t) return mcpPluginOptions;
    return mcpPluginOptions.filter(o => o.name.toLowerCase().includes(t) || o.label.toLowerCase().includes(t));
  }, [mcpPluginOptions, mcpPluginPickerSearch]);

  useEffect(() => {
    if (!configData?.plugins) return;
    if (!mcpPluginName && mcpPluginCandidates.length) {
      setMcpPluginName(mcpPluginCandidates[0]);
    }

    setMcpPluginDrafts(prev => {
      const next = { ...prev };
      for (const p of (Array.isArray(configData.plugins) ? configData.plugins : [])) {
        if (!p?.name) continue;
        if (mcpPluginDirty[p.name]) continue;
        next[p.name] = (Array.isArray(p.variables) ? p.variables : []).map(v => ({ ...v }));
      }
      return next;
    });
  }, [configData?.plugins, mcpPluginCandidates, mcpPluginDirty, mcpPluginName]);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_MODELS_KEY, JSON.stringify(modelsCache));
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

  const addProvider = useCallback(() => {
    const p: Provider = {
      id: uuidv4(),
      name: '新供应商',
      type: 'custom',
      enabled: true,
      baseUrl: '',
      apiKey: '',
      apiKeyHeader: 'Authorization',
      apiKeyPrefix: 'Bearer ',
    };
    setProviders(prev => [p, ...prev]);
    setActiveId(p.id);
  }, []);

  const requestRemoveProvider = useCallback((id: string) => {
    setDeleteTargetId(id);
  }, []);

  const confirmRemoveProvider = useCallback(() => {
    if (!deleteTargetId) return;
    const id = deleteTargetId;
    setDeleteTargetId(null);
    setProviders(prev => prev.filter(px => px.id !== id));
    setModelsCache(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, [deleteTargetId]);

  const copyText = useCallback(async (text: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      addToast('success', '已复制', text);
    } catch (e: any) {
      addToast('error', '复制失败', e?.message ? String(e.message) : String(e));
    }
  }, [addToast]);

  const runTestModels = useCallback(async () => {
    if (!activeProvider) return;

    const baseUrl = normalizeBaseUrlV1(activeProvider.baseUrl);
    if (!baseUrl) {
      addToast('error', '请填写 API Base URL');
      return;
    }

    setBusy(true);
    setErrorText('');

    try {
      const data = await testProviderModels({
        baseUrl,
        apiKey: activeProvider.apiKey,
        apiKeyHeader: 'Authorization',
        apiKeyPrefix: 'Bearer ',
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
      setErrorText(msg);
      addToast('error', '检测失败', msg);
    } finally {
      setBusy(false);
    }
  }, [activeProvider, addToast]);

  const activeModelsEntry = activeProvider ? modelsCache[activeProvider.id] : undefined;
  const activeModels = Array.isArray(activeModelsEntry?.models) ? activeModelsEntry?.models : [];
  const activeModelIds = useMemo(() => {
    if (!activeModels || !Array.isArray(activeModels)) return [];
    return activeModels
      .map(m => (m?.id != null ? String(m.id) : ''))
      .filter(Boolean);
  }, [activeModels]);

  const [modelDropdownKey, setModelDropdownKey] = useState<string | null>(null);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);

  const modelDropdownMaxHeight = 240;

  const filteredProviders = useMemo(() => {
    const term = providerSearch.trim().toLowerCase();
    if (!term) return providers;
    return providers.filter(p => {
      const name = (p?.name || '').toLowerCase();
      const url = (p?.baseUrl || '').toLowerCase();
      return name.includes(term) || url.includes(term);
    });
  }, [providers, providerSearch]);

  const commitProviderName = useCallback((id: string, nextName: string) => {
    const name = String(nextName || '').trim() || '未命名供应商';
    setProviders(prev => prev.map(p => (p.id === id ? { ...p, name } : p)));
  }, []);

  const reorderProviders = useCallback((fromId: string, toId: string) => {
    if (!fromId || !toId || fromId === toId) return;
    setProviders(prev => {
      const fromIndex = prev.findIndex(p => p.id === fromId);
      const toIndex = prev.findIndex(p => p.id === toId);
      if (fromIndex < 0 || toIndex < 0) return prev;
      const next = prev.slice();
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
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
  const [iconSearch, setIconSearch] = useState('');
  const [capabilitySearch, setCapabilitySearch] = useState('');

  const capabilityChoices = useMemo(() => {
    const uniq = new Map<string, string>();
    for (const r of capabilityRules) {
      if (!r?.key) continue;
      uniq.set(String(r.key), String(r.label || r.key));
    }
    return Array.from(uniq.entries()).map(([key, label]) => ({ key, label }));
  }, []);

  const filteredCapabilityChoices = useMemo(() => {
    const q = String(capabilitySearch || '').trim().toLowerCase();
    if (!q) return capabilityChoices;
    return capabilityChoices.filter(c => {
      const k = String(c.key || '').toLowerCase();
      const l = String(c.label || '').toLowerCase();
      return k.includes(q) || l.includes(q);
    });
  }, [capabilityChoices, capabilitySearch]);

  const inferredModelSettingsCaps = useMemo(() => {
    if (!modelSettingsModelId) return [] as string[];
    return safeInferModelCapabilities(modelSettingsModelId).map(c => String(c.key));
  }, [modelSettingsModelId]);

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
      if (evalLlmConditions(p.when, llmVarsMap)) return p;
    }
    return profiles[0];
  }, [llmModuleMapping, llmVarsMap]);

  useEffect(() => {
    // Any context switch should close the dropdown to avoid stale anchor -> misplacement/jumping
    setModelDropdownOpen(false);
    setModelDropdownKey(null);
    setMcpPluginPickerOpen(false);
  }, [llmModule, llmTab, llmActiveProfile?.key, activeProvider?.id, mcpPluginName]);

  useEffect(() => {
    if (!mcpPluginPickerOpen) {
      setMcpPluginMenuPos(null);
      return;
    }

    const updatePos = () => {
      const el = mcpPluginComboRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();

      const safePad = 8;
      const estimatedMenuHeight = 360;
      const maxLeft = Math.max(safePad, window.innerWidth - rect.width - safePad);
      const left = Math.min(Math.max(rect.left, safePad), maxLeft);

      const openDownTop = rect.bottom + 8;
      const openUpTop = rect.top - 8 - estimatedMenuHeight;
      const shouldOpenUp = (openDownTop + estimatedMenuHeight > window.innerHeight) && (openUpTop > safePad);
      const top = shouldOpenUp ? openUpTop : openDownTop;

      setMcpPluginMenuPos({ left, top, width: rect.width });
    };

    updatePos();

    const onDown = (e: MouseEvent) => {
      const el = mcpPluginComboRef.current;
      const menu = mcpPluginMenuRef.current;
      if (!el) return;
      if (e.target && el.contains(e.target as Node)) return;
      if (menu && e.target && menu.contains(e.target as Node)) return;
      setMcpPluginPickerOpen(false);
    };

    const onScroll = () => updatePos();
    const onResize = () => updatePos();

    document.addEventListener('mousedown', onDown);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [mcpPluginPickerOpen]);

  const activeMcpPluginConfig = useMemo(() => {
    if (!mcpPluginName) return null;
    const ps = Array.isArray(configData?.plugins) ? configData!.plugins : [];
    return ps.find(p => p.name === mcpPluginName) || null;
  }, [configData?.plugins, mcpPluginName]);

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

        <div className={styles.searchBox}>
          <div className={styles.searchInputWrap}>
            <span className={styles.searchIcon}>
              <IoSearch size={16} />
            </span>
            <input
              className={styles.searchInputWithIcon}
              value={providerSearch}
              onChange={(e) => setProviderSearch(e.target.value)}
              placeholder="搜索供应商 / Base URL"
            />
          </div>
        </div>

        <div className={styles.providerListScroll}>
          <div className={styles.providerList}>
            {filteredProviders.map(p => {
            const isActive = p.id === activeId;
            return (
              <div
                key={p.id}
                onClick={() => {
                  setActiveId(p.id);
                  if (isCompact) setMobilePane('detail');
                }}
                className={[
                  styles.providerItem,
                  isActive ? styles.providerItemActive : '',
                  draggingProviderId === p.id ? styles.providerItemDragging : '',
                  dragOverProviderId === p.id ? styles.providerItemDragOver : '',
                ].filter(Boolean).join(' ')}
                draggable={!providerSearch.trim() && editingProviderId !== p.id}
                onDragStart={(e) => {
                  if (providerSearch.trim() || editingProviderId === p.id) return;
                  setDraggingProviderId(p.id);
                  try {
                    e.dataTransfer.setData('text/plain', p.id);
                  } catch {
                    // ignore
                  }
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragEnd={() => {
                  setDraggingProviderId(null);
                  setDragOverProviderId(null);
                }}
                onDragOver={(e) => {
                  if (!draggingProviderId || draggingProviderId === p.id) return;
                  e.preventDefault();
                  setDragOverProviderId(p.id);
                }}
                onDragLeave={() => {
                  if (dragOverProviderId === p.id) setDragOverProviderId(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const from = draggingProviderId || (() => {
                    try {
                      return e.dataTransfer.getData('text/plain');
                    } catch {
                      return '';
                    }
                  })();
                  if (from) reorderProviders(from, p.id);
                  setDraggingProviderId(null);
                  setDragOverProviderId(null);
                }}
              >
                <div className={styles.providerMain}>
                  <div className={styles.logoRound}>
                    <ProviderLogo type={p.type} />
                  </div>
                  <div className={styles.providerText}>
                    {editingProviderId === p.id ? (
                      <input
                        className={styles.providerNameInput}
                        value={editingProviderName}
                        onChange={(e) => setEditingProviderName(e.target.value)}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            commitProviderName(p.id, editingProviderName);
                            setEditingProviderId(null);
                          }
                          if (e.key === 'Escape') {
                            setEditingProviderId(null);
                          }
                        }}
                        onBlur={() => {
                          commitProviderName(p.id, editingProviderName);
                          setEditingProviderId(null);
                        }}
                      />
                    ) : (
                      <div
                        className={styles.providerName}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setEditingProviderId(p.id);
                          setEditingProviderName(p.name || '');
                        }}
                        title="双击改名"
                      >
                        {p.name}
                      </div>
                    )}
                    <div className={styles.providerSub}>{p.baseUrl || '未配置 Base URL'}</div>
                  </div>
                </div>

                <div className={styles.providerItemActions}>
                  <span
                    className={[p.enabled ? styles.badgeOn : styles.badgeOff, styles.badgeClickable].join(' ')}
                    onClick={(e) => {
                      e.stopPropagation();
                      setProviders(prev => prev.map(x => x.id === p.id ? { ...x, enabled: !x.enabled } : x));
                    }}
                    title="点击切换"
                  >
                    {p.enabled ? 'ON' : 'OFF'}
                  </span>
                </div>
              </div>
            );
            })}
          </div>
        </div>

        <div className={styles.addBar}>
          <button onClick={addProvider} className={styles.addBarButton} type="button">
            <IoAdd />
            添加
          </button>
        </div>
      </div>

      <div className={[styles.right, (isCompact && mobilePane === 'list') ? styles.mobileHidden : ''].filter(Boolean).join(' ')} ref={rightRef}>
        {isCompact ? (
          <div className={styles.mobileBackRow}>
            <button
              type="button"
              className={styles.mobileBackBtn}
              onClick={() => setMobilePane('list')}
            >
              <IoChevronBack />
              供应商
            </button>
            <div className={styles.mobileBackTitle}>{activeProvider?.name || '模型供应商'}</div>
          </div>
        ) : null}

        {isCompact && activeProvider ? (
          <div className={styles.mobileSectionBar}>
            <button
              type="button"
              className={[styles.mobileSectionBtn, mobileSection === 'provider' ? styles.mobileSectionBtnActive : ''].filter(Boolean).join(' ')}
              onClick={() => setMobileSection('provider')}
            >
              供应商
            </button>
            <button
              type="button"
              className={[styles.mobileSectionBtn, mobileSection === 'config' ? styles.mobileSectionBtnActive : ''].filter(Boolean).join(' ')}
              onClick={() => setMobileSection('config')}
            >
              配置中心
            </button>
            <button
              type="button"
              className={[styles.mobileSectionBtn, mobileSection === 'models' ? styles.mobileSectionBtnActive : ''].filter(Boolean).join(' ')}
              onClick={() => setMobileSection('models')}
            >
              模型
            </button>
          </div>
        ) : null}
        {!activeProvider ? (
          <div className={styles.emptyState}>请先新增或选择一个供应商。</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
            <div className={styles.header}>
              <div>
                <div className={styles.headerTitle}>模型供应商管理</div>
                <div className={styles.headerSub}>统一管理供应商、连接信息与模型列表</div>
              </div>
              <div className={styles.toolbar}>
                <span
                  className={[activeProvider.enabled ? styles.badgeOn : styles.badgeOff, styles.badgeClickable].join(' ')}
                  onClick={() => updateActive({ enabled: !activeProvider.enabled })}
                  title="点击切换"
                >
                  {activeProvider.enabled ? 'ON' : 'OFF'}
                </span>
                <button
                  className={styles.dangerButton}
                  type="button"
                  onClick={() => requestRemoveProvider(activeProvider.id)}
                  title="删除当前供应商"
                >
                  <IoTrashOutline />
                  删除
                </button>
              </div>
            </div>

            {errorText ? <div className={styles.errorBox}>{errorText}</div> : null}

            {(!isCompact || mobileSection === 'provider') ? (
            <div className={styles.card}>
              <div className={styles.cardTitleRow}>
                <div className={styles.cardTitle}>供应商设置</div>
                <div className={styles.cardMeta}>用于连接与鉴权（不会上传到服务器，保存在浏览器本地）</div>
              </div>

              <div className={styles.formGridSingle}>
                <div className={styles.field}>
                  <div className={styles.fieldLabel}>API 密钥</div>
                  <div className={styles.inputRow}>
                    <input
                      className={styles.input}
                      type={showApiKey ? 'text' : 'password'}
                      value={activeProvider.apiKey}
                      onChange={(e) => updateActive({ apiKey: e.target.value })}
                      placeholder="sk-..."
                    />
                    <button
                      className={styles.inputSuffixBtn}
                      onClick={() => setShowApiKey(s => !s)}
                      aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                      title={showApiKey ? '隐藏' : '显示'}
                      type="button"
                    >
                      {showApiKey ? <IoEyeOffOutline /> : <IoEyeOutline />}
                    </button>
                  </div>
                </div>

                <div className={styles.field}>
                  <div className={styles.fieldLabel}>API 地址</div>
                  <input
                    className={styles.input}
                    value={activeProvider.baseUrl}
                    onChange={(e) => updateActive({ baseUrl: e.target.value })}
                    onBlur={(e) => updateActive({ baseUrl: normalizeBaseUrlV1(e.target.value) })}
                    placeholder="https://api.openai.com"
                  />
                </div>
              </div>
            </div>
            ) : null}

            {(!isCompact || mobileSection === 'config') ? (
            <div className={styles.card}>
              <div className={styles.cardTitleRow}>
                <div>
                  <div className={styles.cardTitle}>LLM 配置中心</div>
                  <div className={styles.cardMeta}>
                    {configLoading
                      ? '加载配置中...'
                      : (llmTab === 'mcp-plugins'
                        ? '配置 sentra-mcp/plugins 本地插件环境变量'
                        : (llmMappingLoading ? '加载映射中...' : '按模块编辑所有 LLM 相关环境变量（OpenAI-compat）'))}
                  </div>
                </div>
                <div className={styles.llmTopRight}>
                  <div className={styles.moduleTabs}>
                    {LLM_TABS.map(m => (
                      <button
                        key={m.name}
                        type="button"
                        className={[styles.moduleTab, llmTab === m.name ? styles.moduleTabActive : ''].filter(Boolean).join(' ')}
                        onClick={() => {
                          setLlmTab(m.name);
                          if (m.name !== 'mcp-plugins') setLlmModule(m.name);
                        }}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className={styles.llmToolbar}>
                <div className={styles.llmToolbarLeft}>
                  <button
                    className={styles.secondaryButton}
                    type="button"
                    onClick={loadConfigData}
                    disabled={configLoading || llmSaving || mcpPluginSaving}
                    title="重新加载配置"
                  >
                    <IoRefresh />
                    刷新
                  </button>

                  {llmTab === 'mcp-plugins' ? (
                    <>
                      <button
                        className={styles.secondaryButton}
                        type="button"
                        onClick={() => setMcpPluginShowAllVars(s => !s)}
                        disabled={mcpPluginSaving}
                      >
                        {mcpPluginShowAllVars ? '仅显示 LLM 字段' : '显示全部字段'}
                      </button>

                      <button
                        className={styles.secondaryButton}
                        type="button"
                        onClick={fillMcpPluginSecretsFromActiveProvider}
                        disabled={!activeProvider || mcpPluginSaving || !mcpPluginName}
                        title="一键把当前供应商的 BaseURL(/v1) / API Key 填入插件内所有 *_BASE_URL/*_API_KEY 字段"
                      >
                        一键配置
                      </button>

                      <div className={styles.comboWrap} ref={mcpPluginComboRef}>
                        <button
                          type="button"
                          className={styles.comboButton}
                          onClick={() => {
                            if (mcpPluginPickerOpen) {
                              setMcpPluginPickerOpen(false);
                              return;
                            }
                            const el = mcpPluginComboRef.current;
                            if (el) {
                              const rect = el.getBoundingClientRect();
                              setMcpPluginMenuPos({ left: rect.left, top: rect.bottom + 8, width: rect.width });
                            }
                            setMcpPluginPickerOpen(true);
                          }}
                          disabled={mcpPluginSaving}
                          title="选择 MCP 插件"
                        >
                          <span className={styles.comboButtonText}>
                            {mcpPluginName ? (mcpPluginDisplayName || '未知插件') : '选择插件'}
                          </span>
                          <IoChevronDown />
                        </button>

                        {(mcpPluginPickerOpen && mcpPluginMenuPos) ? createPortal((
                          <div
                            ref={mcpPluginMenuRef}
                            className={styles.comboMenu}
                            style={{ left: mcpPluginMenuPos.left, top: mcpPluginMenuPos.top, width: mcpPluginMenuPos.width }}
                          >
                            <input
                              className={styles.comboSearch}
                              value={mcpPluginPickerSearch}
                              onChange={(e) => setMcpPluginPickerSearch(e.target.value)}
                              placeholder="搜索插件（名称）"
                              autoFocus
                            />
                            <div className={styles.comboList}>
                              {mcpPluginFilteredOptions.length ? mcpPluginFilteredOptions.map((op) => (
                                <button
                                  key={op.name}
                                  type="button"
                                  className={[styles.comboItem, op.name === mcpPluginName ? styles.comboItemActive : ''].filter(Boolean).join(' ')}
                                  onClick={() => {
                                    setMcpPluginName(op.name);
                                    setMcpPluginPickerOpen(false);
                                    setMcpPluginPickerSearch('');
                                  }}
                                >
                                  <div className={styles.comboItemTitle}>{op.label}</div>
                                </button>
                              )) : (
                                <div className={styles.cardMeta}>没有匹配的插件。</div>
                              )}
                            </div>
                          </div>
                        ), document.body) : null}
                      </div>
                    </>
                  ) : (
                    <button
                      className={styles.secondaryButton}
                      type="button"
                      onClick={fillLlmSecretsFromActiveProvider}
                      disabled={!activeProvider || llmSaving}
                      title="一键把当前供应商的 BaseURL(/v1) / API Key 填入本模块支持的 BaseURL/API_KEY 字段"
                    >
                      一键配置
                    </button>
                  )}

                  <button
                    className={styles.secondaryButton}
                    type="button"
                    onClick={() => setShowSecretsInEnv(s => !s)}
                    disabled={llmSaving || mcpPluginSaving}
                  >
                    {showSecretsInEnv ? '隐藏密钥' : '显示密钥'}
                  </button>
                  {(String(llmTab) !== 'mcp-plugins' && llmHasAdvancedItems) ? (
                    <button
                      className={[styles.secondaryButton, showAdvancedLlm ? styles.secondaryButtonActive : ''].filter(Boolean).join(' ')}
                      type="button"
                      onClick={() => setShowAdvancedLlm(s => !s)}
                      disabled={llmSaving}
                      title="显示/隐藏 JSON 映射中标记为 advanced 的参数"
                    >
                      {showAdvancedLlm ? '隐藏高级参数' : '高级参数'}
                    </button>
                  ) : null}
                </div>
                <button
                  className={[styles.primaryButton, styles.llmSaveBtn].filter(Boolean).join(' ')}
                  type="button"
                  onClick={llmTab === 'mcp-plugins' ? saveMcpPlugin : saveLlmModule}
                  disabled={llmTab === 'mcp-plugins'
                    ? (mcpPluginSaving || !mcpPluginName || !mcpPluginDirty[mcpPluginName])
                    : (configLoading || llmSaving || !llmDirty[llmModule])}
                  title={llmTab === 'mcp-plugins' ? (mcpPluginName ? '保存' : '请选择插件') : '写入该模块 .env'}
                >
                  <IoSave />
                  {llmTab === 'mcp-plugins'
                    ? (mcpPluginSaving ? '保存中...' : '保存')
                    : (llmSaving ? '保存中...' : '保存')}
                </button>
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
                        const collapsed = !!mcpPluginGroupCollapsed[k];
                        return (
                          <div className={styles.llmGroup} key={k}>
                            <div className={styles.llmGroupHeader}>
                              <div className={styles.llmGroupHeaderLeft}>
                                <div className={styles.llmGroupTitle}>{g}</div>
                                <span className={styles.badgeOff}>{items.length}</span>
                              </div>
                              <div className={styles.llmGroupHeaderRight}>
                                <button
                                  className={styles.groupToggleBtn}
                                  type="button"
                                  onClick={() => setMcpPluginGroupCollapsed(prev => ({ ...prev, [k]: !prev[k] }))}
                                  aria-label={collapsed ? '展开' : '折叠'}
                                  title={collapsed ? '展开' : '折叠'}
                                >
                                  {collapsed ? <IoChevronForward /> : <IoChevronDown />}
                                </button>
                              </div>
                            </div>

                            {!collapsed ? (
                              <div className={styles.envList}>
                                {items.map((it) => {
                                  const v = mcpPluginVarsMap.get(it.key);
                                  const meta = parseEnvMeta(v?.comment);
                                  const desc = meta?.description || '';
                                  const displayName = String(v?.displayName ?? '').trim();
                                  const value = String(v?.value ?? '');
                                  const type: EnvValueType = (it.kind === 'boolean' ? 'boolean' : (it.kind === 'number' ? 'number' : (it.kind === 'enum' ? 'enum' : 'string')));
                                  const isSecret = isSensitiveKeyKind(it.kind, it.key);
                                  const dropKey = `plugin:${mcpPluginName}:${it.key}`;

                                  return (
                                    <div
                                      className={[
                                        styles.envRow,
                                        modelDropdownOpen && modelDropdownKey === dropKey ? styles.envRowDropdownOpen : '',
                                      ].filter(Boolean).join(' ')}
                                      key={it.key}
                                    >
                                      <div className={styles.envLeft}>
                                        {displayName ? <div className={styles.envName}>{displayName}</div> : null}
                                        <div className={styles.envKey}>{it.key}</div>
                                        {desc ? <div className={styles.envDesc}>{desc}</div> : null}
                                      </div>
                                      <div className={styles.envRight}>
                                        {it.kind === 'boolean' ? (
                                          <Switch
                                            ariaLabel={it.key}
                                            checked={isTruthyString(value)}
                                            onChange={(next) => updateMcpPluginVar(it.key, next ? 'true' : 'false')}
                                          />
                                        ) : it.kind === 'enum' ? (
                                          <select
                                            className={styles.select}
                                            value={value}
                                            onChange={(e) => updateMcpPluginVar(it.key, e.target.value)}
                                          >
                                            {(Array.isArray(it.options) && it.options.length ? it.options : (Array.isArray(meta?.options) ? meta!.options! : [])).map(op => (
                                              <option key={op} value={op}>{op}</option>
                                            ))}
                                          </select>
                                        ) : it.kind === 'model' ? (
                                          <div className={styles.modelInputWrap}>
                                            <input
                                              className={styles.input}
                                              value={value}
                                              onChange={(e) => {
                                                updateMcpPluginVar(it.key, e.target.value);
                                                setModelDropdownKey(dropKey);
                                                setModelDropdownOpen(true);
                                              }}
                                              onFocus={() => {
                                                setModelDropdownKey(dropKey);
                                                setModelDropdownOpen(true);
                                              }}
                                              onBlur={() => {
                                                setTimeout(() => setModelDropdownOpen(false), 120);
                                              }}
                                              placeholder={activeProvider ? (activeModelIds.length ? '从供应商模型选择或手动输入' : '请先检测供应商模型') : '请先选择供应商'}
                                            />
                                          </div>
                                        ) : it.kind === 'api_key' ? (
                                          <input
                                            className={styles.input}
                                            value={value}
                                            onChange={(e) => updateMcpPluginVar(it.key, e.target.value)}
                                            type={isSecret && !showSecretsInEnv ? 'password' : 'text'}
                                          />
                                        ) : it.kind === 'base_url' ? (
                                          <input
                                            className={styles.input}
                                            value={value}
                                            onChange={(e) => updateMcpPluginVar(it.key, e.target.value)}
                                            onBlur={(e) => updateMcpPluginVar(it.key, normalizeBaseUrlV1(e.target.value))}
                                            type="text"
                                            placeholder="https://.../v1"
                                          />
                                        ) : (
                                          <input
                                            className={styles.input}
                                            value={value}
                                            onChange={(e) => updateMcpPluginVar(it.key, e.target.value)}
                                            type={isSecret && !showSecretsInEnv ? 'password' : (type === 'number' ? 'number' : 'text')}
                                          />
                                        )}
                                      </div>

                                      {it.kind === 'model' &&
                                        modelDropdownOpen &&
                                        modelDropdownKey === dropKey &&
                                        activeProvider &&
                                        activeModelIds.length ? (
                                        <div className={styles.modelPickerInlineRow}>
                                          <div
                                            className={styles.modelPickerInlineList}
                                            style={{ maxHeight: `${modelDropdownMaxHeight}px` }}
                                          >
                                            {(() => {
                                              const requireCaps = getPluginModelRequireCaps(mcpPluginName, it.key);
                                              return activeModelIds
                                                .filter(id => modelInScope(id, inferModelScopeFromItem(it)))
                                                .filter(id => modelHasCaps(activeProvider.id, id, requireCaps))
                                                .filter(id => value ? id.toLowerCase().includes(value.toLowerCase()) : true)
                                                .slice(0, 80)
                                                .map(id => (
                                                  <ModelOptionRow
                                                    key={id}
                                                    modelId={id}
                                                    providerType={activeProviderType}
                                                    override={getModelOverride(activeProvider.id, id)}
                                                    onPick={(picked) => {
                                                      updateMcpPluginVar(it.key, picked);
                                                      setModelDropdownOpen(false);
                                                    }}
                                                  />
                                                ));
                                            })()}
                                          </div>
                                        </div>
                                      ) : null}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </BrandLogoErrorBoundary>
                ))
              : (!llmModuleConfig ? (
                <div className={styles.cardMeta}>该模块未找到配置。</div>
              ) : !llmModuleMapping || !llmActiveProfile ? (
                <div className={styles.cardMeta}>该模块未配置 LLM 映射规则（请更新 llmEnvMapping.json）。</div>
              ) : llmVisibleItems.length === 0 ? (
                <div className={styles.cardMeta}>当前模式下没有可配置项（可能被条件规则隐藏）。</div>
              ) : (
                <div className={styles.llmGroups}>
                  {llmGroupedItems.map(([g, items]) => {
                    const k = `${llmModule}:${g}`;
                    const collapsed = !!llmGroupCollapsed[k];
                    return (
                      <div className={styles.llmGroup} key={k}>
                        <div className={styles.llmGroupHeader}>
                          <div className={styles.llmGroupHeaderLeft}>
                            <div className={styles.llmGroupTitle}>{g}</div>
                            <span className={styles.badgeOff}>{items.length}</span>
                          </div>
                          <div className={styles.llmGroupHeaderRight}>
                            <button
                              className={styles.iconOnlyButton}
                              type="button"
                              onClick={() => quickFillGroupFromProvider(g)}
                              aria-label="一键配置该分组 BaseURL/Key"
                              title="一键配置该分组 BaseURL/Key"
                              disabled={llmSaving}
                            >
                              <IoFlashOutline />
                            </button>
                            <button
                              className={styles.groupToggleBtn}
                              type="button"
                              onClick={() => setLlmGroupCollapsed(prev => ({ ...prev, [k]: !prev[k] }))}
                              aria-label={collapsed ? '展开' : '折叠'}
                              title={collapsed ? '展开' : '折叠'}
                            >
                              {collapsed ? <IoChevronForward /> : <IoChevronDown />}
                            </button>
                          </div>
                        </div>

                        {!collapsed ? (
                          <div className={styles.envList}>
                            {items.map((it) => {
                              const v = llmVarsMap.get(it.key);
                              const meta = parseEnvMeta(v?.comment);
                              const desc = meta?.description || '';
                              const displayName = String(v?.displayName ?? '').trim();
                              const value = String(v?.value ?? '');
                              const type: EnvValueType = (it.kind === 'boolean' ? 'boolean' : (it.kind === 'number' ? 'number' : (it.kind === 'enum' ? 'enum' : 'string')));
                              const isSecret = isSensitiveKeyKind(it.kind, it.key);
                              const isModelMultiCsv = it.kind === 'model' && it.picker === 'model' && it.multiple === true && it.valueFormat === 'csv';

                              return (
                                <div
                                  className={[
                                    styles.envRow,
                                    modelDropdownOpen && modelDropdownKey === it.key ? styles.envRowDropdownOpen : '',
                                  ].filter(Boolean).join(' ')}
                                  key={it.key}
                                >
                                  <div className={styles.envLeft}>
                                    {displayName ? <div className={styles.envName}>{displayName}</div> : null}
                                    <div className={styles.envKey}>{it.key}</div>
                                    {desc ? <div className={styles.envDesc}>{desc}</div> : null}
                                  </div>
                                  <div className={styles.envRight}>
                                    {it.kind === 'boolean' ? (
                                      <Switch
                                        ariaLabel={it.key}
                                        checked={isTruthyString(value)}
                                        onChange={(next) => updateLlmVar(it.key, next ? 'true' : 'false')}
                                      />
                                    ) : it.kind === 'enum' ? (
                                      <select
                                        className={styles.select}
                                        value={value}
                                        onChange={(e) => updateLlmVar(it.key, e.target.value)}
                                      >
                                        {(Array.isArray(it.options) && it.options.length ? it.options : (Array.isArray(meta?.options) ? meta!.options! : [])).map(op => (
                                          <option key={op} value={op}>{op}</option>
                                        ))}
                                      </select>
                                    ) : it.kind === 'model' ? (
                                      <>
                                        <div className={styles.modelInputWrap}>
                                          {(() => {
                                            const draft = String(multiModelDrafts[it.key] ?? '');
                                            const csvValues = isModelMultiCsv ? parseCsvValue(value) : [];
                                            const first = (csvValues[0] || draft || value);
                                            const displayId = first || '';
                                            const removeCsvValue = (id: string) => {
                                              const next = csvValues.filter(x => x !== id);
                                              updateLlmVar(it.key, formatCsvValue(next));
                                            };
                                            const addCsvValue = (rawId: string) => {
                                              const nextId = String(rawId || '').trim();
                                              if (!nextId) return;
                                              const merged = Array.from(new Set([...csvValues, nextId]));
                                              updateLlmVar(it.key, formatCsvValue(merged));
                                              setMultiModelDrafts(prev => ({ ...prev, [it.key]: '' }));
                                            };
                                            const setDraft = (next: string) => {
                                              setMultiModelDrafts(prev => ({ ...prev, [it.key]: next }));
                                            };

                                            return (
                                              <>
                                                <span className={styles.modelInputLeftIcon}>
                                                  <BrandLogo
                                                    iconName={safeInferModelVendor({ id: displayId }, providerTypeFallbackVendor(activeProviderType || 'custom')).iconName}
                                                    size={16}
                                                  />
                                                </span>

                                                {isModelMultiCsv ? (
                                                  <div className={styles.modelMultiInput}>
                                                    <div className={styles.modelMultiChips}>
                                                      {csvValues.map((id) => (
                                                        <span key={id} className={styles.modelMultiChip}>
                                                          <span className={styles.modelMultiChipText}>{id}</span>
                                                          <button
                                                            type="button"
                                                            className={styles.modelMultiChipRemove}
                                                            aria-label={`remove-${id}`}
                                                            onClick={() => removeCsvValue(id)}
                                                          >
                                                            ×
                                                          </button>
                                                        </span>
                                                      ))}
                                                      <input
                                                        className={styles.modelMultiDraftInput}
                                                        value={draft}
                                                        onChange={(e) => {
                                                          const next = e.target.value;
                                                          setDraft(next);
                                                          setModelDropdownKey(it.key);
                                                          setModelDropdownOpen(true);
                                                        }}
                                                        onKeyDown={(e) => {
                                                          if (e.key === 'Enter' || e.key === ',') {
                                                            e.preventDefault();
                                                            const parts = String(draft || '')
                                                              .split(',')
                                                              .map(s => s.trim())
                                                              .filter(Boolean);
                                                            if (parts.length) parts.forEach(addCsvValue);
                                                            return;
                                                          }
                                                          if (e.key === 'Backspace' && !draft && csvValues.length) {
                                                            removeCsvValue(csvValues[csvValues.length - 1]);
                                                          }
                                                        }}
                                                        onFocus={() => {
                                                          setModelDropdownKey(it.key);
                                                          setModelDropdownOpen(true);
                                                        }}
                                                        onBlur={() => {
                                                          setTimeout(() => setModelDropdownOpen(false), 120);
                                                        }}
                                                        placeholder={activeProvider ? (activeModelIds.length ? '添加模型（回车/逗号）' : '请先检测供应商模型') : '请先选择供应商'}
                                                      />
                                                    </div>
                                                  </div>
                                                ) : (
                                                  <>
                                                    <input
                                                      className={styles.input}
                                                      value={value}
                                                      onChange={(e) => {
                                                        updateLlmVar(it.key, e.target.value);
                                                        if (it.picker === 'model') {
                                                          setModelDropdownKey(it.key);
                                                          setModelDropdownOpen(true);
                                                        }
                                                      }}
                                                      onFocus={() => {
                                                        if (it.picker === 'model') {
                                                          setModelDropdownKey(it.key);
                                                          setModelDropdownOpen(true);
                                                        }
                                                      }}
                                                      onBlur={() => {
                                                        setTimeout(() => setModelDropdownOpen(false), 120);
                                                      }}
                                                      placeholder={activeProvider ? (activeModelIds.length ? '从供应商模型选择或手动输入' : '请先检测供应商模型') : '请先选择供应商'}
                                                    />
                                                    <span className={styles.modelInputCaps}>
                                                      {(() => {
                                                        const ov = activeProvider ? getModelOverride(activeProvider.id, value) : null;
                                                        const caps = ov?.caps && ov.caps.length ? ov.caps.map(k => ({ key: k, label: k })) : safeInferModelCapabilities(value);
                                                        return caps.map((cap) => (
                                                        <span
                                                          key={cap.key}
                                                          className={styles.modelCapIcon}
                                                          style={capStyleVars(cap.key)}
                                                          title={cap.label}
                                                          aria-label={cap.key}
                                                        >
                                                          <CapabilityIcon capKey={cap.key} />
                                                        </span>
                                                        ));
                                                      })()}
                                                    </span>
                                                  </>
                                                )}
                                              </>
                                            );
                                          })()}
                                        </div>
                                      </>
                                    ) : it.kind === 'api_key' ? (
                                      <input
                                        className={styles.input}
                                        value={value}
                                        onChange={(e) => updateLlmVar(it.key, e.target.value)}
                                        type={isSecret && !showSecretsInEnv ? 'password' : 'text'}
                                      />
                                    ) : it.kind === 'base_url' ? (
                                      <input
                                        className={styles.input}
                                        value={value}
                                        onChange={(e) => updateLlmVar(it.key, e.target.value)}
                                        onBlur={(e) => updateLlmVar(it.key, normalizeBaseUrlV1(e.target.value))}
                                        type="text"
                                        placeholder="https://.../v1"
                                      />
                                    ) : (
                                      <input
                                        className={styles.input}
                                        value={value}
                                        onChange={(e) => updateLlmVar(it.key, e.target.value)}
                                        type={isSecret && !showSecretsInEnv ? 'password' : (type === 'number' ? 'number' : 'text')}
                                      />
                                    )}
                                  </div>

                                  {it.kind === 'model' &&
                                    it.picker === 'model' &&
                                    modelDropdownOpen &&
                                    modelDropdownKey === it.key &&
                                    activeProvider &&
                                    activeModelIds.length ? (
                                    <div className={styles.modelPickerInlineRow}>
                                      <div
                                        className={styles.modelPickerInlineList}
                                        style={{ maxHeight: `${modelDropdownMaxHeight}px` }}
                                      >
                                        {activeModelIds
                                          .filter(id => modelInScope(id, inferModelScopeFromItem(it)))
                                          .filter(id => {
                                            if (isModelMultiCsv) {
                                              const draft = String(multiModelDrafts[it.key] ?? '');
                                              return draft ? id.toLowerCase().includes(draft.toLowerCase()) : true;
                                            }
                                            return value ? id.toLowerCase().includes(value.toLowerCase()) : true;
                                          })
                                          .slice(0, 80)
                                          .map(id => (
                                            <ModelOptionRow
                                              key={id}
                                              modelId={id}
                                              providerType={activeProviderType}
                                              override={getModelOverride(activeProvider.id, id)}
                                              onPick={(picked) => {
                                                if (isModelMultiCsv) {
                                                  const csvValues = parseCsvValue(String(llmVarsMap.get(it.key)?.value ?? ''));
                                                  const merged = Array.from(new Set([...csvValues, picked]));
                                                  updateLlmVar(it.key, formatCsvValue(merged));
                                                  setMultiModelDrafts(prev => ({ ...prev, [it.key]: '' }));
                                                  setModelDropdownOpen(false);
                                                  return;
                                                }
                                                updateLlmVar(it.key, picked);
                                                setModelDropdownOpen(false);
                                              }}
                                            />
                                          ))}
                                      </div>
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            ) : null}

            {(!isCompact || mobileSection === 'models') ? (
            <div className={styles.card}>
              <div className={styles.modelsHeader}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div className={styles.cardTitle}>模型</div>
                    <span className={styles.badgeOff}>{filteredModels.length}</span>
                  </div>
                  <div className={styles.cardMeta}>
                    {activeModelsEntry?.fetchedAt ? `更新时间：${new Date(activeModelsEntry.fetchedAt).toLocaleString()}` : '尚未获取（点击下方检测 /v1/models）'}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button onClick={runTestModels} disabled={busy} className={styles.primaryButton} type="button">
                    <IoFlashOutline />
                    {busy ? '检测中...' : '检测 /v1/models'}
                  </button>

                  <div className={styles.modelsSearch}>
                    <div className={styles.searchInputWrap}>
                      <span className={styles.searchIcon}>
                        <IoSearch size={16} />
                      </span>
                      <input
                        className={styles.searchInputWithIcon}
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                        placeholder="搜索模型 id / owned_by"
                      />
                    </div>
                  </div>
                </div>
              </div>

              {filteredModels.length === 0 ? (
                <div className={styles.cardMeta}>暂无模型数据，点击“检测 /v1/models”获取。</div>
              ) : (
                <BrandLogoErrorBoundary
                  resetKey={`models:${activeProvider?.id || ''}:${activeModelsEntry?.fetchedAt || 0}`}
                  fallback={<div className={styles.errorBox}>模型列表渲染失败，请重新检测或切换供应商。</div>}
                >
                  <div>
                  {groupedModels.map(({ vendor, models: ms }) => (
                    <div className={styles.modelGroup} key={vendor.key}>
                      <div className={styles.modelGroupHeader}>
                        <div className={styles.groupHeaderLeft}>
                          <span className={styles.logoRound} style={{ width: 22, height: 22 }}>
                            <BrandLogo iconName={vendor.iconName} size={16} />
                          </span>
                          <span className={styles.vendorLabel}>{vendor.label}</span>
                          <span className={styles.badgeOff}>{ms.length}</span>
                        </div>
                        <button
                          className={styles.groupToggleBtn}
                          onClick={() => setCollapsedGroups(prev => ({ ...prev, [vendor.key]: !prev[vendor.key] }))}
                          aria-label={collapsedGroups[vendor.key] ? '展开' : '折叠'}
                          title={collapsedGroups[vendor.key] ? '展开' : '折叠'}
                          type="button"
                        >
                          {collapsedGroups[vendor.key] ? <IoChevronForward /> : <IoChevronDown />}
                        </button>
                      </div>

                      {!collapsedGroups[vendor.key] ? (
                        <div className={styles.modelList}>
                          {ms.map((m, idx) => {
                            const inferred = safeInferModelVendor(m, providerTypeFallbackVendor(activeProviderType));
                            const title = m?.id != null ? String(m.id) : formatModelTitle(m);
                            const override = activeProvider ? getModelOverride(activeProvider.id, title) : null;

                            return (
                              <div className={styles.modelRow} key={String(m?.id || idx)} title={title}>
                                <div className={styles.modelLeft}>
                                  <div className={styles.logoRound}>
                                    {override?.icon ? (
                                      <CustomIcon icon={override.icon as any} size={18} />
                                    ) : (
                                      <BrandLogo iconName={inferred.iconName} size={18} />
                                    )}
                                  </div>
                                  <div style={{ minWidth: 0 }}>
                                    <div className={styles.modelTitle}>{title}</div>
                                  </div>
                                </div>

                                <div className={styles.modelRight}>
                                  <div className={styles.modelCaps}>
                                    {(override?.caps && override.caps.length ? override.caps.map(k => ({ key: k, label: k })) : safeInferModelCapabilities(title)).map((cap) => (
                                      <span
                                        key={cap.key}
                                        className={styles.modelCapIcon}
                                        style={capStyleVars(cap.key)}
                                        title={cap.label}
                                        aria-label={cap.key}
                                      >
                                        <CapabilityIcon capKey={cap.key} />
                                      </span>
                                    ))}
                                  </div>

                                  <div className={styles.modelActions}>
                                    <button
                                      className={styles.modelActionBtn}
                                      onClick={() => openModelSettings(activeProvider.id, title)}
                                      aria-label="模型设置"
                                      title="模型设置"
                                      type="button"
                                    >
                                      <IoSettingsOutline />
                                    </button>
                                    <button
                                      className={styles.modelActionBtn}
                                      onClick={() => copyText(title)}
                                      aria-label="复制模型 ID"
                                      title="复制模型 ID"
                                      type="button"
                                    >
                                      <IoCopyOutline />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ))}
                  </div>
                </BrandLogoErrorBoundary>
              )}
            </div>
            ) : null}

            {modelSettingsOpen ? (
              <div
                className={styles.modalOverlay}
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) setModelSettingsOpen(false);
                }}
              >
                <div className={styles.modalCard} role="dialog" aria-modal="true">
                  <div className={styles.modalTitle}>模型设置</div>
                  <div className={styles.modalBody}>
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

                    <div className={styles.modelSettingsActionsRow}>
                      <button className={styles.secondaryButton} type="button" onClick={() => setIconPickerOpen(true)}>
                        选择图标
                      </button>
                      <label className={styles.secondaryButton} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        上传图片
                        <input
                          type="file"
                          accept="image/*"
                          style={{ display: 'none' }}
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
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
                          }}
                        />
                      </label>
                      <button className={styles.secondaryButton} type="button" onClick={() => setModelSettingsIcon(null)}>
                        清除
                      </button>
                    </div>

                    <div className={styles.modelSettingsSectionTitle}>能力</div>
                    <div className={styles.modelSettingsCapToolbar}>
                      <div className={styles.searchInputWrap} style={{ flex: 1, maxWidth: 360 }}>
                        <span className={styles.searchIcon}><IoSearch size={16} /></span>
                        <input
                          className={styles.searchInputWithIcon}
                          value={capabilitySearch}
                          onChange={(e) => setCapabilitySearch(e.target.value)}
                          placeholder="搜索能力，例如 vision / web / embedding"
                        />
                      </div>
                      <button
                        className={styles.secondaryButton}
                        type="button"
                        onClick={() => setModelSettingsCaps(inferredModelSettingsCaps)}
                      >
                        按推断
                      </button>
                      <button
                        className={styles.secondaryButton}
                        type="button"
                        onClick={() => setModelSettingsCaps(capabilityChoices.map(c => c.key))}
                      >
                        全选
                      </button>
                      <button
                        className={styles.secondaryButton}
                        type="button"
                        onClick={() => setModelSettingsCaps([])}
                      >
                        清空
                      </button>
                    </div>

                    <div className={styles.modelSettingsCapGrid}>
                      {filteredCapabilityChoices.map(c => {
                        const on = modelSettingsCaps.includes(c.key);
                        return (
                          <button
                            key={c.key}
                            type="button"
                            className={[styles.capChip, on ? styles.capChipOn : styles.capChipOff].filter(Boolean).join(' ')}
                            style={capStyleVars(c.key)}
                            onClick={() => {
                              const next = new Set(modelSettingsCaps);
                              if (next.has(c.key)) next.delete(c.key);
                              else next.add(c.key);
                              setModelSettingsCaps(Array.from(next));
                            }}
                            title={c.key}
                          >
                            <span className={styles.capChipIcon}><CapabilityIcon capKey={c.key} /></span>
                            <span className={styles.capChipText}>{c.label}</span>
                            <span className={styles.capChipCheck} aria-hidden="true">
                              {on ? <IoCheckmarkOutline size={14} /> : null}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className={styles.modalActions}>
                    <button className={styles.secondaryButton} onClick={() => setModelSettingsOpen(false)} type="button">取消</button>
                    <button className={styles.primaryButton} onClick={saveModelSettings} type="button">保存</button>
                  </div>

                  {iconPickerOpen ? (
                    <div
                      className={styles.modalOverlay}
                      style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.25)' }}
                      onMouseDown={(e) => {
                        if (e.target === e.currentTarget) setIconPickerOpen(false);
                      }}
                    >
                      <div className={styles.modalCard} role="dialog" aria-modal="true" style={{ width: 'min(720px, calc(100% - 32px))' }}>
                        <div className={styles.modalTitle}>选择图标（Lobe Icons）</div>
                        <div className={styles.modalBody}>
                          <div className={styles.searchInputWrap} style={{ marginBottom: 10 }}>
                            <span className={styles.searchIcon}><IoSearch size={16} /></span>
                            <input
                              className={styles.searchInputWithIcon}
                              value={iconSearch}
                              onChange={(e) => setIconSearch(e.target.value)}
                              placeholder="搜索图标名，例如 OpenAI / Gemini / Qwen"
                            />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 10, maxHeight: 360, overflow: 'auto', paddingRight: 4 }}>
                            {makeLobeIconChoices(iconSearch).map((name) => (
                              <button
                                key={name}
                                type="button"
                                className={styles.modelActionBtn}
                                style={{ width: '100%', height: 54, display: 'flex', flexDirection: 'column', gap: 6 }}
                                onClick={() => {
                                  setModelSettingsIcon({ type: 'lobe', iconName: name });
                                  setIconPickerOpen(false);
                                }}
                                title={name}
                              >
                                <BrandLogo iconName={name} size={20} />
                                <span style={{ fontSize: 10, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className={styles.modalActions}>
                          <button className={styles.secondaryButton} onClick={() => setIconPickerOpen(false)} type="button">关闭</button>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {deleteTargetId ? (
        <div
          className={styles.modalOverlay}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDeleteTargetId(null);
          }}
        >
          <div className={styles.modalCard} role="dialog" aria-modal="true">
            <div className={styles.modalTitle}>删除供应商</div>
            <div className={styles.modalBody}>
              确定删除供应商「{providers.find(p => p.id === deleteTargetId)?.name || '未命名'}」？
              <br />
              此操作会同时清空该供应商的模型缓存。
            </div>
            <div className={styles.modalActions}>
              <button className={styles.secondaryButton} onClick={() => setDeleteTargetId(null)} type="button">取消</button>
              <button className={styles.dangerPrimaryButton} onClick={confirmRemoveProvider} type="button">删除</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
