# Model Farm 0.9.22

This release makes the step from "the app works" to "an MCP client works" a
documented one.

## Use the tools from an MCP client

A new guide, [Use the tools from an MCP client](mcp-clients.md), walks through
connecting Claude Desktop, Cursor and other MCP clients to a Model Farm
installation:

- the exact configuration the install needs, including
  `ELECTRON_RUN_AS_NODE` and `TOOLBOX_MCP_HOME`;
- where each client keeps its configuration file and how to restart it;
- what success looks like — 37 tools listed, and why the panel may still say
  `panel only` while the tools work in the client;
- a troubleshooting table for the usual failures.

The guide is linked from the README, the Windows install guide, the landing
page and the panel's own **Client guide** link.

## The Connect card explains itself

The note under the generated configuration now says that each client starts
its own copy of the server and that the paths belong to this installation. The
`panel only` badge describes the app process, not a broken connection, and the
card no longer reads like something failed.

## Verification

- 335 tests in 77 suites pass, `tsc --noEmit` is clean.
- The packaged app passes the smoke run (37 tools, sandbox on) and the MCP
  client journey.
- The portable build, the extracted installer payload and the ten secondary
  runtimes are verified.

## Downloads

| Build | Size | SHA-256 |
| --- | --- | --- |
| `ModelFarm-Setup-0.9.22.exe` | 124,825,065 bytes | `4b1251deb5497445b994292ac29d0a2ee5ae95dc0e94ff2a98fefca18d61603e` |
| `ModelFarm-Portable-0.9.22.exe` | 113,143,419 bytes | `ced8de3aa58cd703d74c579fbec7b6052ac63666b5eb39e0b08e69d54066b66e` |

`SHA256SUMS.txt` is attached to the release; check a download with
`sha256sum -c SHA256SUMS.txt`.
