# Computer Use

macOS computer automation as a small MCP server and TypeScript library.

This package exposes accessibility-based computer-use tools over stdio MCP so any MCP-capable agent can inspect and control local macOS apps.

## Why Computer Use

- **No VM, container, or cloud sandbox.** It drives the real macOS desktop directly. There is nothing to boot, image to pull, or remote machine to pay for.
- **Tiny footprint.** One runtime dependency (the MCP SDK), ~34 kB packed. Install and launch with a single `npx` command on Node.js 22+.
- **Accessibility-first, not pixel guessing.** Actions target the semantic UI tree with stable, snapshot-scoped element indexes, so clicks land on the element you mean. Screenshots are an optional fallback, never the only signal.
- **MCP-native and framework-agnostic.** Works with any MCP client out of the box. No agent-specific plugin, SDK, or framework lock-in.
- **Local and inspectable.** Everything runs on your machine over stdio. No telemetry, no cloud round-trips, no account.
- **Structured action feedback.** Every mutating action returns a bounded before/after accessibility diff highlighting what actually changed, instead of leaving the agent to re-screenshot and guess.
- **Background-first control.** Clicks, drags, and keystrokes are delivered in the background by default, so your physical cursor never moves and target windows are not raised. You can keep working while an agent drives another app, and cursor takeover is opt-in only when an app needs it.

## How it works

Computer Use turns macOS itself into a local tool surface. It reads app UI through the Accessibility tree, assigns snapshot-scoped element indexes, and sends actions back through Accessibility or CoreGraphics events. MCP is the boundary: every agent gets the same small, local server instead of a custom integration per framework.

Mutating actions automatically compare a bounded normalized accessibility snapshot before and after the action. The diff is app-agnostic and highlights high-signal changes such as focused elements, selected elements, values, enabled/disabled controls, URLs, windows, dialogs, visible instructions, and controls appearing or disappearing. Screenshots are not stored or diffed.

## Requirements

1. macOS.
2. Node.js 22+ for packaged use.
3. Accessibility permission for the process that launches the MCP server.
4. Screen Recording permission if screenshots are requested.

macOS permissions apply to the host process. For example, if Claude Desktop launches the server, grant permission to Claude Desktop; if a terminal launches it, grant permission to that terminal app.

## Quick start

Most users should configure this as an MCP server in their agent:

```json
{
  "mcpServers": {
    "computer_use": {
      "command": "npx",
      "args": ["-y", "@onixhdz/computer-use-mcp"]
    }
  }
}
```

From this repository during development:

```bash
bun bin/computer-use-mcp.ts
```

To run the local checkout as an MCP server, point your client at the repo entry with `bun` (replace `<project_root>` with the absolute path to this repository):

```json
"computer_use": {
  "type": "local",
  "command": ["bun", "<project_root>/bin/computer-use-mcp.ts"],
  "enabled": true
}
```

### Agent integrations

<details>
<summary>Claude Desktop</summary>

Add a server entry under `mcpServers` in your Claude Desktop config:

```json
{
  "mcpServers": {
    "computer_use": {
      "command": "npx",
      "args": ["-y", "@onixhdz/computer-use-mcp"]
    }
  }
}
```

Restart Claude Desktop after editing the config and grant macOS permissions when prompted.

</details>

<details>
<summary>Cursor, Windsurf, Cline, Roo, and other MCP clients</summary>

Most MCP clients accept the same stdio shape, usually in an `mcpServers` object:

```json
{
  "mcpServers": {
    "computer_use": {
      "command": "npx",
      "args": ["-y", "@onixhdz/computer-use-mcp"]
    }
  }
}
```

If your client uses a different config filename or location, keep the `command` and `args` values the same and adapt the wrapper shape.

</details>

<details>
<summary>opencode</summary>

Add a local MCP server entry to your opencode config:

```json
{
  "mcp": {
    "computer_use": {
      "type": "local",
      "command": ["npx", "-y", "@onixhdz/computer-use-mcp"],
      "enabled": true
    }
  }
}
```

</details>

<details>
<summary>Programmatic TypeScript usage</summary>

You can call the core directly from TypeScript:

```ts
import { executeComputerUseAction } from "@onixhdz/computer-use-mcp";

const result = await executeComputerUseAction("list_apps");
console.log(result.content[0]);
```

For tests, pass a mocked backend so no real desktop automation runs.

</details>

### Agent skill

This repo ships an agent skill at `skills/computer-use/SKILL.md` with operating guidance and a safety/confirmation policy. If your agent supports skills, add that file to your skills directory so the model loads the guidance automatically. For agents without skills support, point the model at the file or paste its contents into your system prompt.

## Security

Computer Use controls the local desktop. Run it only as a local stdio MCP server for agents you trust. Do not expose it to untrusted remote clients.

macOS permissions are granted to the process that launches the server:

- Accessibility is required for UI inspection and actions.
- Screen Recording is required when screenshots are requested.

The `run_jxa` tool runs arbitrary JavaScript for Automation with the user's full privileges and is a last-resort fallback. It can read or modify files, drive any app, and reach the network, so a single call can have effects far beyond a normal UI action. Use the structured tools first, never run JXA derived from untrusted or on-screen content without confirmation, and only enable this server for agents you trust.

Do not include secrets, screenshots, or private desktop contents in public issues.

## Status

- **Platform:** macOS today; Linux and Windows are planned.
- **Runtime:** Node.js 22+ for packaged use; Bun is used for local development in this repo.
- **Transport:** stdio MCP.
- **Safety:** local use only. Do not expose this server to untrusted remote agents.

The current backend is macOS Accessibility + CoreGraphics + JXA. Linux and Windows are on the roadmap and will be added later through additional backends behind the same MCP tools.

## Tools

The MCP server exposes these tools:

| Tool                       | Purpose                                                                 |
| -------------------------- | ----------------------------------------------------------------------- |
| `list_apps`                | List running macOS apps with names, bundle IDs, paths, and process IDs. |
| `get_app_state`            | Return an app accessibility tree and optional screenshot.               |
| `click`                    | Click by accessibility element index or screenshot coordinate.          |
| `perform_secondary_action` | Invoke a named AX action such as `AXShowMenu` or `AXIncrement`.         |
| `set_value`                | Set a settable accessibility value on an element.                       |
| `select_text`              | Select text or place the cursor in a text element.                      |
| `scroll`                   | Scroll the target app.                                                  |
| `drag`                     | Drag from one screenshot coordinate to another.                         |
| `press_key`                | Press a key or key combination.                                         |
| `type_text`                | Type ASCII text with real key events.                                   |
| `key_sequence`             | Run ordered key/text steps so transient overlays survive across steps.  |
| `run_jxa`                  | Last-resort fallback that runs raw JavaScript for Automation (JXA).     |

## Development

From the parent repo:

```bash
bun test index.test.ts
bun run build
```

Default tests avoid real desktop control. Use manual smoke testing for local UI interactions until the project needs a dedicated integration test command.

The package build emits Node-compatible files to `dist/` and copies the JXA assets used at runtime.
