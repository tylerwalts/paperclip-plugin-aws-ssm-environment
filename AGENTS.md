# Agent Instructions

## Commands

```bash
npm run verify          # typecheck + test + build + manifest contract check
npm test                # vitest run (uses SDK harness + AWS client mocks)
npm run dev             # esbuild watch for worker + manifest
```

## Architecture

- Paperclip plugin declaring `kind: "sandbox_provider"` (not `environment_driver`) — the only driver kind with UI discovery and run-execution wiring in the host
- Entry: `src/index.ts` re-exports `manifest` + `plugin` from `definePlugin()`
- Build: esbuild with SDK presets (`@paperclipai/plugin-sdk/bundlers`), outputs `dist/manifest.js` + `dist/worker.js`
- Worker banner injects `createRequire` for AWS SDK CJS internals (esbuild ESM output needs real `require` for node builtins)

## Verify workflow

`npm run verify` must pass before commits. It runs in order:
1. `tsc --noEmit`
2. `vitest run` (tests live in `src/__tests__/*.test.ts`)
3. `esbuild` bundles
4. `scripts/check-manifest-contract.mjs` loads `dist/manifest.js` and asserts contract (driverKey, kind, configSchema required fields, `additionalProperties: true` for host-injected keys)

## Testing

- Use `createEnvironmentTestHarness` from `@paperclipai/plugin-sdk` for plugin hook tests
- AWS SDK mocked via `aws-sdk-client-mock` — no real AWS calls in unit tests
- Test file pattern: `src/**/*.test.ts`

## Key constraints

- `configSchema.additionalProperties: true` required — host probes overlay `reuseLease`/`archiveOnRelease` keys
- `onEnvironmentReleaseLease`/`onEnvironmentDestroyLease` are no-ops — persistent EC2 host is never created/destroyed
- Credentials: worker runs with stripped env; profile-based AWS creds must resolve via `os.homedir()` fallback (see `ssm-client.ts` subprocess env handling)
