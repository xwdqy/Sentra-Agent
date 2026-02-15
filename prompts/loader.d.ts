export function loadPrompt(name: string): Promise<unknown>;
export function renderTemplate(str: string, vars?: Record<string, unknown>): string;
export function composeSystem(base: string, overlay?: string | null): string;
