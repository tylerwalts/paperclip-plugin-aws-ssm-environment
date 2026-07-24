# Migration Plan: AWS SSM Environment Driver → Paperclip Plugin

Re-implement the AWS SSM connection method (currently a core-feature fork on
`feature/aws-ssm-environment-driver`) as a standalone, out-of-tree Paperclip
plugin living in this repository. End state: the fork's SSM diff against
upstream shrinks to zero, and the SSM connection method installs onto any
self-hosted Paperclip instance with `paperclipai plugin install <this dir>`.

All `file:line` references below are into the Paperclip checkout at
`/Users/tylerwalters/code/claritas/paperclip` as of merge commit `548e2879`.

---

## 1. Key design decisions (researched, not assumptions)

### D1 — Declare the driver as `kind: "sandbox_provider"`, NOT `environment_driver`

This is counterintuitive (an SSM bastion is a persistent host, not a sandbox)
but it is the only fully-wired path today:

| Concern | `environment_driver` (core `driver:"plugin"`) | `sandbox_provider` (core `driver:"sandbox"`) |
|---|---|---|
| Probe / lease / validate RPCs | ✅ wired | ✅ wired |
| **Agent run execution** | ❌ `resolveEnvironmentExecutionTarget` has no `plugin` branch (returns null → agent silently runs locally); `supportedEnvironmentDriversForAdapter` only allows `local/ssh/ssm/sandbox` (`packages/shared/src/environment-support.ts:53-57`); `drivers.plugin` hardcoded `"unsupported"` (`environment-support.ts:163`) | ✅ execution target routes through `environmentRuntime.execute` → plugin worker (`server/src/services/environment-execution-target.ts:86-112`) |
| UI discovery + config form | ❌ capabilities endpoint filters `kind === "sandbox_provider"` (`server/src/services/plugin-environment-driver.ts:98`); no `driver:"plugin"` branch in `CompanyEnvironments.tsx` | ✅ auto-listed via `GET /companies/:id/environments/capabilities`; JSON-Schema-driven form |
| First-party precedent | none in repo | all shipping driver plugins (kubernetes, daytona, novita, e2b, modal, …) |

"Sandbox" does not force ephemerality: the declaration supports
`supportsReusableLeases: true` (`packages/shared/src/types/plugin.ts:148-153`),
and the provider decides what acquire/release mean. Our acquire = "resolve the
existing EC2 instance by tag and verify the workspace"; release/destroy =
lease bookkeeping only — **never touches the instance**.

> If upstream later finishes `environment_driver` run-execution wiring, the
> hooks are identical — switching is a one-line `kind` change in the manifest.

### D2 — Ship as an external plugin with a compiled `dist/`

- Self-hosted instances can install from an arbitrary local path
  (`POST /plugins/install` with `isLocalPath: true`); commit `0ef3b320` only
  adds path canonicalization for self-hosted — the bundled-catalog floor
  applies exclusively to cloud-managed hosts (`PAPERCLIP_MANAGED_CONFIG` set).
- External plugins get **no auto-build** and **no tsx loader** — the worker is
  `child_process.fork(dist/worker.js)`. We must build with esbuild
  (`@paperclipai/plugin-sdk/bundlers` presets) and point the package.json
  `paperclipPlugin` key at `dist/manifest.js` + `dist/worker.js`.
- SDK dependency: depend on the **published** `@paperclipai/plugin-sdk` +
  `@paperclipai/shared` from npm (calver, e.g. `^2026.x`), pinned by lockfile —
  the convention proven by `fischk/paperclip-plugin-slack-bridge`. Our plugin
  uses only upstream SDK surface (no fork-specific SDK changes), so nothing
  forces a local snapshot. Fallback if we ever need unreleased SDK bits: the
  scaffolder's `file:` tarball mechanism
  (`packages/plugins/create-paperclip-plugin/src/index.ts:150-195`).

### D3 — AWS credentials must survive the stripped worker env ⚠️ (top risk)

The worker is forked with a minimal env (`server/src/services/plugin-worker-manager.ts:717-739`):
only `PATH`, `NODE_PATH`, `PAPERCLIP_PLUGIN_ID`, `NODE_ENV`, `TZ`, plus
model-API keys granted to `environment.drivers.register` plugins
(`server/src/services/plugin-loader.ts:97-103`). **No `HOME`, no `AWS_*`.**

Implications:
- `@aws-sdk/credential-provider-ini` resolves the home dir via
  `HOME → USERPROFILE → os.homedir()`; `os.homedir()` falls back to the passwd
  entry on POSIX, so profile-based creds *should* still resolve — but this is
  the #1 thing to verify in Phase 4 before trusting anything else.
- The `aws` CLI / `session-manager-plugin` subprocesses (used by
  `startSsmSession`) also need `HOME`; when the plugin spawns them it must pass
  `env: { ...process.env, HOME: os.homedir() }` explicitly.
- Escape hatches, in order of preference: (1) set `HOME`/`AWS_*` explicitly in
  spawned-subprocess env from `os.homedir()`; (2) add optional
  `accessKeyId`/`secretAccessKey` config fields with `format: "secret-ref"`
  (UI stores them as company secrets — precedent: kubernetes manifest
  `packages/plugins/sandbox-providers/kubernetes/src/manifest.ts:37`);
  (3) tiny upstream PR extending `buildPluginWorkerEnv` to pass `AWS_*`
  through for driver plugins (same pattern as the existing K8s passthrough at
  `plugin-loader.ts:114-118`).

### D4 — Config moves fully into the driver `configSchema`

Two things that currently leak host state into the driver get fixed in the port:
- `PAPERCLIP_SSM_OUTPUT_BUCKET` / `CONFIG_BUCKET_NAME` env lookups
  (`server/src/services/environment-runtime.ts:745`) become an
  `outputS3Bucket` config field.
- The Claude-specific large-output heuristic
  (`timeout>300s && /claude/ && /output-format/`,
  `environment-runtime.ts:741-744`) is replaced by an honest rule: use S3
  large-output capture whenever `outputS3Bucket` is set and
  `timeoutMs > largeOutputTimeoutThresholdMs` (config, default 300 000) —
  the 24 KB `GetCommandInvocation` truncation risk is a function of the
  command's runtime, not of which CLI is being run.

---

## 2. Target package layout (this repository)

Layout follows the ecosystem conventions established by
`fischk/paperclip-plugin-slack-bridge` (see §9):

```
paperclip-plugin-aws-ssm-environment/
├── package.json               name: paperclip-plugin-aws-ssm-environment
│                              type: module; paperclipPlugin: { manifest: ./dist/manifest.js,
│                              worker: ./dist/worker.js }; files: ["dist/"];
│                              deps: @aws-sdk/client-ssm, @aws-sdk/client-s3,
│                              @aws-sdk/credential-provider-ini;
│                              devDeps: @paperclipai/plugin-sdk + @paperclipai/shared (npm, calver),
│                              typescript, esbuild, vitest, aws-sdk-client-mock;
│                              scripts.verify = typecheck && test && build && manifest contract check
├── esbuild.config.mjs         from @paperclipai/plugin-sdk/bundlers presets
├── tsconfig.json
├── vitest.config.ts
├── .github/
│   ├── actions/verify/action.yml   shared verify gate: npm ci → optional SDK dist-tag
│   │                               overlay → npm run verify → npm pack dry-run asserting
│   │                               dist/manifest.js + dist/worker.js are in the tarball
│   └── workflows/
│       ├── ci.yml                  verify on PR + push to main
│       └── nightly-compat.yml      verify matrix vs @paperclipai/*@{latest,canary};
│                                   auto-files/updates a `compat` issue on failure
├── scripts/
│   └── check-manifest-contract.mjs loads dist/manifest.js, asserts id/capabilities/
│                                   environmentDrivers shape + kind + configSchema present
├── src/
│   ├── index.ts               barrel: export { default as manifest } / { default as plugin }
│   ├── manifest.ts            PaperclipPluginManifestV1 (see §3)
│   ├── plugin.ts              definePlugin({ ...hooks })   (see §4)
│   ├── worker.ts              runWorker(plugin, import.meta.url)
│   ├── ssm-client.ts          port of server/src/services/aws-ssm.ts (verbatim + env fix from D3)
│   ├── config.ts              zod schema mirroring configSchema; parse/normalize helpers
│   ├── shell.ts               port of shellQuoteForSsm (environment-runtime.ts:1580)
│   └── __tests__/
│       ├── ssm-client.test.ts     port of server/src/__tests__/aws-ssm.test.ts (aws-sdk-client-mock)
│       └── plugin.test.ts         SDK test harness (createEnvironmentTestHarness)
├── docs/                      COMPATIBILITY.md (nightly-red semantics), decisions/
├── CHANGELOG.md
├── SECURITY.md                IAM-least-privilege notes; how to report issues
├── LICENSE                    MIT
├── MIGRATION_PLAN.md          this file
└── README.md                  operator setup (rewrite of SSM_AGENT_SETUP.md — see §7 note on staleness)
```

## 3. Manifest (`src/manifest.ts`)

```ts
const manifest: PaperclipPluginManifestV1 = {
  id: "aws-ssm-environment",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "AWS SSM Environment",
  description: "Run agents on a persistent EC2/hybrid instance over AWS Systems Manager (no inbound SSH).",
  author: "Tyler Walters",
  categories: ["environments"],          // verify against PluginCategory enum
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "./dist/worker.js" },
  environmentDrivers: [
    {
      driverKey: "aws-ssm",              // becomes the sandbox provider key in the UI
      kind: "sandbox_provider",          // decision D1
      displayName: "AWS SSM (Session Manager)",
      description: "Targets an existing instance resolved by EC2 tag; executes via SSM SendCommand.",
      supportsReusableLeases: true,      // persistent host — leases are re-attachable
      configSchema: {
        type: "object",
        required: ["region", "tagKey", "tagValue", "remoteWorkspacePath"],
        properties: {
          region:               { type: "string", title: "AWS region" },
          awsProfile:           { type: "string", title: "AWS profile" },
          tagKey:               { type: "string", title: "EC2 tag key" },
          tagValue:             { type: "string", title: "EC2 tag value" },
          remoteWorkspacePath:  { type: "string", title: "Remote workspace path" },
          outputS3Bucket:       { type: "string", title: "S3 bucket for large command output",
                                  "x-paperclip-advanced": true },
          largeOutputTimeoutThresholdMs: { type: "number", default: 300000,
                                  "x-paperclip-advanced": true },
          reuseLease:           { type: "boolean", default: true,
                                  "x-paperclip-advanced": true },
        },
        additionalProperties: true,      // host probes inject reuseLease/archiveOnRelease
      },
    },
  ],
};
```

Interactive-setup / template-capture flags are **omitted** (a persistent
bastion has no snapshot semantics). `additionalProperties: true` matters:
saved-environment probes overlay `{ reuseLease: false, archiveOnRelease: true }`
onto the config (`server/src/services/environment-probe.ts:65-77`), and
validation must tolerate those keys.

## 4. Hook implementation map (`src/plugin.ts`)

Source of truth to port from: `createSsmEnvironmentDriver`
(`server/src/services/environment-runtime.ts:631-769`), the probe branch
(`server/src/services/environment-probe.ts`, restored on the fork 2026-07-23),
and `server/src/services/aws-ssm.ts`.

| Hook | Ported behavior | Notes / deltas |
|---|---|---|
| `onEnvironmentValidateConfig` | zod-parse config (`src/config.ts`) | replaces `ssmEnvironmentConfigSchema` (`environment-config.ts:71`) |
| `onEnvironmentProbe` | `assertSsmCliAvailable()` → `resolveSsmInstanceByTag` → `runSsmCommand("mkdir -p … && pwd", 15s)` → ok/summary/details | verbatim port of the core probe branch, incl. timeout / non-zero-exit / catch shapes |
| `onEnvironmentAcquireLease` | resolve tag → verify/mkdir workspace → return `{ providerLeaseId: "ssm://<region>/<instanceId><remoteCwd>", metadata: { region, instanceId, awsProfile, tagKey, tagValue, remoteWorkspacePath, remoteCwd } }` | Host now owns DB lease bookkeeping (`environmentsSvc.acquireLease` is called by the bridge, `environment-runtime.ts:1635-1890`) — the plugin only returns the lease descriptor. **Add `awsProfile` to metadata** (the core driver reads it from lease metadata at execute-time but never wrote it — a latent core bug the port fixes). |
| `onEnvironmentResumeLease` | re-resolve tag; if same instanceId, return same metadata; else fail with a clear message | new capability (core driver had `leasePolicy: "ephemeral"` only); backs `supportsReusableLeases` |
| `onEnvironmentReleaseLease` | no-op success | never terminates the instance |
| `onEnvironmentDestroyLease` | no-op success | ditto — destroy applies to sandboxes, not a bastion |
| `onEnvironmentRealizeWorkspace` | return `{ cwd: metadata.remoteCwd ?? remoteWorkspacePath, metadata: {} }` | host builds the realization record itself (`buildWorkspaceRealizationRecordFromDriverInput` stays host-side) |
| `onEnvironmentExecute` | shell-assembly port: cwd + `export K=V;` env prefix + `bash -c` unwrapping + `shellQuoteForSsm`; then `runSsmCommand` with stdin, timeout; map to `{ exitCode, signal: null, timedOut, stdout, stderr }` | large-output rule per D4; drop the `[ssm-exec]` console.error debug line or downgrade to a structured log |
| `onEnvironmentSyncIn` / `onEnvironmentSyncOut` | **omit in v1** | core driver had none; host falls back to the byte-identical base64 path (`environment-execution-target.ts:113-134`). v2 candidate: S3-mediated sync. |
| interactive-setup / template hooks | omit | see §3 |

`src/ssm-client.ts` ports `aws-ssm.ts` (resolveSsmInstanceByTag,
startSsmSession, runSsmCommand, runSsmCommandLargeOutput,
runSsmCommandWithStdin, assertSsmCliAvailable) with one change: every
`spawn`/`exec` of `aws` / `session-manager-plugin` passes
`env: { ...process.env, HOME: process.env.HOME ?? os.homedir() }` (D3).

## 5. Phases

### Phase 0 — Scaffold (½ day)
1. Run the official scaffolder targeting this directory:
   `node <paperclip>/packages/plugins/create-paperclip-plugin/... --template environment`
   (or `pnpm dlx @paperclipai/create-paperclip-plugin` once published).
2. Swap the scaffolder's `file:` SDK tarballs for the published
   `@paperclipai/plugin-sdk` + `@paperclipai/shared` devDependencies (D2).
3. Fix known scaffold gaps: the environment template omits `kind` and the
   required `configSchema` on the driver declaration
   (`create-paperclip-plugin/src/index.ts:326-331`) — apply §3 manifest.
4. Adopt the ecosystem repo conventions (§9): MIT LICENSE, README skeleton,
   `verify` script, `.github/actions/verify` + `ci.yml` + `nightly-compat.yml`,
   CHANGELOG.md, SECURITY.md.
5. `npm install && npm run verify` → `dist/manifest.js` + `dist/worker.js`
   exist and `node dist/worker.js` starts and exits cleanly on stdin close.

### Phase 1 — Port the code (1–2 days)
1. `ssm-client.ts`, `shell.ts`, `config.ts`, `plugin.ts` per §4.
2. Port `aws-ssm.test.ts` (17 tests) onto `ssm-client.ts`.
3. Write `plugin.test.ts` with `createEnvironmentTestHarness`
   (`packages/plugins/sdk/src/testing.ts:2637`): mock `ssm-client` module,
   assert `assertLeaseLifecycle` / `assertExecutionLifecycle`, probe
   failure shapes, config validation (including tolerance of injected
   `reuseLease`/`archiveOnRelease` keys), and that execute env-prefix
   quoting matches the core driver byte-for-byte for a table of tricky
   inputs (spaces, quotes, `$`, newlines).

### Phase 2 — Install & probe on the real instance (½–1 day)
1. On the self-hosted Paperclip host:
   `paperclipai plugin install /Users/tylerwalters/code/claritas/paperclip-plugin-aws-ssm-environment`.
2. Confirm the driver appears under sandbox providers in
   `GET /companies/:id/environments/capabilities` and in the New Environment
   UI with the schema-generated form.
3. Create a new environment (driver "sandbox", provider `aws-ssm`) pointing at
   the AI bastion tag, and run **Test connection**.
4. **Gate: verify D3 here** — if the probe fails on credentials, apply the D3
   escape hatches before proceeding.

### Phase 3 — End-to-end agent run (1 day)
1. Run a real issue/agent (claude_local adapter) on the plugin environment;
   compare against a run on the core `ssm` driver environment: exit codes,
   full stdout capture on a >24 KB output command (exercises S3 large-output),
   stdin-heavy command (exercises base64 chunking), workspace cwd, lease
   metadata in the UI.
2. Verify lease reuse across two consecutive runs (`supportsReusableLeases`).
3. Worker kill/restart mid-run: confirm host error surfaces cleanly and a
   retry works.

### Phase 4 — Decommission the core driver from the fork (½ day + PR churn)
Once Phase 3 shows parity, the fork branch deletes its SSM diff — this is the
payoff. Files that revert to pure upstream:
- `server/src/services/aws-ssm.ts` (delete)
- `server/src/__tests__/aws-ssm.test.ts` (delete)
- `server/src/services/environment-runtime.ts` (drop `createSsmEnvironmentDriver`, `shellQuoteForSsm`, registration)
- `server/src/services/environment-probe.ts` (drop the `ssm` branch restored 2026-07-23)
- `server/src/services/environment-execution-target.ts` (drop `ssm` branch, lines 140–259)
- `server/src/services/environment-config.ts` (drop `ssm` schemas/branches)
- `packages/shared/src/constants.ts` (`ENVIRONMENT_DRIVERS` loses `"ssm"`), `environment-support.ts`, `types/environment.ts` (`SsmEnvironmentConfig`), `index.ts` exports
- `ui/src/api/environments.ts`, `ui/src/pages/CompanyEnvironments.tsx` (drop `ssm` union members + hardcoded form)
- `server/package.json` (drop `@aws-sdk/client-ssm`, `@aws-sdk/credential-provider-ini`, `aws-sdk-client-mock`; keep `@aws-sdk/client-s3` — upstream uses it independently)
- `SSM_AGENT_SETUP.md` (moves here as README.md, rewritten — see §7)

Migration of the existing environment record: create the new plugin-backed
environment alongside the old one, repoint agents, then delete the old
`driver:"ssm"` environment **before** deploying the de-SSM'd branch (a stale
`driver:"ssm"` row would fail config parsing on a build without the driver).

Tag the last validated core-SSM commit with a `TylerTest*` tag before the
removal commit (fork convention: those tags mark hand-validated states and
must be preserved).

### Phase 5 — Optional upstream contributions
- `AWS_*`/`HOME` env passthrough for `environment.drivers.register` workers
  (mirrors the K8s passthrough, `plugin-loader.ts:114-118`).
- Fix the scaffolder's environment template (missing `kind`/`configSchema`).
- If upstream ever wires `environment_driver` run execution, flip `kind`.

## 6. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| AWS creds unresolvable in stripped worker env (D3) | High | Phase 2 gate; three escape hatches listed in D3 |
| SDK drift as upstream evolves | Medium | lockfile-pinned published SDK + nightly compat workflow vs `latest`/`canary` dist-tags that auto-files a `compat` issue on breakage (§9) |
| "Sandbox" semantics invoked destructively (host calls destroy) | Medium | release/destroy are hard no-ops; unit test asserts no SSM API call is made |
| Probe-injected config keys rejected by validation | Low | `additionalProperties: true` + explicit test |
| 24 KB output truncation regression if `outputS3Bucket` unset | Low | README documents it; execute() appends a stderr warning when output is exactly at the truncation boundary and no bucket is configured |
| Managed-cloud install blocked | N/A | target instance is self-hosted; documented constraint |

## 7. Documentation note

`SSM_AGENT_SETUP.md` in the fork describes the **older SSH-tunnel design**
(ProxyCommand / `AWS-StartSSHSession`, privateKey/username/port) which the
shipped driver does not use. The README written here in Phase 1 documents the
actual SendCommand/RunShellScript architecture: instance IAM role
(`AmazonSSMManagedInstanceCore` + S3 access for the output bucket), host-side
requirements (`aws` CLI, `session-manager-plugin`, credentials/profile for the
daemon user), tag-based instance resolution, and the large-output S3 flow.

## 8. Effort summary

~4–6 working days end-to-end. Phase 0+1 are pure local work; Phase 2's
credential gate is the only step with real unknown risk; Phases 3–4 are
mostly validation and deletion.

## 9. Ecosystem conventions to adopt (surveyed 2026-07-23)

A survey of the community plugin ecosystem (GitHub + the `gsxdsm/awesome-paperclip`
curated list, 819★) found **no existing environment/sandbox-provider plugin** —
every community plugin is a chat/integration/UI plugin (slack, telegram,
discord, github-issues, linear, acp, chat copilot, …). This plugin would be
the first community environment connection type. Once working, submit it to
`awesome-paperclip` (inclusion is just a PR adding a link).

Style/quality template: **`fischk/paperclip-plugin-slack-bridge`** (different
plugin type, but the best-engineered repo surveyed). Conventions to copy:

- **License:** MIT.
- **README structure:** badges (CI, Nightly SDK compat, npm) → tagline →
  "Where this works" support matrix (✅/❌ — for us: self-hosted ✅,
  cloud-managed ❌ per the install floor) → numbered setup steps → config
  reference table (our configSchema fields) → troubleshooting → "Keeping up
  with Paperclip core" (nightly-compat semantics) → development section →
  documentation map → contributing/license. Practical, no marketing.
- **Single verify gate:** `scripts.verify = typecheck && test && build && node
  scripts/check-manifest-contract.mjs`, with `prepublishOnly: npm run verify`.
  CI and nightly both call one shared composite action
  (`.github/actions/verify`) so build/test steps are defined exactly once.
- **Packaging dry-run gate:** the verify action runs `npm pack --dry-run` and
  fails unless `dist/manifest.js` and `dist/worker.js` are in the tarball —
  this directly guards the `paperclipPlugin` entrypoint contract the host
  loader depends on.
- **Nightly SDK compat workflow:** cron matrix over `@paperclipai/*@latest`
  and `@canary` overlaid via `npm install --no-save`, read-only token while
  executing unpinned upstream code, and a separate `issues: write` job that
  files/updates a `compat`-labeled issue per failed channel. Semantics
  documented in `docs/COMPATIBILITY.md`. For us this is the early-warning
  system for the exact class of breakage that motivated this migration
  (upstream restructuring interfaces under the fork).
- **Housekeeping:** CHANGELOG.md, SECURITY.md (ours: IAM least-privilege for
  the instance role + bucket, no long-lived keys in config, secret-ref for any
  credential fields), `docs/` with decision records, canary dist-tag for
  pre-releases if we publish to npm.
