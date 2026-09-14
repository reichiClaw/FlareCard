// The app itself uses Web-standard APIs only, so the main tsconfig carries just the
// Workers types. Tests that shell out (openssl, Pebble) need these few Node modules.

declare module "node:child_process" {
  export function execFileSync(
    file: string,
    args?: readonly string[],
    options?: { stdio?: unknown; cwd?: string; env?: Record<string, string | undefined>; timeout?: number },
  ): { toString(encoding?: string): string };
  export interface ChildProcess {
    kill(signal?: string): boolean;
    on(event: "exit" | "error", listener: (...args: unknown[]) => void): this;
    stdout: { on(event: "data", listener: (chunk: { toString(): string }) => void): void } | null;
    stderr: { on(event: "data", listener: (chunk: { toString(): string }) => void): void } | null;
  }
  export function spawn(
    file: string,
    args?: readonly string[],
    options?: { stdio?: unknown; cwd?: string; env?: Record<string, string | undefined> },
  ): ChildProcess;
}

declare module "node:fs" {
  export function mkdtempSync(prefix: string): string;
  export function writeFileSync(path: string, data: string | Uint8Array): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:http" {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    headers: Record<string, string | string[] | undefined>;
    on(event: "data", listener: (chunk: Uint8Array) => void): void;
    on(event: "end", listener: () => void): void;
  }
  export interface ServerResponse {
    writeHead(status: number, headers?: Record<string, string>): void;
    end(body?: string | Uint8Array): void;
  }
  export interface Server {
    listen(port: number, host: string, cb?: () => void): Server;
    close(cb?: () => void): void;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
}

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): never;
};
