# Changelog

## 0.1.0 (unreleased)

- Initial release: AWS SSM environment driver as a Paperclip plugin
  (`kind: "sandbox_provider"`, driverKey `aws-ssm`), ported from the
  `feature/aws-ssm-environment-driver` core fork.
- Tag-based instance resolution, SendCommand execution with env/cwd/stdin
  support, base64-chunked stdin upload, S3 large-output capture, reusable
  leases, end-to-end connection probe.
- Changes vs the core driver: S3 output bucket moves from a host env var into
  driver config (`outputS3Bucket`); the large-output heuristic is now a plain
  timeout threshold (`largeOutputTimeoutThresholdMs`) instead of sniffing for
  Claude CLI invocations; `awsProfile` is recorded in lease metadata (fixes a
  latent core bug where execute-time profile lookup always missed); lease
  resume is supported.
