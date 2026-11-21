# Model Farm 0.9.18

Completes the runtime-truth pass in 0.9.17: a shared port with no banner is no longer attributed to the first runtime that claims it.

## Local runtimes

- When a server answers on a shared port (llama.cpp, LocalAI and llamafile all
  use 8080) but does not name itself, none of the claimants is reported as
  installed or running. The row says the port answers but the server does not
  identify itself, rather than offering **use this** for the wrong runtime.
- A runtime with a port of its own (for example LM Studio on 1234) is still
  recognised when its banner is missing.
- This is on top of the 0.9.17 fixes: neighbours no longer inherit an owner's
  install state, stopped installs read **installed · server not running**, the
  Ollama chip and active-runtime chip share one scan, and a busy port is never
  claimed for a model it does not serve.

## Verification

- 318 tests in 73 suites pass; TypeScript typecheck clean.
- Packaged probes on 0.9.18: smoke test green (sandboxed window, loopback-only
  panel, 37 tools, 4-row scorecard); install probe passed against the unpacked
  payload and the extracted Setup payload (37 tools, matching panel catalogue,
  read-only call, MCP client journey); secondary-runtime probe detected 10
  runtimes and passed switching, unknown-runtime refusal, removal guard and
  restore.

## Artifacts

```
df9855615e1e1731008f4c2d7831360389cdb4e03146bfd012a282c597ac9271  ModelFarm-Portable-0.9.18.exe  (113,141,494 bytes)
bdb43a1c450b75b898c076cd6ef74a46122f74172392f675bb120fbeacdb2bf0  ModelFarm-Setup-0.9.18.exe     (124,823,550 bytes)
```

Windows, x64, no administrator rights. The binaries are not code-signed, so
SmartScreen shows an "unverified publisher" warning on first start.
