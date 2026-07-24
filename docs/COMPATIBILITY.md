# SDK compatibility policy

This plugin pins `@paperclipai/plugin-sdk` and `@paperclipai/shared` via the
lockfile; CI verifies against those pins.

The **Nightly SDK compat** workflow additionally overlays the `latest` and
`canary` dist-tags (`npm install --no-save`) and re-runs the full verify gate
for each.

## What a red nightly means

- `latest` red: the newest released SDK breaks us — installed copies keep
  working, but fresh builds against the new SDK will not. Fix promptly, then
  bump the lockfile pins in the same PR.
- `canary` red: an unreleased SDK change will break us when it ships. File the
  fix (or an upstream issue) before it reaches `latest`.

Failures auto-file/refresh a `compat`-labeled issue per channel.

## Host-version compatibility

The manifest does not currently set `minimumHostVersion`. The driver depends
on host wiring introduced with plugin sandbox providers (capabilities endpoint
listing, `driver: "sandbox"` plugin routing). If installation on an older host
fails manifest validation, upgrade the host rather than downgrading the
plugin.
