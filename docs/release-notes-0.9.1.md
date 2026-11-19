# Model Farm 0.9.1

A patch release with one real fix and one real capability. The Model Farm can
now install a model from any repository on Hugging Face — including the ones
whose file names Ollama cannot tag — and the installed app can serve an MCP
client on a machine that has no Node.js at all.

## What's changed

### The Model Farm installs models again

Installing a model could fail with `ollama exited with code 1` and nothing
else. The reason was hidden in the runtime's output, and the reason was a
mismatch of names:

- Ollama matches a quantization tag against the **file names a repository
  publishes**. A file called `model.q8.gguf` yields the label `Q8`, which is
  not one of Ollama's schemes, so Ollama answers *"the specified tag is not a
  valid quantization scheme"* and refuses the pull.
- A tag Ollama understands is not always published either: `Q8_0` is a valid
  scheme, and a repository that only ships `model.q8.gguf` still does not have
  it. Ollama answers *"the specified tag is not available in the repository"*.

Both are handled now:

- A label is **mapped onto a tag Ollama understands** (`FP16` → `F16`, and the
  schemes Ollama accepts are listed explicitly).
- A label Ollama cannot use installs the **repository default**, and the panel
  says so: *"Ollama could not use the Q8 tag for this repository, so it
  installed the repository default (hf.co/gradium/phonon-31m-en:latest)."*
- A tag Ollama understands but does not publish is **retried once with the
  repository default** — for the plain pull and for the GPU split create.
- The reference that is actually installed is what gets recorded: the AstrLink
  model setting, the "what to run next" steps and the install result all name
  the served model, not the requested tag.

### Failures say what Ollama said

A failed install now carries Ollama's own words — *"the specified tag is not a
valid quantization scheme"* — instead of an exit code. The exit code is only
used when the runtime printed nothing useful.

### The installed app can serve an MCP client

The installed app ships its own Node runtime, so **no separate Node.js install
is needed** to use the Model Farm tools from Claude Desktop, Cursor or any
other MCP client:

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
runtime, so the server starts on stdio without opening a window.
`node scripts/verify-install.cjs` performs the same handshake a client
performs and prints the tool count — see
[docs/install.md](https://github.com/acsdd/toolbox-mcp/blob/main/docs/install.md).

## Install

Download the installer or the portable executable from the
[release page](https://github.com/acsdd/toolbox-mcp/releases/tag/v0.9.1). An
existing 0.9.0 install is updated by running the newer installer over it; your
settings and the stored credential stay.

## Verification

- Local suites: **261 tests** in this repository and **176** in the widget
  core, all passing (`npm test`).
- The Model Farm journey was run against the **live Ollama runtime** on this
  machine: a live search found the repository, the quant picker listed its
  files, the install pulled the weights (55 MB) and finished `done`, the model
  appeared in the runtime's inventory, the removal deleted it, and the runtime
  was back to its previous contents afterwards.
- The same journey was run again through the **installed 0.9.1 application**,
  driven as a real MCP client over stdio (`node scripts/verify-model-journey.mjs`):
  search → quant list → install → progress → inventory → removal → clean, plus
  the graceful `not-found` answer for an unknown repository.
- The failure paths were exercised against the live runtime as well: an
  unknown repository reports `not-found`, and a repository that is not
  published as GGUF explains that Ollama cannot import it.
- The installed application was started from its own folder and served an MCP
  client handshake with all 36 tools; a read-only tool call succeeded.
- The widget core is released as **0.2.1**; it is published first, because this
  repository builds against it.

## Notes

- The binaries are not code-signed, so Windows SmartScreen shows an
  "unverified publisher" warning on first start.
- The fallback to the repository default is deliberate: Ollama itself answers
  *"please use another tag or 'latest'"* when a tag is unusable. The panel
  always reports which reference was installed.
