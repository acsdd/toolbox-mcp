# Model Farm 0.9.16

Runtime names read like names, and Ollama pulls no longer pretend they can be cancelled from the panel.

## What changed

- **Runtime names in words, everywhere.** The recently-installed strip and each in-progress download row used to print the stored runtime id (`· lmstudio`, `→ lmstudio`). Both now use the same friendly label as the runtime cards (`LM Studio`), and the strip resolves the label as soon as runtime detection lands — the stored id is only a fallback while detection is still running.
- **Honest Ollama cancellation.** Ollama streams a pull through its daemon and exposes no abort hook, so the progress row used to offer a cancel button that could only fail. It now shows a quiet **no cancel** note with a tooltip explaining the pull keeps running, and only builds with a real abort path (GGUF downloads into a file-based runtime) get the cancel button. The service's refusal message says the same thing plainly instead of pointing at a terminal.
- **Accessible names for repeated controls.** Model cards repeat the same actions, so the buttons now carry the model name: "Install Ornith-1.5-9B", "Choose quantization for …", "Retry install of …", "Remove … from Ollama", "Save note for …", and "Copy AstrLink setup for …". Screen-reader users can tell the rows apart without counting.
- **Runtime scan is announced.** The Local runtimes header and its scan log are polite live regions, so detection results and runtime switches reach assistive technology as they happen. Each installed runtime's action is labelled "Use <runtime>" and each missing one is labelled "Get <runtime>".
- **Clearer Local runtimes copy.** The section now says what the list is for: pick one with **use this** to make it the active runtime for grading; each model can still install into any runtime that was found.

## Verification

- `npm test`: 308/308 across 71 suites, typecheck clean. New tests run the real panel script: the recent strip and download rows name the runtime in words, the stored id only applies before detection, the Ollama row shows **no cancel** and explains the background pull, and the repeated controls carry model-specific accessible names. The service test drives a pending Ollama pull through cancellation and checks the plain-language refusal, including the absence of "terminal".
- Live panel check with Playwright on a scratch panel (seeded settings, throwaway home, dedicated port; the user's panel on port 3851 was not touched): the recent chips rendered "Llama 3.2 3B Instruct … · LM Studio" and "Qwen2.5 Coder 7B … · Ollama", runtime actions read "Use LM Studio" / "Use llama.cpp" / "Use Jan" and "Get GPT4All", and an expanded model card exposed "Install Ornith-1.5-9B", "Choose quantization for Ornith-1.5-9B", and "Save note for Ornith-1.5-9B".
- Packaged probes on 0.9.16: smoke test green (sandboxed window, loopback-only panel, 37 tools, 4-row scorecard); install probe passed against the unpacked payload and the extracted Setup payload (37 tools, matching panel catalogue, read-only call, MCP client journey); secondary-runtime probe detected 10 runtimes and passed switching, unknown-runtime refusal, removal guard and restore.

## Verify the download

```text
a68dbbfe4d66ed19c0834f0729ab47dc6e87613be4ced1174d9c1ac932868820  ModelFarm-Portable-0.9.16.exe  (113,142,201 bytes)
a0e74e2a24454385e42bb12ce0fd985c1a9cb765c3d2d4bf4e39c0129dcfad26  ModelFarm-Setup-0.9.16.exe     (124,822,524 bytes)
```

Both binaries are unsigned, so Windows SmartScreen shows an "unverified publisher" warning on first start.
