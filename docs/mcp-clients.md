# Use the tools from an MCP client

The panel is optional. The same tools work inside Claude Desktop, Cursor or any
MCP client that can launch a local stdio server. This guide connects one.

## Before you start

- Install Model Farm with the **installer**. The portable build unpacks to a
  temporary folder on every run, so its path is not stable enough for a client.
- A source checkout works too: Node.js 22+, `npm ci`, `npm run build`.
- No account and no API key. The server talks MCP over stdio on this machine.

## Copy the configuration

1. Open Model Farm and go to **Overview**.
2. Find **Connect an MCP client** below Live activity.
3. Choose **Copy config**.

The block is generated for this installation: the executable, the path to
`dist/index.js`, and `TOOLBOX_MCP_HOME` so the client reads the same settings
and credential references as the app. For an installed app it looks like this
(the panel fills in your real paths):

```json
{
  "mcpServers": {
    "toolbox": {
      "command": "C:\\Users\\you\\AppData\\Local\\Programs\\Model Farm\\Model Farm.exe",
      "args": [
        "C:\\Users\\you\\AppData\\Local\\Programs\\Model Farm\\resources\\app.asar\\dist\\index.js"
      ],
      "env": {
        "ELECTRON_RUN_AS_NODE": "1",
        "TOOLBOX_MCP_HOME": "C:\\Users\\you\\AppData\\Roaming\\Model Farm\\settings"
      }
    }
  }
}
```

Do not edit the paths unless you moved the app. A source checkout produces a
plain `node` command instead, with no `env`.

## Claude Desktop

1. Open **Settings → Developer → Edit Config**. This opens
   `%APPDATA%\Claude\claude_desktop_config.json` (macOS:
   `~/Library/Application Support/Claude/claude_desktop_config.json`).
2. Merge the `mcpServers` block into the file, keeping any servers already
   there.
3. Quit Claude Desktop completely and start it again.
4. The `toolbox` server appears in the tools menu. Ask it for `crypto_status`
   or `system_stats` — both are read-only — to confirm the connection.

## Cursor

1. Open **Cursor Settings → Tools & MCP → New MCP Server**, or edit the file
   directly: `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for
   every project.
2. Merge the `mcpServers` block, save, and reload the window.
3. The server appears in the MCP list. Call a read-only tool to confirm.

## Other clients

Any client that accepts the `mcpServers` shape can paste the same block under
that key. A client with a different schema — VS Code uses `servers`, for
example — needs the same command, arguments and environment under its own key.

## What success looks like

- The client lists 37 tools under `toolbox`.
- A read-only call such as `crypto_status` returns data.
- The app panel may still say **panel only**. A client starts its own copy of
  the server, so the app's Live activity feed only covers the panel's own
  process. The call still ran; it just ran in the client's process.

## If the tools do not appear

| Check | What to do |
| --- | --- |
| The client was not restarted | Quit it completely and start it again after editing the configuration. |
| The JSON is invalid | Check for trailing commas and unescaped backslashes. |
| The path is wrong | Copy the block from the panel again; it is generated for this installation. |
| The installed app cannot be launched | Run `npm run verify:install -- "<install folder>"` from a source checkout. It performs the same handshake and prints the tool count. |
| The portable build was configured | Install the app or use a source checkout; the portable path changes on every run. |
| The client uses different settings | Keep `TOOLBOX_MCP_HOME` in the environment, otherwise the client falls back to `~/.toolbox-mcp` and asks for Gmail again. |
| The panel port is taken | The server's panel moves to a free loopback port; the stdio connection is unaffected. |

The complete install, update and uninstall guide is
[Install Model Farm on Windows](install.md). Back to the
[project page](https://acsdd.github.io/toolbox-mcp/).
