# Security

## Reporting

Report vulnerabilities via GitHub private security advisories on this
repository (or email the author). Please do not open public issues for
exploitable problems.

## Design notes

- **No secrets in config.** The driver config carries no credentials — AWS
  access resolves through the Paperclip host's default credential chain or a
  named profile in the daemon user's `~/.aws`. Prefer short-lived credentials
  (SSO/instance roles) over static keys.
- **Least privilege, host side:** `ssm:DescribeInstanceInformation`,
  `ssm:SendCommand` (scope to the target instance and the
  `AWS-RunShellScript` document), `ssm:GetCommandInvocation`,
  `ssm:StartSession`/`ssm:TerminateSession`, and `s3:GetObject` on the output
  bucket prefix.
- **Least privilege, instance side:** `AmazonSSMManagedInstanceCore` plus
  `s3:PutObject` on the output bucket prefix. Nothing else.
- **Blast radius:** the plugin executes arbitrary agent commands on the target
  instance by design. Treat the instance as agent-controlled: isolate it in
  its own VPC/security group, give its role only what agents need, and never
  share it with unrelated workloads.
- **No instance lifecycle:** release/destroy hooks are deliberate no-ops; the
  plugin can never stop or terminate the instance.
- **Temp files:** stdin and large-output staging files are written to `/tmp`
  on the target with unpredictable names and removed after each command.
