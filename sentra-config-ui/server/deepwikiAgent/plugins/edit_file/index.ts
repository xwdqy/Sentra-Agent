import type { DeepwikiTool } from '../types';
import { editEnvFileTool } from '../shared';

const tool: DeepwikiTool = {
  name: 'edit_file',
  description: 'Apply incremental edits to .env* files only (structured operations).',
  cacheable: false,
  run: (args) => {
    return editEnvFileTool(String(args.path || ''), args.operations);
  },
};

export default tool;
