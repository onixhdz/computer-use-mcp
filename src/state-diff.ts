const BASELINE_TTL_MS = 10 * 60 * 1000;
const MAX_BASELINES = 20;
const MAX_FACTS = 2000;
const MAX_DIFF_LINES = 50;
const MAX_DIFF_CHARS = 8_000;
const MAX_FACT_TEXT = 180;
export const MAX_DIFF_DEPTH = 40;
export const MAX_DIFF_NODES = 1500;

type StateFactCategory =
  | "window"
  | "url"
  | "focus"
  | "selected"
  | "value"
  | "enabled"
  | "visibility"
  | "modal"
  | "state"
  | "text";

type StateNode = {
  depth: number;
  index: number;
  role: string;
  label: string;
  value?: string;
  url?: string;
  placeholder?: string;
  flags: Set<string>;
  context: string;
  line: string;
};

type StateFact = {
  key: string;
  category: StateFactCategory;
  label: string;
  role?: string;
  value?: string;
  context?: string;
  line: string;
  priority: number;
};

export type StateSnapshot = {
  app: string;
  lines: number;
  facts: Map<string, StateFact>;
  summary: string[];
  capturedAt: number;
  maxDepth: number;
  maxNodes: number;
};

export type DiffResult = {
  text: string;
  added: number;
  removed: number;
  changed: number;
  truncated: boolean;
};

const FRIENDLY_ROLES = [
  "full screen button",
  "disclosure triangle",
  "menu bar item",
  "pop up button",
  "close button",
  "minimize button",
  "toggle button",
  "radio button",
  "HTML content",
  "switch",
  "text field",
  "text area",
  "menu button",
  "scroll area",
  "content list",
  "tab group",
  "menu item",
  "menu bar",
  "combo box",
  "checkbox",
  "container",
  "toolbar",
  "heading",
  "button",
  "slider",
  "window",
  "column",
  "outline",
  "image",
  "table",
  "link",
  "cell",
  "text",
  "menu",
  "row",
  "tab",
].sort((a, b) => b.length - a.length);

class StateBaselineStore {
  private baselineByTarget = new Map<string, StateSnapshot>();
  private targetQueues = new Map<string, Promise<unknown>>();
  private backendIds = new WeakMap<object, number>();
  private nextBackendId = 1;

  key(backend: object, targetApp: string): string {
    let id = this.backendIds.get(backend);
    if (id === undefined) {
      id = this.nextBackendId++;
      this.backendIds.set(backend, id);
    }
    return `${id}:${targetApp}`;
  }

  get(key: string): StateSnapshot | undefined {
    return this.baselineByTarget.get(key);
  }

  set(key: string, snapshot: StateSnapshot): void {
    this.evict();
    this.baselineByTarget.set(key, snapshot);
  }

  delete(key: string): void {
    this.baselineByTarget.delete(key);
  }

  evict(now = Date.now()): void {
    for (const [key, snapshot] of this.baselineByTarget) {
      if (now - snapshot.capturedAt > BASELINE_TTL_MS)
        this.baselineByTarget.delete(key);
    }
    while (this.baselineByTarget.size > MAX_BASELINES) {
      const oldest = [...this.baselineByTarget.entries()].sort(
        (a, b) => a[1].capturedAt - b[1].capturedAt,
      )[0]?.[0];
      if (!oldest) break;
      this.baselineByTarget.delete(oldest);
    }
  }

  async enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.targetQueues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const tracked = next
      .catch(() => undefined)
      .finally(() => {
        if (this.targetQueues.get(key) === tracked)
          this.targetQueues.delete(key);
      });
    this.targetQueues.set(key, tracked);
    return next;
  }
}

export const stateBaselines = new StateBaselineStore();

function truncateText(text: string, max = MAX_FACT_TEXT): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 14)}… [truncated]`;
}

function stripTrailingFields(line: string): string {
  return line
    .replace(/(?:^| )Position:.*$/, "")
    .replace(/(?:^| )Secondary Actions:.*$/, "")
    .replace(/(?:^| )Selected Text:.*$/, "")
    .replace(/(?:^| )Identifier:.*$/, "")
    .replace(/(?:^| )Help:.*$/, "")
    .replace(/(?:^| )Role:.*$/, "")
    .replace(/(?:^| )Mark:.*$/, "")
    .trim();
}

function cleanLabel(label: string): string {
  return label
    .replace(/^Description:\s*/, "")
    .replace(/,+$/, "")
    .trim();
}

function extractField(
  rest: string,
  marker: string,
): [string, string | undefined] {
  const startMarker = marker.trimStart();
  if (rest.startsWith(startMarker)) {
    const value = rest.slice(startMarker.length).trim();
    return ["", value ? truncateText(value) : undefined];
  }
  const idx = rest.indexOf(marker);
  if (idx < 0) return [rest, undefined];
  const value = rest.slice(idx + marker.length).trim();
  return [rest.slice(0, idx).trim(), value ? truncateText(value) : undefined];
}

function parseStateLine(line: string): StateNode | undefined {
  const match = /^(\s*)(\d+)\s+(.+)$/.exec(line);
  if (!match) return undefined;
  const depth = Math.floor(match[1].length / 2);
  const index = Number(match[2]);
  let rest = match[3];
  const role = FRIENDLY_ROLES.find(
    (candidate) => rest === candidate || rest.startsWith(`${candidate} `),
  );
  if (!role) return undefined;
  rest = rest.slice(role.length).trim();

  const flags = new Set<string>();
  if (rest.startsWith("(")) {
    const close = rest.indexOf(")");
    if (close >= 0) {
      for (const flag of rest.slice(1, close).split(",")) {
        const trimmed = flag.trim();
        if (trimmed) flags.add(trimmed);
      }
      rest = rest.slice(close + 1).trim();
    }
  }

  rest = stripTrailingFields(rest);
  let url: string | undefined;
  let placeholder: string | undefined;
  let value: string | undefined;
  [rest, url] = extractField(rest, " URL: ");
  [rest, placeholder] = extractField(rest, " Placeholder: ");
  [rest, value] = extractField(rest, " Value: ");
  const label = truncateText(cleanLabel(rest));

  return {
    depth,
    index,
    role,
    label,
    value,
    url,
    placeholder,
    flags,
    context: "",
    line: stripTrailingFields(line.trim()),
  };
}

function factKey(...parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => !!part)
    .map((part) => part.toLowerCase())
    .join("|");
}

function nodeIdentity(node: StateNode): string {
  return factKey(
    node.context,
    node.role,
    node.label || node.placeholder || `node-${node.index}`,
  );
}

function addFact(facts: StateFact[], fact: StateFact): void {
  if (facts.length < MAX_FACTS) facts.push(fact);
}

function lowSignalLabel(label: string): boolean {
  return (
    !label ||
    /^#[0-9a-f]{3,8}$/i.test(label) ||
    label === "transparent" ||
    /^\d+$/.test(label) ||
    label === "%" ||
    label.startsWith("Secondary Actions")
  );
}

function highSignalContainerLabel(label: string): boolean {
  return /actions?|dialog|menu|toolbar|canvas|settings?|results?|library|layers?|style|width|opacity|shape|status|error|warning|press|enter|tip|selected/i.test(
    label,
  );
}

function visibilityPriority(role: string, label: string): number {
  if (role === "window") return 15;
  if (role === "text field" || role === "text area") return 45;
  if (
    role === "checkbox" ||
    role === "radio button" ||
    role === "switch" ||
    role === "toggle button" ||
    role === "tab"
  )
    return 50;
  if (role === "button" || role === "menu item" || role === "pop up button")
    return 60;
  if (role === "heading" || role === "text")
    return highSignalContainerLabel(label) ? 55 : 80;
  if (role === "container") return highSignalContainerLabel(label) ? 55 : 90;
  return 75;
}

export function normalizeAppState(
  appName: string,
  tree: string,
  maxDepth = 40,
  maxNodes = 1500,
): StateSnapshot {
  const facts: StateFact[] = [];
  const contextStack: StateNode[] = [];
  let appSummary: string | undefined;
  let windowSummary: string | undefined;
  let urlSummary: string | undefined;

  const lines = tree ? tree.split("\n") : [];
  for (const rawLine of lines) {
    if (rawLine.startsWith("App: ")) {
      appSummary = rawLine.trim();
      addFact(facts, {
        key: "app",
        category: "window",
        label: rawLine.trim(),
        line: rawLine.trim(),
        priority: 10,
      });
      continue;
    }

    const node = parseStateLine(rawLine);
    if (!node) continue;
    while (contextStack.length && contextStack.at(-1)!.depth >= node.depth) {
      contextStack.pop();
    }
    node.context = contextStack
      .slice(-2)
      .map((item) => item.label || item.role)
      .filter(Boolean)
      .join(" > ");
    if (node.label) contextStack.push(node);

    const identity = nodeIdentity(node);
    if (node.role === "window" && node.label && !windowSummary)
      windowSummary = `Window: ${node.label}`;
    if (node.url && !urlSummary) urlSummary = `URL: ${node.url}`;

    if (node.url) {
      addFact(facts, {
        key: factKey("url", node.role, node.context),
        category: "url",
        label: node.label || node.role,
        role: node.role,
        value: node.url,
        context: node.context,
        line: `${node.role} ${node.label} URL: ${node.url}`.trim(),
        priority: 20,
      });
    }

    if (node.flags.has("focused")) {
      addFact(facts, {
        key: factKey("focus", node.role, node.label || node.context),
        category: "focus",
        label: node.label || node.role,
        role: node.role,
        context: node.context,
        line: `${node.role} ${node.label} focused`.trim(),
        priority: 30,
      });
    }

    if (node.flags.has("selected")) {
      addFact(facts, {
        key: factKey("selected", identity),
        category: "selected",
        label: node.label || node.role,
        role: node.role,
        context: node.context,
        line: `${node.role} ${node.label} selected`.trim(),
        priority: 35,
      });
    }

    if (node.value !== undefined) {
      addFact(facts, {
        key: factKey("value", identity),
        category: "value",
        label: node.label || node.role,
        role: node.role,
        value: node.value,
        context: node.context,
        line: `${node.role} ${node.label} Value: ${node.value}`.trim(),
        priority: 40,
      });
    }

    for (const flag of node.flags) {
      if (
        flag === "expanded" ||
        flag === "collapsed" ||
        flag === "marked" ||
        flag.startsWith("selected-children:") ||
        flag.startsWith("selected-rows:")
      ) {
        addFact(facts, {
          key: factKey("state", flag.split(":")[0], identity),
          category: "state",
          label: node.label || node.role,
          role: node.role,
          value: flag,
          context: node.context,
          line: `${node.role} ${node.label} ${flag}`.trim(),
          priority: 42,
        });
      }
    }

    if (node.flags.has("disabled")) {
      addFact(facts, {
        key: factKey("enabled", identity),
        category: "enabled",
        label: node.label || node.role,
        role: node.role,
        value: "disabled",
        context: node.context,
        line: `${node.role} ${node.label} disabled`.trim(),
        priority: 45,
      });
    }

    if (node.flags.has("modal")) {
      addFact(facts, {
        key: factKey("modal", identity),
        category: "modal",
        label: node.label || node.role,
        role: node.role,
        context: node.context,
        line: `${node.role} ${node.label} modal`.trim(),
        priority: 50,
      });
    }

    if (
      node.label &&
      !lowSignalLabel(node.label) &&
      [
        "window",
        "button",
        "text field",
        "text area",
        "checkbox",
        "radio button",
        "switch",
        "toggle button",
        "tab",
        "menu item",
        "pop up button",
        "slider",
        "row",
        "link",
        "heading",
        "text",
        "container",
      ].includes(node.role) &&
      (node.role !== "container" || highSignalContainerLabel(node.label))
    ) {
      addFact(facts, {
        key: factKey("visible", identity),
        category:
          node.role === "text" || node.role === "heading"
            ? "text"
            : "visibility",
        label: node.label,
        role: node.role,
        context: node.context,
        line: `${node.role} ${node.label}`,
        priority: visibilityPriority(node.role, node.label),
      });
    }
  }

  const factMap = new Map<string, StateFact>();
  for (const fact of facts) factMap.set(fact.key, fact);
  const summary = [appSummary, windowSummary, urlSummary].filter(
    (item): item is string => !!item,
  );
  return {
    app: appName,
    lines: lines.length,
    facts: factMap,
    summary,
    capturedAt: Date.now(),
    maxDepth,
    maxNodes,
  };
}

function formatFact(fact: StateFact): string {
  const context = fact.context ? ` (${fact.context})` : "";
  if (fact.value !== undefined)
    return `${fact.role ?? fact.category} ${fact.label}${context}: ${fact.value}`;
  return `${fact.role ?? fact.category} ${fact.label}${context}`;
}

export function diffSnapshots(
  before: StateSnapshot,
  after: StateSnapshot,
): DiffResult {
  const added: StateFact[] = [];
  const removed: StateFact[] = [];
  const changed: Array<{ before: StateFact; after: StateFact }> = [];

  for (const [key, afterFact] of after.facts) {
    const beforeFact = before.facts.get(key);
    if (!beforeFact) added.push(afterFact);
    else if (
      beforeFact.value !== afterFact.value ||
      beforeFact.line !== afterFact.line
    )
      changed.push({ before: beforeFact, after: afterFact });
  }
  for (const [key, beforeFact] of before.facts) {
    if (!after.facts.has(key)) removed.push(beforeFact);
  }

  added.sort((a, b) => a.priority - b.priority || a.line.localeCompare(b.line));
  removed.sort(
    (a, b) => a.priority - b.priority || a.line.localeCompare(b.line),
  );
  changed.sort(
    (a, b) =>
      a.after.priority - b.after.priority ||
      a.after.line.localeCompare(b.after.line),
  );

  const lines: string[] = ["App state diff:"];
  let emitted = 0;
  let truncated = false;
  const push = (line: string): void => {
    if (
      emitted >= MAX_DIFF_LINES ||
      lines.join("\n").length + line.length > MAX_DIFF_CHARS
    ) {
      truncated = true;
      return;
    }
    lines.push(line);
    emitted++;
  };

  if (!added.length && !removed.length && !changed.length) {
    push("- No high-signal accessibility changes detected.");
  }

  if (changed.length) {
    push("Changed:");
    for (const item of changed) {
      const beforeValue = item.before.value ?? formatFact(item.before);
      const afterValue = item.after.value ?? formatFact(item.after);
      push(
        `- ${item.after.role ?? item.after.category} ${item.after.label}: ${beforeValue} -> ${afterValue}`,
      );
    }
  }
  if (added.length) {
    push("Added:");
    for (const fact of added) push(`- ${formatFact(fact)}`);
  }
  if (removed.length) {
    push("Removed:");
    for (const fact of removed) push(`- ${formatFact(fact)}`);
  }
  if (truncated) {
    lines.push(
      `... [diff truncated; ${added.length} added, ${removed.length} removed, ${changed.length} changed total. Call get_app_state for full state.]`,
    );
  }
  if (after.summary.length) {
    lines.push("", "Current:", ...after.summary.map((line) => `- ${line}`));
  }

  return {
    text: lines.join("\n"),
    added: added.length,
    removed: removed.length,
    changed: changed.length,
    truncated,
  };
}
