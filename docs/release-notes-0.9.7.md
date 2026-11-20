# Model Farm 0.9.7

The 0.9.7 build rounds out the download and runtime work from 0.9.4–0.9.6 with
three fixes, and adds the two acceptance probes that were still missing.

## Quantization labels the catalog could not see

Hugging Face repos often name their weights `model.q4k.gguf` or
`model.IQ4_XS.gguf`. The catalog parser only understood `Q4_K_M`, `Q8_0`,
`F16` and a few like them, so those files were listed with no quant at all and
could not be chosen by name. The parser in `toolbox-widgets` now reads the short
k-quant form (`q4k` → `Q4_K`) and the i-quant family (`IQ2_XXS`, `IQ3_M`,
`IQ4_XS`), and normalizes the short form so `q4k` and `Q4_K` name the same
thing. `llamafarm_quants` lists those files with their labels and sizes, and
`llamafarm_install` accepts the label like any other quant.

## Test downloads no longer land in the real LM Studio folder

The cancellation tests install into a mocked transfer, but the destination folder
was still resolved from the real home directory, so every run created an empty
`~/.lmstudio/models/test/...` folder on the machine. The service now accepts an
injectable `homeDir` for runtime model folders, and the tests point it at their
temporary home. Verified after the change: a full `npm test` leaves
`~/.lmstudio/models` exactly as it was.

## Acceptance probes

Two probes that were run by hand are now scripts:

- `scripts/verify-secondary-runtime.mjs` takes an install folder (or an unpacked
  portable app) as its argument and checks detection, runtime switching, the
  unknown-runtime refusal, the non-Ollama removal guard and restoration.
- `scripts/verify-lmstudio-journey.mjs` proves the file-based runtime path end to
  end: select LM Studio, list quants, install a small GGUF into LM Studio's own
  models folder, wait for the transfer, confirm the file, then delete only what
  it created. It refuses to run if the test model is already present, and it
  works against the packaged app or a built checkout.

Both were run against the 0.9.7 packaged build before this release. The journey
downloaded 55,075,168 bytes (`model.q4k.gguf`) into
`~/.lmstudio/models/gradium/phonon-31m-en/`, reached `done`, and cleaned up.

## Everything else

- 275 MCP tests and 177 widget-core tests pass; typecheck is clean.
- The install probe against the packaged app reports 37 tools, a matching panel
  catalogue and a successful read-only call.
