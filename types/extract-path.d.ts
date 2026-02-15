declare module 'extract-path' {
  export interface ExtractPathOptions {
    validateFileExists?: boolean;
    resolveWithFallback?: boolean;
  }

  const extractPath: (input: string, options?: ExtractPathOptions) => string | null;
  export default extractPath;
}
