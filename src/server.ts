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
      instructions: "macOS-only computer-use tools exposed over MCP.",
    },
  );
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
