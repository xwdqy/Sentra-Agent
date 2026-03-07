import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

// 鑾峰彇褰撳墠妯″潡鐨勭洰褰?
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXED_MEM_PREFIX = 'sentra_mcp_mem';
const FIXED_METRICS_PREFIX = 'sentra_mcp_metrics';
const FIXED_CONTEXT_PREFIX = 'sentra_mcp_ctx';

// 鍔犺浇鐜鍙橀噺锛堜粠 sentra-mcp 鐩綍锛?
const mcpRootDir = path.resolve(__dirname, '../..');
const envPath = path.join(mcpRootDir, '.env');

function loadEnv(options = {}) {
  const { override = false } = options;
  const dotenvOptions = { override };
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, ...dotenvOptions });
  } else {
    // 濡傛灉 sentra-mcp/.env 涓嶅瓨鍦紝灏濊瘯鍔犺浇鐖剁洰褰曠殑 .env
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
  // Judge 妯″瀷鍒楄〃锛堟敮鎸侀€楀彿鍒嗛殧鐨勫妯″瀷閰嶇疆锛?
  const judgeModelEnv = process.env.JUDGE_MODEL || process.env.OPENAI_MODEL || 'grok-4.1';
  const judgeModels = parseCsv(judgeModelEnv);
  const primaryJudgeModel = judgeModels[0] || 'grok-4.1';

  // Plan 闃舵 native 妯″瀷鍒楄〃锛堟敮鎸侀€楀彿鍒嗛殧澶氭ā鍨嬶紱绗竴涓负涓绘ā鍨嬶級
  const planModelEnv = process.env.PLAN_MODEL || process.env.OPENAI_MODEL || 'grok-4.1';
  const planModels = parseCsv(planModelEnv);
  const primaryPlanModel = planModels[0] || 'grok-4.1';

  // FC Judge 妯″瀷鍒楄〃锛堜粎鍦?TOOL_STRATEGY=fc 鏃朵娇鐢紝鐣欑┖鍒欏洖閫€鍒?FC_MODEL / JUDGE_MODEL锛?
  const judgeFcModels = parseCsv(process.env.JUDGE_FC_MODEL || '');
  const primaryJudgeFcModel = judgeFcModels[0] || '';

  // FC Plan 闃舵妯″瀷鍒楄〃锛堟敮鎸侀€楀彿鍒嗛殧澶氭ā鍨嬶紱澶氫釜妯″瀷鏃舵寜妯″瀷缁村害鐢熸垚鍊欓€夎鍒掞級
  const planFcModels = parseCsv(process.env.PLAN_FC_MODEL || '');
  const primaryPlanFcModel = planFcModels[0] || '';

  return {
    llm: {
      baseURL: process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
      apiKey: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_MODEL || 'grok-4.1',
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
    // 涓撶敤浜?FC (<function_call>) 妯″紡涓嬬殑鎻愪緵鍟嗛厤缃紱鏈缃椂鍥為€€鍒?llm 閰嶇疆
    fcLlm: {
      baseURL: process.env.FC_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
      apiKey: process.env.FC_API_KEY || process.env.OPENAI_API_KEY || '',
      model: process.env.FC_MODEL || process.env.OPENAI_MODEL || 'grok-4.1',
      temperature: Number(process.env.FC_TEMPERATURE || process.env.OPENAI_TEMPERATURE || 0.2),
      maxTokens: int(process.env.FC_MAX_TOKENS, -1), // -1 琛ㄧず鐪佺暐 max_tokens
      timeoutMs: timeoutMs(process.env.FC_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000)),
      format: (process.env.FC_FORMAT || 'sentra').toLowerCase(),
      planMaxRetries: int(process.env.FC_PLAN_MAX_RETRIES, 3),
      argMaxRetries: int(process.env.FC_ARG_MAX_RETRIES, 3),
      evalMaxRetries: int(process.env.FC_EVAL_MAX_RETRIES, 3),
      summaryMaxRetries: int(process.env.FC_SUMMARY_MAX_RETRIES, 1),  // 榛樿 1 娆★紝閬垮厤娴垂
      // Stage-specific models (optional; fall back to FC_MODEL)
      // judgeModel: 涓?FC Judge 妯″瀷锛沯udgeModels: 澶氭ā鍨嬪垪琛紙鎸変紭鍏堢骇浠庡墠鍒板悗锛?
      judgeModel: primaryJudgeFcModel,
      judgeModels: judgeFcModels,
      // planModel: 涓?FC 瑙勫垝妯″瀷锛沺lanModels: 瑙勫垝妯″瀷鍒楄〃锛堥€楀彿鍒嗛殧锛屽妯″瀷鐢ㄤ簬澶氳鍒掑€欓€夛級
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
    // 鍚戦噺宓屽叆妯″瀷閰嶇疆锛堥粯璁ゅ鐢?OPENAI_*锛屼篃鍙崟鐙厤缃級
    embedding: {
      baseURL: process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
      apiKey: process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_EMBEDDING_MODEL || 'qwen3-embedding-4b',
      timeoutMs: timeoutMs(process.env.EMBEDDING_TIMEOUT_MS, 30000),
    },
    // 璁板繂绯荤粺閰嶇疆锛堝惎鐢ㄥ悗灏嗘妸瑙勫垝/宸ュ叿璋冪敤鎽樿钀藉簱鍒?Redis锛屽苟鏀寔鐩镐技妫€绱級
    memory: {
      enable: bool(process.env.MEM_ENABLE, false),
      prefix: FIXED_MEM_PREFIX,
      // 楂樼浉浼煎害澶嶇敤鍙傛暟锛?= reuseThreshold 鐩存帴澶嶇敤鍘嗗彶鍙傛暟锛岃烦杩?LLM 鍙傜敓
      reuseThreshold: Number(process.env.MEM_REUSE_THRESHOLD || 0.97),
      // 宸ュ叿缁撴灉鍚戦噺缂撳瓨锛堝熀浜?args 鐩镐技搴﹀鐢ㄧ粨鏋滐級
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
      model: process.env.SUMMARIZER_MODEL || process.env.OPENAI_MODEL || 'grok-4.1',
      temperature: Number(process.env.SUMMARIZER_TEMPERATURE || 0.1),
      timeoutMs: timeoutMs(process.env.SUMMARIZER_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000)),
    },
    truncation: {
      evaluate: {
        feedbackContentMaxTokens: 300,
        feedbackExcerptMaxTokens: 120,
        rawOutputMaxTokens: 1000,
      },
      summary: {
        toolArgsPreviewMaxTokens: 64,
        feedbackExcerptMaxTokens: 72,
        rawOutputMaxTokens: 1000,
      }
    },
    // 宸ュ叿鍊欓€夐噸鎺掑簭锛圧eRank锛夐厤缃?
    rerank: {
      enable: !(String(process.env.RERANK_ENABLE || 'true').toLowerCase() === 'false'),
      baseURL: process.env.RERANK_BASE_URL || '',
      apiKey: process.env.RERANK_API_KEY || '',
      model: process.env.RERANK_MODEL || 'BAAI/bge-reranker-v2-m3',
      timeoutMs: timeoutMs(process.env.RERANK_TIMEOUT_MS, 20000),
      errorPreviewMaxTokens: 120,
      queryMaxTokens: 256,
      signalTextMaxTokens: 320,
      ruleMatchMaxTokens: 640,
      toolDocMaxTokens: 1024,
      triggerKeywordMaxItems: 64,
      triggerPatternMaxItems: 32,
      triggerKeywordMaxTokens: 80,
      triggerPatternMaxTokens: 160,
      regexPatternMaxTokens: 160,
    },
    // 宸ュ叿璋冪敤鍒ゅ畾妯″瀷锛堝湪璁″垝涓庢墽琛屽墠鍒ゆ柇鏄惁闇€瑕佽皟鐢ㄥ伐鍏凤級
    judge: {
      baseURL: process.env.JUDGE_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
      apiKey: process.env.JUDGE_API_KEY || process.env.OPENAI_API_KEY || '',
      // model: 涓?Judge 妯″瀷锛沵odels: 澶氭ā鍨嬪垪琛紙鎸変紭鍏堢骇浠庡墠鍒板悗锛?
      model: primaryJudgeModel,
      models: judgeModels,
      temperature: Number(process.env.JUDGE_TEMPERATURE || 0.1),
      maxTokens: int(process.env.JUDGE_MAX_TOKENS, -1),
      timeoutMs: timeoutMs(process.env.JUDGE_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000)),
      raceTimeoutMs: int(process.env.JUDGE_RACE_TIMEOUT_MS, 12000),
    },

    // 瑙勫垝闃舵锛坣ative/auto 妯″紡浣跨敤锛夋ā鍨嬮厤缃?
    plan: {
      model: primaryPlanModel,
      models: planModels,
      timeoutMs: timeoutMs(process.env.PLAN_TIMEOUT_MS, timeoutMs(process.env.OPENAI_TIMEOUT_MS, 180000)),
    },
    // 涓枃锛氭€濊€?棰勬帹婕斾笓鐢ㄦā鍨嬶紙涓庡伐鍏疯皟鐢ㄧ殑 LLM 鍒嗙锛岄伩鍏嶇浉浜掕鐩栵級
    reasoner: {
      baseURL: process.env.REASONER_BASE_URL || process.env.OPENAI_BASE_URL || 'https://yuanplus.chat/v1',
      apiKey: process.env.REASONER_API_KEY || process.env.OPENAI_API_KEY || '',
      model: process.env.REASONER_MODEL || process.env.OPENAI_MODEL || 'grok-4.1',
      temperature: Number(process.env.REASONER_TEMPERATURE || process.env.OPENAI_TEMPERATURE || 0.2),
      // -1 鎴栨湭璁剧疆琛ㄧず鈥滀笉闄愬埗/鐢辨湇鍔＄鍐冲畾鈥濓紝璋冪敤鏃跺皢鐪佺暐 max_tokens
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
      // 宸ュ叿绾?schedule 绛栫暐锛氬摢浜?aiName 鍙互鈥滅珛鍗虫墽琛?+ 寤惰繜鍙戦€佲€濓紝鍝簺蹇呴』鈥滃埌鐐瑰啀鎵ц鈥?
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
      metricsPrefix: FIXED_METRICS_PREFIX,
      contextPrefix: FIXED_CONTEXT_PREFIX,
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
      // Verbose stage logs are always on (no env toggle) so PLAN/ARGS/RESULT/EVAL traces remain visible.
      enableVerboseSteps: true,
      enableToolStreaming: bool(process.env.ENABLE_TOOL_STREAMING, false),
      // Rolling recent context controls
      recentContextLimit: int(process.env.RECENT_CONTEXT_LIMIT, 5),
      // Whether to inject preThought into evaluation/summarizer stages
      evalUsePreThought: bool(process.env.EVAL_USE_PRETHOUGHT, false),
      enableSummary: true,
      summaryUsePreThought: bool(process.env.SUMMARY_USE_PRETHOUGHT, false),
      // Whether to run preThought in planning stages (native & FC)
      planUsePreThought: bool(process.env.PLAN_USE_PRETHOUGHT, false),
      // Reflection (task completeness check before summary)
      enableReflection: bool(process.env.ENABLE_REFLECTION, true),
      reflectionMaxSupplements: int(process.env.REFLECTION_MAX_SUPPLEMENTS, 3),
    },
    logging: {
      level: process.env.LOG_LEVEL || 'info',
      dir: 'logs',
      // Console display options
      timestampLocal: true,
      colorMeta: true,
      dimMeta: false,
      prettyLabels: 'PLAN,PLAN_STEP,STEP,ARGS,RESULT,PLUGIN,REDIS,MCP,RUN,EVAL,RETRY'
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
 * 鑾峰彇鎸囧畾闃舵鐨勬ā鍨嬮厤缃?
 * @param {string} stage - 闃舵鍚嶇О: 'judge' | 'plan' | 'arg' | 'eval' | 'summary' | 'reflection'
 * @returns {string} 妯″瀷鍚嶇О
 * 
 * 閫昏緫锛?
 * 1. 濡傛灉 TOOL_STRATEGY=fc锛屼紭鍏堜娇鐢?{STAGE}_FC_MODEL
 * 2. 濡傛灉鏈缃紝鍥為€€鍒?FC_MODEL
 * 3. 濡傛灉 FC_MODEL 涔熸湭璁剧疆锛屽洖閫€鍒板搴旈樁娈电殑 native model锛堝 JUDGE_MODEL锛?
 */
export function getStageModel(stage) {
  const strategy = config.llm?.toolStrategy || 'auto';
  const fcLlm = config.fcLlm;

  if (strategy === 'fc' || strategy === 'auto') {
    // FC 妯″紡锛氫紭鍏堜娇鐢ㄩ樁娈典笓鐢ㄧ殑 FC 妯″瀷
    const stageModelMap = {
      judge: fcLlm.judgeModel,
      plan: fcLlm.planModel,
      arg: fcLlm.argModel,
      eval: fcLlm.evalModel,
      mini_eval: fcLlm.evalModel,
      summary: fcLlm.summaryModel,
      reflection: fcLlm.reflectionModel,
    };

    const stageModel = stageModelMap[stage];
    if (stageModel) return stageModel;

    // 鍥為€€鍒?FC_MODEL
    if (fcLlm.model) return fcLlm.model;
  }

  // Native 妯″紡鎴栧厹搴曪細浣跨敤瀵瑰簲闃舵鐨?native model
  const nativeModelMap = {
    judge: config.judge?.model,
    plan: config.plan?.model || config.llm?.model,
    arg: config.llm?.model,
    eval: config.llm?.model,
    mini_eval: config.llm?.model,
    summary: config.summarizer?.model,
    reflection: config.llm?.model,
  };

  return nativeModelMap[stage] || config.llm?.model || 'grok-4.1';
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
      mini_eval: { baseURL: fc.evalBaseURL, apiKey: fc.evalApiKey },
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
    mini_eval: { baseURL: config.llm?.baseURL, apiKey: config.llm?.apiKey },
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
      mini_eval: fc.evalTimeoutMs,
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
    mini_eval: config.llm?.timeoutMs,
    summary: config.summarizer?.timeoutMs,
    reflection: config.llm?.timeoutMs,
  };
  return normalizeMs(stageMap[stage], globalDefault);
}
