declare module 'sentra-prompts' {
  const SentraPromptsSDK: (template: string, configPath: string) => Promise<string>;
  export default SentraPromptsSDK;
}
