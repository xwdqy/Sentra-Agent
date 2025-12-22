import type { DeepwikiTool } from './types';

import readFile from './read_file/index';
import listDir from './list_dir/index';
import editFile from './edit_file/index';

let registry: Map<string, DeepwikiTool> | null = null;

export function getDeepwikiToolRegistry(): Map<string, DeepwikiTool> {
  if (registry) return registry;
  registry = new Map();
  for (const t of [readFile, listDir, editFile]) {
    if (!t?.name) continue;
    registry.set(t.name, t);
  }
  return registry;
}

export function getDeepwikiTool(name: string): DeepwikiTool | undefined {
  const reg = getDeepwikiToolRegistry();
  return reg.get(String(name || '').trim());
}
