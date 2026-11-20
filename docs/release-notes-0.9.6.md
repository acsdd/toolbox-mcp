# Model Farm 0.9.6

Same app as 0.9.5; this build carries the test-harness fix so the published
commit runs green end to end.

## What was wrong

The cancellation test sent its cancel request as soon as the download row
appeared, which can happen a moment before the transfer function is entered. On
a fast runner the abort then landed before the transfer existed: cancellation
was still correct (no bytes were written), but the assertion that the transfer
had been aborted could not hold.

The test now waits until the download has actually started before cancelling,
and asserts both that state and the abort. The shipped behaviour is unchanged
from 0.9.5.

## In this line

- 0.9.5: a second install of a model that is already downloading is refused
  (`"<repo>" is already downloading…`) instead of racing the same staging file.
- 0.9.4: remote marketplace modules connect only over public HTTPS — local
  network names refused, every DNS answer must be a public address, loopback,
  private, link-local, CGNAT, reserved, IPv4-mapped and NAT64 forms rejected.
  Downloads show rate and time left; failed or cancelled installs offer Retry.

## Verification

`npm test` — 275 tests, cancellation suite run five times locally without a
failure. Packaged smoke test: sandboxed window, 127.0.0.1-only panel, foreign
origin 403, 37 tools, listener closes with the window.
