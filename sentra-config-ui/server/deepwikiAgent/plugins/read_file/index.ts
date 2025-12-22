import type { DeepwikiTool } from '../types';
import { readFileTool } from '../shared';

const tool: DeepwikiTool = {
  name: 'read_file',
  description: 'Read a file from repository (read-only). Supports text files and image files as data URLs.',
  cacheable: true,
  run: (args) => {
    return readFileTool(String(args.path || ''), args.max_chars != null ? Number(args.max_chars) : undefined);
  },
};

export default tool;
