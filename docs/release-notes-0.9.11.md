# Model Farm 0.9.11

A small panel release that finishes what 0.9.10 started: the tool-group filter is now usable without seeing the colour highlight.

## What changed

- The chip row above the tool list is a labelled group, "Filter tools by group", so a screen reader announces what the buttons filter.
- Each chip carries `aria-pressed="true|false"` and updates it when picked. Selection was previously colour-only.
- Chip glyphs are decorative and hidden from the accessible name, so a chip reads as "Crypto watch · 4" instead of "diamond Crypto watch · 4".
- The "N of 37" match count is a polite live region, so filtering with the search box or a chip is announced.

## Verification

- `npm test`: 285/285 across 67 suites, typecheck clean (new panel test pins the group name, pressed state, hidden glyphs and live count).
- Accessibility tree of the running panel checked with Playwright: group named "Filter tools by group"; chips read "Crypto watch · 4", etc.; "all" starts pressed; picking "Model Farm · 14" flips the pressed state, shows "14 of 37" and renders 14 tools.
- Packaged probes on 0.9.11: smoke test green (sandboxed window, loopback-only panel, foreign origin 403, 37 tools); install probe passed against the portable payload and the extracted Setup payload (37 tools, matching panel catalogue, read-only call, MCP client journey); secondary-runtime probe detected 10 runtimes and passed switching, unknown-runtime refusal, removal guard and restore.
- Overview screenshot regenerated from the packaged build.

## Verify the download

```text
1e38fa893f71f47dd6dcc8a8198cd82a87c00309cf0824853f0a67bd58c1d07c  ModelFarm-Portable-0.9.11.exe  (113,139,964 bytes)
ac1fa5c9c95188c73e87846b2f8b83f37458a87490a93544c2513b75636512c7  ModelFarm-Setup-0.9.11.exe     (124,820,521 bytes)
```

Both binaries are unsigned, so Windows SmartScreen shows an "unverified publisher" warning on first start.
