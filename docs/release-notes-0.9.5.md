# Model Farm 0.9.5

## One download per model

Starting a second install of a model that is already downloading is now
refused with `"<repo>" is already downloading. Cancel it before starting
another install.` Before, both installs wrote the same staging file and only
the later transfer could be cancelled; the earlier one kept running unseen.

Cancelling the first download still works exactly as before, and the panel or
`llamafarm_cancel` can then start the install again.

## Still in this line

0.9.4 closed the remote-marketplace endpoint guard: remote modules connect only
over public HTTPS, local network names are refused, and every DNS answer must
be a public address (loopback, private, link-local, CGNAT, reserved ranges,
IPv4-mapped and NAT64 forms rejected). Both live registry endpoints
(`liquidvision.app`, `mcp.cve.now`) pass the policy; loopback, `localhost` and
plain-HTTP endpoints are refused.

## Verification

`npm test` — 275 tests. New: a duplicate install of a downloading repo is
refused while the first stays cancellable. Packaged smoke test: sandboxed
window, 127.0.0.1-only panel, foreign origin 403, 37 tools, listener closes with
the window.
