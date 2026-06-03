import { type Tool } from "@modelcontextprotocol/sdk/types.js";

export const MAX_TYPED_CHARS = 2000;
export const MAX_APP_STATE_DEPTH = 200;
export const MAX_APP_STATE_NODES = 10000;

export const TOOL_NAMES = [
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

export type JsonSchema = {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
};

export type TextBlock = { type: "text"; text: string };
export type ImageBlock = { type: "image"; data: string; mimeType: string };
export type ContentBlock = TextBlock | ImageBlock;

export type CoreResult = {
  content: ContentBlock[];
  details: Record<string, unknown>;
  isError?: boolean;
};

export type CoreAction = (typeof TOOL_NAMES)[number];

export type ToolSpec = {
  name: CoreAction;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: NonNullable<Tool["annotations"]>;
  // Defaults to true (gated); set false for tools that work without Accessibility.
  requiresAccessibility?: boolean;
};

export type ComputerUseBackend = {
  platform?: NodeJS.Platform;
  runJxa(code: string, signal?: AbortSignal): Promise<string>;
  captureWindow(app: string, signal?: AbortSignal): Promise<Buffer>;
  // Omitted backends are treated as trusted (no gating).
  accessibilityTrusted?(): Promise<boolean>;
};

export type ExecuteOptions = {
  signal?: AbortSignal;
  backend?: ComputerUseBackend;
};
