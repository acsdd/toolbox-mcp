# Model Farm 0.9.12

The tool surface on the Overview can now be reset in one click, and the last unnamed panel fields carry names.

## What changed

- **Clear** replaces the Filter button beside the tool search. It empties the search text, drops the group chip back to "all", re-renders the list and puts focus back in the search field, so the whole surface is one keystroke away. The "N of 37" live count follows. The old button only re-applied the text already typed, so a picked group could not be undone from the toolbar.
- The Marketplace module search is named "Search modules" for assistive tech.
- The Settings fields for the watchlist and the disk path are named "Crypto watchlist coin ids" and "Disk path for the resource monitor".

## Verification

- `npm test`: 287/287 across 67 suites, typecheck clean. New tests drive the Clear control in the real panel script and pin the three field names.
- Accessibility tree of the running panel checked with Playwright: searching "gmail" showed "4 of 37", Clear returned "37 of 37" with the search box empty, "all" pressed and focus in the search field; Settings announced the two textbox names; Marketplace announced "Search modules".
- Packaged probes on 0.9.12: smoke test green (sandboxed window, loopback-only panel, 37 tools); install probe passed against the portable payload and the extracted Setup payload (37 tools, matching panel catalogue, read-only call, MCP client journey); secondary-runtime probe detected 10 runtimes and passed switching, unknown-runtime refusal, removal guard and restore.

## Verify the download

```text
aa485078aa22609a13016b3cdb10cf50a528abe4d7f62bead34e04369787c6c9  ModelFarm-Portable-0.9.12.exe  (113,139,971 bytes)
5f007e9e74233a3a33fb88ab7f1803b2a0fdba1d985b9a177f2206ddb5be581c  ModelFarm-Setup-0.9.12.exe     (124,820,807 bytes)
```

Both binaries are unsigned, so Windows SmartScreen shows an "unverified publisher" warning on first start.
