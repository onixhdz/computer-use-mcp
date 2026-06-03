import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { BackendError } from "./errors.js";
import { type ComputerUseBackend } from "./types.js";

const OSASCRIPT = "/usr/bin/osascript";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const scriptCache = new Map<string, string>();
export function script(name: string): string {
  const cached = scriptCache.get(name);
  if (cached !== undefined) return cached;
  const text = readFileSync(new URL(`./jxa/${name}`, import.meta.url), "utf8");
  scriptCache.set(name, text);
  return text;
}

function prelude(params: Record<string, unknown>): string {
  const json = JSON.stringify(params)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `const P = ${json};\n`;
}

export function coreScript(
  body: string,
  params: Record<string, unknown>,
): string {
  return prelude(params) + script("core.jxa") + "\n" + script(body);
}

async function runProcess(
  cmd: string,
  args: string[],
  input?: string | Buffer,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
        reject(
          new BackendError(`${cmd} output exceeded ${MAX_OUTPUT_BYTES} bytes`),
        );
        return;
      }
      sink.push(Buffer.from(chunk));
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.on("error", reject);
    child.on("close", (code) => {
      if (overflow) return;
      const out = Buffer.concat(stdout).toString().trim();
      const err = Buffer.concat(stderr).toString().trim();
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(new BackendError(err || `${cmd} exited with code ${code}`));
    });
    if (input && child.stdin) {
      child.stdin.end(input);
    }
  });
}

async function runJxa(code: string, signal?: AbortSignal): Promise<string> {
  return (await runProcess(OSASCRIPT, ["-l", "JavaScript"], code, signal))
    .stdout;
}

async function captureWindow(
  app: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const base64 = await runJxa(
    coreScript("capture-window.jxa", { app }),
    signal,
  );
  if (!base64)
    throw new BackendError(`no window found or capture failed for app: ${app}`);
  return Buffer.from(base64, "base64");
}

export const defaultBackend: ComputerUseBackend = { runJxa, captureWindow };
