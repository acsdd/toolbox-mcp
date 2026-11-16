# Set up Toolbox MCP with AstrLink

This guide connects the Toolbox MCP server, the local Ollama runtime and the
AstrLink gateway on Windows. AstrLink and Ollama are separate applications;
Toolbox does not install or configure either one automatically.

## 1. Install the prerequisites

- Install [Node.js 22 or newer](https://nodejs.org/en/download/).
- Install [Ollama for Windows](https://ollama.com/download/windows) and start it.
- Install and start [AstrLink](https://github.com/Calcium-Ion/AstrLink).

In AstrLink, open **Settings → Agent tools** and install the tools for this
host. This gives Toolbox the local read-only `astrlink` observer CLI used by
the Gateway panel.

## 2. Get the Toolbox repositories

The MCP server uses `toolbox-widgets` as a sibling folder. Clone both into the
same parent directory, then install the locked dependencies:

```powershell
git clone https://github.com/acsdd/toolbox-widgets.git
git clone https://github.com/acsdd/toolbox-mcp.git
Set-Location .\toolbox-mcp
npm ci
npm run build
```

## 3. Connect Ollama in AstrLink

Follow AstrLink's [provider connection guide](https://docs.astrsk.ai/en/How-to-connect-providers)
to add an OpenAI-compatible provider for the local Ollama server. Use:

- Base URL: `http://127.0.0.1:11434/v1`
- Model: the exact model name shown by `ollama list`
- Capability: `openai.chat`

The Model Farm panel can install GGUF models into Ollama and show these
connection details after a successful install. Its **Copy setup** text is a
manual reference; it contains no credentials and does not change AstrLink.

## 4. Add the MCP server to your MCP client

For clients that use the `mcpServers` JSON format, configure the client to
launch the built server with Node.js. Replace the two example paths with the
paths on your machine:

```json
{
  "mcpServers": {
    "toolbox": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\toolbox-mcp\\dist\\index.js"]
    }
  }
}
```

The server starts the MCP stdio connection and a local panel at
`http://127.0.0.1:3851`. Set `TOOLBOX_MCP_PORT` if that port is already in use.
The Marketplace section lets you install the **AstrLink Gateway** feature.

## What the Gateway feature reads

The feature uses AstrLink's observer CLI for provider health, routing and
privacy posture, plus recent request metadata. It does not change AstrLink
settings or read prompt and response bodies. When the CLI is missing or the
gateway is stopped, the panel reports that state; its Gateway section links to
the provider setup guide.
