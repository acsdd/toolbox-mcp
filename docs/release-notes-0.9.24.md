# Model Farm 0.9.24

This release hardens terminal and runtime lifecycle handling, makes Ollama installation status honest, and steers pull-based runtimes away from direct GGUF imports.

## What changed

- Terminal spawn, stdin and output-stream failures are now handled without crashing the panel or app. Errors are bounded, visible in the terminal and allow a fresh session to start.
- Terminal stop/start handling is identity-safe: delayed output, write callbacks, exit events and kill errors from an old shell cannot overwrite or clear a replacement session. A stop is reported as successful only after the process exits; failed kill attempts are shown explicitly.
- Detached runtime launches now consume asynchronous spawn errors, wait for the actual spawn event and preserve launch diagnostics instead of leaving an unhandled error or reporting a generic timeout.
- Ollama installation no longer reports success just because its CLI works. Success requires a version response from the local server; server-launch failures remain visible in the result and log, while a CLI-only install is still identified as installed.
- `runtimes_download` rejects pull-based runtimes such as Ollama before catalog, disk or download work begins, and directs callers to `llamafarm_install`. Direct GGUF downloads into file-based runtimes such as LM Studio continue to work.
- The terminal prompt again has a visible keyboard-focus outline.

## Verification

- 372 tests in 82 suites pass; `tsc --noEmit` is clean.
- The packaged portable app passes the Electron smoke run: 37 tools, sandbox on, Model Farm scoring and the Overview catalog render correctly.
- The packaged MCP client journey passes for both the portable payload and the extracted assisted-installer payload: initialize, 37-tool catalog, read-only call and matching panel catalog.
- Secondary-runtime acceptance passes with 10 registered runtimes, including runtime switching, unknown-runtime rejection and the non-Ollama removal guard.
- The live LM Studio journey downloads a 55,075,168-byte GGUF into its models folder, reaches done and removes only the test files it created.
- The live packaged Ollama journey passes search, quantization listing, install, progress, installed-state and removal checks with a 10-minute MCP client timeout for the network pull. The Q8 tag correctly falls back to the repository default, and the test model is removed afterward.
- Both executable SHA-256 checksums verify against `SHA256SUMS.txt`.

## Downloads

| Build | Size | SHA-256 |
| --- | --- | --- |
| `ModelFarm-Setup-0.9.24.exe` | 124,826,531 bytes | `14323a2ba72c78752c2ddfd02626e9a4db9e98ad945b531e3ee1474e34a501df` |
| `ModelFarm-Portable-0.9.24.exe` | 113,144,776 bytes | `827cde38e7314388199731d0fcaf99ee0a80d3bf8dd4cbdb691813adf0b34ff0` |

`SHA256SUMS.txt` is attached to the release; check a download with
`sha256sum -c SHA256SUMS.txt`. The Windows binaries are not code-signed.
