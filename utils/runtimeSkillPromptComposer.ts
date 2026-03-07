import {
  resolveRuntimeSkillGuides,
  type RuntimeSkillHint,
  type RuntimeSkillMode,
  type RuntimeSkillRef,
  type RuntimeSkillSelection
} from './runtimeSkillGuideEngine.js';

type RuntimeComposerOptions = {
  maxSkills?: number;
  minConfidence?: number;
  minScore?: number;
  maxUserSignalChars?: number;
  maxToolSignalChars?: number;
};

function hashSignal(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function normalizeHintKey(hint?: RuntimeSkillHint): string {
  if (!hint) return 'none';
  const stage = String(hint.stage || 'runtime').trim().toLowerCase();
  const user = String(hint.userText || '').trim();
  const tool = String(hint.toolText || '').trim();
  const joined = `${stage}\n${user}\n${tool}`.trim();
  if (!joined) return `${stage}:empty`;
  return `${stage}:${hashSignal(joined)}`;
}

export function createRuntimeSkillPromptComposer(options: RuntimeComposerOptions = {}) {
  const cache = new Map<string, Promise<RuntimeSkillSelection>>();

  const getSelection = async (mode: RuntimeSkillMode, hint?: RuntimeSkillHint): Promise<RuntimeSkillSelection> => {
    const normalizedMode = String(mode || 'full').trim() || 'full';
    const key = `${normalizedMode}|${normalizeHintKey(hint)}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const built = resolveRuntimeSkillGuides(normalizedMode, hint || {}, options);
    cache.set(key, built);
    return built;
  };

  return {
    getSelection,
    getSystemAugment: async (mode: RuntimeSkillMode, hint?: RuntimeSkillHint) => {
      const selected = await getSelection(mode, hint);
      return {
        refs: selected.refs,
        signal: selected.signal,
        skillRefsXml: selected.skillRefsXml,
        dynamicSkillBlock: selected.systemBlock,
        systemBlock: selected.systemBlock
      };
    },
    getSkillRefs: async (mode: RuntimeSkillMode, hint?: RuntimeSkillHint): Promise<RuntimeSkillRef[]> =>
      (await getSelection(mode, hint)).refs,
    getSkillRefsXml: async (mode: RuntimeSkillMode, hint?: RuntimeSkillHint): Promise<string> =>
      (await getSelection(mode, hint)).skillRefsXml || ''
  };
}
