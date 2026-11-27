# Model Farm 0.9.27

This release is a diagnostics and metadata wave: the ops panel now separates recent activity from lifetime totals, leak-prone error text is bounded and redacted, and the tool contract Model Farm advertises is exported verbatim for local audits.

## What changed

- Activity counters are now lifetime totals instead of being reset with the 60-entry recent-call window. The panel header shows the recent window count alongside the totals when they differ, and per-tool counters stay stable across long runs.
- Recorded activity errors are sanitized before they reach memory or the panel: control characters are stripped, `Bearer` credentials are redacted, and the text is capped at 200 characters with an ellipsis.
- Unexpected panel failures return a generic `Internal panel error.` response and log only a sanitized error type, so local paths and internal messages no longer leak into HTTP responses.
- Every catalog tool carries MCP annotations (read-only, destructive, idempotent, open-world). Static and proxied remote tools expose them through `/api/catalog`, and the panel renders hint badges for each tool.
- New `GET /api/tool-contract` endpoint serves the deterministic tool contract (schema version 1, service, version, groups and per-tool input schemas) from the same source that powers discovery.
- The contract's input schemas are now produced with the MCP SDK's own `toJsonSchemaCompat` conversion, making them byte-identical to what `tools/list` advertises. The previous Zod-native export used the draft 2020-12 dialect, which a schema-fingerprint audit correctly read as drift on every tool.
- Builds export `dist/tool-contract.json` every time, and the portable package ships it so offline audits and the bundled Router see the same contract.
- Fixed the portable packaging script so the new contract export step runs without arguments.

## Verification

- 503 tests in 86 suites pass (2 POSIX-signal cases are skipped on Windows); `tsc --noEmit` is clean.
- A per-tool regression test now asserts every exported input schema is deep-equal to the SDK advertisement.
- The packaged executables were rebuilt from the same sources and their hashes are below.

## Downloads

| Build | Size | SHA-256 |
| --- | --- | --- |
| `ModelFarm-Setup-0.9.27.exe` | 124,773,589 bytes | `b034854f4a103b825f78c9971fd33595f86bd6dfbebc9fedda929740d7ecd19d` |
| `ModelFarm-Portable-0.9.27.exe` | 113,165,775 bytes | `c1fbdfd46ecaa3a503e3bc54d74b04fc114977cbef843d86053d5ae9df999213` |

`SHA256SUMS.txt` is attached to the release; check a download with
`sha256sum -c SHA256SUMS.txt` from the download folder.
