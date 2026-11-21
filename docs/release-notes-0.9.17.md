# Model Farm 0.9.17

Runtime truth pass: the panel now reports what is actually installed and running, and starts a local server only when it is safe.

## Local runtimes

- A server answering on a shared port no longer makes every runtime that uses
  that port look installed. Only the runtime that owns the banner — or a real
  CLI / install folder — is counted; the neighbours say who holds the port.
- An install whose server is off reads **installed · server not running**
  instead of a bare "installed". The Ollama chip and the active-runtime chip now
  read the same runtime scan, so "OLLAMA not found" can no longer sit next to
  "ACTIVE RUNTIME · Ollama · installed". The machine strip refreshes when the
  scan lands.
- **use this** reports a failed selection instead of silently doing nothing.

## Starting a server runtime

- Each runtime gets the command line it understands: llama.cpp and llamafile
  take `-m <file>`, while vLLM now gets `serve <file>` plus the Hub repository
  as `--tokenizer` for local GGUF.
- An occupied port is checked first. If it already serves the same model the
  start is reused; if it serves another model or an unidentified server, the
  panel leaves it alone and prints the exact command to run.
- Paths with spaces are quoted in the command the panel shows.
- vLLM's note names the `vllm-gguf-plugin` requirement for local GGUF.

## Verification

- 317 tests in 73 suites pass; TypeScript typecheck clean.
- Packaged probes on 0.9.17: smoke test green (sandboxed window, loopback-only
  panel, 37 tools, 4-row scorecard); install probe passed against the unpacked
  payload and the extracted Setup payload (37 tools, matching panel catalogue,
  read-only call, MCP client journey); secondary-runtime probe detected 10
  runtimes and passed switching, unknown-runtime refusal, removal guard and
  restore.

## Artifacts

```
272038459c547bc74cf36714098e171d45756e9493d7524b973e3103d9f1ab10  ModelFarm-Portable-0.9.17.exe  (113,141,775 bytes)
15e2920be9fdbcc89f8b79f15569f538017c65a79290b8b5a03d1d96dcecec35  ModelFarm-Setup-0.9.17.exe     (124,823,640 bytes)
```

Windows, x64, no administrator rights. The binaries are not code-signed, so
SmartScreen shows an "unverified publisher" warning on first start.
