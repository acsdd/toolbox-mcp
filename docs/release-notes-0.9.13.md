# Model Farm 0.9.13

Panel sections have addresses, the terminal has a Clear view, and the Model Farm no longer dead-ends when a filter matches nothing.

## What changed

- **Every section has an address.** `#models`, `#terminal`, `#marketplace`, `#gateway` and `#settings` open that section directly, the address bar follows the rail when you click, and a reload lands where you were. An address for a section that is not available — the gateway before its widget is installed — falls back to Overview and the address is rewritten to match, so the URL never claims a view you are not on.
- **Terminal · Clear view.** Drops the on-page scrollback without stopping the shell or touching its command history, then puts focus back in the input. The scrollback is also capped at 200,000 characters, so a long-running session cannot grow the page without bound.
- **Model Farm · Reset filters.** Returns to the whole catalog in one click: search text, both size bounds, the purpose filter and the submitted verdict are cleared together. An empty result now says what is empty and offers two ways out — search HuggingFace for the same words, or reset — instead of leaving a bare list.
- The live search count reads "1 hit" for a single result instead of "1 hits".
- The size bounds, the module category and the gateway status selects carry accessible names ("Minimum parameters (billions)", "Maximum parameters (billions)", "Module category", "Request status").

## Verification

- `npm test`: 293/293 across 68 suites, three consecutive full runs and a run at `--test-concurrency=8`, typecheck clean. New tests drive the section address functions, the terminal clear, and the model-filter reset in the real panel script and pin the reset/clear controls and the named selects. The run-now preference case now uses weights small enough to stay green on a loaded machine instead of depending on free RAM.
- Live panel checks with Playwright: `#models` opened the Model Farm with the rail current; clicking Terminal changed the address to `#terminal`; `#gateway` (widget not installed) showed Overview and the address became `#overview`; Clear view emptied an active PowerShell scrollback while the same pid stayed running and focus returned to the input; a nonsense model search showed the empty-state actions, Reset filters restored 44 models across 8 purpose lists with empty fields; a one-result live search read "1 hit"; the four selects announced their names.
- Packaged probes on 0.9.13: smoke test green (sandboxed window, loopback-only panel, 37 tools); install probe passed against the unpacked payload and the extracted Setup payload (37 tools, matching panel catalogue, read-only call, MCP client journey); secondary-runtime probe detected 10 runtimes and passed switching, unknown-runtime refusal, removal guard and restore. The probes now stop the MCP server child they start, so a finished probe no longer leaves a stray panel process behind on Windows.

## Verify the download

```text
8e607486849a36715e5fe207b594cc769f7c23eb0a7b1e457f4a2d1a88d3a9ac  ModelFarm-Portable-0.9.13.exe  (113,140,433 bytes)
554e4baa3dc9b0fc6557eb690ab8d6f0f246e6cc4e33faa11bc1a381c5561d91  ModelFarm-Setup-0.9.13.exe     (124,821,392 bytes)
```

Both binaries are unsigned, so Windows SmartScreen shows an "unverified publisher" warning on first start.
