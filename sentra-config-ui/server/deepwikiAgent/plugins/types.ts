export type DeepwikiToolResult = { success: boolean; data: any };

export type DeepwikiTool = {
  name: string;
  description: string;
  cacheable: boolean;
  run: (args: Record<string, any>) => DeepwikiToolResult;
};
