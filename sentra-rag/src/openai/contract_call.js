import { getEnv, getEnvBoolean, getEnvNumber } from '../config/env.js';
import { logger } from '../logger.js';

const CONTRACT_HARDENING = [
  'CRITICAL GRAPH REQUIREMENTS:',
  '- For ingest: you MUST output non-empty segments.parent and segments.child unless document_text is empty.',
  '- For ingest: segments.parent.text and segments.child.text should be concise summaries of their spans (NOT verbatim copy). Preserve identifiers: timestamps, ids, versions, IPs, URLs, error codes, and names exactly as in the source.',
  '- For ingest: you MUST output extraction.entities as an array and extraction.relations as an array (empty only if truly none).',
  '- Every entity should include evidence: segment_id (child) + quote whenever possible.',
  '- Every relation MUST reference entities structurally (subject/object with type + canonical_name), and include evidence segment_id + quote whenever possible.',
  '- Entity identity & merging (IMPORTANT): if an entity has a stable, globally unique identifier, you MUST output entity_key on that entity.',
  '- entity_key is a stable string key. Avoid separators like ":" or "/"; prefer lowercase + digits + underscore only.',
  '- Examples: "qq_2166683295", "pkg_react", "repo_owner_name", "file_utils_emoji-stickers_.env" (keep identifiers exact; do not invent).',
  '- If entity_key exists, relations SHOULD include subject.entity_key/object.entity_key in addition to canonical_name so the system can merge across documents/turns.',
  '- Optionally output aliases as an array of alternative surface forms (e.g. nicknames, different spellings).',
  '- Output MUST be valid XML and use the typed value nodes required by the policy.',
].join('\n');

const CONTRACT_V4_PROCEDURE = [
  'STRICT OUTPUT PROCEDURE (DO NOT PRINT THESE STEPS):',
  '1) Decide task strictly from <sentra-input><task>: ingest | query | repair.',
  '2) Start by writing <sentra-contract> root and COMPLETE <meta> first.',
  '   - meta.task is REQUIRED and must match the input task.',
  "   - meta.version MUST be 'rag-contract-v4' when the policy is v4.",
  '3) Fill <normalized_input> next (query_text/context_text/document_text).',
  '   - normalized_input MUST be an exact copy of the provided input strings. Do NOT summarize. Do NOT use ellipsis like "..." / "略" / "省略".',
  '4) ingest mode: MUST output non-empty segments.parent and segments.child (unless document_text empty), then extraction.entities and extraction.relations with evidence.',
  '5) query mode: MUST output retrieval_plan with parameters{k_vector,k_fulltext,token_budget}, then final_answer.answer and (recommended) citations[].',
  '6) quality: always output can_execute/confidence/errors[]/warnings[]. If anything is missing, set can_execute=false and explain in errors[].',
  '7) FINAL XML SELF-CHECK (MUST PASS BEFORE OUTPUT):',
  '   - Exactly one root <sentra-contract>',
  '   - <meta><task> is present and non-empty',
  '   - All required sections exist: meta, normalized_input, segments, extraction, retrieval_plan, final_answer, quality',
  '   - Structured values use typed value nodes (<string>/<number>/<boolean>/<array>/<object>) as defined by the policy',
  '   - No markdown, no extra text before/after XML',
].join('\n');

const FEWSHOT_INGEST_USER = [
  '<sentra-input>',
  '  <task>ingest</task>',
  '  <lang>zh</lang>',
  '  <normalized_input>',
  '    <query_text></query_text>',
  '    <context_text></context_text>',
  '    <document_text>用户反馈：RAG 入库报错 XML parse failed</document_text>',
  '  </normalized_input>',
  '</sentra-input>',
].join('\n');

const FEWSHOT_INGEST_ASSISTANT = [
  '<sentra-contract>',
  '  <meta>',
  '    <task><string>ingest</string></task>',
  '    <lang><string>zh</string></lang>',
  '    <version><string>rag-contract-v4</string></version>',
  '    <request_id><string></string></request_id>',
  '  </meta>',
  '  <normalized_input>',
  '    <query_text><string></string></query_text>',
  '    <context_text><string></string></context_text>',
  '    <document_text><string>用户反馈：RAG 入库报错 XML parse failed</string></document_text>',
  '  </normalized_input>',
  '  <segments>',
  '    <parent>',
  '      <array>',
  '        <object>',
  '          <field name="segment_id"><string>p_0</string></field>',
  '          <field name="text"><string>RAG 入库报错，涉及 XML 解析失败</string></field>',
  '          <field name="start_char"><number>0</number></field>',
  '          <field name="end_char"><number>22</number></field>',
  '        </object>',
  '      </array>',
  '    </parent>',
  '    <child>',
  '      <array>',
  '        <object>',
  '          <field name="segment_id"><string>c_0</string></field>',
  '          <field name="parent_id"><string>p_0</string></field>',
  '          <field name="text"><string>错误信息：XML parse failed</string></field>',
  '          <field name="start_char"><number>0</number></field>',
  '          <field name="end_char"><number>22</number></field>',
  '        </object>',
  '      </array>',
  '    </child>',
  '  </segments>',
  '  <extraction>',
  '    <entities><array></array></entities>',
  '    <relations><array></array></relations>',
  '    <linking_hints><array></array></linking_hints>',
  '  </extraction>',
  '  <retrieval_plan>',
  '    <strategy><string></string></strategy>',
  '    <intent><string></string></intent>',
  '    <parameters><object></object></parameters>',
  '    <steps><array></array></steps>',
  '  </retrieval_plan>',
  '  <final_answer>',
  '    <answer><string></string></answer>',
  '    <citations><array></array></citations>',
  '  </final_answer>',
  '  <quality>',
  '    <can_execute><boolean>true</boolean></can_execute>',
  '    <confidence><number>0.6</number></confidence>',
  '    <errors><array></array></errors>',
  '    <warnings><array></array></warnings>',
  '  </quality>',
  '</sentra-contract>',
].join('\n');

const FEWSHOT_REPAIR_USER = [
  '<sentra-repair>',
  '  <lang>zh</lang>',
  '  <error_report>XML root is not <sentra-contract></error_report>',
  '  <bad_xml><contract><meta><task>ingest</task></meta></contract></bad_xml>',
  '</sentra-repair>',
].join('\n');

const FEWSHOT_REPAIR_ASSISTANT = [
  '<sentra-contract>',
  '  <meta>',
  '    <task><string>ingest</string></task>',
  '    <lang><string>zh</string></lang>',
  '    <version><string>rag-contract-v4</string></version>',
  '    <request_id><string></string></request_id>',
  '  </meta>',
  '  <normalized_input>',
  '    <query_text><string></string></query_text>',
  '    <context_text><string></string></context_text>',
  '    <document_text><string></string></document_text>',
  '  </normalized_input>',
  '  <segments>',
  '    <parent><array></array></parent>',
  '    <child><array></array></child>',
  '  </segments>',
  '  <extraction>',
  '    <entities><array></array></entities>',
  '    <relations><array></array></relations>',
  '    <linking_hints><array></array></linking_hints>',
  '  </extraction>',
  '  <retrieval_plan>',
  '    <strategy><string></string></strategy>',
  '    <intent><string></string></intent>',
  '    <parameters><object></object></parameters>',
  '    <steps><array></array></steps>',
  '  </retrieval_plan>',
  '  <final_answer>',
  '    <answer><string></string></answer>',
  '    <citations><array></array></citations>',
  '  </final_answer>',
  '  <quality>',
  '    <can_execute><boolean>false</boolean></can_execute>',
  '    <confidence><number>0</number></confidence>',
  '    <errors>',
  '      <array>',
  '        <string>Bad XML root was not <sentra-contract>; repaired to minimal skeleton</string>',
  '      </array>',
  '    </errors>',
  '    <warnings><array></array></warnings>',
  '  </quality>',
  '</sentra-contract>',
].join('\n');

 function sanitizeXmlText(value) {
   return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
 }

function xmlEscape(value) {
  return sanitizeXmlText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

 function extractContractXmlBlock(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';

  const fenced = raw.match(/```(?:xml)?\s*([\s\S]*?)\s*```/i);
  const candidate = String(fenced?.[1] ?? raw).trim();

  const start = candidate.indexOf('<sentra-contract');
  if (start < 0) return candidate;

  const endTag = '</sentra-contract>';
  const end = candidate.lastIndexOf(endTag);
  if (end < 0) return candidate.slice(start).trim();
  return candidate.slice(start, end + endTag.length).trim();
 }

function injectNormalizedInputXml(xml, { queryText, contextText, documentText } = {}) {
  const open = '<normalized_input>';
  const close = '</normalized_input>';
  const i = String(xml || '').indexOf(open);
  const j = String(xml || '').indexOf(close);
  if (i < 0 || j < 0 || j <= i) return xml;

  const block = [
    '  <normalized_input>',
    `    <query_text><string>${xmlEscape(queryText ?? '')}</string></query_text>`,
    `    <context_text><string>${xmlEscape(contextText ?? '')}</string></context_text>`,
    `    <document_text><string>${xmlEscape(documentText ?? '')}</string></document_text>`,
    '  </normalized_input>',
  ].join('\n');

  return String(xml).slice(0, i) + block + String(xml).slice(j + close.length);
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;

  // OpenAI-style multi-part content: [{type:'text', text:'...'}, ...]
  let out = '';
  for (const part of content) {
    if (typeof part === 'string') {
      out += part;
      continue;
    }
    if (part && typeof part === 'object') {
      if (typeof part.text === 'string') {
        out += part.text;
        continue;
      }
      if (typeof part.content === 'string') {
        out += part.content;
        continue;
      }
    }
  }
  return out;
}

function extractAssistantText(resp) {
  const choice = resp?.choices?.[0];
  const msg = choice?.message;
  const debug = getEnvBoolean('DEBUG_OPENAI', { defaultValue: false });

  const candidate =
    extractTextFromContent(msg?.content) ??
    (typeof choice?.text === 'string' ? choice.text : undefined) ??
    (typeof resp?.output_text === 'string' ? resp.output_text : undefined);

  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();

  const finishReason = choice?.finish_reason;
  const refusal = msg?.refusal;
  const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls.length : 0;
  const msgKeys = msg && typeof msg === 'object' ? Object.keys(msg).join(',') : 'none';

  if (debug) {
    try {
      const snapshot = {
        hasChoices: Array.isArray(resp?.choices),
        finish_reason: finishReason,
        refusal: refusal ?? null,
        tool_calls: msg?.tool_calls ?? null,
        message: msg ?? null,
      };
      // Avoid huge logs
      logger.debug('openai: empty-output snapshot', JSON.stringify(snapshot).slice(0, 4000));
    } catch {
      // ignore
    }
  }

  throw new Error(
    `Empty model output (finish_reason=${finishReason ?? 'unknown'}, refusal=${refusal ? 'yes' : 'no'}, tool_calls=${toolCalls}, message_fields=${msgKeys})`
  );
}

function buildUserInputXml({ task, lang, queryText, contextText, documentText }) {
  return [
    '<sentra-input>',
    `  <task>${xmlEscape(task)}</task>`,
    `  <lang>${xmlEscape(lang)}</lang>`,
    '  <normalized_input>',
    `    <query_text>${xmlEscape(queryText ?? '')}</query_text>`,
    `    <context_text>${xmlEscape(contextText ?? '')}</context_text>`,
    `    <document_text>${xmlEscape(documentText ?? '')}</document_text>`,
    '  </normalized_input>',
    '</sentra-input>',
  ].join('\n');
}

 function extractAssistantTextWithMeta(resp) {
   const choice = resp?.choices?.[0];
   const finishReason = choice?.finish_reason;
   const text = extractAssistantText(resp);
   return { text, finishReason };
 }

export async function requestContractXml(openai, policy, { task, queryText, contextText, documentText, lang }) {
  const model = getEnv('CHAT_MODEL', { defaultValue: 'gpt-4o-mini' });
  const temperature = getEnvNumber('CHAT_TEMPERATURE', { defaultValue: 0 });
  const maxTokens = getEnvNumber('CHAT_MAX_OUTPUT_TOKENS', { defaultValue: 2000 });

  const inputXml = buildUserInputXml({ task, lang, queryText, contextText, documentText });

  const req = {
    model,
    temperature,
    messages: [
      { role: 'system', content: `${policy.text}\n\n${CONTRACT_HARDENING}\n\n${CONTRACT_V4_PROCEDURE}` },
      { role: 'user', content: FEWSHOT_INGEST_USER },
      { role: 'assistant', content: FEWSHOT_INGEST_ASSISTANT },
      { role: 'user', content: inputXml },
    ],
  };
  if (maxTokens !== -1) req.max_tokens = maxTokens;

  const resp = await openai.chat.completions.create(req);

  const { text, finishReason } = extractAssistantTextWithMeta(resp);
  const xmlRaw = extractContractXmlBlock(text);
  if (finishReason === 'length' && !xmlRaw.includes('</sentra-contract>')) {
    throw new Error('Model output truncated (finish_reason=length)');
  }

  const echoInput = getEnvBoolean('CONTRACT_ECHO_INPUT', { defaultValue: true });
  const injected = echoInput ? injectNormalizedInputXml(xmlRaw, { queryText, contextText, documentText }) : xmlRaw;
  return extractContractXmlBlock(injected);
}

export async function requestContractXmlRepair(openai, policy, { badXml, errorReport, lang }) {
  const model = getEnv('CHAT_MODEL', { defaultValue: 'gpt-4o-mini' });
  const temperature = 0;
  const maxTokens = getEnvNumber('CHAT_MAX_OUTPUT_TOKENS', { defaultValue: 2000 });

  const user = [
    '<sentra-repair>',
    `  <lang>${xmlEscape(lang)}</lang>`,
    '  <error_report>',
    `${xmlEscape(errorReport)}`,
    '  </error_report>',
    '  <bad_xml>',
    `${xmlEscape(badXml)}`,
    '  </bad_xml>',
    '</sentra-repair>',
  ].join('\n');

  const req = {
    model,
    temperature,
    messages: [
      { role: 'system', content: `${policy.text}\n\n${CONTRACT_HARDENING}\n\n${CONTRACT_V4_PROCEDURE}` },
      { role: 'user', content: FEWSHOT_REPAIR_USER },
      { role: 'assistant', content: FEWSHOT_REPAIR_ASSISTANT },
      { role: 'user', content: user },
    ],
  };
  if (maxTokens !== -1) req.max_tokens = maxTokens;

  const resp = await openai.chat.completions.create(req);

  const { text, finishReason } = extractAssistantTextWithMeta(resp);
  const xml = extractContractXmlBlock(text);
  if (finishReason === 'length' && !xml.includes('</sentra-contract>')) {
    throw new Error('Model output truncated (finish_reason=length)');
  }
  return xml;
}
