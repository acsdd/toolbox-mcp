# Model Farm 0.9.26

This release is the first v1.0 batch: shutting Model Farm down is now predictable, and every process it starts is accounted for before the app exits. Closing the app, stopping a terminal session or cancelling a model download no longer leaves a helper process behind or reports success for work that never finished.

## What changed

- One shared shutdown controller drives every entry point (MCP stdio server, ops panel and the desktop app). Asking it to close more than once returns the same cleanup, the closing state is published immediately, and every cleanup failure is collected and reported together instead of the first one hiding the rest.
- Work that starts after shutdown has begun is now refused with a clear "toolbox-mcp is shutting down" result instead of half-running, and operations already accepted are drained before the process exits.
- A client that simply closes the MCP connection (standard editor and CLI behaviour) exits with status 0. If that natural exit's own cleanup fails, the process now exits nonzero instead of claiming a clean shutdown, and an existing signal-based status (Ctrl+C / SIGTERM) is preserved.
- A real startup failure is no longer confused with an expected shutdown: genuine errors are still reported and force a failing exit, while a startup cancelled by shutdown stays silent.
- Ollama commands the app owns (pull, create, remove) are now bound to shutdown. Cancelling sends a termination request, escalates to a forced kill, and only finishes when the command is observed to have exited; a command that refuses to exit surfaces as an error rather than hanging shutdown or being reported as an ordinary failure.
- The same rules apply to a model install that would otherwise retry with a different quantization: once shutdown has started, the retry never spawns a second command, and a late successful removal can no longer be reported as success.
- Terminal sessions are owned until their output streams have actually closed, not merely until the shell process exits, so a grandchild that inherited the shell's pipes cannot keep the app alive. A forced kill whose exit is never observed is reported as a cleanup failure.

## Verification

- 497 tests in 84 suites pass (2 POSIX-signal cases are skipped on Windows); `tsc --noEmit` is clean.
- The packaged portable app passes the Electron smoke run: 37 tools, sandbox on, 4 Model Farm scorecard rows and the Overview catalog render correctly.
- The packaged MCP client journey passes for both the portable payload and the extracted assisted-installer payload: initialize, 37-tool catalog, read-only call, matching panel catalog — and closing stdin lets the packaged server exit naturally with status 0.
- Secondary-runtime acceptance passes against the packaged build with 10 detected runtimes, including runtime switching, unknown-runtime rejection, the non-Ollama removal guard and restoring the default runtime.
- Both executable SHA-256 checksums verify against `SHA256SUMS.txt`.

## Downloads

| Build | Size | SHA-256 |
| --- | --- | --- |
| `ModelFarm-Setup-0.9.26.exe` | 124,836,159 bytes | `e7f5c126ed689cea774426b414a3180f77e41f93027d4ac5fec9dbcfebf96f39` |
| `ModelFarm-Portable-0.9.26.exe` | 113,153,760 bytes | `0bc186225e355529686a7e7adc6efc47091590a6e6131bc4d1caf63e26ea260c` |

`SHA256SUMS.txt` is attached to the release; check a download with
`sha256sum -c SHA256SUMS.txt`. The Windows binaries are not code-signed.
