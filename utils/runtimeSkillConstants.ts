export const RUNTIME_SKILL_GUIDES_DIR = 'sentra-prompts/skills/runtime-guides';

export const RUNTIME_SKILL_DEFAULTS = Object.freeze({
  maxSkills: 4,
  minConfidence: 0.46,
  minScore: 1.0,
  maxUserSignalChars: 1400,
  maxToolSignalChars: 1400
});

export const RUNTIME_SKILL_LIMITS = Object.freeze({
  minMaxSkills: 1,
  maxMaxSkills: 12,
  minConfidence: 0.05,
  maxConfidence: 0.99,
  minScore: 0.2,
  minSignalChars: 120
});
