import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { executeComputerUseAction } from "./actions.js";
import { clearScriptCache } from "./backend.js";
import { computerUseTools } from "./tools.js";
import { type CoreResult } from "./types.js";

const SERVER_NAME = "computer_use";
const SERVER_VERSION = "0.1.0";

function toMcpResult(result: CoreResult): CallToolResult {
  return { content: result.content, isError: result.isError };
}

export function createComputerUseMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: [
        "macOS-only computer-use tools. Prefer element_index; get_app_state returns element Position/Size so coordinates need no screenshot.",
        "Screenshots are optional and need Screen Recording; use them for final visual confirmation. If it is unavailable, work Accessibility-only.",
        "If Screen Recording is failing or unavailable, continue Accessibility-only: use `element_index` actions and the `Position`/`Size` geometry in `get_app_state` (which need no screenshot).",
        "If Accessibility is not granted (actions no-op or report not granted), stop and ask the user to grant it.",
      ].join(" "),
    },
  );
  // Reload JXA from disk whenever a client (re)connects, so edits take effect
  // without restarting the server process.
  server.server.oninitialized = () => clearScriptCache();
  // Hand-rolled JSON Schema means McpServer's registerTool helpers add nothing; use raw handlers.
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: computerUseTools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));
  server.server.setRequestHandler(
    CallToolRequestSchema,
    async (request, extra) => {
      const result = await executeComputerUseAction(
        request.params.name,
        request.params.arguments ?? {},
        { signal: extra.signal },
      );
      return toMcpResult(result);
    },
  );
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
