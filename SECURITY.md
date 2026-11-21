# Security

Toolbox MCP is local-first: the server speaks MCP over stdio, the panel binds
to `127.0.0.1`, and nothing is uploaded. The posture is described in the
[README](README.md#security). This file says how to report a problem in it.

## Supported versions

Security fixes go into the latest release. Use the newest
[release](https://github.com/acsdd/toolbox-mcp/releases); older builds are not
patched.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

<https://github.com/acsdd/toolbox-mcp/security/advisories/new>

Please do not open a public issue, and do not include credentials, Gmail App
Passwords, tokens or personal data in a report. A useful report names the
version and the artifact (Setup, Portable, or a source checkout), gives the
steps that reproduce the problem, and states what an attacker gains.

I will confirm the report, work on a fix and credit you in the release notes
unless you ask to stay anonymous. There is no bug bounty.

## What is in scope

- The ops panel's local request checks (foreign `Host` or `Origin`).
- The settings and credential handling, including the credential-store
  migration.
- Remote marketplace connections and the public-HTTPS / public-address guard.
- The packaged app and the MCP server's stdio surface.

## What is not a vulnerability

- The Windows builds are not code-signed, so SmartScreen shows an unverified
  publisher warning. This is a known trade-off, documented in the install
  guide.
- A local process running with your user rights can read your files, drive the
  terminal and reach the panel. The goal is to keep pages and the network out,
  not to defend against code you already run.
- Third-party runtimes, models and marketplace modules are separate projects.
  Report their problems to their maintainers.
