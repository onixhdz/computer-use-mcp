import { coreScript, defaultBackend, script } from "./backend.js";
import {
  AppNotFoundError,
  BackendError,
  ComputerUseError,
  ValidationError,
} from "./errors.js";
import {
  MAX_DIFF_DEPTH,
  MAX_DIFF_NODES,
  diffSnapshots,
  normalizeAppState,
  stateBaselines,
  type StateSnapshot,
} from "./state-diff.js";
import { toolByName } from "./tools.js";
import {
  MAX_APP_STATE_DEPTH,
  MAX_APP_STATE_NODES,
  MAX_TYPED_CHARS,
  type ComputerUseBackend,
  type ContentBlock,
  type CoreAction,
  type CoreResult,
  type ExecuteOptions,
  type TextBlock,
} from "./types.js";
import { ensureMac, validateArgs } from "./validation.js";

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

function app(args: Record<string, unknown>): string {
  return String(args.app ?? "");
}

const clampLimit = (value: unknown, fallback: number, max: number): number =>
  Math.min(Math.max(1, Number(value ?? fallback)), max);

async function runAppStateScript(
  backend: ComputerUseBackend,
  targetApp: string,
  maxDepth: unknown,
  maxNodes: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const tree = await backend.runJxa(
    coreScript("app-state.jxa", { app: targetApp, maxDepth, maxNodes }),
    signal,
  );
  if (tree.startsWith("ERROR: app not found"))
    throw new AppNotFoundError(targetApp);
  if (tree.startsWith("ERROR:"))
    throw new BackendError(tree.slice("ERROR:".length).trim());
  return tree;
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
  const tree = await runAppStateScript(
    backend,
    app(args),
    maxDepth,
    maxNodes,
    signal,
  );
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
              "\n- Accessibility exposed no change, which is normal for canvas or purely visual actions. If the action did not take effect, ask the user to allow cursor control and retry with allow_cursor_takeover: true.";
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
  const maxDepth = clampLimit(args.maxDepth, 40, MAX_APP_STATE_DEPTH);
  const maxNodes = clampLimit(args.maxNodes, 1500, MAX_APP_STATE_NODES);
  const tree = await runAppStateScript(
    backend,
    app(args),
    maxDepth,
    maxNodes,
    signal,
  );
  const content: ContentBlock[] = [
    { type: "text", text: tree || "(empty tree)" },
  ];
  const details: Record<string, unknown> = {
    op: "get_app_state",
    tree,
    nodes: tree ? tree.split("\n").length : 0,
  };
  seedBaseline(backend, app(args), tree, maxDepth, maxNodes);
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
      maxTyped: MAX_TYPED_CHARS,
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
