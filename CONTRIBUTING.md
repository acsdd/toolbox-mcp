# Contributing

Thanks for taking a look. This repository ships the MCP server and the Windows
Model Farm app; both come from the same `src/` tree.

## Checkout

The server consumes the shared widget core from a sibling checkout, so clone
both repositories into the same folder:

```bash
git clone https://github.com/acsdd/toolbox-widgets.git
git clone https://github.com/acsdd/toolbox-mcp.git
cd toolbox-mcp
npm ci
npm run build
```

Node.js 22 or newer is required. The packaged app borrows its Electron
toolchain from `../toolbox-desktop`; you only need that checkout to build the
installers.

## Tests

```bash
npm test           # build + node:test suite
npm run typecheck
```

Tests that touch settings use a temporary `TOOLBOX_MCP_HOME`, and panel tests
listen on a free loopback port. Keep it that way: never point a test at a real
Gmail account, a real remote server or the user's own settings folder.

The packaged acceptance probes are listed in the
[README](README.md#development). They need an install folder or an unpacked
build, not a source checkout.

## Pull requests

- Keep a change focused, and add or update the tests that prove it.
- For a panel change, include what the screen should look like (a screenshot
  or a short description) and check keyboard focus.
- Never commit credentials, `.accounts`, settings files, exported widget
  bundles or downloaded models.
- Update the README or the install guide when behaviour a user sees changes.

## Releases

Releases are maintainer-run: version bump, `npm run portable`, the packaged
probes, a GitHub release with both executables and `SHA256SUMS.txt`. The
commands are in the [README](README.md#release).
