# Model Farm 0.9.8

Two version-identity fixes: the server now says which version it is, in both
places where it used to say something older.

## Remote-server connections named an old version

When toolbox-mcp connects to a marketplace remote server, it introduces itself
as an MCP client. That introduction carried a hardcoded `0.5.0` from the day
the string was written, so every remote server saw a three-release-old
identity. `connectRemote` now builds its client info from `appVersion()`, the
same source as the stdio handshake, the panel and the outgoing user agent.

## A broken build no longer claims to be 0.6.1

`appVersion()` reads `package.json` at runtime and falls back to a constant
only if that read fails. The constant was left at `0.6.1`, so a package with a
missing manifest would have reported a release it was not. The fallback is now
`0.0.0-unknown`, which is valid semver and visibly not a release number.

`test/version.test.ts` pins both behaviours: `appVersion()` equals the
manifest version, and the remote client identity equals `appVersion()`.

## Verification

- 277 MCP tests pass (two new), 177 widget-core tests unchanged; typecheck is
  clean.
- The packaged smoke test passes on this build: sandboxed window, panel bound
  to the loopback address, foreign origin refused with `403`, the 37-tool
  catalogue served, and the listener closes with the window.
- The install probe passes against the portable payload and against the Setup
  artifact's extracted payload (manifest `0.9.8`, widget core `0.2.2`): 37
  tools, matching panel catalogue, successful read-only call.
- The secondary-runtime probe detects 10 runtimes and passes switching,
  unknown-runtime refusal, the non-Ollama removal guard and restore.
- The Ollama journey (search, Q8 request, install, remove) passes on the
  packaged build. Ollama cannot use the `Q8` tag this repository publishes, so
  it installed the repository default and the message said so; removal left
  the model store clean.

No widget-core change ships in this release; it stays at 0.2.2.

## Verify the download

```text
be1aead87967dbc422def5ca5ba16772f90a9eacc41034b7b0e42cb34ba8de6a  ModelFarm-Portable-0.9.8.exe  (113,133,566 bytes)
dba7fc690dfaa49ff95b5076d5194a42e209848a9e0a755bad103382d9324543  ModelFarm-Setup-0.9.8.exe     (124,820,290 bytes)
```

PowerShell: `Get-FileHash .\ModelFarm-Portable-0.9.8.exe -Algorithm SHA256`.

