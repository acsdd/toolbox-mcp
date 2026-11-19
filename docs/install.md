# Install Model Farm on Windows

This guide covers the **Model Farm app** you download, what it does on first
run, and how to update, roll back or remove it. It also explains where the
**Toolbox MCP server** fits, because the two are separate things.

## Two different things ship from this repository

| | What it is | How you get it | What it needs |
| --- | --- | --- | --- |
| **Model Farm app** | A Windows app with one window: the ops panel, the Model Farm, the Marketplace, the Terminal and the MCP tool catalogue | Download the installer or the portable executable from the [release page](https://github.com/acsdd/toolbox-mcp/releases) | Nothing. No Node.js, no administrator rights |
| **Toolbox MCP server** | The MCP server itself. It speaks MCP over stdio for your MCP client and serves the same panel on `http://127.0.0.1:3851` | Either the **installed app** — it ships its own Node runtime — or a source checkout of this repository | The installed app: nothing extra. A source checkout: Node.js 22+ and the sibling `toolbox-widgets` checkout |

The app and the server share the same panel and the same tools. Pick the app
if you want the panel, the Model Farm and the Terminal as a desktop program;
pick the server if you want the tools inside an MCP client such as Claude
Desktop or Cursor. The installed app can do both — see
[Use the MCP tools from an MCP client](#use-the-mcp-tools-from-an-mcp-client).

## Install the app

### Option A — the installer (recommended)

1. Download **`ModelFarm-Setup-<version>.exe`** from the
   [release page](https://github.com/acsdd/toolbox-mcp/releases).
2. Run it. It is an assisted installer: it never asks for administrator
   rights, it lets you choose the folder, and it can add a Desktop and a
   Start-menu shortcut.
3. Start **Model Farm** from the shortcut.

### Option B — the portable executable

1. Download **`ModelFarm-Portable-<version>.exe`** from the
   [release page](https://github.com/acsdd/toolbox-mcp/releases).
2. Put it anywhere you like — `D:\Tools` is fine — and run it. There is no
   installer, nothing is written to the registry, and no administrator rights
   are needed.
3. Keep the `ModelFarm-data` folder that appears next to the executable. It
   holds your settings; moving the executable away from it starts you fresh.

> The binaries are not code-signed, so Windows SmartScreen shows an
> "unverified publisher" warning on first start. Choose **More info →
> Run anyway**.

## First run

- The window opens on the **Overview**: the identity of the running server,
  the MCP tool surface, the recorded tool calls and the shared widgets.
- The app listens on **127.0.0.1 only**, on a free port of its own. The
  address is shown in the top-right badge. It is never reachable from the
  network.
- Nothing is uploaded. The panel is served by the app itself and loads
  nothing from the network.

### Where your data lives

| | Installed app | Portable executable |
| --- | --- | --- |
| Settings | `%APPDATA%\Model Farm\settings\settings.json` | `<folder>\ModelFarm-data\settings\settings.json` |
| Browser profile | `%APPDATA%\Model Farm\browser` | `<folder>\ModelFarm-data\browser` |

The settings file is written with owner-only permissions and holds your
watchlist, the disk the resource monitor reports on, the runtime you picked
for the Model Farm, your Model Farm filters, the installed-model history and
your per-model notes.

### The Gmail App Password

If you connect the Gmail announcer, you paste a 16-character
[App Password](https://support.google.com/accounts/answer/185833) — not your
Google account password. It is stored by the operating system:

- **Windows** — Credential Manager → Windows Credentials → Generic
  Credentials → `toolbox-mcp/gmail`
- **macOS** — Keychain → `toolbox-mcp/gmail`
- **Linux** — Secret Service (GNOME Keyring, KWallet)

The settings file keeps only a reference to it. If an older settings file
still holds the password in plain text, the app moves it into the credential
store and deletes it from the file on the next start; if the credential store
is unavailable, the app refuses to connect rather than fall back to plain
text.

To remove the credential: use **Disconnect** in the panel, or delete the entry
in Credential Manager yourself.

## Update

- **Installed app** — download the newer `ModelFarm-Setup-<version>.exe` and
  run it over the old version. Your settings and the stored credential stay.
- **Portable executable** — replace the `.exe`, keep the `ModelFarm-data`
  folder next to it.
- **MCP server** — in the checkout: `git pull`, `npm ci`, `npm run build`.

## Roll back

- **Installed app** — keep the older installer. Run it again over the newer
  version to go back. Settings are not versioned, and an older build ignores
  settings fields it does not know.
- **Portable executable** — keep the older `.exe` next to the new one and run
  the one you want.
- **MCP server** — `git checkout <older tag>` followed by `npm ci` and
  `npm run build`.

## Uninstall

- **Installed app** — Windows **Settings → Apps → Model Farm → Uninstall**,
  or run `Uninstall Model Farm.exe` in the install folder. Your settings stay
  in `%APPDATA%\Model Farm`; delete that folder too if you want the machine
  clean.
- **Portable executable** — delete the `.exe` and the `ModelFarm-data` folder.
- **Stored credential** — remove `toolbox-mcp/gmail` from Credential Manager
  if you want it gone from the machine.

## Use the MCP tools from an MCP client

### From the installed app (no Node.js needed)

The installed app ships its own Node runtime, so your client can launch the
packaged MCP server straight from the install folder:

```json
{
  "mcpServers": {
    "toolbox": {
      "command": "C:\\Users\\you\\AppData\\Local\\Programs\\Model Farm\\Model Farm.exe",
      "args": [
        "C:\\Users\\you\\AppData\\Local\\Programs\\Model Farm\\resources\\app.asar\\dist\\index.js"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

`ELECTRON_RUN_AS_NODE` makes the app executable behave as a plain Node
runtime, so the server starts on stdio without opening a window. The server
also serves its own panel; set `TOOLBOX_MCP_PORT` when `3851` is already
taken, and `TOOLBOX_MCP_HOME` when you want the settings somewhere else than
`%APPDATA%\Model Farm\settings`.

Check the journey yourself at any time:

```bash
node scripts/verify-install.cjs
```

It performs the same handshake a client performs and prints the tool count.

### From a source checkout

The MCP server also runs from a source checkout — see
[Set up Toolbox MCP with AstrLink](astrlink-setup.md) for the complete
Windows setup including Ollama and AstrLink. In short:

```bash
git clone https://github.com/acsdd/toolbox-widgets.git
git clone https://github.com/acsdd/toolbox-mcp.git
cd toolbox-mcp
npm ci
npm start          # MCP server on stdio + ops panel on 127.0.0.1:3851
```

Point the client at the built server:

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

The server starts the MCP stdio connection and the panel on
`http://127.0.0.1:3851`. Set `TOOLBOX_MCP_PORT` when that port is taken, and
`TOOLBOX_MCP_HOME` when you want the settings somewhere else than
`~/.toolbox-mcp`.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| SmartScreen warns about an unverified publisher | Expected — the builds are not code-signed. Choose **More info → Run anyway**. |
| "Address already in use" on the panel | Set `TOOLBOX_MCP_PORT` to a free port. |
| The Gmail announcer says it needs to be reconnected | The credential store was unavailable when it was saved. Reconnect with the App Password. |
| The Terminal shows no prompt | Press **Start**. The shell starts with the first visit to the section. |
| The Model Farm shows no models | The catalog comes from HuggingFace and is cached for 6 hours. Check the network, then refresh. |
