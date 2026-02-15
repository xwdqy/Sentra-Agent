declare module 'sentra-rag' {
  type RagIngestOpts = { docId: string; title?: string; source?: string; contextText?: string };
  type RagContextResult = { chunks?: Array<{ rawText?: string; text?: string; [key: string]: unknown }>; contextText?: string; stats?: Record<string, unknown> | null };
  type RagSdk = {
    ingestText: (text: string, opts: RagIngestOpts) => Promise<unknown>;
    getContextHybrid: (query: string) => Promise<RagContextResult>;
    getContextFromFulltext: (query: string, opts?: { limit?: number; expandParent?: boolean }) => Promise<RagContextResult>;
  };

  export function createRagSdk(options?: Record<string, unknown>): Promise<RagSdk>;
  export function getRagEnvNumber(key: string, fallback: number): number;
  export function getRagRuntimeConfig(): Record<string, unknown>;
}
