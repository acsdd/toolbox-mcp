# Model Farm 0.9.23

This release tightens the day-to-day Marketplace, Overview and startup paths.

## What changed

- Connected remote MCP tools now appear in the Overview tool catalog with their
  real names, descriptions and parameters. Uninstalling the module removes them
  from the catalog immediately.
- Marketplace Install and Uninstall recover from rejected requests and non-JSON
  HTTP failures. The controls are re-enabled and the panel explains what failed
  and how to retry; the registry reloads only after a successful mutation.
- Removing an Ollama model and uninstalling a Marketplace module now require
  confirmation. Uninstall confirmation names the module, warns when remote tools
  will disconnect and states that widget settings are kept.
- The Gmail widget shows the real credential or service error even when no
  account is configured, instead of hiding it behind first-run setup guidance.
- Malformed, empty or oversized saved crypto watchlists are normalized or reset
  to safe defaults during settings load, so damaged persisted data cannot block
  MCP startup. Explicit user updates still reject invalid watchlists.

## Verification

- 351 tests in 81 suites pass; `tsc --noEmit` is clean.
- The packaged portable app passes the Electron smoke run: 37 tools, sandbox on,
  Model Farm scoring and the Overview catalog render correctly.
- The packaged MCP client journey passes for both the portable payload and the
  extracted assisted-installer payload: initialize, 37-tool catalog, read-only
  call and matching panel catalog.
- Secondary-runtime acceptance passes with 10 registered runtimes, including
  runtime switching, unknown-runtime rejection and the non-Ollama removal guard.
- Both executable SHA-256 checksums verify against `SHA256SUMS.txt`.

## Downloads

| Build | Size | SHA-256 |
| --- | --- | --- |
| `ModelFarm-Setup-0.9.23.exe` | 124,825,716 bytes | `03bd0c8b06509813245e6cf3924e03b8eb52f04aa14db4920292e6b50efe9af5` |
| `ModelFarm-Portable-0.9.23.exe` | 113,144,795 bytes | `b9acf4bed19c46c47543eb2d1093289fcc37ff832e85dbe79d91ab79e4791b6d` |

`SHA256SUMS.txt` is attached to the release; check a download with
`sha256sum -c SHA256SUMS.txt`. The Windows binaries are not code-signed.
