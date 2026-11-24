# Model Farm 0.9.25

This release makes settings changes and related lifecycle transitions safer under overlapping requests. Settings are committed before their new state is published, failed saves preserve the prior state, and later operations can still use the queue.

## What changed

- Settings mutations now run through one per-service commit queue. Each operation starts from the last committed settings, persists first, then publishes settings and derived in-memory state.
- Failed settings persistence no longer leaks uncommitted watchlists, runtime selections, marketplace state or other preferences into the running service. A failed operation does not poison the queue for later changes.
- Gmail connection, disconnection and bundle-import credential transitions are serialized with their settings changes. Disconnect state is published before best-effort secure-store cleanup, and failed compensation cannot overwrite a newer connection.
- Marketplace install and uninstall transitions are serialized per module, including registry I/O. An older uninstall cannot disconnect a newer remote installation, and call order is preserved before remote work begins.
- Runtime detection uses a generation guard, so a slower older probe cannot replace a newer cached report. Returned reports always show the currently active runtime.
- Network calls, CLI work and other external operations remain outside the global settings queue. These queues are per running service process; cross-process settings locking is not introduced.

## Verification

- 383 tests in 83 suites pass; `tsc --noEmit` is clean.
- The packaged portable app passes the Electron smoke run: 37 tools, sandbox on, Model Farm scoring and the Overview catalog render correctly.
- The packaged MCP client journey passes for both the portable payload and the extracted assisted-installer payload: initialize, 37-tool catalog, read-only call and matching panel catalog.
- Secondary-runtime acceptance passes with 10 registered runtimes, including runtime switching, unknown-runtime rejection and the non-Ollama removal guard.
- The live packaged LM Studio journey selects Q4_K, downloads a 55,075,168-byte GGUF into its models folder, reaches done, verifies the file and removes only the test files it created.
- The live packaged Ollama journey passes search, quantization listing, install, progress, installed-state and removal checks. The Q8 tag correctly falls back to the repository default, and the test model is removed afterward.
- Both executable SHA-256 checksums verify against `SHA256SUMS.txt`.

## Downloads

| Build | Size | SHA-256 |
| --- | --- | --- |
| `ModelFarm-Setup-0.9.25.exe` | 124,827,106 bytes | `02f203edfd968d4dc7ea9c379d7bba137b70f1d658fc05957d127c5cde6fe019` |
| `ModelFarm-Portable-0.9.25.exe` | 113,145,221 bytes | `e461cbf4a47803e8d9690d335d951d1fd0befa3d17cf6729ab09d161a77147ba` |

`SHA256SUMS.txt` is attached to the release; check a download with
`sha256sum -c SHA256SUMS.txt`. The Windows binaries are not code-signed.
