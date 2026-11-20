# Model Farm 0.9.3

A focused model-transfer release: downloads can now be cancelled without leaving a half-written file behind.

## What's changed

### Cancel in-progress model downloads

- Each folder install (LM Studio, llama.cpp, and the other runtimes that take a GGUF file) now registers a cancellable transfer. The Model Farm progress row grows a **cancel** button, and MCP clients get a new tool:

  ```json
  { "name": "llamafarm_cancel", "arguments": { "repo": "bartowski/Llama-3.2-3B-Instruct-GGUF" } }
  ```

- Cancelling aborts the HTTP stream, deletes the staged `.part` file, and settles both the progress entry (`cancelled`) and the install result (`reason: "cancelled"`), so nothing is half-installed and the model folder stays clean.
- Cancellation is idempotent: a second call for the same repository reports that no active download exists.
- Ollama pulls are honest about their limit. The Ollama daemon owns its download stream and exposes no abort hook, so `llamafarm_cancel` says so instead of pretending to stop it, and the panel button reports "cannot cancel".
- The tool catalogue is now 37 tools.

### Panel probe fix

- Restored the minimum-size lift in `scripts/capture-panel.cjs`; the desktop window's 1000px floor had pushed the narrow-layout assertion off the 860px breakpoint. The probe verifies the left rail at wide sizes and its collapse at 820px again.

## Verification

- **Unit test suite:** 263/263 tests passing across 65 suites (`npm test`), including the new cancellation tests (`test/download-cancel.test.ts`) that assert the abort reaches the transfer, the install returns `reason: "cancelled"`, and the progress entry settles as `cancelled`.
- **Typecheck:** clean (`npm run typecheck`).
- **Panel layout probe:** wide rail at 0–232px with the inner-edge accent, rail hidden at a 804px viewport (`npx electron scripts/capture-panel.cjs`).
- **Packaged app smoke test:** sandboxed window, 127.0.0.1 panel origin, foreign-origin refusal, tool catalogue served, listener closed with the window (`scripts/smoke-portable.cjs`).
