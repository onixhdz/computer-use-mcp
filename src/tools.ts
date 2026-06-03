import {
  MAX_TYPED_CHARS,
  type CoreAction,
  type JsonSchema,
  type ToolSpec,
} from "./types.js";

const booleanProp = (description: string) => ({ type: "boolean", description });
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
    requiresAccessibility: false,
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
      maxDepth: numberProp(
        "Maximum accessibility tree depth. Default 40, max 200.",
      ),
      maxNodes: numberProp(
        "Maximum accessibility nodes. Default 1500, max 10000.",
      ),
      screenshot: booleanProp(
        [
          "Also return a PNG screenshot of the frontmost app window; its pixels are the click/drag coordinate space.",
          "Use it to verify rendering or to inspect canvas, video, or other content not exposed in the accessibility tree.",
        ].join(" "),
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
    description: [
      "Click by accessibility element_index (preferred) or app-window screenshot coordinates.",
      "x/y are pixels from a get_app_state(screenshot: true) image (top-left origin).",
      "Coordinate clicks are delivered in the background (no cursor movement, no window raise).",
      "If the result reports the background pointer is unavailable or the action did not register, ask the user for permission to control the cursor, then retry with allow_cursor_takeover: true.",
    ].join(" "),
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
    description: [
      "Drag from one app-window screenshot coordinate to another.",
      "Coordinates are pixels in a get_app_state(screenshot: true) image (top-left origin).",
      "Delivered in the background (no cursor movement, no window raise).",
      "If the result reports the background pointer is unavailable or the drag did not register, ask the user for permission to control the cursor, then retry with allow_cursor_takeover: true.",
    ].join(" "),
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
    description: [
      "Run ordered key/text steps in one call with short delays.",
      "Use for focus-type-submit flows (for example Chrome cmd+l, URL, Return) and transient overlays like command palettes, Quick Open, or autocomplete where separate press_key/type_text calls can lose focus, dismiss the overlay, or drop the commit key.",
    ].join(" "),
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
    description: [
      "Last-resort fallback: run raw JavaScript for Automation (JXA) on macOS when no other tool can do the task.",
      "Executes arbitrary code with the user's privileges; prefer the structured tools and use this only when they cannot accomplish the goal.",
    ].join(" "),
    requiresAccessibility: false,
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

export const toolByName = new Map<CoreAction, ToolSpec>(
  computerUseTools.map((tool) => [tool.name, tool]),
);
