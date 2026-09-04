// Ambient types for the haven-proxy package (plain ESM JS, ships no types).
// Shapes mirror haven-proxy/src/relay.js, src/config.js and src/catalog.js.
declare module "haven-proxy/relay" {
  export interface HavenRelayError {
    status: number;
    message: string;
    type?: string;
    code?: string;
    retryAfter?: string;
  }

  export interface HavenRelayResult {
    ok: boolean;
    aborted?: boolean;
    error?: HavenRelayError;
    stream?: ReadableStream<Uint8Array>;
    completion?: unknown;
    usage?: unknown;
    wantStream?: boolean;
    includeUsage?: boolean;
  }

  export interface SecureRelay {
    relay(
      body: object,
      opts?: { signal?: AbortSignal },
    ): Promise<HavenRelayResult>;
    setServableModels(ids: string[] | null): void;
    ready(): Promise<void>;
    validate(): Promise<{ ok: boolean; reason?: string; balance?: number }>;
  }

  export function createSecureRelay(opts: {
    havenApiRoot: string;
    apiKey: string;
    timeoutMs?: number;
  }): SecureRelay;

  export function sseLinesFor(
    completion: unknown,
    includeUsage?: boolean,
  ): string[];

  export const INSUFFICIENT_BALANCE_MSG: string;
}

declare module "haven-proxy/config" {
  export function loadConfig(): {
    cfg: { apiKey?: string; baseURL?: string };
    path: string;
  };
}

declare module "haven-proxy/catalog" {
  export interface HavenCatalogModel {
    id: string;
    name?: string;
    cost?: { input: number; output: number };
    limit?: { context?: number; output?: number };
    capabilities?: {
      tool_call?: boolean;
      attachment?: boolean;
      reasoning?: boolean;
    };
  }

  export function resolveCatalog(havenApiRoot: string): Promise<{
    models: HavenCatalogModel[];
    servableIds: string[] | null;
    source: "backend" | "cache" | "builtin";
  }>;
}
