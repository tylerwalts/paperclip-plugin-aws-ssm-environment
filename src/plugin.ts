import { definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginEnvironmentValidateConfigParams,
  PluginEnvironmentProbeParams,
  PluginEnvironmentAcquireLeaseParams,
  PluginEnvironmentResumeLeaseParams,
  PluginEnvironmentReleaseLeaseParams,
  PluginEnvironmentDestroyLeaseParams,
  PluginEnvironmentRealizeWorkspaceParams,
  PluginEnvironmentExecuteParams,
} from "@paperclipai/plugin-sdk";
import { parseSsmDriverConfig, requireSsmDriverConfig, type SsmDriverConfig } from "./config.js";
import { shellQuoteForSsm } from "./shell.js";
import {
  assertSsmCliAvailable,
  resolveSsmInstanceByTag,
  runSsmCommand,
} from "./ssm-client.js";

function leaseString(metadata: Record<string, unknown> | undefined, key: string): string | null {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function resolveInstanceAndWorkspace(config: SsmDriverConfig): Promise<{
  instanceId: string;
  platformType: string | null;
  remoteCwd: string;
}> {
  await assertSsmCliAvailable();

  const resolved = await resolveSsmInstanceByTag({
    region: config.region,
    awsProfile: config.awsProfile,
    tagKey: config.tagKey,
    tagValue: config.tagValue,
  });

  const remoteWorkspacePath = config.remoteWorkspacePath;
  const result = await runSsmCommand({
    region: config.region,
    awsProfile: config.awsProfile,
    instanceId: resolved.instanceId,
    command: `mkdir -p ${remoteWorkspacePath} && cd ${remoteWorkspacePath} && pwd`,
    timeoutMs: 15_000,
  });

  if (result.timedOut) {
    throw new Error(`SSM session timed out verifying workspace on ${resolved.instanceId}.`);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `Could not verify workspace path ${remoteWorkspacePath} on ${resolved.instanceId}${detail ? `: ${detail}` : "."}`,
    );
  }

  return {
    instanceId: resolved.instanceId,
    platformType: resolved.platformType,
    remoteCwd: result.stdout.trim() || remoteWorkspacePath,
  };
}

const plugin = definePlugin({
  async setup() {},

  async onHealth() {
    return { status: "ok", message: "AWS SSM environment plugin worker is running" };
  },

  async onEnvironmentValidateConfig(params: PluginEnvironmentValidateConfigParams) {
    const parsed = parseSsmDriverConfig(params.config);
    if (!parsed.ok || !parsed.config) {
      return { ok: false, errors: parsed.errors ?? ["Invalid AWS SSM driver config."] };
    }
    return { ok: true, normalizedConfig: parsed.config as unknown as Record<string, unknown> };
  },

  async onEnvironmentProbe(params: PluginEnvironmentProbeParams) {
    const config = requireSsmDriverConfig(params.config);
    try {
      const resolved = await resolveInstanceAndWorkspace(config);
      return {
        ok: true,
        summary: `Connected via SSM to ${resolved.instanceId} (tag ${config.tagKey}=${config.tagValue}) and verified the remote workspace path.`,
        metadata: {
          region: config.region,
          instanceId: resolved.instanceId,
          tagKey: config.tagKey,
          tagValue: config.tagValue,
          remoteWorkspacePath: config.remoteWorkspacePath,
          remoteCwd: resolved.remoteCwd,
          platformType: resolved.platformType,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        summary: `SSM probe failed for tag ${config.tagKey}=${config.tagValue} in ${config.region}: ${message}`,
        diagnostics: [{ severity: "error" as const, message }],
        metadata: {
          region: config.region,
          tagKey: config.tagKey,
          tagValue: config.tagValue,
          remoteWorkspacePath: config.remoteWorkspacePath,
        },
      };
    }
  },

  async onEnvironmentAcquireLease(params: PluginEnvironmentAcquireLeaseParams) {
    const config = requireSsmDriverConfig(params.config);
    const resolved = await resolveInstanceAndWorkspace(config);

    return {
      providerLeaseId: `ssm://${config.region}/${resolved.instanceId}${resolved.remoteCwd}`,
      metadata: {
        region: config.region,
        awsProfile: config.awsProfile,
        instanceId: resolved.instanceId,
        tagKey: config.tagKey,
        tagValue: config.tagValue,
        remoteWorkspacePath: config.remoteWorkspacePath,
        remoteCwd: resolved.remoteCwd,
        platformType: resolved.platformType,
      },
    };
  },

  async onEnvironmentResumeLease(params: PluginEnvironmentResumeLeaseParams) {
    const config = requireSsmDriverConfig(params.config);
    const previousInstanceId = leaseString(params.leaseMetadata, "instanceId");
    const resolved = await resolveInstanceAndWorkspace(config);

    if (previousInstanceId && previousInstanceId !== resolved.instanceId) {
      throw new Error(
        `SSM lease cannot be resumed: tag ${config.tagKey}=${config.tagValue} now resolves to ${resolved.instanceId}, but the lease was acquired on ${previousInstanceId}.`,
      );
    }

    return {
      providerLeaseId: params.providerLeaseId,
      metadata: {
        ...(params.leaseMetadata ?? {}),
        region: config.region,
        awsProfile: config.awsProfile,
        instanceId: resolved.instanceId,
        remoteCwd: resolved.remoteCwd,
        resumedAt: new Date().toISOString(),
      },
    };
  },

  // The target is a persistent host that Paperclip does not own: releasing or
  // destroying a lease must never touch the instance itself.
  async onEnvironmentReleaseLease(_params: PluginEnvironmentReleaseLeaseParams) {},

  async onEnvironmentDestroyLease(_params: PluginEnvironmentDestroyLeaseParams) {},

  async onEnvironmentRealizeWorkspace(params: PluginEnvironmentRealizeWorkspaceParams) {
    const config = requireSsmDriverConfig(params.config);
    const cwd =
      leaseString(params.lease.metadata, "remoteCwd") ??
      params.workspace.remotePath ??
      config.remoteWorkspacePath;
    return { cwd, metadata: {} };
  },

  async onEnvironmentExecute(params: PluginEnvironmentExecuteParams) {
    const config = requireSsmDriverConfig(params.config);
    const instanceId = leaseString(params.lease.metadata, "instanceId");
    if (!instanceId) {
      throw new Error("SSM lease metadata missing instanceId for command execution.");
    }
    const region = leaseString(params.lease.metadata, "region") ?? config.region;
    const awsProfile = leaseString(params.lease.metadata, "awsProfile") ?? config.awsProfile;

    const cwd = params.cwd ?? leaseString(params.lease.metadata, "remoteCwd") ?? "/tmp";
    const envPrefix = params.env
      ? Object.entries(params.env)
          .map(([k, v]) => `export ${k}=${shellQuoteForSsm(v)};`)
          .join(" ")
      : "";
    const cmd = params.command;
    const args = params.args ?? [];
    let scriptBody: string;
    if ((cmd === "bash" || cmd === "sh") && args[0] === "-c" && args.length >= 2) {
      scriptBody = args.slice(1).join(" ");
    } else {
      const argsStr = args.length
        ? " " + args.map((a) => shellQuoteForSsm(a)).join(" ")
        : "";
      scriptBody = `${cmd}${argsStr}`;
    }
    const fullCommand = `cd ${shellQuoteForSsm(cwd)} && ${envPrefix}${scriptBody}`;

    // GetCommandInvocation truncates stdout/stderr at 24KB. Long-running
    // commands are the ones that produce large output, so when a bucket is
    // configured, capture output via S3 above the configured timeout threshold.
    const timeoutMs = params.timeoutMs ?? 60_000;
    const useLargeOutput =
      config.outputS3Bucket !== null && timeoutMs > config.largeOutputTimeoutThresholdMs;

    const result = await runSsmCommand({
      region,
      awsProfile,
      instanceId,
      command: fullCommand,
      stdin: params.stdin,
      largeOutput: useLargeOutput,
      outputS3Bucket: useLargeOutput ? config.outputS3Bucket ?? undefined : undefined,
      timeoutMs,
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? (result.timedOut ? null : 1),
      signal: null,
      timedOut: result.timedOut,
    };
  },
});

export default plugin;
