# Model Farm 0.9.14

The Model Farm install action now lets you choose the runtime, instead of always installing into whichever runtime happened to be active.

## What changed

- **Model Farm · install runtime picker.** When more than one local runtime is found, an expanded model card shows a runtime dropdown next to **⬇ Install** — Ollama, LM Studio, llama.cpp, Jan, and any other runtime the scan finds with a models folder. The chosen runtime is sent with the install request, so a single click installs into the runtime you mean. Picking a runtime on one card retargets every other open card without re-rendering, so the page never disagrees with itself.
- **Sensible default.** The picker starts on the runtime selected under **Local runtimes**; a pick you make explicitly is kept while that runtime is still found, and a pick that disappears (runtime removed) falls back to the active runtime. Before detection has run, the action stays on plain **Install in Ollama**.
- **One runtime, no clutter.** With a single runtime found the action keeps the plain **Install in &lt;label&gt;** button — the picker only appears when there is a choice to make. The safetensors-only note and the busy/error messages name the chosen runtime, so "downloading into LM Studio…" is what you see.
- The runtime dropdown carries an accessible name ("Runtime to install &lt;model&gt; into").

## Verification

- `npm test`: 298/298 across 69 suites, typecheck clean. New tests drive the runtime-target helpers in the real panel script — found runtimes, default to active, explicit pick kept, fallback when a pick disappears, Ollama before detection — and pin the picker markup and the runtime field of the install payload.
- Live panel checks with Playwright on a scratch panel with four runtimes found (Ollama, LM Studio, llama.cpp, Jan): the expanded card showed the picker with all four; choosing LM Studio synced the selects on every open card; the install request body carried `{"repo":"ornith-ai/Ornith-1.5-9B-GGUF","runtime":"lmstudio"}`; the card then read "Installed into LM Studio", and the accessibility tree exposed the combobox under the model's name.
- Packaged probes on 0.9.14: smoke test green (sandboxed window, loopback-only panel, 37 tools); install probe passed against the unpacked payload and the extracted Setup payload (37 tools, matching panel catalogue, read-only call, MCP client journey); secondary-runtime probe detected 10 runtimes and passed switching, unknown-runtime refusal, removal guard and restore.

## Verify the download

```text
a1dae875297f4cfb0449445d2f0dfe80989e1d13c64f597a8f58e792ffa0d43a  ModelFarm-Portable-0.9.14.exe  (113,140,445 bytes)
4c30a737978669989fe5dfba53c3c7df5120396a1dd436fa024d9eff7cc75a85  ModelFarm-Setup-0.9.14.exe     (124,821,897 bytes)
```

Both binaries are unsigned, so Windows SmartScreen shows an "unverified publisher" warning on first start.
