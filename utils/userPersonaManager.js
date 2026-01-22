/**
 * 用户画像管理器 - 基于 LLM 的渐进式用户认知构建系统
 * 
 * 核心功能：
 * 1. 按 sender_id 分类存储用户消息历史
 * 2. 每 N 条消息触发一次画像分析和优化
 * 3. 初期构建认知大纲，后续不断细化
 * 4. 使用 LLM 分析用户特征，生成中文画像
 * 
 * 设计参考：
 * - Episodic Memory: LLM-Generated Summaries
 * - Dynamic Persona Modeling: Incremental Refinement
 * - Hybrid Memory: Short-term + Long-term
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractXMLTag, extractAllXMLTags } from './xmlUtils.js';
import { escapeXml, escapeXmlAttr, unescapeXml } from './xmlUtils.js';
import { createLogger } from './logger.js';
import { getEnv, getEnvInt, getEnvBool, onEnvReload } from './envHotReloader.js';
import { loadPrompt } from '../prompts/loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger('PersonaManager');

const PERSONA_INITIAL_PROMPT_NAME = 'persona_initial';
const PERSONA_REFINE_PROMPT_NAME = 'persona_refine';

let cachedPersonaInitialSystemPrompt = null;
let cachedPersonaRefineSystemPrompt = null;

// 移除 tools 定义，统一使用 XML 解析

class UserPersonaManager {
  constructor(options = {}) {
    // 配置参数
    this.agent = options.agent; // Agent 实例（必需）
    if (!this.agent) {
      throw new Error('UserPersonaManager requires an agent instance');
    }
    this.enabled = true;
    this.dataDir = options.dataDir || path.join(process.cwd(), 'userData');
    
    this.updateIntervalMs = 600000;
    this.minMessagesForUpdate = 10;
    this.maxHistorySize = 100;
    this.model = 'gpt-4.1-mini';
    this.recentMessagesCount = 40;
    this.halfLifeMs = 172800000;
    this.maxTraits = 6;
    this.maxInterests = 8;
    this.maxPatterns = 6;
    this.maxInsights = 6;

    this._applyConfig(this._getRuntimeDefaults(), options);
    
    // 内存缓存 - 减少文件读写
    this.cache = new Map(); // sender_id -> { persona, messages, messageCount }
    
    // 待执行更新的标记 - 防止同一时间多次触发
    this.pendingUpdates = new Set(); // sender_id
    
    // 确保数据目录存在
    this._ensureDataDir();

    onEnvReload(() => {
      try {
        this._applyConfig(this._getRuntimeDefaults(), {});
      } catch (e) {
        logger.warn('画像配置热更新失败（已忽略）', { err: String(e) });
      }
    });
    
    logger.config('用户画像管理器初始化', {
      '数据目录': this.dataDir,
      '时间间隔': `${this.updateIntervalMs / 60000} 分钟`,
      '消息阈值': `至少 ${this.minMessagesForUpdate} 条新消息`,
      '使用模型': this.model,
      '最大历史': `${this.maxHistorySize} 条消息`,
      '最近消息窗口': `${this.recentMessagesCount} 条`,
      '半衰期(ms)': this.halfLifeMs,
      'TopK-特征/兴趣/模式/洞察': `${this.maxTraits}/${this.maxInterests}/${this.maxPatterns}/${this.maxInsights}`
    });
  }

  /**
   * 确保数据目录存在
   */
  _ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
      logger.success(`创建数据目录: ${this.dataDir}`);
    }
  }

  _getRuntimeDefaults() {
    return {
      enabled: getEnvBool('ENABLE_USER_PERSONA', true),
      dataDir: getEnv('PERSONA_DATA_DIR', './userData'),
      updateIntervalMs: getEnvInt('PERSONA_UPDATE_INTERVAL_MS', 600000),
      minMessagesForUpdate: getEnvInt('PERSONA_MIN_MESSAGES', 10),
      maxHistorySize: getEnvInt('PERSONA_MAX_HISTORY', 100),
      model: getEnv('PERSONA_MODEL', 'gpt-4.1-mini'),
      baseUrl: getEnv('PERSONA_BASE_URL', getEnv('API_BASE_URL', 'https://yuanplus.chat/v1')),
      apiKey: getEnv('PERSONA_API_KEY', getEnv('API_KEY')),
      recentMessagesCount: getEnvInt('PERSONA_RECENT_MESSAGES', 40),
      halfLifeMs: getEnvInt('PERSONA_HALFLIFE_MS', 172800000),
      maxTraits: getEnvInt('PERSONA_MAX_TRAITS', 6),
      maxInterests: getEnvInt('PERSONA_MAX_INTERESTS', 8),
      maxPatterns: getEnvInt('PERSONA_MAX_PATTERNS', 6),
      maxInsights: getEnvInt('PERSONA_MAX_INSIGHTS', 6)
    };
  }

  _applyConfig(defaults, overrides) {
    const cfg = { ...(defaults || {}), ...(overrides || {}) };

    this.enabled = !!cfg.enabled;

    const nextDir = typeof cfg.dataDir === 'string' && cfg.dataDir.trim()
      ? cfg.dataDir.trim()
      : this.dataDir;
    if (nextDir && nextDir !== this.dataDir) {
      this.dataDir = nextDir;
      this._ensureDataDir();
    }

    const nextUpdateIntervalMs = Number(cfg.updateIntervalMs);
    this.updateIntervalMs = Number.isFinite(nextUpdateIntervalMs) && nextUpdateIntervalMs > 0
      ? nextUpdateIntervalMs
      : this.updateIntervalMs;

    const nextMinMessages = Number(cfg.minMessagesForUpdate);
    this.minMessagesForUpdate = Number.isFinite(nextMinMessages) && nextMinMessages > 0
      ? nextMinMessages
      : this.minMessagesForUpdate;

    const nextMaxHistorySize = Number(cfg.maxHistorySize);
    this.maxHistorySize = Number.isFinite(nextMaxHistorySize) && nextMaxHistorySize > 0
      ? nextMaxHistorySize
      : this.maxHistorySize;

    const nextModel = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : this.model;
    this.model = nextModel;

    const nextBaseUrl = typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim() ? cfg.baseUrl.trim() : this.baseUrl;
    this.baseUrl = nextBaseUrl;

    const nextApiKey = typeof cfg.apiKey === 'string' && cfg.apiKey.trim() ? cfg.apiKey.trim() : this.apiKey;
    this.apiKey = nextApiKey;

    const nextRecentMessagesCount = Number(cfg.recentMessagesCount);
    this.recentMessagesCount = Number.isFinite(nextRecentMessagesCount) && nextRecentMessagesCount > 0
      ? nextRecentMessagesCount
      : this.recentMessagesCount;

    const nextHalfLifeMs = Number(cfg.halfLifeMs);
    this.halfLifeMs = Number.isFinite(nextHalfLifeMs) && nextHalfLifeMs > 0
      ? nextHalfLifeMs
      : this.halfLifeMs;

    const nextMaxTraits = Number(cfg.maxTraits);
    this.maxTraits = Number.isFinite(nextMaxTraits) && nextMaxTraits > 0 ? nextMaxTraits : this.maxTraits;
    const nextMaxInterests = Number(cfg.maxInterests);
    this.maxInterests = Number.isFinite(nextMaxInterests) && nextMaxInterests > 0 ? nextMaxInterests : this.maxInterests;
    const nextMaxPatterns = Number(cfg.maxPatterns);
    this.maxPatterns = Number.isFinite(nextMaxPatterns) && nextMaxPatterns > 0 ? nextMaxPatterns : this.maxPatterns;
    const nextMaxInsights = Number(cfg.maxInsights);
    this.maxInsights = Number.isFinite(nextMaxInsights) && nextMaxInsights > 0 ? nextMaxInsights : this.maxInsights;
  }

  /**
   * 获取用户数据文件路径
   */
  _getUserFilePath(senderId) {
    // 安全的文件名（移除特殊字符）
    const safeId = String(senderId).replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dataDir, `${safeId}.json`);
  }

  /**
   * 加载用户数据
   */
  _loadUserData(senderId) {
    // 先从缓存读取
    if (this.cache.has(senderId)) {
      return this.cache.get(senderId);
    }

    const filePath = this._getUserFilePath(senderId);
    
    if (!fs.existsSync(filePath)) {
      // 新用户，创建初始数据结构
      const initialData = {
        senderId,
        persona: null, // 尚未构建画像
        messages: [], // 消息历史
        messageCount: 0, // 总消息数
        lastUpdateCount: 0, // 上次更新时的消息数
        lastUpdateTime: null, // 上次更新的时间戳（毫秒）
        lastAttemptTime: null, // 上次尝试更新的时间戳（毫秒，包含失败）
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 0, // 画像版本号
        personaStats: {
          traits: {},
          interests: {},
          patterns: {},
          insights: {}
        }
      };
      this.cache.set(senderId, initialData);
      return initialData;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      if (!data.personaStats) {
        data.personaStats = { traits: {}, interests: {}, patterns: {}, insights: {} };
      }
      if (!Object.prototype.hasOwnProperty.call(data, 'lastAttemptTime')) {
        data.lastAttemptTime = null;
      }

       let dirty = false;
       if (data && data.persona && typeof data.persona === 'object' && data.persona._raw_xml) {
         try {
           delete data.persona._raw_xml;
           dirty = true;
         } catch {}
       }
       if (dirty) {
         this._saveUserData(senderId, data);
       }

      this.cache.set(senderId, data);
      return data;
    } catch (error) {
      logger.error(`加载用户数据失败 (${senderId})`, error);
      return null;
    }
  }

  /**
   * 保存用户数据
   */
  _saveUserData(senderId, data) {
    const filePath = this._getUserFilePath(senderId);
    
    try {
      data.updatedAt = new Date().toISOString();
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      this.cache.set(senderId, data); // 更新缓存
      return true;
    } catch (error) {
      logger.error(`保存用户数据失败 (${senderId})`, error);
      return false;
    }
  }

  /**
   * 记录用户消息
   * @param {string} senderId - 发送者 ID
   * @param {object} message - 消息对象 { text, timestamp, senderName, groupId, etc. }
   */
  async recordMessage(senderId, message) {
    if (!this.enabled) return;
    const userData = this._loadUserData(senderId);
    if (!userData) return;

    // 添加消息到历史
    userData.messages.push({
      text: message.text || '',
      timestamp: message.timestamp || new Date().toISOString(),
      senderName: message.senderName || '未知',
      groupId: message.groupId || null,
      ...message
    });

    userData.messageCount++;

    // 限制历史消息大小
    if (userData.messages.length > this.maxHistorySize) {
      userData.messages = userData.messages.slice(-this.maxHistorySize);
    }

    // 保存数据
    this._saveUserData(senderId, userData);

    // 检查是否需要更新画像（基于时间间隔 + 消息阈值双重控制）
    this._checkAndScheduleUpdate(senderId, userData);
  }

  /**
   * 检查并调度画像更新
   * @private
   */
  _checkAndScheduleUpdate(senderId, userData) {
    // 1. 检查是否已有待执行的更新（防重）
    if (this.pendingUpdates.has(senderId)) {
      logger.debug(`[画像] ${senderId} 已有待执行的更新，跳过`);
      return;
    }

    // 2. 计算新增消息数
    const messagesSinceUpdate = userData.messageCount - userData.lastUpdateCount;
    
    // 3. 检查消息阈值
    if (messagesSinceUpdate < this.minMessagesForUpdate) {
      logger.debug(`[画像] ${senderId} 新增消息数 ${messagesSinceUpdate} < 阈值 ${this.minMessagesForUpdate}，跳过`);
      return;
    }

    // 4. 检查时间间隔
    const now = Date.now();
    const lastUpdateTime = userData.lastUpdateTime;
    const lastAttemptTime = userData.lastAttemptTime;
    const effectiveLastTime = (lastAttemptTime && lastAttemptTime > 0)
      ? lastAttemptTime
      : lastUpdateTime;
    
    // 如果不是首次更新，检查时间间隔
    if (effectiveLastTime && effectiveLastTime > 0) {
      const timeSinceUpdate = now - effectiveLastTime;
      
      if (timeSinceUpdate < this.updateIntervalMs) {
        const remainingMinutes = Math.ceil((this.updateIntervalMs - timeSinceUpdate) / 60000);
        logger.debug(`[画像] ${senderId} 距离上次更新仅 ${Math.floor(timeSinceUpdate / 60000)} 分钟，需等待 ${remainingMinutes} 分钟`);
        return;
      }
      
      // 5. 满足条件，触发更新（非首次）
      logger.info(`[画像] ${senderId} 触发更新 - 新增 ${messagesSinceUpdate} 条消息，距上次更新 ${Math.floor(timeSinceUpdate / 60000)} 分钟`);
    } else {
      // 5. 首次更新
      logger.info(`[画像] ${senderId} 触发首次更新 - 累积 ${messagesSinceUpdate} 条消息`);
    }
    
    // 标记为待执行，防止重复触发
    this.pendingUpdates.add(senderId);
    
    // 异步执行，不阻塞主流程
    setImmediate(() => {
      this.updatePersona(senderId).catch(err => {
        logger.error(`[画像] ${senderId} 异步更新失败`, err);
      }).finally(() => {
        // 清除待执行标记
        this.pendingUpdates.delete(senderId);
      });
    });
  }

  /**
   * 更新用户画像（使用 LLM 分析）
   */
  async updatePersona(senderId) {
    const userData = this._loadUserData(senderId);
    if (!userData || userData.messages.length === 0) return;

    try {
      // 记录“尝试更新时间”，用于失败时也能进行时间门控
      userData.lastAttemptTime = Date.now();
      this._saveUserData(senderId, userData);

      logger.info(`[画像] 开始分析用户画像 (${senderId})...`);

      // 准备分析数据
      const recentMessages = userData.messages.slice(-this.recentMessagesCount);
      const isFirstTime = !userData.persona; // 是否首次构建

      // 调用 LLM 分析
      const newPersona = await this._analyzePersona(
        recentMessages,
        userData.persona,
        isFirstTime,
        senderId
      );

      if (newPersona) {
        const merged = this._mergePersonaWithStats(userData, newPersona);
        userData.persona = merged;
        userData.version++;
        userData.lastUpdateCount = userData.messageCount;
        userData.lastUpdateTime = Date.now(); // ✅ 记录更新时间
        userData.lastAttemptTime = userData.lastUpdateTime;
        
        this._saveUserData(senderId, userData);
        
        logger.info(`[画像] ${senderId} 画像更新成功 - 版本 ${userData.version}`);
        logger.info(this._getPersonaSummary(newPersona));
      }
    } catch (error) {
      logger.error('画像更新失败', error);
    }
  }

  /**
   * 使用 LLM 分析用户画像（统一使用 XML 解析）
   */
  async _analyzePersona(recentMessages, existingPersona, isFirstTime, senderId) {
    const prompt = this._buildAnalysisPrompt(recentMessages, existingPersona, isFirstTime, senderId);
    
    try {
      const systemPrompt = await this._getSystemPrompt(isFirstTime);
      const response = await this.agent.chat(
        [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        {
          model: this.model,
          temperature: 1,
          max_tokens: 2000,
          apiBaseUrl: this.baseUrl,
          apiKey: this.apiKey
        }
      );

      // 统一使用 XML 解析
      const responseText = response.content || (typeof response === 'string' ? response : '');
      
      if (!responseText) {
        throw new Error('LLM 返回内容为空');
      }
      
      logger.debug('使用 XML 解析模式');
      const parsed = await this._parsePersonaResponse(responseText, senderId);
      return parsed;
      
    } catch (error) {
      logger.error('LLM 分析失败', error);
      return null;
    }
  }

  /**
   * 获取系统提示词 - 使用 Sentra XML 协议
   */
  async _getSystemPrompt(isFirstTime) {
    const name = isFirstTime ? PERSONA_INITIAL_PROMPT_NAME : PERSONA_REFINE_PROMPT_NAME;
    try {
      if (isFirstTime && cachedPersonaInitialSystemPrompt) {
        return cachedPersonaInitialSystemPrompt;
      }
      if (!isFirstTime && cachedPersonaRefineSystemPrompt) {
        return cachedPersonaRefineSystemPrompt;
      }

      const data = await loadPrompt(name);
      const system = data && typeof data.system === 'string' ? data.system : '';

      if (system) {
        if (isFirstTime) {
          cachedPersonaInitialSystemPrompt = system;
        } else {
          cachedPersonaRefineSystemPrompt = system;
        }
        return system;
      }
    } catch (e) {
      logger.warn('UserPersonaManager: 加载 persona system prompt 失败，将使用内联回退文案', {
        err: String(e),
        name
      });
    }

    // 回退：如果 JSON prompt 加载失败，使用简单的内联提示词
    if (isFirstTime) {
      return '# User Persona Analysis System - Initial Profile Construction';
    }
    return '# User Persona Analysis System - Profile Refinement';
  }

  /**
   * 构建分析提示词 - 使用 Sentra XML 协议
   */
  _buildAnalysisPrompt(recentMessages, existingPersona, isFirstTime, senderId) {
    let prompt = '';

    if (isFirstTime) {
      prompt += '# Initial Persona Construction\n\n';
      prompt += '**User Conversation History**:\n\n';
    } else {
      prompt += '# Persona Refinement\n\n';
      prompt += '**Existing Persona (XML Format)**:\n\n';
      
      // 将已有画像转为 XML 格式显示（直接 XML，不用代码块）
      prompt += this._serializePersonaToXML(existingPersona, senderId);
      prompt += '\n\n';
      
      prompt += '**New Conversation Data**:\n\n';
    }

    // 添加消息历史（结构化列表）
    prompt += '<conversation_history>\n';
    recentMessages.forEach((msg, idx) => {
      const time = new Date(msg.timestamp).toLocaleString('zh-CN');
      const name = msg.senderName || '用户';
      const text = msg.text || '';
      prompt += `  <message index="${escapeXmlAttr(String(idx + 1))}">\n`;
      prompt += `    <time>${escapeXml(time)}</time>\n`;
      prompt += `    <sender>${escapeXml(name)}</sender>\n`;
      prompt += `    <content>${escapeXml(text)}</content>\n`;
      prompt += `  </message>\n`;
    });
    prompt += '</conversation_history>\n\n';

    prompt += '---\n\n';
    
    if (isFirstTime) {
      prompt += '**Your Task**: Analyze the conversation history above and construct an initial user persona using the <sentra-persona> XML format specified in the system prompt.\n\n';
      prompt += '**Focus on**: Observable patterns, recurring themes, communication characteristics, and behavioral tendencies.\n\n';
      prompt += '**Remember**: Output ONLY the <sentra-persona> XML block. Be specific and evidence-based.';
    } else {
      prompt += '**Your Task**: Refine the existing persona based on new conversation data. Output an enhanced <sentra-persona> XML block.\n\n';
      prompt += '**Focus on**: Validating previous insights, adding new observations, tracking changes, increasing specificity.\n\n';
      prompt += '**Remember**: Maintain ~70% continuity, ~30% new insights. Mark status/novelty/trend indicators. Output ONLY the <sentra-persona> XML block.';
    }

    return prompt;
  }

  /**
   * 解析 LLM 返回的画像数据 - 使用 Sentra XML 协议
   */
  async _parsePersonaResponse(content, senderId) {
    try {
      // 提取 <sentra-persona> 块
      let personaXML = extractXMLTag(content, 'sentra-persona');
      
      if (!personaXML) {
        // 尝试从 markdown 代码块中提取
        const xmlMatch = content.match(/```xml\s*([\s\S]*?)\s*```/);
        if (xmlMatch) {
          personaXML = extractXMLTag(xmlMatch[1], 'sentra-persona');
        }
      }
      
      if (!personaXML) {
        logger.error('解析画像失败：未找到 <sentra-persona> 标签');
        return null;
      }
      
      // 解析 XML 结构
      const persona = this._parsePersonaXML(personaXML);

      return persona;
      
    } catch (error) {
      logger.error('解析画像异常', error);
      return null;
    }
  }
  
  /**
   * 解析 Sentra XML 格式的画像数据
   */
  _parsePersonaXML(personaXML) {
    const persona = {};
    
    // 提取 summary
    persona.summary = extractXMLTag(personaXML, 'summary')?.trim() || '';
    
    // 提取 traits 块
    const traitsBlock = extractXMLTag(personaXML, 'traits');
    if (traitsBlock) {
      persona.traits = {};
      
      // personality 特征
      const personalityBlock = extractXMLTag(traitsBlock, 'personality');
      if (personalityBlock) {
        persona.traits.personality = extractAllXMLTags(personalityBlock, 'trait');
      }
      
      // communication_style
      persona.traits.communication_style = extractXMLTag(traitsBlock, 'communication_style')?.trim() || '';
      
      // interests
      const interestsBlock = extractXMLTag(traitsBlock, 'interests');
      if (interestsBlock) {
        const interestTags = this._extractTagsWithAttributes(interestsBlock, 'interest');
        persona.traits.interests = interestTags;
      }
      
      // behavioral_patterns
      const patternsBlock = extractXMLTag(traitsBlock, 'behavioral_patterns');
      if (patternsBlock) {
        const patternTags = this._extractTagsWithAttributes(patternsBlock, 'pattern');
        persona.traits.behavioral_patterns = patternTags;
      }
      
      // emotional_profile
      const emotionalBlock = extractXMLTag(traitsBlock, 'emotional_profile');
      if (emotionalBlock) {
        persona.traits.emotional_profile = {
          dominant_emotions: extractXMLTag(emotionalBlock, 'dominant_emotions')?.trim() || '',
          sensitivity_areas: extractXMLTag(emotionalBlock, 'sensitivity_areas')?.trim() || '',
          expression_tendency: extractXMLTag(emotionalBlock, 'expression_tendency')?.trim() || ''
        };
      }
    }
    
    // 提取 insights
    const insightsBlock = extractXMLTag(personaXML, 'insights');
    if (insightsBlock) {
      persona.insights = this._extractTagsWithAttributes(insightsBlock, 'insight');
    }
    
    // 提取 evolution（仅在优化后的画像中存在）
    const evolutionBlock = extractXMLTag(personaXML, 'evolution');
    if (evolutionBlock) {
      persona.evolution = {
        changes: this._extractTagsWithAttributes(evolutionBlock, 'change'),
        continuity: extractXMLTag(evolutionBlock, 'continuity')?.trim() || ''
      };
    }
    
    // 提取 metadata
    const metadataBlock = extractXMLTag(personaXML, 'metadata');
    if (metadataBlock) {
      persona.metadata = {
        confidence: extractXMLTag(metadataBlock, 'confidence')?.trim() || 'medium',
        data_quality: extractXMLTag(metadataBlock, 'data_quality')?.trim() || '',
        update_priority: extractXMLTag(metadataBlock, 'update_priority')?.trim() || ''
      };
    }
    
    // 兼容性：提取 confidence（如果 metadata 不存在）
    if (!persona.metadata) {
      const confidence = extractXMLTag(personaXML, 'confidence')?.trim();
      if (confidence) {
        persona.confidence = confidence;
      }
    }
    
    return persona;
  }
  
  /**
   * 提取带属性的 XML 标签
   */
  _extractTagsWithAttributes(xmlBlock, tagName) {
    const results = [];
    const regex = new RegExp(`<${tagName}([^>]*)>([\\s\\S]*?)<\/${tagName}>`, 'g');
    let match;
    
    while ((match = regex.exec(xmlBlock)) !== null) {
      const attributesStr = match[1];
      const content = match[2].trim();
      
      // 解析属性
      const attributes = {};
      const attrRegex = /(\w+)="([^"]*)"/g;
      let attrMatch;
      while ((attrMatch = attrRegex.exec(attributesStr)) !== null) {
        attributes[attrMatch[1]] = attrMatch[2];
      }
      
      results.push({
        content,
        attributes
      });
    }
    
    return results;
  }
  
  _serializePersonaToXML(persona, senderId) {
    if (!persona) return '<sentra-persona></sentra-persona>';
    // 若已是 XML 字符串或对象内含原始XML，则直接返回
    if (typeof persona === 'string' && persona.includes('<sentra-persona')) {
      return persona;
    }
    
    const lines = [];
    const s = (v) => (v == null ? '' : String(v));
    const escText = (v) => escapeXml(unescapeXml(s(v)));
    const escAttr = (v) => escapeXmlAttr(unescapeXml(s(v)));
    const arr = (a) => Array.isArray(a) ? a : (a ? [a] : []);
    const items = (a) => arr(a).map(x => (typeof x === 'object' && x && (x.content || x.attributes)) ? x : { content: s(x), attributes: {} }).filter(i => i.content);
    const attrs = (o, ks) => {
      const ps = [];
      ks.forEach(k => { if (o && o[k]) ps.push(`${k}="${escAttr(o[k])}"`); });
      return ps.length ? ' ' + ps.join(' ') : '';
    };
    
    const senderAttr = senderId ? ` sender_id="${escAttr(senderId)}"` : '';
    lines.push(`<sentra-persona${senderAttr}>`);
    
    if (persona.summary) lines.push(`  <summary>${escText(persona.summary)}</summary>`);
    
    if (persona.traits) {
      lines.push('  <traits>');
      const pers = items(persona.traits.personality);
      if (pers.length) {
        lines.push('    <personality>');
        pers.forEach(t => lines.push(`      <trait${attrs(t.attributes, ['status'])}>${escText(t.content)}</trait>`));
        lines.push('    </personality>');
      }
      if (persona.traits.communication_style) {
        lines.push(`    <communication_style>${escText(persona.traits.communication_style)}</communication_style>`);
      }
      const ints = items(persona.traits.interests);
      if (ints.length) {
        lines.push('    <interests>');
        ints.forEach(it => lines.push(`      <interest${attrs(it.attributes, ['category', 'status'])}>${escText(it.content)}</interest>`));
        lines.push('    </interests>');
      }
      const pats = items(persona.traits.behavioral_patterns);
      if (pats.length) {
        lines.push('    <behavioral_patterns>');
        pats.forEach(p => lines.push(`      <pattern${attrs(p.attributes, ['type', 'trend'])}>${escText(p.content)}</pattern>`));
        lines.push('    </behavioral_patterns>');
      }
      const ep = persona.traits.emotional_profile || {};
      if (ep.dominant_emotions || ep.sensitivity_areas || ep.expression_tendency) {
        lines.push('    <emotional_profile>');
        if (ep.dominant_emotions) lines.push(`      <dominant_emotions>${escText(ep.dominant_emotions)}</dominant_emotions>`);
        if (ep.sensitivity_areas) lines.push(`      <sensitivity_areas>${escText(ep.sensitivity_areas)}</sensitivity_areas>`);
        if (ep.expression_tendency) lines.push(`      <expression_tendency>${escText(ep.expression_tendency)}</expression_tendency>`);
        lines.push('    </emotional_profile>');
      }
      lines.push('  </traits>');
    }
    
    const insights = items(persona.insights);
    if (insights.length) {
      lines.push('  <insights>');
      insights.forEach(ins => lines.push(`    <insight${attrs(ins.attributes, ['evidence', 'novelty'])}>${escText(ins.content)}</insight>`));
      lines.push('  </insights>');
    }
    
    if (persona.evolution) {
      const changes = items(persona.evolution.changes);
      const cont = persona.evolution.continuity;
      if (changes.length || cont) {
        lines.push('  <evolution>');
        changes.forEach(c => lines.push(`    <change${attrs(c.attributes, ['type'])}>${escText(c.content)}</change>`));
        if (cont) lines.push(`    <continuity>${escText(cont)}</continuity>`);
        lines.push('  </evolution>');
      }
    }
    
    const md = persona.metadata || {};
    if (md.confidence || md.data_quality || md.update_priority) {
      lines.push('  <metadata>');
      if (md.confidence) lines.push(`    <confidence>${escText(md.confidence)}</confidence>`);
      if (md.data_quality) lines.push(`    <data_quality>${escText(md.data_quality)}</data_quality>`);
      if (md.update_priority) lines.push(`    <update_priority>${escText(md.update_priority)}</update_priority>`);
      lines.push('  </metadata>');
    }
    
    lines.push('</sentra-persona>');
    return lines.join('\n');
  }

  /**
   * 获取画像摘要（用于日志输出）
   */
  _getPersonaSummary(persona) {
    if (!persona) return '(无画像)';
    
    if (persona.summary) {
      const confidence = persona.metadata?.confidence || persona.confidence || 'medium';
      return `${persona.summary} [${confidence}]`;
    }
    
    return '  (画像数据异常)';
  }

  _mergePersonaWithStats(userData, newPersona) {
    const now = Date.now();
    if (!userData.personaStats) {
      userData.personaStats = { traits: {}, interests: {}, patterns: {}, insights: {} };
    }
    const stats = userData.personaStats;
    const readItems = (arr) => {
      if (!arr) return [];
      return arr.map(x => {
        if (typeof x === 'object' && x && (x.content || x.attributes)) return { content: (x.content || '').trim(), attributes: x.attributes || {} };
        return { content: String(x || '').trim(), attributes: {} };
      }).filter(it => it.content);
    };
    const decay = (w, lastSeen) => {
      const delta = Math.max(0, now - (lastSeen || now));
      if (!this.halfLifeMs || this.halfLifeMs <= 0) return w;
      const factor = Math.pow(0.5, delta / this.halfLifeMs);
      return w * factor;
    };
    const bump = (base, attrs) => {
      let b = base;
      const s = attrs?.status;
      if (s === 'confirmed') b += 0.2;
      else if (s === 'refined') b += 0.1;
      else if (s === 'new') b += 0.15;
      const n = attrs?.novelty;
      if (n === 'new') b += 0.15;
      const t = attrs?.trend;
      if (t === '增强') b += 0.1;
      return b;
    };
    const normKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
    const decayAll = (map) => {
      Object.keys(map).forEach(k => { map[k].weight = decay(map[k].weight || 0, map[k].lastSeen); });
    };
    const upsert = (map, item, base) => {
      const key = normKey(item.content);
      const prev = map[key] || { content: item.content, attributes: item.attributes || {}, firstSeen: now, lastSeen: now, count: 0, weight: 0 };
      const w = decay(prev.weight || 0, prev.lastSeen) + bump(base, item.attributes || {});
      map[key] = { content: item.content, attributes: item.attributes || {}, firstSeen: prev.firstSeen, lastSeen: now, count: (prev.count || 0) + 1, weight: w };
    };
    const topN = (map, n) => {
      return Object.values(map)
        .sort((a, b) => (b.weight - a.weight) || (b.lastSeen - a.lastSeen) || (b.count - a.count))
        .slice(0, Math.max(0, n))
        .map(v => ({ content: v.content, attributes: v.attributes }));
    };
    decayAll(stats.traits);
    decayAll(stats.interests);
    decayAll(stats.patterns);
    decayAll(stats.insights);
    const personality = readItems(newPersona?.traits?.personality);
    const interests = readItems(newPersona?.traits?.interests);
    const patterns = readItems(newPersona?.traits?.behavioral_patterns);
    const insights = readItems(newPersona?.insights);
    personality.forEach(it => upsert(stats.traits, it, 1.0));
    interests.forEach(it => upsert(stats.interests, it, 1.0));
    patterns.forEach(it => upsert(stats.patterns, it, 1.0));
    insights.forEach(it => upsert(stats.insights, it, 1.0));
    const result = {
      summary: (newPersona?.summary && newPersona.summary.trim()) || (userData.persona?.summary || ''),
      traits: {
        personality: topN(stats.traits, this.maxTraits),
        communication_style: (newPersona?.traits?.communication_style && newPersona.traits.communication_style.trim()) || (userData.persona?.traits?.communication_style || ''),
        interests: topN(stats.interests, this.maxInterests),
        behavioral_patterns: topN(stats.patterns, this.maxPatterns),
        emotional_profile: {
          dominant_emotions: newPersona?.traits?.emotional_profile?.dominant_emotions || userData.persona?.traits?.emotional_profile?.dominant_emotions || '',
          sensitivity_areas: newPersona?.traits?.emotional_profile?.sensitivity_areas || userData.persona?.traits?.emotional_profile?.sensitivity_areas || '',
          expression_tendency: newPersona?.traits?.emotional_profile?.expression_tendency || userData.persona?.traits?.emotional_profile?.expression_tendency || ''
        }
      },
      insights: topN(stats.insights, this.maxInsights),
      metadata: {
        confidence: newPersona?.metadata?.confidence || userData.persona?.metadata?.confidence || newPersona?.confidence || userData.persona?.confidence || 'medium',
        data_quality: newPersona?.metadata?.data_quality || userData.persona?.metadata?.data_quality || '',
        update_priority: newPersona?.metadata?.update_priority || userData.persona?.metadata?.update_priority || ''
      }
    };
    return result;
  }

  /**
   * 获取用户画像（供 AI 使用）
   */
  getPersona(senderId) {
    const userData = this._loadUserData(senderId);
    return userData?.persona || null;
  }

  /**
   * 格式化画像为 Sentra XML（用于插入到 AI 上下文）
   */
  formatPersonaForContext(senderId) {
    if (!this.enabled) return '';
    const persona = this.getPersona(senderId);
    if (!persona) return '';
    return this._serializePersonaToXML(persona, senderId);
  }

  /**
   * 强制更新画像（手动触发）
   */
  async forceUpdate(senderId) {
    logger.info(`手动触发画像更新 (${senderId})`);
    await this.updatePersona(senderId);
  }

  /**
   * 重置用户画像
   */
  resetPersona(senderId) {
    const userData = this._loadUserData(senderId);
    if (userData) {
      userData.persona = null;
      userData.version = 0;
      userData.lastUpdateCount = 0;
      this._saveUserData(senderId, userData);
      logger.success(`[画像] ${senderId} 画像重置成功`);
    }
  }

  /**
   * 获取用户统计信息
   */
  getUserStats(senderId) {
    const userData = this._loadUserData(senderId);
    if (!userData) return null;

    return {
      senderId,
      messageCount: userData.messageCount,
      hasPersona: !!userData.persona,
      version: userData.version,
      createdAt: userData.createdAt,
      updatedAt: userData.updatedAt,
      nextUpdateIn: Math.max(0, this.minMessagesForUpdate - (userData.messageCount - userData.lastUpdateCount))
    };
  }

  /**
   * 列出所有用户
   */
  listAllUsers() {
    if (!fs.existsSync(this.dataDir)) return [];

    const files = fs.readdirSync(this.dataDir).filter(f => f.endsWith('.json'));
    return files.map(f => {
      const senderId = f.replace('.json', '').replace(/_/g, ''); // 还原 ID
      return this.getUserStats(senderId);
    }).filter(Boolean);
  }
}

// 导出单例
export default UserPersonaManager;
