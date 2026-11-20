# Model Farm 0.9.10

Keyboard and screen-reader fixes for the ops panel's section navigation,
plus one layout fix for narrow windows.

## The rail is real navigation now

The sidebar was a row of buttons with no navigation landmark, no
current-page state, and icons plus ordering numbers ("01"–"06") that were
read as part of each name. The rail is now a labelled `<nav>`, the active
section carries `aria-current="page"`, and the glyphs and numbers are
`aria-hidden` — a screen reader now hears "Overview", "Model Farm",
"Terminal", not "▣ Overview 01".

Switching sections moves focus to the new section's heading, so the view
change is announced instead of leaving focus behind on the rail.

## Narrow windows keep all sections reachable

Below 860px the rail was hidden outright, which left Terminal,
Marketplace and Settings unreachable in a narrow browser window. It now
folds into a scrollable strip above the stage; the desktop rail is
unchanged (232px column, 48px rows).

## Links show where focus is

Links in the content (the repository link, setup guides, Homepage and
"get it") fell back to the browser's near-black default focus ring, which
is invisible on the dark panel. They now use the same accent ring as the
buttons, inputs and selects.

## Smaller follow-ups

- The NOW/TOTAL scenario buttons report their state with `aria-pressed`
  and keep it in sync when a saved preference is restored.
- The two search fields and the terminal input have explicit
  `aria-label`s instead of relying on placeholder text.

## Verification

- 284 MCP tests pass (two new accessibility assertions); typecheck clean.
- Checked in a running panel: the accessibility tree names the navigation
  and its buttons cleanly, `aria-current` follows the selection, focus
  lands on the "Model Farm" heading after a switch, and the Tab path shows
  an accent outline on the navigation buttons and on the repository link.
- At an 800px viewport the strip sits between the top bar and the stage
  with all five visible sections, 38px targets, no horizontal overflow,
  and the stage starts below it; at 1440px the rail and its 199×48px
  buttons are unchanged.
- Packaged 0.9.10: smoke test green (sandboxed window, loopback-only panel,
  37 tools); install probe on both the portable payload and the Setup
  artifact's extracted payload reports 37 tools, a matching panel catalogue,
  a successful read-only call and the client journey; the secondary-runtime
  probe detects 10 runtimes and passes switching, unknown-runtime refusal,
  the removal guard and restore.

No widget-core change ships in this release; it stays at 0.2.2.

## Verify the download

```text
344ce7ad6c6df7993673a878678e5063274ec8875139a78f9c4004357cd6fc75  ModelFarm-Portable-0.9.10.exe  (113,140,203 bytes)
f066eae85c4e9c324082beca28cddc3c17dbf2f17c7a878da55c83b8c4d7a92c  ModelFarm-Setup-0.9.10.exe     (124,820,657 bytes)
```

PowerShell: `Get-FileHash .\ModelFarm-Portable-0.9.10.exe -Algorithm SHA256`.
