import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  MAX_DIFF_DEPTH,
  MAX_DIFF_NODES,
  diffSnapshots,
  normalizeAppState,
  stateBaselines,
  type StateSnapshot,
} from "./state-diff.js";

const OSASCRIPT = "/usr/bin/osascript";
const SERVER_NAME = "computer_use";
const SERVER_VERSION = "0.1.0";
const MAX_TYPED_CHARS = 2000;

type JsonSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
};

type TextBlock = { type: "text"; text: string };
type ImageBlock = { type: "image"; data: string; mimeType: string };
type ContentBlock = TextBlock | ImageBlock;

type CoreResult = {
  content: ContentBlock[];
  details: Record<string, unknown>;
  isError?: boolean;
};
type CoreAction = (typeof TOOL_NAMES)[number];
type ToolSpec = {
  name: CoreAction;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: NonNullable<Tool["annotations"]>;
};

export type ComputerUseBackend = {
  platform?: NodeJS.Platform;
  runJxa(code: string, signal?: AbortSignal): Promise<string>;
  captureWindow(app: string, signal?: AbortSignal): Promise<Buffer>;
};

type ExecuteOptions = { signal?: AbortSignal; backend?: ComputerUseBackend };

const TOOL_NAMES = [
  "list_apps",
  "get_app_state",
  "click",
  "perform_secondary_action",
  "set_value",
  "select_text",
  "scroll",
  "drag",
  "press_key",
  "type_text",
  "key_sequence",
  "run_jxa",
] as const;

const stringProp = (
  description: string,
  extra: Record<string, unknown> = {},
) => ({
  type: "string",
  description,
  ...extra,
});
const numberProp = (
  description: string,
  extra: Record<string, unknown> = {},
) => ({
  type: "number",
  description,
  ...extra,
});
const booleanProp = (description: string) => ({ type: "boolean", description });

const emptySchema: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const appSchema = (
  required: string[],
  properties: JsonSchema["properties"],
): JsonSchema => ({
  type: "object",
  properties: {
    app: stringProp("App display name, .app path, bundle id, or numeric pid."),
    ...properties,
  },
  required,
  additionalProperties: false,
});

export const computerUseTools: ToolSpec[] = [
  {
    name: "list_apps",
    title: "List Apps",
    description:
      "List running macOS apps with names, bundle IDs, paths, and process IDs.",
    inputSchema: emptySchema,
    annotations: {
      title: "List Apps",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "get_app_state",
    title: "Get App State",
    description:
      "Return a target app accessibility tree and optional screenshot.",
    inputSchema: appSchema(["app"], {
      maxDepth: numberProp("Maximum accessibility tree depth. Default 40."),
      maxNodes: numberProp("Maximum accessibility nodes. Default 1500."),
      screenshot: booleanProp(
        "Also return a PNG screenshot of the frontmost app window.",
      ),
    }),
    annotations: {
      title: "Get App State",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "click",
    title: "Click",
    description:
      "Click by accessibility element index or app-window screenshot coordinates. Coordinate clicks are delivered in the background (no cursor movement, no window raise). If the result reports the background pointer is unavailable or the action did not register, ask the user for permission to control the cursor, then retry with allow_cursor_takeover: true.",
    inputSchema: appSchema(["app"], {
      element_index: numberProp(
        "Element index from the latest get_app_state snapshot.",
      ),
      x: numberProp("X coordinate in the app-window screenshot."),
      y: numberProp("Y coordinate in the app-window screenshot."),
      mouse_button: stringProp("Mouse button.", {
        enum: ["left", "right", "middle"],
      }),
      click_count: numberProp("Click count. Default 1."),
      allow_cursor_takeover: booleanProp(
        "Only after the user grants permission: move the real cursor to perform the click. Default false (background, never moves the cursor).",
      ),
      maxDepth: numberProp(
        "Maximum accessibility tree depth used to resolve element_index. Default 40.",
      ),
      expectRole: stringProp(
        "Expected friendly role or AX role for indexed clicks.",
      ),
      expectLabel: stringProp(
        "Expected label/value substring for indexed clicks.",
      ),
    }),
    annotations: {
      title: "Click",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "perform_secondary_action",
    title: "Perform Secondary Action",
    description: "Invoke a named AX action exposed by an element.",
    inputSchema: appSchema(["app", "element_index", "action"], {
      element_index: numberProp(
        "Element index from the latest get_app_state snapshot.",
      ),
      action: stringProp(
        "AX action name, e.g. AXShowMenu, AXIncrement, AXRaise.",
      ),
      maxDepth: numberProp("Maximum accessibility tree depth. Default 40."),
      expectRole: stringProp("Expected friendly role or AX role."),
      expectLabel: stringProp("Expected label/value substring."),
    }),
    annotations: {
      title: "Perform Secondary Action",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "set_value",
    title: "Set Value",
    description: "Set a settable accessibility attribute on an element.",
    inputSchema: appSchema(["app", "element_index", "value"], {
      element_index: numberProp(
        "Element index from the latest get_app_state snapshot.",
      ),
      value: stringProp(
        "New value as a string; coerced to native type where possible.",
      ),
      attribute: stringProp("AX attribute to set. Default AXValue."),
      maxDepth: numberProp("Maximum accessibility tree depth. Default 40."),
      expectRole: stringProp("Expected friendly role or AX role."),
      expectLabel: stringProp("Expected label/value substring."),
    }),
    annotations: {
      title: "Set Value",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "select_text",
    title: "Select Text",
    description:
      "Select text inside a text element, or place the cursor before/after it.",
    inputSchema: appSchema(["app", "element_index", "text"], {
      element_index: numberProp("Text-bearing element index."),
      text: stringProp("Exact text to select or use as cursor anchor."),
      prefix: stringProp(
        "Optional disambiguating text immediately before text.",
      ),
      suffix: stringProp(
        "Optional disambiguating text immediately after text.",
      ),
      selection: stringProp("Selection mode. Default text.", {
        enum: ["text", "cursor_before", "cursor_after"],
      }),
      maxDepth: numberProp("Maximum accessibility tree depth. Default 40."),
    }),
    annotations: {
      title: "Select Text",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "scroll",
    title: "Scroll",
    description: "Scroll the target app in one direction.",
    inputSchema: appSchema(["app", "direction"], {
      direction: stringProp("Scroll direction.", {
        enum: ["up", "down", "left", "right"],
      }),
      pages: numberProp("Pages or page fraction to scroll. Default 1."),
    }),
    annotations: {
      title: "Scroll",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "drag",
    title: "Drag",
    description:
      "Drag from one app-window screenshot coordinate to another. Delivered in the background (no cursor movement, no window raise). If the result reports the background pointer is unavailable or the drag did not register, ask the user for permission to control the cursor, then retry with allow_cursor_takeover: true.",
    inputSchema: appSchema(["app", "from_x", "from_y", "to_x", "to_y"], {
      from_x: numberProp("Start X coordinate in app-window screenshot."),
      from_y: numberProp("Start Y coordinate in app-window screenshot."),
      to_x: numberProp("End X coordinate in app-window screenshot."),
      to_y: numberProp("End Y coordinate in app-window screenshot."),
      allow_cursor_takeover: booleanProp(
        "Only after the user grants permission: move the real cursor to perform the drag. Default false (background, never moves the cursor).",
      ),
    }),
    annotations: {
      title: "Drag",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "press_key",
    title: "Press Key",
    description: "Press a key or key combination in the target app.",
    inputSchema: appSchema(["app", "key"], {
      key: stringProp(
        "Key or combo, e.g. Return, Tab, Escape, cmd+l, ctrl+shift+t.",
      ),
      element_index: numberProp("Optional element index to focus first."),
      maxDepth: numberProp("Maximum accessibility tree depth. Default 40."),
    }),
    annotations: {
      title: "Press Key",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "type_text",
    title: "Type Text",
    description: "Type ASCII text into the target app using real key events.",
    inputSchema: appSchema(["app", "text"], {
      text: stringProp(
        `Literal ASCII text to type. Max ${MAX_TYPED_CHARS} chars.`,
      ),
      element_index: numberProp("Optional element index to focus first."),
      maxDepth: numberProp("Maximum accessibility tree depth. Default 40."),
    }),
    annotations: {
      title: "Type Text",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "key_sequence",
    title: "Key Sequence",
    description:
      "Run ordered key/text steps in one call with short delays. Use for focus-type-submit flows (for example Chrome cmd+l, URL, Return) and transient overlays like command palettes, Quick Open, or autocomplete where separate press_key/type_text calls can lose focus, dismiss the overlay, or drop the commit key.",
    inputSchema: appSchema(["app", "steps"], {
      steps: {
        type: "array",
        description:
          "Ordered steps. Each step has exactly one of key (a key or combo) or text (ASCII to type), e.g. [{key:'cmd+l'},{text:'example.com'},{key:'Return'}].",
        items: {
          type: "object",
          properties: {
            key: stringProp(
              "Key or combo for this step, e.g. cmd+p, Return, Escape.",
            ),
            text: stringProp(
              `Literal ASCII text to type for this step. Max ${MAX_TYPED_CHARS} chars.`,
            ),
          },
          additionalProperties: false,
        },
      },
      element_index: numberProp(
        "Optional element index to focus once before running the sequence.",
      ),
      maxDepth: numberProp("Maximum accessibility tree depth. Default 40."),
    }),
    annotations: {
      title: "Key Sequence",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "run_jxa",
    title: "Run JXA",
    description:
      "Last-resort fallback: run raw JavaScript for Automation (JXA) on macOS when no other tool can do the task. Executes arbitrary code with the user's privileges; prefer the structured tools and use this only when they cannot accomplish the goal.",
    inputSchema: {
      type: "object",
      properties: {
        code: stringProp(
          "JXA source executed via 'osascript -l JavaScript'. Return a string for output.",
        ),
      },
      required: ["code"],
      additionalProperties: false,
    },
    annotations: {
      title: "Run JXA",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

const toolByName = new Map(computerUseTools.map((tool) => [tool.name, tool]));

class ComputerUseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = code;
  }
}

export class PlatformUnsupportedError extends ComputerUseError {
  constructor() {
    super("platform_unsupported", "computer-use currently supports macOS only");
  }
}
export class ValidationError extends ComputerUseError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("validation_error", message, details);
  }
}
export class AppNotFoundError extends ComputerUseError {
  constructor(app: string) {
    super("app_not_found", `app not found or not running: ${app}`, { app });
  }
}
export class BackendError extends ComputerUseError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("backend_error", message, details);
  }
}

function ensureMac(platform: NodeJS.Platform): void {
  if (platform !== "darwin") throw new PlatformUnsupportedError();
}

function validateKeySequenceStep(step: unknown, index: number): void {
  if (typeof step !== "object" || step === null)
    throw new ValidationError(`key_sequence: step ${index} must be an object`);

  const stepArgs = step as Record<string, unknown>;
  const unknownKey = Object.keys(stepArgs).find(
    (key) => key !== "key" && key !== "text",
  );
  if (unknownKey)
    throw new ValidationError(
      `key_sequence: step ${index} has unknown argument ${unknownKey}`,
    );

  const { key, text } = stepArgs;
  const hasKey = key !== undefined;
  const hasText = text !== undefined;
  if (hasKey === hasText)
    throw new ValidationError(
      `key_sequence: step ${index} must have exactly one of key or text`,
    );
  if (hasKey && typeof key !== "string")
    throw new ValidationError(
      `key_sequence: step ${index} key must be a string`,
    );
  if (hasText && typeof text !== "string")
    throw new ValidationError(
      `key_sequence: step ${index} text must be a string`,
    );
  if (hasText && text.length > MAX_TYPED_CHARS)
    throw new ValidationError(
      `key_sequence: step ${index} text too long (max ${MAX_TYPED_CHARS} chars)`,
    );
}

function validateArgs(tool: ToolSpec, args: Record<string, unknown>): void {
  for (const field of tool.inputSchema.required ?? []) {
    if (
      args[field] === undefined ||
      args[field] === null ||
      args[field] === ""
    ) {
      throw new ValidationError(`${tool.name}: ${field} is required`, {
        field,
      });
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const prop = tool.inputSchema.properties[key];
    if (!prop)
      throw new ValidationError(`${tool.name}: unknown argument ${key}`, {
        field: key,
      });
    if (prop.type === "string" && typeof value !== "string")
      throw new ValidationError(`${tool.name}: ${key} must be a string`);
    if (
      prop.type === "number" &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new ValidationError(`${tool.name}: ${key} must be a finite number`);
    }
    if (prop.type === "boolean" && typeof value !== "boolean")
      throw new ValidationError(`${tool.name}: ${key} must be a boolean`);
    if (Array.isArray(prop.enum) && !prop.enum.includes(value)) {
      throw new ValidationError(
        `${tool.name}: ${key} must be one of ${prop.enum.join(", ")}`,
      );
    }
  }
  if (tool.name === "click") {
    const hasIndex = args.element_index !== undefined;
    const hasCoords = args.x !== undefined || args.y !== undefined;
    if (!hasIndex && !hasCoords)
      throw new ValidationError(
        "click requires element_index or x/y coordinates",
      );
    if (hasCoords && (args.x === undefined || args.y === undefined))
      throw new ValidationError("click coordinates require both x and y");
  }
  if (
    tool.name === "type_text" &&
    typeof args.text === "string" &&
    args.text.length > MAX_TYPED_CHARS
  ) {
    throw new ValidationError(
      `type_text: text too long (${args.text.length} chars; max ${MAX_TYPED_CHARS})`,
    );
  }
  if (tool.name === "key_sequence") {
    const { steps } = args;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new ValidationError(
        "key_sequence: steps must be a non-empty array",
      );
    }
    steps.forEach(validateKeySequenceStep);
  }
}

function ok(
  text: string,
  details: Record<string, unknown> = {},
  extra: ContentBlock[] = [],
): CoreResult {
  return {
    content: [{ type: "text", text }, ...extra],
    details: { ok: true, ...details },
  };
}

function errorResult(error: unknown): CoreResult {
  const err =
    error instanceof ComputerUseError
      ? error
      : new BackendError(
          error instanceof Error ? error.message : String(error),
        );
  return {
    content: [{ type: "text", text: `Error: ${err.message}` }],
    details: { ok: false, code: err.code, error: err.message, ...err.details },
    isError: true,
  };
}

export async function executeComputerUseAction(
  name: string,
  args: Record<string, unknown> = {},
  options: ExecuteOptions = {},
): Promise<CoreResult> {
  try {
    const tool = toolByName.get(name as CoreAction);
    if (!tool) throw new ValidationError(`unknown tool: ${name}`);
    validateArgs(tool, args);
    const backend = options.backend ?? defaultBackend;
    ensureMac(backend.platform ?? process.platform);
    switch (tool.name) {
      case "list_apps":
        return await runListApps(backend, options.signal);
      case "get_app_state":
        return await runGetAppState(backend, args, options.signal);
      case "click":
        return await runWithStateDiff(backend, args, options.signal, () =>
          runClick(backend, args, options.signal),
        );
      case "perform_secondary_action":
        return await runWithStateDiff(backend, args, options.signal, () =>
          runIndexedAction(
            backend,
            "perform_secondary_action",
            { ...args, kind: "action" },
            options.signal,
          ),
        );
      case "set_value":
        return await runWithStateDiff(backend, args, options.signal, () =>
          runIndexedAction(
            backend,
            "set_value",
            { ...args, kind: "setvalue" },
            options.signal,
          ),
        );
      case "select_text":
        return await runWithStateDiff(backend, args, options.signal, () =>
          runSelectText(backend, args, options.signal),
        );
      case "scroll":
        return await runWithStateDiff(backend, args, options.signal, () =>
          runPointerAction(backend, "scroll", args, options.signal),
        );
      case "drag":
        return await runWithStateDiff(backend, args, options.signal, () =>
          runPointerAction(backend, "drag", args, options.signal),
        );
      case "press_key":
        return await runWithStateDiff(backend, args, options.signal, () =>
          runKeys(
            backend,
            "press_key",
            { ...args, kind: "key" },
            options.signal,
          ),
        );
      case "type_text":
        return await runWithStateDiff(backend, args, options.signal, () =>
          runKeys(
            backend,
            "type_text",
            { ...args, kind: "type" },
            options.signal,
          ),
        );
      case "key_sequence":
        return await runWithStateDiff(backend, args, options.signal, () =>
          runKeys(
            backend,
            "key_sequence",
            { ...args, kind: "sequence" },
            options.signal,
          ),
        );
      case "run_jxa":
        return await runRawJxa(backend, args, options.signal);
    }
  } catch (error) {
    return errorResult(error);
  }
}

const scriptCache = new Map<string, string>();
function script(name: string): string {
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

function coreScript(body: string, params: Record<string, unknown>): string {
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
    child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
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

const defaultBackend: ComputerUseBackend = { runJxa, captureWindow };

function app(args: Record<string, unknown>): string {
  return String(args.app ?? "");
}

async function captureStateSnapshot(
  backend: ComputerUseBackend,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  limits?: { maxDepth: number; maxNodes: number },
): Promise<StateSnapshot> {
  const requestedDepth = limits?.maxDepth ?? Number(args.maxDepth ?? 40);
  const requestedNodes = limits?.maxNodes ?? Number(args.maxNodes ?? 1500);
  const maxDepth = Math.min(requestedDepth, MAX_DIFF_DEPTH);
  const maxNodes = Math.min(requestedNodes, MAX_DIFF_NODES);
  const tree = await backend.runJxa(
    coreScript("app-state.jxa", {
      app: app(args),
      maxDepth,
      maxNodes,
    }),
    signal,
  );
  if (tree.startsWith("ERROR: app not found"))
    throw new AppNotFoundError(app(args));
  if (tree.startsWith("ERROR:"))
    throw new BackendError(tree.slice("ERROR:".length).trim());
  return normalizeAppState(app(args), tree || "", maxDepth, maxNodes);
}

function seedBaseline(
  backend: ComputerUseBackend,
  targetApp: string,
  tree: string,
  maxDepth = 40,
  maxNodes = 1500,
): void {
  stateBaselines.set(
    stateBaselines.key(backend, targetApp),
    normalizeAppState(
      targetApp,
      tree || "",
      Math.min(maxDepth, MAX_DIFF_DEPTH),
      Math.min(maxNodes, MAX_DIFF_NODES),
    ),
  );
}

async function runWithStateDiff(
  backend: ComputerUseBackend,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
  action: () => Promise<CoreResult>,
): Promise<CoreResult> {
  const key = stateBaselines.key(backend, app(args));
  return stateBaselines.enqueue(key, async () => {
    stateBaselines.evict();
    let before = stateBaselines.get(key);
    let baselineWarning: string | undefined;
    if (!before) {
      try {
        before = await captureStateSnapshot(backend, args, signal);
      } catch (error) {
        baselineWarning =
          error instanceof Error ? error.message : String(error);
      }
    }

    const result = await action();
    let after: StateSnapshot | undefined;
    let diffText: string;
    let diffDetails: Record<string, unknown> = { available: false };
    try {
      after = await captureStateSnapshot(backend, args, signal, before);
      stateBaselines.set(key, after);
      if (before) {
        const diff = diffSnapshots(before, after);
        diffText = diff.text;
        diffDetails = { available: true, ...diff, text: undefined };
        if (!diff.added && !diff.removed && !diff.changed) {
          try {
            const image = await backend.captureWindow(app(args), signal);
            result.content.push({
              type: "image",
              data: image.toString("base64"),
              mimeType: "image/png",
            });
            diffText +=
              "\n- Visual fallback screenshot attached because Accessibility exposed no high-signal changes.";
            diffDetails.visualFallback = {
              available: true,
              reason: "empty_accessibility_diff",
            };
          } catch (error) {
            diffDetails.visualFallback = {
              available: false,
              reason: error instanceof Error ? error.message : String(error),
            };
          }
          if (result.details.delivery === "background") {
            diffText +=
              "\n- Accessibility exposed no change, which is normal for canvas or purely visual actions — inspect the attached screenshot. If the action did not take effect, ask the user to allow cursor control and retry with allow_cursor_takeover: true.";
          }
        }
      } else {
        diffText = `App state diff:\n- Unavailable: no previous baseline${baselineWarning ? ` (${baselineWarning})` : ""}.\n\nCurrent:\n${after.summary.map((line) => `- ${line}`).join("\n")}`;
        diffDetails = { available: false, reason: "missing_baseline" };
      }
    } catch (error) {
      stateBaselines.delete(key);
      const message = error instanceof Error ? error.message : String(error);
      diffText = `App state diff:\n- Unavailable: post-action app state failed: ${message}. Baseline was invalidated; the next action will capture a fresh baseline.`;
      diffDetails = {
        available: false,
        reason: message,
        baselineInvalidated: true,
      };
    }

    const firstText = result.content.find(
      (item): item is TextBlock => item.type === "text",
    );
    if (firstText) firstText.text = `${firstText.text}\n\n${diffText}`;
    else result.content.unshift({ type: "text", text: diffText });
    result.details.appStateDiff = diffDetails;
    return result;
  });
}

async function runListApps(
  backend: ComputerUseBackend,
  signal?: AbortSignal,
): Promise<CoreResult> {
  const stdout = await backend.runJxa(script("list-apps.jxa"), signal);
  const text = stdout || "(no running apps)";
  return ok(text, { op: "list_apps", output: text });
}

async function runRawJxa(
  backend: ComputerUseBackend,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CoreResult> {
  const out = await backend.runJxa(String(args.code ?? ""), signal);
  const text = out || "(no output)";
  return ok(text, { op: "run_jxa", output: text });
}

async function runGetAppState(
  backend: ComputerUseBackend,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CoreResult> {
  const params = {
    app: app(args),
    maxDepth: args.maxDepth ?? 40,
    maxNodes: args.maxNodes ?? 1500,
  };
  const tree = await backend.runJxa(
    coreScript("app-state.jxa", params),
    signal,
  );
  if (tree.startsWith("ERROR: app not found"))
    throw new AppNotFoundError(app(args));
  if (tree.startsWith("ERROR:"))
    throw new BackendError(tree.slice("ERROR:".length).trim());
  const content: ContentBlock[] = [
    { type: "text", text: tree || "(empty tree)" },
  ];
  const details: Record<string, unknown> = {
    op: "get_app_state",
    tree,
    nodes: tree ? tree.split("\n").length : 0,
  };
  seedBaseline(
    backend,
    app(args),
    tree,
    Number(args.maxDepth ?? 40),
    Number(args.maxNodes ?? 1500),
  );
  if (args.screenshot) {
    const image = await backend.captureWindow(app(args), signal);
    content.push({
      type: "image",
      data: image.toString("base64"),
      mimeType: "image/png",
    });
    details.bytes = image.byteLength;
  }
  return { content, details: { ok: true, ...details } };
}

async function runClick(
  backend: ComputerUseBackend,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CoreResult> {
  if (args.element_index !== undefined) {
    return runIndexedAction(
      backend,
      "click",
      { ...args, kind: "press" },
      signal,
    );
  }
  return runPointerAction(backend, "click", args, signal);
}

function normalizeIndexedArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return {
    app: args.app,
    index: args.element_index,
    maxDepth: args.maxDepth ?? 40,
    kind: args.kind,
    action: args.action,
    attribute: args.attribute,
    value: args.value,
    expectRole: args.expectRole,
    expectLabel: args.expectLabel,
  };
}

async function runIndexedAction(
  backend: ComputerUseBackend,
  op: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CoreResult> {
  const stdout = await backend.runJxa(
    coreScript("action.jxa", normalizeIndexedArgs(args)),
    signal,
  );
  const parsed = parseActionJson(stdout, op);
  if (!parsed.ok)
    throw new BackendError(String(parsed.error ?? "action failed"), parsed);
  return ok(indexedSummary(op, parsed), { op, ...parsed });
}

async function runKeys(
  backend: ComputerUseBackend,
  op: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CoreResult> {
  const stdout = await backend.runJxa(
    coreScript("keys.jxa", {
      app: args.app,
      kind: args.kind,
      text: args.text,
      key: args.key,
      steps: args.steps,
      index: args.element_index,
      maxDepth: args.maxDepth ?? 40,
    }),
    signal,
  );
  const parsed = parseActionJson(stdout, op);
  if (!parsed.ok)
    throw new BackendError(String(parsed.error ?? "key action failed"), parsed);
  let text: string;
  if (op === "press_key") text = `pressed ${parsed.key}`;
  else if (op === "key_sequence") text = `ran ${parsed.steps ?? 0} steps`;
  else
    text = `typed ${parsed.typed ?? 0} chars${parsed.skipped ? ` (${parsed.skipped} unsupported)` : ""}`;
  return ok(text, { op, ...parsed });
}

async function runPointerAction(
  backend: ComputerUseBackend,
  op: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CoreResult> {
  const stdout = await backend.runJxa(
    coreScript("pointer.jxa", { ...args, op }),
    signal,
  );
  const parsed = parseActionJson(stdout, op);
  if (!parsed.ok)
    throw new BackendError(String(parsed.error ?? `${op} failed`), parsed);
  return ok(String(parsed.message ?? `${op} ok`), { op, ...parsed });
}

async function runSelectText(
  backend: ComputerUseBackend,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CoreResult> {
  const stdout = await backend.runJxa(
    coreScript("select-text.jxa", {
      ...args,
      index: args.element_index,
      selection: args.selection ?? "text",
      maxDepth: args.maxDepth ?? 40,
    }),
    signal,
  );
  const parsed = parseActionJson(stdout, "select_text");
  if (!parsed.ok)
    throw new BackendError(
      String(parsed.error ?? "select_text failed"),
      parsed,
    );
  return ok(String(parsed.message ?? "selected text"), {
    op: "select_text",
    ...parsed,
  });
}

function parseActionJson(
  stdout: string,
  op: string,
): Record<string, unknown> & { ok?: boolean } {
  try {
    return { op, ...(JSON.parse(stdout) as Record<string, unknown>) };
  } catch {
    return { op, ok: false, error: stdout || "no output" };
  }
}

function indexedSummary(op: string, details: Record<string, unknown>): string {
  if (op === "set_value")
    return `set ${details.attribute ?? "AXValue"} on [${details.index}]`;
  if (op === "perform_secondary_action")
    return `${details.action ?? "action"} on [${details.index}]`;
  return `clicked [${details.index}]`;
}

function toMcpResult(result: CoreResult): CallToolResult {
  return { content: result.content, isError: result.isError };
}

export function createComputerUseMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: "macOS-only computer-use tools exposed over MCP.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: computerUseTools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const result = await executeComputerUseAction(
      request.params.name,
      request.params.arguments ?? {},
      {
        signal: extra.signal,
      },
    );
    return toMcpResult(result);
  });
  return server;
}

export async function runComputerUseMcpServer(): Promise<void> {
  const server = createComputerUseMcpServer();
  await server.connect(new StdioServerTransport());
}

export function getComputerUseMcpServerConfig():
  | { type: "local"; command: string[]; enabled: boolean }
  | undefined {
  if (process.platform !== "darwin") return undefined;
  const root = dirname(fileURLToPath(import.meta.url));
  const sourceBin = join(root, "bin", "computer-use-mcp.ts");
  if (process.versions.bun && existsSync(sourceBin))
    return {
      type: "local",
      command: [process.execPath, sourceBin],
      enabled: true,
    };
  const builtBin = join(root, "bin", "computer-use-mcp.js");
  if (existsSync(builtBin))
    return { type: "local", command: ["node", builtBin], enabled: true };
  if (existsSync(sourceBin))
    return { type: "local", command: ["bun", sourceBin], enabled: true };
  return undefined;
}
