# Model Farm 0.9.21

Small visible fixes before the wider release: the section rail stays numbered
without a gap, and the project links look right when they are shared.

## Panel

- The rail numbers follow the sections that are actually on screen. The
  Gateway entry only exists while its widget is installed; when it is absent,
  Settings is numbered 05 instead of jumping from 04 to 06.
- The numbers update as soon as the widget list loads, and again whenever the
  installed widgets change.

## Landing page and README

- The landing page has a real icon, a canonical address and a social preview
  (Open Graph and Twitter cards) built around the panel screenshot, so shared
  links show the app rather than a bare title.
- The page title describes the project instead of repeating the account name.
- **Install guide** now opens the rendered document on GitHub instead of the
  raw Markdown served by Pages.
- The README shows the ops panel below the introduction.

## Verification

- 334 tests in 77 suites pass; TypeScript typecheck clean.
- Packaged probes on 0.9.21: smoke test green (sandboxed window, loopback-only
  panel, 37 tools, 4-row scorecard, rail numbered 01–05); install probe passed
  against the unpacked payload and the extracted Setup payload (37 tools,
  matching panel catalogue, read-only call, MCP client journey);
  secondary-runtime probe detected 10 runtimes and passed switching,
  unknown-runtime refusal, removal guard and restore.

## Artifacts

```
394b6f2c7c951f127b83b06e309c1b1ad055631093888f6f5a4d88975b44d69d  ModelFarm-Portable-0.9.21.exe  (113,142,991 bytes)
f0e156933c72a5979daab1db6f65bf8f096623fc1396580db9828fec33bc7ea6  ModelFarm-Setup-0.9.21.exe     (124,825,208 bytes)
```

Windows, x64, no administrator rights.
