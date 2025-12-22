import type { DeepwikiTool } from '../types';
import { listDirTool } from '../shared';

const tool: DeepwikiTool = {
  name: 'list_dir',
  description: 'List repository directory entries (read-only).',
  cacheable: true,
  run: (args) => {
    return listDirTool(String(args.path || ''), { recursive: args.recursive, max_entries: args.max_entries });
  },
};

export default tool;
