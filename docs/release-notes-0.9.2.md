# Model Farm 0.9.2

A usability and stability release bringing layout ergonomics, terminal probe resilience, automated secondary runtime verification, and reproducible CI builds.

## What's changed

### Ergonomics: Panel navigation restored to the primary left rail

- The main navigation rail (Overview, Model Farm, Terminal, Marketplace, Gateway, Settings) has been moved back to the fixed first column on the left of the stage (`232px minmax(0, 1fr)`).
- Active navigation items display an accented indicator on their inner edge for instant visual feedback.
- Narrow and mobile viewports automatically collapse the rail and expand the stage to full width.

### Terminal UX & probe resilience

- **Decoupled input region (Issue #3):** The terminal command entry field remains visible and anchored at the bottom of the viewport, while command output accumulates in an independently scrollable region. Output growth no longer pushes the prompt off-screen.
- **Probe resilience:** The terminal connection probe now persists across the entire wait window, eliminating false-positive timeout errors on busy or cold runner environments.

### Multi-runtime validation

- Added an automated end-to-end acceptance suite (`scripts/verify-secondary-runtime.mjs`) verifying:
  - Discovery across all 10 supported local runtimes (Ollama, LM Studio, llama.cpp, Jan, etc.).
  - Dynamic switching of the active installation runtime (`runtimes_use`) with persistence in user settings.
  - Runtime validation guards that reject non-existent runtimes.
  - Safety guards that refuse non-Ollama model removals.
  - Seamless restoration of the default Ollama runtime.

### CI & Build Reproducibility

- Pinned the sibling dependency `@toolbox/widgets` to a verified commit hash (`146b9ba5446575d36263c835b503608c218944d1`) in `.github/workflows/ci.yml`. This ensures deterministic builds and guards against unreleased upstream changes.

## Verification

- **Unit test suite:** 261/261 tests passing cleanly across 64 suites (`npm test`).
- **Core widgets:** 176/176 tests passing cleanly in `@toolbox/widgets` v0.2.1.
- **Packaged stdio MCP execution:** Verified via `verify-install.cjs` using `ELECTRON_RUN_AS_NODE=1` without external Node dependencies.
- **End-to-end model lifecycle:** Verified via `verify-model-journey.mjs` against live Ollama runtime (search -> quant mapping -> pull -> progress -> inventory -> clean removal).
- **Secondary runtime journey:** Verified via `verify-secondary-runtime.mjs`.
