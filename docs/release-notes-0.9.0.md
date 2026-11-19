# Model Farm 0.9.0

Two things ship in this release: the **installer** that was missing, and the
**security and terminal fixes** that make the app usable as a daily tool. The
Gmail App Password now lives in the operating system's credential store, the
terminal keeps its prompt on screen while output streams, and the settings
file survives being read by another process at the wrong moment.

## What's changed

### An installer, not only a portable executable

- The release now carries **two** Windows builds:
  - `ModelFarm-Setup-0.9.0.exe` — an assisted installer. No administrator
    rights, you choose the folder, and it can add a Desktop and a Start-menu
    shortcut.
  - `ModelFarm-Portable-0.9.0.exe` — unchanged. No installer, no registry
    writes, data next to the executable.
- Both build from the same payload, so the portable app is not a stripped
  variant: the packaged server, the widgets and the tool catalogue are
  identical in the two.
- **Install, update, roll back and uninstall** are documented in
  [docs/install.md](https://github.com/acsdd/toolbox-mcp/blob/main/docs/install.md),
  including where the settings live in each build and how to remove the
  stored credential.

### The Gmail App Password leaves the settings file

- The App Password is stored by the **operating system** — Windows Credential
  Manager, macOS Keychain or Linux Secret Service — under the entry
  `toolbox-mcp/gmail`. The settings file keeps only a reference to it.
- A password left in an older settings file is **moved into the credential
  store and deleted from the file** on the next start.
- If the credential store is unavailable, the server **refuses to connect**
  rather than fall back to plain text. It says so and asks you to reconnect
  instead.
- Disconnecting removes the credential entry, not just the reference.

### The terminal keeps its prompt on screen

- The command line has its own scroll region. Output no longer pushes the
  input below the window, and the page does not grow downward with the
  amount of output.
- New output only pulls the view down while you are reading the tail.
  Scroll up to read earlier lines and your position is kept.
- Keyboard focus, typing, <kbd>Enter</kbd> to submit, the command history
  and <kbd>Tab</kbd> completion stay usable while output streams in.
- Verified in the packaged app: the output region overflows on its own
  (948 px of output in a 508 px region), the page height does not change
  (901 px viewport, 901 px page), the prompt stays visible at the normal
  window size and at 1000 × 680, and the reading position survives new
  output. See [docs/panel-terminal.png](https://github.com/acsdd/toolbox-mcp/blob/main/docs/panel-terminal.png).

### Settings survive a file that is being read

- The settings file is written **atomically**: a temporary file in the same
  folder, flushed to disk, then renamed over the target. A crash leaves the
  old complete file or the new complete file, never a half-written one.
- Windows refuses to replace a file that another process still has open.
  The write now **waits the lock out** instead of failing, which is what
  broke the save on a busy machine and in CI.
- Temp files left behind by a crash between write and rename are swept up
  on the next start.

### Model Farm: remember and annotate

- A **recently-installed strip** above the model list remembers your
  successful installs — model, runtime, how long ago. Clicking a chip
  searches that repository again.
- A free-form **note per model** — why you kept it, which quant fits, the
  speed you measured. The note is stored locally and shown in the model
  detail.
- Two new MCP tools expose the notes: `llamafarm_notes` and `llamafarm_note`.
- Installs started elsewhere — through an MCP tool while the panel is open —
  show their download progress in the panel, and the list and the strip
  refresh when they finish.
- An unsaved note draft survives the list re-rendering, so a slow refresh
  never eats what you were typing.

### Smaller fixes

- Every model column is navigable, and the Model Farm remembers the filters
  you set (task, parameter range, red models) across restarts.
- Remote marketplace modules are bounded and opt-in: their tool arguments
  leave this machine, and the panel says so.
- The CI workflow can be re-run on demand for release verification.

## Install

Download the installer or the portable executable from the
[release page](https://github.com/acsdd/toolbox-mcp/releases/tag/v0.9.0).

The MCP server itself is used from a source checkout — see
[docs/astrlink-setup.md](https://github.com/acsdd/toolbox-mcp/blob/main/docs/astrlink-setup.md)
for the complete Windows setup, and
[docs/install.md](https://github.com/acsdd/toolbox-mcp/blob/main/docs/install.md)
for the app.

## Verification

- Local suite: **258 tests, all passing** (`npm test`).
- CI: green on the release commit.
- The packaged application was smoke-tested from its own `app.asar`: the
  panel answers on `127.0.0.1`, a foreign `Origin` is refused with `403`,
  the Overview renders the full tool surface, and closing the window closes
  the listener.
- The portable executable was started as a user would, and it served the
  panel with all 36 tools on its own port.
- The terminal was measured in the packaged app at the normal window size and
  at 1000 × 680, with the reading position checked while new output arrived.

## Notes

- The binaries are not code-signed, so Windows SmartScreen shows an
  "unverified publisher" warning on first start.
- The app and the MCP server share the same panel and the same tools; the
  app is the desktop program, the server is what an MCP client launches.
- The credential store holds the App Password. Removing the app does not
  remove that entry — delete `toolbox-mcp/gmail` in Credential Manager, or
  use **Disconnect** in the panel.
