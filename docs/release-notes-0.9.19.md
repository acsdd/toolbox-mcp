# Model Farm 0.9.19

Finishes the runtime-truth pass where it was still visible: the model list a
runtime reports, and the runtime list itself.

## Local runtimes

- Reading the models of a runtime on port 8080 no longer returns another
  runtime's models. If the server names itself as a different runtime, the
  panel says which one is answering instead of listing its models under the
  requested runtime.
- An unnamed server on a shared port is not assumed to be any of the runtimes
  that use that port; its models are not offered either.
- The runtimes card now leads with the runtimes found on this machine (plus the
  active one). The runtimes that are not installed are folded into
  **Other runtimes (n)**, so the card reads as "what I can use here" rather
  than a catalogue of ten. The folded list opens automatically when nothing is
  found, with a short hint instead of an empty grid.

## Verification

- 322 tests in 73 suites pass; TypeScript typecheck clean.
- Packaged probes on 0.9.19: smoke test green (sandboxed window, loopback-only
  panel, 37 tools, 4-row scorecard); install probe passed against the unpacked
  payload and the extracted Setup payload (37 tools, matching panel catalogue,
  read-only call, MCP client journey); secondary-runtime probe detected 10
  runtimes and passed switching, unknown-runtime refusal, removal guard and
  restore.

## Artifacts

```
995adac2f1c1671fee58ecba3034d52975bb022ce05731b0471c78866a2137d9  ModelFarm-Portable-0.9.19.exe  (113,141,893 bytes)
14a501ae976bd4b6451cac2018146f5b8e181d5445b257e8771cdc9428e2e7a5  ModelFarm-Setup-0.9.19.exe     (124,823,899 bytes)
```

Windows, x64, no administrator rights. The binaries are not code-signed, so
SmartScreen shows an "unverified publisher" warning on first start.
