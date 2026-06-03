import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  computerUseTools,
  executeComputerUseAction,
  getComputerUseMcpServerConfig,
  type ComputerUseBackend,
} from "./index.js";

function firstText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const block = result.content[0];
  return block && "text" in block ? (block.text ?? "") : "";
}

function mockBackend(
  output: string,
  image = Buffer.from("png"),
): ComputerUseBackend {
  return {
    platform: "darwin",
    runJxa: async () => output,
    captureWindow: async () => image,
  };
}

function mockBackendSequence(
  outputs: string[],
  image = Buffer.from("png"),
): ComputerUseBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    platform: "darwin",
    calls,
    runJxa: async (code: string) => {
      calls.push(code);
      const next = outputs.shift();
      if (next === undefined) throw new Error("no mocked output left");
      return next;
    },
    captureWindow: async () => image,
  };
}

const finderBefore = `App: Finder (pid 1)
0 window Finder
  1 text field (settable, focused) Search Value: old
  2 button (disabled) Open`;

const finderAfter = `App: Finder (pid 1)
0 window Finder
  1 text field (settable, focused) Search Value: new
  2 button Open
  3 row (selected) result.txt`;

const unlabeledFieldBefore = `App: Test (pid 1)
0 window Test
  1 text field (settable, focused) Value: old`;

const unlabeledFieldAfter = `App: Test (pid 1)
0 window Test
  1 text field (settable, focused) Value: new`;

const stateFlagsBefore = `App: Test (pid 1)
0 window Test
  1 disclosure triangle Details
  2 menu item Option`;

const stateFlagsAfter = `App: Test (pid 1)
0 window Test
  1 disclosure triangle (expanded) Details
  2 menu item (marked) Option
  3 outline (selected-rows:2) Files`;

const switchBefore = `App: System Settings (pid 1)
0 window Accessibility
  1 row Codex Computer Use
    2 switch Value: off
  3 toggle button Description: Toggle Panel, Value: 0`;

const switchAfter = `App: System Settings (pid 1)
0 window Accessibility
  1 row Codex Computer Use
    2 switch Value: on
  3 toggle button Description: Toggle Panel, Value: 1`;

describe("computer-use core", () => {
  test("exports MCP-native tool schemas", () => {
    expect(computerUseTools.map((tool) => tool.name)).toEqual([
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
    ]);
    expect(
      computerUseTools.find((tool) => tool.name === "get_app_state")
        ?.inputSchema.required,
    ).toEqual(["app"]);
    expect(
      computerUseTools.find((tool) => tool.name === "scroll")?.inputSchema
        .properties.element_index,
    ).toBeUndefined();
  });

  test("returns validation errors through the core envelope", async () => {
    const result = await executeComputerUseAction("get_app_state", {});
    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("validation_error");
    expect(result.content[0]).toEqual({
      type: "text",
      text: "Error: get_app_state: app is required",
    });
  });

  test("rejects unknown arguments centrally", async () => {
    const result = await executeComputerUseAction("list_apps", { extra: true });
    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("validation_error");
  });

  test("validates cross-field and bounded inputs before backend work", async () => {
    const missingY = await executeComputerUseAction("click", {
      app: "Finder",
      x: 10,
    });
    expect(missingY.details.code).toBe("validation_error");
    expect(firstText(missingY)).toContain("coordinates require both x and y");

    const invalidDirection = await executeComputerUseAction("scroll", {
      app: "Finder",
      direction: "diagonal",
    });
    expect(invalidDirection.details.code).toBe("validation_error");

    const tooLong = await executeComputerUseAction("type_text", {
      app: "Finder",
      text: "x".repeat(2001),
    });
    expect(tooLong.details.code).toBe("validation_error");
    expect(firstText(tooLong)).toContain("text too long");
  });

  test("validates key_sequence steps", async () => {
    const empty = await executeComputerUseAction("key_sequence", {
      app: "Finder",
      steps: [],
    });
    expect(empty.details.code).toBe("validation_error");
    expect(firstText(empty)).toContain("non-empty array");

    const ambiguous = await executeComputerUseAction("key_sequence", {
      app: "Finder",
      steps: [{ key: "cmd+p", text: "x" }],
    });
    expect(ambiguous.details.code).toBe("validation_error");
    expect(firstText(ambiguous)).toContain("exactly one of key or text");

    const unknown = await executeComputerUseAction("key_sequence", {
      app: "Finder",
      steps: [{ key: "cmd+p", typo: true }],
    });
    expect(unknown.details.code).toBe("validation_error");
    expect(firstText(unknown)).toContain("unknown argument typo");
  });

  test("runs a key_sequence through a mocked backend and appends a diff", async () => {
    const backend = mockBackendSequence([
      finderBefore,
      '{"ok":true,"steps":2}',
      finderAfter,
    ]);
    const result = await executeComputerUseAction(
      "key_sequence",
      { app: "Finder", steps: [{ key: "cmd+p" }, { text: "file.ts" }] },
      { backend },
    );
    expect(result.isError).toBeUndefined();
    expect(result.details.steps).toBe(2);
    expect(firstText(result)).toContain("ran 2 steps");
    expect(firstText(result)).toContain("App state diff:");
    expect(firstText(result)).toContain("Search: old -> new");
    expect(firstText(result)).toContain("row result.txt");
  });

  test("can execute app state with a mocked backend", async () => {
    const result = await executeComputerUseAction(
      "get_app_state",
      { app: "Finder", screenshot: true },
      { backend: mockBackend("App: Finder\n0 window") },
    );
    expect(result.isError).toBeUndefined();
    expect(result.details.nodes).toBe(2);
    expect(result.content).toEqual([
      { type: "text", text: "App: Finder\n0 window" },
      { type: "image", data: "cG5n", mimeType: "image/png" },
    ]);
  });

  test("get_app_state seeds the next action diff baseline", async () => {
    const backend = mockBackendSequence([
      finderBefore,
      '{"ok":true,"key":"Return"}',
      finderAfter,
    ]);
    await executeComputerUseAction(
      "get_app_state",
      { app: "Finder" },
      { backend },
    );
    const result = await executeComputerUseAction(
      "press_key",
      { app: "Finder", key: "Return" },
      { backend },
    );
    expect(firstText(result)).toContain("pressed Return");
    expect(firstText(result)).toContain("App state diff:");
    expect(firstText(result)).toContain("Changed:");
    expect(firstText(result)).toContain("Added:");
  });

  test("keeps action success when post-action diff capture fails", async () => {
    const backend = mockBackendSequence([
      finderBefore,
      '{"ok":true,"message":"dragged"}',
    ]);
    const result = await executeComputerUseAction(
      "drag",
      { app: "Finder", from_x: 1, from_y: 1, to_x: 2, to_y: 2 },
      { backend },
    );
    expect(result.isError).toBeUndefined();
    expect(firstText(result)).toContain("dragged");
    expect(firstText(result)).toContain("post-action app state failed");
    expect(firstText(result)).toContain("Baseline was invalidated");
    expect(result.details.appStateDiff).toMatchObject({
      available: false,
      baselineInvalidated: true,
    });
  });

  test("attaches screenshot when action diff is empty", async () => {
    const backend = mockBackendSequence([
      finderBefore,
      '{"ok":true,"message":"dragged"}',
      finderBefore,
    ]);
    const result = await executeComputerUseAction(
      "drag",
      { app: "Finder", from_x: 1, from_y: 1, to_x: 2, to_y: 2 },
      { backend },
    );
    expect(firstText(result)).toContain("Visual fallback screenshot attached");
    expect(result.content).toContainEqual({
      type: "image",
      data: "cG5n",
      mimeType: "image/png",
    });
    expect(result.details.appStateDiff).toMatchObject({
      available: true,
      added: 0,
      removed: 0,
      changed: 0,
      visualFallback: {
        available: true,
        reason: "empty_accessibility_diff",
      },
    });
  });

  test("diffs unlabeled editable field values without remove/add churn", async () => {
    const backend = mockBackendSequence([
      unlabeledFieldBefore,
      '{"ok":true,"typed":3}',
      unlabeledFieldAfter,
    ]);
    const result = await executeComputerUseAction(
      "type_text",
      { app: "Test", text: "new" },
      { backend },
    );
    expect(firstText(result)).toContain("Changed:");
    expect(firstText(result)).toContain("text field: old -> new");
    expect(firstText(result)).not.toContain("Removed:");
    expect(firstText(result)).not.toContain("Added:");
  });

  test("normalizes expanded marked and selected count flags", async () => {
    const backend = mockBackendSequence([
      stateFlagsBefore,
      '{"ok":true,"key":"Return"}',
      stateFlagsAfter,
    ]);
    const result = await executeComputerUseAction(
      "press_key",
      { app: "Test", key: "Return" },
      { backend },
    );
    expect(firstText(result)).toContain("expanded");
    expect(firstText(result)).toContain("marked");
    expect(firstText(result)).toContain("selected-rows:2");
  });

  test("normalizes switch and toggle button values", async () => {
    const backend = mockBackendSequence([
      switchBefore,
      '{"ok":true,"key":"Space"}',
      switchAfter,
    ]);
    const result = await executeComputerUseAction(
      "press_key",
      { app: "System Settings", key: "Space" },
      { backend },
    );
    expect(firstText(result)).toContain("switch: off -> on");
    expect(firstText(result)).toContain("toggle button Toggle Panel: 0 -> 1");
  });

  test("clamps action diff snapshots after large get_app_state baseline", async () => {
    const backend = mockBackendSequence([
      finderBefore,
      '{"ok":true,"key":"Return"}',
      finderAfter,
    ]);
    await executeComputerUseAction(
      "get_app_state",
      { app: "Finder", maxDepth: 9999, maxNodes: 999999 },
      { backend },
    );
    await executeComputerUseAction(
      "press_key",
      { app: "Finder", key: "Return" },
      { backend },
    );
    const postActionStateCall = backend.calls.at(-1) ?? "";
    expect(postActionStateCall).toContain('"maxDepth":40');
    expect(postActionStateCall).toContain('"maxNodes":1500');
  });

  test("get_app_state forwards requested app-state limits", async () => {
    const backend = mockBackendSequence([finderBefore]);
    await executeComputerUseAction(
      "get_app_state",
      { app: "Finder", maxDepth: 12, maxNodes: 34 },
      { backend },
    );
    const stateCall = backend.calls.at(-1) ?? "";
    expect(stateCall).toContain('"maxDepth":12');
    expect(stateCall).toContain('"maxNodes":34');
  });

  test("get_app_state clamps oversized limits", async () => {
    const backend = mockBackendSequence([finderBefore]);
    await executeComputerUseAction(
      "get_app_state",
      { app: "Finder", maxDepth: 99999, maxNodes: 999999 },
      { backend },
    );
    const stateCall = backend.calls.at(-1) ?? "";
    expect(stateCall).toContain('"maxDepth":200');
    expect(stateCall).toContain('"maxNodes":10000');
  });

  test("click rejects both element_index and coordinates", async () => {
    const both = await executeComputerUseAction("click", {
      app: "Finder",
      element_index: 1,
      x: 10,
      y: 20,
    });
    expect(both.isError).toBe(true);
    expect(firstText(both)).toContain("not both");
  });

  test("threads MAX_TYPED_CHARS into the keys script", async () => {
    const backend = mockBackendSequence([
      unlabeledFieldBefore,
      '{"ok":true,"typed":3}',
      unlabeledFieldAfter,
    ]);
    await executeComputerUseAction(
      "type_text",
      { app: "Test", text: "new" },
      { backend },
    );
    const keysCall = backend.calls.find((code) =>
      code.includes('"kind":"type"'),
    );
    expect(keysCall).toContain('"maxTyped":2000');
  });

  test("maps mocked backend failures through the core envelope", async () => {
    const result = await executeComputerUseAction(
      "click",
      { app: "Finder", element_index: 1 },
      { backend: mockBackend('{"ok":false,"error":"stale"}') },
    );
    expect(result.isError).toBe(true);
    expect(result.details.code).toBe("backend_error");
    expect(firstText(result)).toBe("Error: stale");
  });

  test("errors with takeover guidance when background pointer is unavailable", async () => {
    const backend = mockBackendSequence([
      finderBefore,
      '{"ok":false,"code":"background_pointer_unavailable","error":"Background pointer delivery is unavailable on this macOS (SkyLight SPIs did not load). Ask the user whether they allow taking control of the physical cursor; if they agree, retry with allow_cursor_takeover: true.","delivery":"none"}',
    ]);
    const result = await executeComputerUseAction(
      "click",
      { app: "Finder", x: 5, y: 5 },
      { backend },
    );
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("allow_cursor_takeover: true");
    expect(firstText(result)).toContain("control of the physical cursor");
  });

  test("flags possible non-registration on a background pointer no-op", async () => {
    const backend = mockBackendSequence([
      finderBefore,
      '{"ok":true,"message":"dragged","delivery":"background"}',
      finderBefore,
    ]);
    const result = await executeComputerUseAction(
      "drag",
      { app: "Finder", from_x: 1, from_y: 1, to_x: 2, to_y: 2 },
      { backend },
    );
    expect(firstText(result)).toContain("Visual fallback screenshot attached");
    expect(firstText(result)).toContain("allow_cursor_takeover: true");
  });

  test("omits the screenshot line on a background no-op when capture fails", async () => {
    const outputs = [
      finderBefore,
      '{"ok":true,"message":"dragged","delivery":"background"}',
      finderBefore,
    ];
    const backend: ComputerUseBackend = {
      platform: "darwin",
      runJxa: async () => {
        const next = outputs.shift();
        if (next === undefined) throw new Error("no mocked output left");
        return next;
      },
      captureWindow: async () => {
        throw new Error("screen recording not granted");
      },
    };
    const result = await executeComputerUseAction(
      "drag",
      { app: "Finder", from_x: 1, from_y: 1, to_x: 2, to_y: 2 },
      { backend },
    );
    expect(firstText(result)).not.toContain("Visual fallback screenshot attached");
    expect(firstText(result)).toContain("allow_cursor_takeover: true");
    expect(result.content.some((c) => c.type === "image")).toBe(false);
  });

  test("suppresses the takeover hint once the cursor is already controlled", async () => {
    const backend = mockBackendSequence([
      finderBefore,
      '{"ok":true,"message":"dragged","delivery":"physical"}',
      finderBefore,
    ]);
    const result = await executeComputerUseAction(
      "drag",
      {
        app: "Finder",
        from_x: 1,
        from_y: 1,
        to_x: 2,
        to_y: 2,
        allow_cursor_takeover: true,
      },
      { backend },
    );
    expect(result.isError).toBeUndefined();
    expect(firstText(result)).not.toContain("allow_cursor_takeover");
    expect(result.details.delivery).toBe("physical");
  });

  test("does not hint cursor takeover for an indexed-click no-op", async () => {
    const backend = mockBackendSequence([
      finderBefore,
      '{"ok":true,"index":1}',
      finderBefore,
    ]);
    const result = await executeComputerUseAction(
      "click",
      { app: "Finder", element_index: 1 },
      { backend },
    );
    expect(firstText(result)).toContain("Visual fallback screenshot attached");
    expect(firstText(result)).not.toContain("allow_cursor_takeover");
  });

  test("provides a local MCP config on macOS", () => {
    const config = getComputerUseMcpServerConfig();
    if (process.platform === "darwin") {
      expect(config?.type).toBe("local");
      expect(config?.command.at(-1)).toEndWith("bin/computer-use-mcp.ts");
    } else {
      expect(config).toBeUndefined();
    }
  });
});

describe("computer-use MCP server", () => {
  test("lists tools over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.versions.bun ? process.execPath : "bun",
      args: ["src/bin/computer-use-mcp.ts"],
      stderr: "ignore",
    });
    const client = new Client(
      { name: "test", version: "0.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport, { timeout: 10_000 });
      const listed = await client.listTools(undefined, { timeout: 10_000 });
      expect(listed.tools.some((tool) => tool.name === "list_apps")).toBe(true);
      expect(listed.tools.some((tool) => tool.name === "get_app_state")).toBe(
        true,
      );
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  });
});
