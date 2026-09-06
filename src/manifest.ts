import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "aws-ssm-environment",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "AWS SSM Environment",
  description:
    "Run agents on a persistent EC2/hybrid instance over AWS Systems Manager (no inbound SSH). Resolves the target by EC2 tag and executes via SSM SendCommand.",
  author: "Tyler Walters",
  // "environment" exists as a category only on unreleased SDKs; the published
  // kubernetes provider uses "automation" as well.
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  environmentDrivers: [
    {
      driverKey: "aws-ssm",
      // sandbox_provider (not environment_driver) is deliberate: it is the only
      // kind with UI discovery and agent run-execution wiring in the host today.
      kind: "sandbox_provider",
      displayName: "AWS SSM (Session Manager)",
      description:
        "Targets an existing SSM-managed instance resolved by EC2 tag; executes commands via SSM SendCommand (AWS-RunShellScript). The instance is never created or destroyed by Paperclip.",
      supportsReusableLeases: true,
      configSchema: {
        type: "object",
        required: ["region", "tagKey", "tagValue", "remoteWorkspacePath"],
        properties: {
          region: {
            type: "string",
            title: "AWS region",
            description: "Region the target instance is registered in, e.g. us-east-1.",
          },
          awsProfile: {
            type: "string",
            title: "AWS profile",
            description:
              "Named profile from the Paperclip host's AWS credentials file. Leave empty to use the default credential chain.",
          },
          tagKey: {
            type: "string",
            title: "EC2 tag key",
            description: "Tag key used to resolve the target instance.",
          },
          tagValue: {
            type: "string",
            title: "EC2 tag value",
            description:
              "Tag value that must match exactly one online SSM-managed instance.",
          },
          remoteWorkspacePath: {
            type: "string",
            title: "Remote workspace path",
            description: "Directory on the instance where agent workspaces are created.",
          },
          outputS3Bucket: {
            type: "string",
            title: "S3 bucket for large command output",
            description:
              "Bucket name only (my-output-bucket) — not an s3:// URL and not a path. Captures full stdout/stderr via S3 for long-running commands, avoiding the 24KB SSM output limit. The instance role and the Paperclip host both need access.",
            "x-paperclip-advanced": true,
          },
          largeOutputTimeoutThresholdMs: {
            type: "number",
            title: "Large-output timeout threshold (ms)",
            description:
              "Commands with a timeout above this threshold use S3 output capture when a bucket is configured.",
            default: 300000,
            "x-paperclip-advanced": true,
          },
          reuseLease: {
            type: "boolean",
            title: "Reuse leases across runs",
            default: true,
            "x-paperclip-advanced": true,
          },
        },
        additionalProperties: true,
      },
    },
  ],
};

export default manifest;
