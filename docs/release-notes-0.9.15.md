# Model Farm 0.9.15

The install result now tells the whole story: which runtime holds the model, where it landed, and what to run next.

## What changed

- **AstrLink setup names the real runtime.** The note under **Use in AstrLink** used to say it was using "the default local Ollama address" no matter which runtime had received the model. It now names the runtime and prints that runtime's base URL, so an install started for llama.cpp or another server runtime points at the right address.
- **Install line keeps the explanation and the next step.** The card used to replace the service's message with the last install step, dropping the quantization fallback note ("Ollama could not use the Q8 tag…") or the model-folder path a file-based runtime reported. Both are now shown together — for example, where the file landed plus "Open LM Studio and load …".
- **Install status is announced.** The install line (downloading, installed, or failed) is a polite live region, so a screen reader hears the result without polling the card.

## Verification

- `npm test`: 302/302 across 70 suites, typecheck clean. New tests drive the AstrLink setup and the install-message composition in the real panel script: runtime name and address replace the Ollama claim, the service explanation survives next to the last step, a repeated step is not duplicated, and failures report the service error. The panel test pins the live-region attributes and the new hooks.
- Live panel check with Playwright on a scratch panel: an install state for llama.cpp rendered "This uses llama.cpp’s local address (http://127.0.0.1:8080/v1)" with the copied settings showing the same base URL; the install line showed the folder explanation plus the start command and exposed `role="status"`, `aria-live="polite"`.
- Packaged probes on 0.9.15: smoke test green (sandboxed window, loopback-only panel, 37 tools); install probe passed against the unpacked payload and the extracted Setup payload (37 tools, matching panel catalogue, read-only call, MCP client journey); secondary-runtime probe detected 10 runtimes and passed switching, unknown-runtime refusal, removal guard and restore.

## Verify the download

```text
622e78a7a42b333fce6446b9eaaea035c6d68fb010cb44fff0abbcdb29c1979e  ModelFarm-Portable-0.9.15.exe  (113,141,838 bytes)
76444100e887f585feda27dfc033807236cf65b9f8f43a2816031a7a295448b8  ModelFarm-Setup-0.9.15.exe     (124,822,213 bytes)
```

Both binaries are unsigned, so Windows SmartScreen shows an "unverified publisher" warning on first start.
