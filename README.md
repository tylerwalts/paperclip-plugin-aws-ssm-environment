# paperclip-plugin-aws-ssm-environment

[![CI](https://github.com/tylerwalters-crx/paperclip-plugin-aws-ssm-environment/actions/workflows/ci.yml/badge.svg)](https://github.com/tylerwalters-crx/paperclip-plugin-aws-ssm-environment/actions/workflows/ci.yml)
[![Nightly SDK compat](https://github.com/tylerwalters-crx/paperclip-plugin-aws-ssm-environment/actions/workflows/nightly-compat.yml/badge.svg)](https://github.com/tylerwalters-crx/paperclip-plugin-aws-ssm-environment/actions/workflows/nightly-compat.yml)

Run Paperclip agents on a **persistent EC2 or hybrid instance over AWS Systems
Manager** — no inbound SSH, no open ports, no key management. The plugin
resolves your instance by EC2 tag and executes agent commands through SSM
SendCommand (`AWS-RunShellScript`).

Unlike sandbox providers that create and destroy machines, this driver targets
a long-lived host you own (for example, an AI bastion box inside a private
VPC). Paperclip never creates, stops, or terminates the instance.

## Where this works

- ✅ Self-hosted Paperclip instances (installed from a local path)
- ✅ EC2 instances and SSM hybrid activations (on-prem/other-cloud hosts)
- ✅ Remote-capable adapters: `claude_local`, `codex_local`, `gemini_local`, `opencode_local`, `pi_local`, `cursor`, `acpx_local`
- ❌ Cloud-managed Paperclip instances (external plugin installs are blocked by policy)
- ❌ Windows targets (commands run via `AWS-RunShellScript`/bash)

## Setup

### 1. Prepare the target instance

- The instance runs the SSM agent and is **Online** in Systems Manager.
- Its instance profile includes `AmazonSSMManagedInstanceCore`.
- It carries a tag that uniquely identifies it, e.g. `PaperclipAgent=ai-bastion`.
- The agent CLIs your adapters need (e.g. `claude`) are installed for the
  target user, and the workspace path (e.g. `/home/ubuntu/paperclip`) exists or
  is creatable.
- (Recommended) For full output on long commands, grant the instance role
  `s3:PutObject` on an output bucket — see *Large command output* below.

### 2. Prepare the Paperclip host

- AWS credentials for the daemon user (default chain or a named profile in
  `~/.aws/credentials`) with the permissions below.
- The [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
  (`session-manager-plugin`) on `PATH`.

Create an IAM policy for the Paperclip host credentials:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ssm:DescribeInstanceInformation",
        "ssm:SendCommand",
        "ssm:GetCommandInvocation",
        "ssm:StartSession",
        "ssm:TerminateSession"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::YOUR-OUTPUT-BUCKET/ssm-output/*"
    }
  ]
}
```

Replace `YOUR-OUTPUT-BUCKET` with the bucket name configured in
`outputS3Bucket`. If not using S3 output capture, omit the second statement.

### 3. Install the plugin

```bash
git clone https://github.com/tylerwalters-crx/paperclip-plugin-aws-ssm-environment
cd paperclip-plugin-aws-ssm-environment
npm install && npm run build
paperclipai plugin install "$PWD"
```

### 4. Create the environment

In **Company → Environments → New**, pick the **AWS SSM (Session Manager)**
provider and fill in the form:

| Field | Required | Meaning |
| --- | --- | --- |
| `region` | ✅ | Region the instance is registered in, e.g. `us-east-1` |
| `tagKey` / `tagValue` | ✅ | Tag that resolves to exactly one Online instance |
| `remoteWorkspacePath` | ✅ | Directory on the instance for agent workspaces |
| `awsProfile` | — | Named profile on the Paperclip host; empty = default chain |
| `outputS3Bucket` | — | Bucket for large-output capture (advanced) |
| `largeOutputTimeoutThresholdMs` | — | Commands with a longer timeout use S3 capture; default 300000 (advanced) |
| `reuseLease` | — | Reuse leases across runs; default true (advanced) |

Click **Test connection** — the probe verifies the Session Manager plugin,
resolves the instance by tag, and checks the workspace path end-to-end.

## Large command output

SSM's `GetCommandInvocation` truncates stdout/stderr at **24 KB**. When
`outputS3Bucket` is set, any command whose timeout exceeds
`largeOutputTimeoutThresholdMs` writes its full output to
`s3://<bucket>/ssm-output/…` and the plugin reads it back from S3. Without a
bucket, long agent runs risk truncated output. The instance role needs
`s3:PutObject` and the Paperclip host needs `s3:GetObject` on that prefix.

## Troubleshooting

- **"session-manager-plugin is not installed"** — install it on the *Paperclip
  host* (not the target) and ensure it's on the daemon's `PATH`.
- **"No online SSM-managed instance matches tag …"** — check the tag, the
  region, and that the instance shows *Online* under Fleet Manager.
- **"Multiple SSM-managed instances match tag …"** — narrow `tagValue` to a
  single host.
- **Credential errors from the worker** — plugin workers run with a stripped
  environment. Credentials resolve from the daemon user's home directory
  (`~/.aws`); `AWS_*` environment variables set for the server process are not
  visible to the worker. Prefer a named `awsProfile`.
- **Output cut off at 24 KB** — configure `outputS3Bucket`.

## Keeping up with Paperclip core

Paperclip's plugin SDK evolves quickly. A nightly workflow re-runs the full
verify gate against the `latest` and `canary` dist-tags of
`@paperclipai/plugin-sdk` and files a `compat`-labeled issue when either
breaks. Red nightly ≠ broken plugin: your installed copy keeps working against
the SDK version it was built with. See
[docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Development

```bash
npm install
npm run dev        # esbuild watch → dist/
npm test           # vitest (SDK environment harness + AWS client mocks)
npm run verify     # typecheck + test + build + manifest contract check
```

The driver declares `kind: "sandbox_provider"` deliberately — it is the only
plugin driver kind with UI discovery and agent run-execution wiring in the
host today. Design details and the original core-feature migration are
documented in [MIGRATION_PLAN.md](MIGRATION_PLAN.md).

## Contributing

Issues and PRs welcome.

## License

[MIT](LICENSE)
