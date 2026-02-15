declare module 'linkify-it' {
  const LinkifyIt: new (...args: any[]) => {
    match: (text: string) => Array<{ raw: string }> | null;
  };
  export default LinkifyIt;
}

declare module 'string-similarity' {
  export function compareTwoStrings(a: string, b: string): number;
  export function findBestMatch(mainString: string, targetStrings: string[]): {
    ratings: Array<{ target: string; rating: number }>;
    bestMatch: { target: string; rating: number };
    bestMatchIndex: number;
  };
}

declare module 'wink-nlp-utils' {
  const winkUtils: any;
  export default winkUtils;
}

declare module 'sentra-rag' {
  const sdk: any;
  export default sdk;
}

declare module 'segment' {
  class Segment {
    useDefault(): void;
    doSegment(text: string, options?: { simple?: boolean; stripPunctuation?: boolean }): string[];
  }
  export default Segment;
}

declare module 'sentra-mcp' {
  class SentraMcpSDK {
    init: () => Promise<void>;
    cancelRun?: (runId: string) => Promise<void> | void;
    callTool: (params: { aiName: string; args?: Record<string, unknown>; context?: Record<string, unknown> }) => Promise<unknown>;
    sendAndWaitResult?: (payload: Record<string, unknown>) => Promise<unknown>;
    stream: (params: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>;
    streamToolsXml?: (params: Record<string, unknown>) => AsyncIterable<Record<string, unknown>>;
  }
  export default SentraMcpSDK;
}

declare module 'sentra-mcp/src/history/store.js' {
  export const HistoryStore: {
    list: (runId: string, start: number, end: number) => Promise<unknown>;
  };
}

declare module 'mime-types' {
  const mimeTypes: any;
  export default mimeTypes;
  export function lookup(path: string): string | false;
  export function contentType(type: string): string | false;
}
