import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// 获取当前模块的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载环境变量（从 sentra-mcp 目录）
const mcpRootDir = path.resolve(__dirname, '../..');
const envPath = path.join(mcpRootDir, '.env');

function loadEnv(options = {}) {
  const { override = false } = options;
  const dotenvOptions = { override };
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, ...dotenvOptions });
  } else {
    // 如果 sentra-mcp/.env 不存在，尝试加载父目录的 .env
    dotenv.config(dotenvOptions);
  }
}

loadEnv();

const bool = (v, d = false) => {
  if (v === undefined) return d;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

const int = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

const timeoutMs = (v, d) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return d;
  return Math.min(n, 900000);
};

// Parse simple comma-separated strings to string array
function parseCsv(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Parse overrides from env: keys like PREFIX__SOME_KEY=2 -> { 'SOME_KEY': 2 }
function parseConcurrencyOverrides(prefix) {
  const out = {};
  const pfx = String(prefix || '').toUpperCase();
  for (const [k, v] of Object.entries(process.env)) {
    if (!k || !k.toUpperCase().startsWith(pfx + '__')) continue;
    const name = k.substring((pfx + '__').length);
    const num = int(v, NaN);
    if (name && Number.isFinite(num)) out[name] = num;
  }
  return out;
}

function buildConfigFromEnv() {
  // Judge 模型列表（支持逗号分隔的多模型配置）
  const judgeModelEnv = process.env.JUDGE_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const judgeModels = parseCsv(judgeModelEnv);
  const primaryJudgeModel = judgeModels[0] || 'gpt-4.1-mini';

  // Plan 阶段 native 模型列表（支持逗号分隔多模型；第一个为主模型）
  const planModelEnv = process.env.PLAN_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const planModels = parseCsv(planModelEnv);
  const primaryPlanModel = planModels[0] || 'gpt-4.1-mini';

  // FC Judge 模型列表（仅在 TOOL_STRATEGY=fc 时使用，留空则回退到 FC_MODEL / JUDGE_MODEL）
  const judgeFcModels = parseCsv(process.env.JUDGE_FC_MODEL || '');
  const primaryJudgeFcModel = judgeFcModels[0] || '';

  // FC Plan 阶段模型列表（支持逗号分隔多模型；多个模型时按模型维度生成候选计划）
  const planFcModels = parseCsv(process.env.PLAN_FC_MODEL || '');
  const primaryPlanFcModel = planFcModels[0] || '';

  return {
  llm: {
    baseURL: process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    temperature: Number(process.env.OPENAI_TEMPERATURE || 0.2),
    maxTokens: int(process.env.OPENAI_MAX_TOKENS, 4096),
    timeoutMs: timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000),
    toolChoice: process.env.OPENAI_TOOL_CHOICE || 'auto',
    toolStrategy: (process.env.TOOL_STRATEGY || 'auto').toLowerCase(),
  },
  // Run-level repair / diversification controls
  runner: {
    enableRepair: bool(process.env.RUN_ENABLE_REPAIR, true),
    maxRepairs: int(process.env.RUN_MAX_REPAIRS, 1),
    retryDiversify: bool(process.env.RETRY_DIVERSIFY, true),
  },
  // 专用于 FC (<function_call>) 模式下的提供商配置；未设置时回退到 llm 配置
  fcLlm: {
    baseURL: process.env.FC_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
    apiKey: process.env.FC_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.FC_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    temperature: Number(process.env.FC_TEMPERATURE || process.env.OPENAI_TEMPERATURE || 0.2),
    maxTokens: int(process.env.FC_MAX_TOKENS, -1), // -1 表示省略 max_tokens
    timeoutMs: timeoutMs(process.env.FC_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000)),
    format: (process.env.FC_FORMAT || 'sentra').toLowerCase(),
    planMaxRetries: int(process.env.FC_PLAN_MAX_RETRIES, 3),
    argMaxRetries: int(process.env.FC_ARG_MAX_RETRIES, 3),
    evalMaxRetries: int(process.env.FC_EVAL_MAX_RETRIES, 3),
    summaryMaxRetries: int(process.env.FC_SUMMARY_MAX_RETRIES, 1),  // 默认 1 次，避免浪费
    // Stage-specific models (optional; fall back to FC_MODEL)
    // judgeModel: 主 FC Judge 模型；judgeModels: 多模型列表（按优先级从前到后）
    judgeModel: primaryJudgeFcModel,
    judgeModels: judgeFcModels,
    // planModel: 主 FC 规划模型；planModels: 规划模型列表（逗号分隔，多模型用于多计划候选）
    planModel: primaryPlanFcModel,
    planModels: planFcModels,
    argModel: process.env.ARG_FC_MODEL || '',
    evalModel: process.env.EVAL_FC_MODEL || '',
    summaryModel: process.env.SUMMARY_FC_MODEL || '',
    reflectionModel: process.env.REFLECTION_FC_MODEL || '',
    // Stage-specific providers (optional; fall back to FC_BASE_URL/FC_API_KEY)
    judgeBaseURL: process.env.JUDGE_FC_BASE_URL || process.env.FC_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
    judgeApiKey: process.env.JUDGE_FC_API_KEY || process.env.FC_API_KEY || process.env.OPENAI_API_KEY || '',
    planBaseURL: process.env.PLAN_FC_BASE_URL || process.env.FC_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
    planApiKey: process.env.PLAN_FC_API_KEY || process.env.FC_API_KEY || process.env.OPENAI_API_KEY || '',
    argBaseURL: process.env.ARG_FC_BASE_URL || process.env.FC_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
    argApiKey: process.env.ARG_FC_API_KEY || process.env.FC_API_KEY || process.env.OPENAI_API_KEY || '',
    evalBaseURL: process.env.EVAL_FC_BASE_URL || process.env.FC_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
    evalApiKey: process.env.EVAL_FC_API_KEY || process.env.FC_API_KEY || process.env.OPENAI_API_KEY || '',
    summaryBaseURL: process.env.SUMMARY_FC_BASE_URL || process.env.FC_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
    summaryApiKey: process.env.SUMMARY_FC_API_KEY || process.env.FC_API_KEY || process.env.OPENAI_API_KEY || '',
    reflectionBaseURL: process.env.REFLECTION_FC_BASE_URL || process.env.FC_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
    reflectionApiKey: process.env.REFLECTION_FC_API_KEY || process.env.FC_API_KEY || process.env.OPENAI_API_KEY || '',
    // Stage-specific request timeouts (ms). If unset, fall back to FC_TIMEOUT_MS.
    judgeTimeoutMs: timeoutMs(process.env.JUDGE_FC_TIMEOUT_MS, timeoutMs(process.env.FC_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000))),
    planTimeoutMs: timeoutMs(process.env.PLAN_FC_TIMEOUT_MS, timeoutMs(process.env.FC_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000))),
    argTimeoutMs: timeoutMs(process.env.ARG_FC_TIMEOUT_MS, timeoutMs(process.env.FC_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000))),
    evalTimeoutMs: timeoutMs(process.env.EVAL_FC_TIMEOUT_MS, timeoutMs(process.env.FC_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000))),
    summaryTimeoutMs: timeoutMs(process.env.SUMMARY_FC_TIMEOUT_MS, timeoutMs(process.env.FC_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000))),
    reflectionTimeoutMs: timeoutMs(process.env.REFLECTION_FC_TIMEOUT_MS, timeoutMs(process.env.FC_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000))),
    // Stage-specific sampling controls (optional; fall back to temperature/top_p defaults)
    planTemperature: Number(process.env.FC_PLAN_TEMPERATURE || 'NaN'),
    planTopP: Number(process.env.FC_PLAN_TOP_P || 'NaN'),
    evalTemperature: Number(process.env.FC_EVAL_TEMPERATURE || 'NaN'),
    evalTopP: Number(process.env.FC_EVAL_TOP_P || 'NaN'),
    summaryTemperature: Number(process.env.FC_SUMMARY_TEMPERATURE || 'NaN'),
    summaryTopP: Number(process.env.FC_SUMMARY_TOP_P || 'NaN'),
    reflectionMaxRetries: int(process.env.FC_REFLECTION_MAX_RETRIES, 2),
    reflectionTemperature: Number(process.env.FC_REFLECTION_TEMPERATURE || 'NaN'),
    reflectionTopP: Number(process.env.FC_REFLECTION_TOP_P || 'NaN'),
  },
  // 向量嵌入模型配置（默认复用 OPENAI_*，也可单独配置）
  embedding: {
    baseURL: process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
    apiKey: process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small',
    timeoutMs: timeoutMs(process.env.EMBEDDING_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000)),
  },
  // 记忆系统配置（启用后将把规划/工具调用摘要落库到 Redis，并支持相似检索）
  memory: {
    enable: bool(process.env.MEM_ENABLE, false),
    namespace: process.env.MEM_NAMESPACE || 'sentra-mcp',
    prefix: process.env.MEM_PREFIX || 'sentra:mcp:mem',
    topK: int(process.env.MEM_TOP_K, 5),
    toolTopK: int(process.env.MEM_TOOL_TOP_K, 3),
    minScore: Number(process.env.MEM_MIN_SCORE || 0.7),
    candidatePool: int(process.env.MEM_CANDIDATE_POOL, 200),
    onlySuccessful: bool(process.env.MEM_ONLY_SUCCESSFUL, true),
    // 高相似度复用参数：>= reuseThreshold 直接复用历史参数，跳过 LLM 参生
    enableReuse: bool(process.env.MEM_ENABLE_REUSE, true),
    reuseThreshold: Number(process.env.MEM_REUSE_THRESHOLD || 0.97),
    // RediSearch HNSW 向量索引
    enableRediSearch: bool(process.env.MEM_ENABLE_REDISEARCH, false),
    rsIndex: process.env.MEM_RS_INDEX || 'mem_idx',
    rsDim: int(process.env.MEM_RS_DIM, 0),
    rsDistance: process.env.MEM_RS_DISTANCE || 'COSINE', // COSINE | L2 | IP
    rsM: int(process.env.MEM_RS_M, 16),
    rsEfConstruction: int(process.env.MEM_RS_EF_CONSTRUCTION, 200),
    rsEfRuntime: int(process.env.MEM_RS_EF_RUNTIME, 200),
    // 工具结果向量缓存（基于 args 相似度复用结果）
    resultCache: {
      enable: bool(process.env.MEM_RESULT_CACHE_ENABLE, true),
      reuseThreshold: Number(process.env.MEM_RESULT_REUSE_THRESHOLD || process.env.MEM_REUSE_THRESHOLD || 0.97),
      ttlSeconds: int(process.env.MEM_RESULT_TTL_SEC, 86400),
      allowlist: parseCsv(process.env.MEM_RESULT_CACHE_ALLOWLIST),
      denylist: parseCsv(process.env.MEM_RESULT_CACHE_DENYLIST),
    },
  },
  summarizer: {
    baseURL: process.env.SUMMARIZER_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
    apiKey: process.env.SUMMARIZER_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.SUMMARIZER_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    temperature: Number(process.env.SUMMARIZER_TEMPERATURE || 0.1),
    timeoutMs: timeoutMs(process.env.SUMMARIZER_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000)),
  },
  // 工具候选重排序（ReRank）配置
  rerank: {
    enable: !(String(process.env.RERANK_ENABLE || 'true').toLowerCase() === 'false'),
    baseURL: process.env.RERANK_BASE_URL || '',
    apiKey: process.env.RERANK_API_KEY || '',
    model: process.env.RERANK_MODEL || 'BAAI/bge-reranker-v2-m3',
    candidateK: int(process.env.RERANK_CANDIDATE_K, 50),
    topN: int(process.env.RERANK_TOP_N, 12),
    useDescFallback: String(process.env.RERANK_USE_DESC_FALLBACK || 'false').toLowerCase() === 'true',
    timeoutMs: timeoutMs(process.env.RERANK_TIMEOUT_MS, 180000),
    maxSubqueries: int(process.env.RERANK_MAX_SUBQUERIES, 5),
    aggAlpha: Number(process.env.RERANK_AGG_ALPHA || 0.1),  // frequency weight
    aggBeta: Number(process.env.RERANK_AGG_BETA || 0.5),   // score weight
    aggGamma: Number(process.env.RERANK_AGG_GAMMA || 0.4), // reciprocal rank weight
  },
  // 工具调用判定模型（在计划与执行前判断是否需要调用工具）
  judge: {
    baseURL: process.env.JUDGE_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
    apiKey: process.env.JUDGE_API_KEY || process.env.OPENAI_API_KEY || '',
    // model: 主 Judge 模型；models: 多模型列表（按优先级从前到后）
    model: primaryJudgeModel,
    models: judgeModels,
    temperature: Number(process.env.JUDGE_TEMPERATURE || 0.1),
    maxTokens: int(process.env.JUDGE_MAX_TOKENS, -1),
    timeoutMs: timeoutMs(process.env.JUDGE_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000)),
    raceTimeoutMs: int(process.env.JUDGE_RACE_TIMEOUT_MS, 12000),
  },

  // 规划阶段（native/auto 模式使用）模型配置
  plan: {
    model: primaryPlanModel,
    models: planModels,
    timeoutMs: timeoutMs(process.env.PLAN_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000)),
  },
  // 中文：思考/预推演专用模型（与工具调用的 LLM 分离，避免相互覆盖）
  reasoner: {
    baseURL: process.env.REASONER_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
    apiKey: process.env.REASONER_API_KEY || process.env.OPENAI_API_KEY || '',
    model: process.env.REASONER_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    temperature: Number(process.env.REASONER_TEMPERATURE || process.env.OPENAI_TEMPERATURE || 0.2),
    // -1 或未设置表示“不限制/由服务端决定”，调用时将省略 max_tokens
    maxTokens: int(process.env.REASONER_MAX_TOKENS, -1),
    timeoutMs: timeoutMs(process.env.REASONER_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000)),
  },
  planner: {
    maxSteps: int(process.env.PLAN_MAX_STEPS, 8),
    maxConcurrency: int(process.env.PLAN_MAX_CONCURRENCY, 3),
    totalTimeBudgetMs: int(process.env.PLAN_TOTAL_TIME_BUDGET_MS, 60000),
    toolTimeoutMs: int(process.env.TOOL_TIMEOUT_MS, 15000),
    cooldownDefaultMs: int(process.env.TOOL_COOLDOWN_DEFAULT_MS, 2000),
    // Plan audit controls
    auditEnable: bool(process.env.PLAN_AUDIT_ENABLE, true),
    auditVoters: int(process.env.PLAN_AUDIT_VOTERS, 1),
    // Per-tool/provider concurrency
    toolConcurrencyDefault: int(process.env.PLANNER_TOOL_CONCURRENCY_DEFAULT, 1),
    providerConcurrencyDefault: int(process.env.PLANNER_PROVIDER_CONCURRENCY_DEFAULT, 4),
    toolConcurrency: parseConcurrencyOverrides('PLANNER_TOOL_CONCURRENCY'),
    providerConcurrency: parseConcurrencyOverrides('PLANNER_PROVIDER_CONCURRENCY'),
    // Call-level cooldown retry (prefer 0 to let scheduler handle delayed rescheduling)
    cooldownFunctionRetry: int(process.env.TOOL_COOLDOWN_FUNC_RETRY, 0),
    // Tool result cache: aiName + args hash -> result (success only)
    toolCache: {
      enable: bool(process.env.TOOL_CACHE_ENABLE, false),
      ttlSeconds: int(process.env.TOOL_CACHE_TTL_SEC, 600),
      allowlist: parseCsv(process.env.TOOL_CACHE_ALLOWLIST), // empty means no restriction
      denylist: parseCsv(process.env.TOOL_CACHE_DENYLIST),
    },
  },
  schedule: {
    // 工具级 schedule 策略：哪些 aiName 可以“立即执行 + 延迟发送”，哪些必须“到点再执行”
    immediateAllowlist: parseCsv(process.env.SCHEDULE_IMMEDIATE_AI_ALLOWLIST),
    immediateDenylist: parseCsv(process.env.SCHEDULE_IMMEDIATE_AI_DENYLIST),
  },
  governance: {
    defaultScope: process.env.DEFAULT_SCOPE || 'global',
    defaultTenantId: process.env.DEFAULT_TENANT_ID || 'default',
  },
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: int(process.env.REDIS_PORT, 6379),
    db: int(process.env.REDIS_DB, 0),
    password: process.env.REDIS_PASSWORD || undefined,
    metricsPrefix: process.env.REDIS_METRICS_PREFIX || 'sentra:mcp:metrics',
    contextPrefix: process.env.REDIS_CONTEXT_PREFIX || 'sentra:mcp:ctx',
  },
  server: {
    transport: (process.env.MCP_SERVER_TRANSPORT || 'stdio').toLowerCase(),
    httpPort: int(process.env.HTTP_PORT, 3000),
    allowedHosts: (process.env.ALLOWED_HOSTS || '127.0.0.1,localhost')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  flags: {
    enableToolStreaming: bool(process.env.ENABLE_TOOL_STREAMING, false),
    enableHistorySummary: bool(process.env.ENABLE_HISTORY_SUMMARY, true),
    historySummaryTrigger: int(process.env.HISTORY_SUMMARY_TRIGGER, 8000),
    enableVerboseSteps: bool(process.env.ENABLE_VERBOSE_STEPS, false),
    verbosePreviewMax: int(process.env.VERBOSE_PREVIEW_MAX, 400),
    toolPreReplySingleSkipTools: parseCsv(process.env.TOOL_PREREPLY_SINGLE_SKIP_TOOLS),
    // Context summarization controls for step argument generation
    contextMaxDepth: int(process.env.CONTEXT_MAX_DEPTH, 2),
    contextStringMax: int(process.env.CONTEXT_STRING_MAX, 160),
    contextPreviewKeys: int(process.env.CONTEXT_PREVIEW_KEYS, 8),
    contextPreviewArrayItems: int(process.env.CONTEXT_PREVIEW_ARRAY_ITEMS, 3),
    recentContextLimit: int(process.env.RECENT_CONTEXT_LIMIT, 5),
    // Evaluation & retry controls
    evalRetryOnFail: bool(process.env.EVAL_RETRY_ON_FAIL, true),
    evalMaxRetries: int(process.env.EVAL_MAX_RETRIES, 1),
    // Whether to inject preThought into evaluation/summarizer stages
    evalUsePreThought: bool(process.env.EVAL_USE_PRETHOUGHT, false),
    summaryUsePreThought: bool(process.env.SUMMARY_USE_PRETHOUGHT, false),
    // Whether to run preThought in planning stages (native & FC)
    planUsePreThought: bool(process.env.PLAN_USE_PRETHOUGHT, false),
    // Reflection (task completeness check before summary)
    enableReflection: bool(process.env.ENABLE_REFLECTION, true),
    reflectionMaxSupplements: int(process.env.REFLECTION_MAX_SUPPLEMENTS, 3),
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || 'logs',
    // Console display options
    timestampLocal: bool(process.env.LOG_TIMESTAMP_LOCAL, true),
    colorMeta: bool(process.env.LOG_COLOR_META, true),
    dimMeta: bool(process.env.LOG_DIM_META, false),
    prettyLabels: (process.env.LOG_PRETTY_LABELS || 'PLAN,PLAN_STEP,STEP,ARGS,RESULT,PLUGIN,REDIS,MCP,RUN,EVAL,RETRY')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  };
}

export const config = buildConfigFromEnv();

export function reloadConfig() {
  loadEnv({ override: true });
  const next = buildConfigFromEnv();
  Object.assign(config, next);
}

/**
 * 获取指定阶段的模型配置
 * @param {string} stage - 阶段名称: 'judge' | 'plan' | 'arg' | 'eval' | 'summary' | 'reflection'
 * @returns {string} 模型名称
 * 
 * 逻辑：
 * 1. 如果 TOOL_STRATEGY=fc，优先使用 {STAGE}_FC_MODEL
 * 2. 如果未设置，回退到 FC_MODEL
 * 3. 如果 FC_MODEL 也未设置，回退到对应阶段的 native model（如 JUDGE_MODEL）
 */
export function getStageModel(stage) {
  const strategy = config.llm?.toolStrategy || 'auto';
  const fcLlm = config.fcLlm;
  
  if (strategy === 'fc' || strategy === 'auto') {
    // FC 模式：优先使用阶段专用的 FC 模型
    const stageModelMap = {
      judge: fcLlm.judgeModel,
      plan: fcLlm.planModel,
      arg: fcLlm.argModel,
      eval: fcLlm.evalModel,
      summary: fcLlm.summaryModel,
      reflection: fcLlm.reflectionModel,
    };
    
    const stageModel = stageModelMap[stage];
    if (stageModel) return stageModel;
    
    // 回退到 FC_MODEL
    if (fcLlm.model) return fcLlm.model;
  }
  
  // Native 模式或兜底：使用对应阶段的 native model
  const nativeModelMap = {
    judge: config.judge?.model,
    plan: config.plan?.model || config.llm?.model,
    arg: config.llm?.model,
    eval: config.llm?.model,
    summary: config.summarizer?.model,
    reflection: config.llm?.model,
  };
  
  return nativeModelMap[stage] || config.llm?.model || 'gpt-4.1-mini';
}

export function getStageProvider(stage) {
  const strategy = config.llm?.toolStrategy || 'auto';
  const fc = config.fcLlm || {};

  if (strategy === 'fc' || strategy === 'auto') {
    const stageProviderMap = {
      judge: { baseURL: fc.judgeBaseURL, apiKey: fc.judgeApiKey },
      plan: { baseURL: fc.planBaseURL, apiKey: fc.planApiKey },
      arg: { baseURL: fc.argBaseURL, apiKey: fc.argApiKey },
      eval: { baseURL: fc.evalBaseURL, apiKey: fc.evalApiKey },
      summary: { baseURL: fc.summaryBaseURL, apiKey: fc.summaryApiKey },
      reflection: { baseURL: fc.reflectionBaseURL, apiKey: fc.reflectionApiKey },
    };
    const pick = stageProviderMap[stage];
    if (pick?.baseURL || pick?.apiKey) {
      return {
        baseURL: pick.baseURL || fc.baseURL,
        apiKey: pick.apiKey || fc.apiKey,
      };
    }
    return { baseURL: fc.baseURL, apiKey: fc.apiKey };
  }

  const nativeProviderMap = {
    judge: { baseURL: config.judge?.baseURL, apiKey: config.judge?.apiKey },
    plan: { baseURL: config.llm?.baseURL, apiKey: config.llm?.apiKey },
    arg: { baseURL: config.llm?.baseURL, apiKey: config.llm?.apiKey },
    eval: { baseURL: config.llm?.baseURL, apiKey: config.llm?.apiKey },
    summary: { baseURL: config.summarizer?.baseURL, apiKey: config.summarizer?.apiKey },
    reflection: { baseURL: config.llm?.baseURL, apiKey: config.llm?.apiKey },
  };
  return nativeProviderMap[stage] || { baseURL: config.llm?.baseURL, apiKey: config.llm?.apiKey };
}

export function getStageTimeoutMs(stage) {
  const strategy = config.llm?.toolStrategy || 'auto';
  const fc = config.fcLlm || {};

  const normalizeMs = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };

  const globalDefault = normalizeMs(config.llm?.timeoutMs, 60000);

  // FC mode (or auto that may run FC fallbacks)
  if (strategy === 'fc' || strategy === 'auto') {
    const fcDefault = normalizeMs(fc.timeoutMs, globalDefault);
    const stageMap = {
      judge: fc.judgeTimeoutMs,
      plan: fc.planTimeoutMs,
      arg: fc.argTimeoutMs,
      eval: fc.evalTimeoutMs,
      summary: fc.summaryTimeoutMs,
      reflection: fc.reflectionTimeoutMs,
    };
    const v = stageMap[stage];
    return normalizeMs(v, fcDefault);
  }

  // Native mode
  const stageMap = {
    judge: config.judge?.timeoutMs,
    plan: config.plan?.timeoutMs,
    arg: config.llm?.timeoutMs,
    eval: config.llm?.timeoutMs,
    summary: config.summarizer?.timeoutMs,
    reflection: config.llm?.timeoutMs,
  };
  return normalizeMs(stageMap[stage], globalDefault);
}
