import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEnvironmentTestHarness,
  assertEnvironmentEventOrder,
  assertLeaseLifecycle,
  assertExecutionLifecycle,
} from "@paperclipai/plugin-sdk";
import manifest from "../manifest.js";
import plugin from "../plugin.js";
import {
  assertSsmCliAvailable,
  resolveSsmInstanceByTag,
  runSsmCommand,
} from "../ssm-client.js";

vi.mock("../ssm-client.js", () => ({
  assertSsmCliAvailable: vi.fn().mockResolvedValue(undefined),
  resolveSsmInstanceByTag: vi.fn(),
  runSsmCommand: vi.fn(),
}));

const mockedResolve = vi.mocked(resolveSsmInstanceByTag);
const mockedRun = vi.mocked(runSsmCommand);
const mockedCliCheck = vi.mocked(assertSsmCliAvailable);

const definition = plugin.definition;
const driverKey = manifest.environmentDrivers![0].driverKey;

const ENV_ID = "env-1";
const BASE_CONFIG = {
  region: "us-east-1",
  awsProfile: "bastion",
  tagKey: "PaperclipAgent",
  tagValue: "ai-bastion",
  remoteWorkspacePath: "/home/ubuntu/paperclip",
};

function baseParams(config: Record<string, unknown> = BASE_CONFIG) {
  return {
    driverKey,
    companyId: "company-1",
    environmentId: ENV_ID,
    config,
  };
}

function makeHarness() {
  return createEnvironmentTestHarness({
    manifest,
    environmentDriver: {
      driverKey,
      onValidateConfig: definition.onEnvironmentValidateConfig,
      onProbe: definition.onEnvironmentProbe,
      onAcquireLease: definition.onEnvironmentAcquireLease,
      onResumeLease: definition.onEnvironmentResumeLease,
      onReleaseLease: definition.onEnvironmentReleaseLease,
      onDestroyLease: definition.onEnvironmentDestroyLease,
      onRealizeWorkspace: definition.onEnvironmentRealizeWorkspace,
      onExecute: definition.onEnvironmentExecute,
    },
  });
}

function givenHealthyInstance() {
  mockedResolve.mockResolvedValue({
    instanceId: "i-deadbeef",
    pingStatus: "Online",
    computerName: "ip-10-0-0-1",
    platformType: "Linux",
  });
  mockedRun.mockResolvedValue({
    stdout: "/home/ubuntu/paperclip\n",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  });
}

beforeEach(() => {
  mockedResolve.mockReset();
  mockedRun.mockReset();
  mockedCliCheck.mockReset();
  mockedCliCheck.mockResolvedValue(undefined);
});

describe("manifest", () => {
  it("declares a discoverable, executable sandbox provider", () => {
    expect(manifest.capabilities).toContain("environment.drivers.register");
    const driver = manifest.environmentDrivers![0];
    expect(driver.kind).toBe("sandbox_provider");
    expect(driver.supportsReusableLeases).toBe(true);
    expect(driver.configSchema).toBeDefined();
  });
});

describe("validateConfig", () => {
  it("accepts a valid config and applies defaults", async () => {
    const harness = makeHarness();
    const result = await harness.validateConfig({ driverKey, config: BASE_CONFIG });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toMatchObject({
      region: "us-east-1",
      awsProfile: "bastion",
      largeOutputTimeoutThresholdMs: 300_000,
      reuseLease: true,
      outputS3Bucket: null,
    });
  });

  it("tolerates host-injected probe keys", async () => {
    const harness = makeHarness();
    const result = await harness.validateConfig({
      driverKey,
      config: { ...BASE_CONFIG, reuseLease: false, archiveOnRelease: true, driver: "sandbox" },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toMatchObject({ reuseLease: false, archiveOnRelease: true });
  });

  it("rejects a config missing required fields", async () => {
    const harness = makeHarness();
    const result = await harness.validateConfig({
      driverKey,
      config: { region: "us-east-1" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toMatch(/tagKey/);
  });

  it("normalizes empty awsProfile to null", async () => {
    const harness = makeHarness();
    const result = await harness.validateConfig({
      driverKey,
      config: { ...BASE_CONFIG, awsProfile: "  " },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toMatchObject({ awsProfile: null });
  });

  it("strips an s3:// scheme and trailing slashes from outputS3Bucket", async () => {
    // SSM stores OutputS3BucketName unvalidated and the S3 SDK only rejects the
    // URL form on the later read, so an unnormalized value yields commands that
    // succeed with no output at all instead of a visible failure.
    const harness = makeHarness();
    for (const input of ["s3://my-output-bucket", "S3://my-output-bucket/", "my-output-bucket"]) {
      const result = await harness.validateConfig({
        driverKey,
        config: { ...BASE_CONFIG, outputS3Bucket: input },
      });
      expect(result.ok).toBe(true);
      expect(result.normalizedConfig).toMatchObject({ outputS3Bucket: "my-output-bucket" });
    }
  });

  it("rejects an outputS3Bucket that is a path or key prefix rather than a bucket name", async () => {
    const harness = makeHarness();
    for (const input of ["s3://my-output-bucket/some/prefix", "my-output-bucket/prefix", "MyBucket"]) {
      const result = await harness.validateConfig({
        driverKey,
        config: { ...BASE_CONFIG, outputS3Bucket: input },
      });
      expect(result.ok).toBe(false);
      expect(result.errors?.join(" ")).toMatch(/outputS3Bucket/);
    }
  });

  it("still treats a blank outputS3Bucket as unset", async () => {
    const harness = makeHarness();
    const result = await harness.validateConfig({
      driverKey,
      config: { ...BASE_CONFIG, outputS3Bucket: "   " },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedConfig).toMatchObject({ outputS3Bucket: null });
  });
});

describe("probe", () => {
  it("verifies CLI, instance, and workspace end-to-end", async () => {
    givenHealthyInstance();
    const harness = makeHarness();

    const result = await harness.probe(baseParams());

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("i-deadbeef");
    expect(result.metadata).toMatchObject({
      instanceId: "i-deadbeef",
      remoteCwd: "/home/ubuntu/paperclip",
      platformType: "Linux",
    });
    expect(mockedCliCheck).toHaveBeenCalled();
    expect(mockedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        awsProfile: "bastion",
        instanceId: "i-deadbeef",
        command: expect.stringContaining("mkdir -p /home/ubuntu/paperclip"),
      }),
    );
  });

  it("reports failure when the instance cannot be resolved", async () => {
    mockedResolve.mockRejectedValue(new Error("No online SSM-managed instance matches tag"));
    const harness = makeHarness();

    const result = await harness.probe(baseParams());

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("No online SSM-managed instance");
    expect(result.diagnostics?.[0]?.severity).toBe("error");
  });

  it("reports failure when workspace verification fails", async () => {
    mockedResolve.mockResolvedValue({
      instanceId: "i-deadbeef",
      pingStatus: "Online",
      computerName: null,
      platformType: "Linux",
    });
    mockedRun.mockResolvedValue({ stdout: "", stderr: "Permission denied", exitCode: 1, timedOut: false });
    const harness = makeHarness();

    const result = await harness.probe(baseParams());

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("Permission denied");
  });
});

describe("lease lifecycle", () => {
  it("acquires a lease with instance metadata including awsProfile", async () => {
    givenHealthyInstance();
    const harness = makeHarness();

    const lease = await harness.acquireLease({ ...baseParams(), runId: "run-1" });

    expect(lease.providerLeaseId).toBe("ssm://us-east-1/i-deadbeef/home/ubuntu/paperclip");
    expect(lease.metadata).toMatchObject({
      region: "us-east-1",
      awsProfile: "bastion",
      instanceId: "i-deadbeef",
      remoteCwd: "/home/ubuntu/paperclip",
    });
  });

  it("resumes a lease on the same instance", async () => {
    givenHealthyInstance();
    const harness = makeHarness();

    const lease = await harness.resumeLease({
      ...baseParams(),
      providerLeaseId: "ssm://us-east-1/i-deadbeef/home/ubuntu/paperclip",
      leaseMetadata: { instanceId: "i-deadbeef", remoteCwd: "/home/ubuntu/paperclip" },
    });

    expect(lease.providerLeaseId).toBe("ssm://us-east-1/i-deadbeef/home/ubuntu/paperclip");
    expect(lease.metadata).toMatchObject({ instanceId: "i-deadbeef" });
  });

  it("refuses to resume when the tag resolves to a different instance", async () => {
    givenHealthyInstance();
    const harness = makeHarness();

    await expect(
      harness.resumeLease({
        ...baseParams(),
        providerLeaseId: "ssm://us-east-1/i-other/home/ubuntu/paperclip",
        leaseMetadata: { instanceId: "i-other" },
      }),
    ).rejects.toThrow(/cannot be resumed/);
  });

  it("never touches the instance on release or destroy", async () => {
    const harness = makeHarness();

    await harness.releaseLease({
      ...baseParams(),
      providerLeaseId: "ssm://us-east-1/i-deadbeef/home/ubuntu/paperclip",
      leaseMetadata: { instanceId: "i-deadbeef" },
    });
    await harness.destroyLease({
      ...baseParams(),
      providerLeaseId: "ssm://us-east-1/i-deadbeef/home/ubuntu/paperclip",
      leaseMetadata: { instanceId: "i-deadbeef" },
    });

    expect(mockedResolve).not.toHaveBeenCalled();
    expect(mockedRun).not.toHaveBeenCalled();
  });
});

describe("realizeWorkspace", () => {
  it("prefers the lease's remoteCwd", async () => {
    const harness = makeHarness();
    const result = await harness.realizeWorkspace({
      ...baseParams(),
      lease: {
        providerLeaseId: "ssm://us-east-1/i-deadbeef/home/ubuntu/paperclip",
        metadata: { remoteCwd: "/home/ubuntu/paperclip/ws-42" },
      },
      workspace: { remotePath: "/somewhere/else" },
    });
    expect(result.cwd).toBe("/home/ubuntu/paperclip/ws-42");
  });

  it("falls back to workspace remotePath, then config path", async () => {
    const harness = makeHarness();
    const withRemote = await harness.realizeWorkspace({
      ...baseParams(),
      lease: { providerLeaseId: "x", metadata: {} },
      workspace: { remotePath: "/remote/ws" },
    });
    expect(withRemote.cwd).toBe("/remote/ws");

    const bare = await harness.realizeWorkspace({
      ...baseParams(),
      lease: { providerLeaseId: "x", metadata: {} },
      workspace: {},
    });
    expect(bare.cwd).toBe("/home/ubuntu/paperclip");
  });
});

describe("execute", () => {
  const LEASE = {
    providerLeaseId: "ssm://us-east-1/i-deadbeef/home/ubuntu/paperclip",
    metadata: {
      region: "us-east-1",
      awsProfile: "bastion",
      instanceId: "i-deadbeef",
      remoteCwd: "/home/ubuntu/paperclip",
    },
  };

  it("assembles cwd + env prefix + quoted args like the core driver", async () => {
    mockedRun.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false });
    const harness = makeHarness();

    const result = await harness.execute({
      ...baseParams(),
      lease: LEASE,
      command: "git",
      args: ["commit", "-m", "it's done"],
      env: { FOO: "bar baz" },
      timeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(mockedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        region: "us-east-1",
        awsProfile: "bastion",
        instanceId: "i-deadbeef",
        command:
          `cd '/home/ubuntu/paperclip' && export FOO='bar baz';git 'commit' '-m' 'it'"'"'s done'`,
        largeOutput: false,
        timeoutMs: 30_000,
      }),
    );
  });

  it("unwraps bash -c bodies instead of double-quoting them", async () => {
    mockedRun.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const harness = makeHarness();

    await harness.execute({
      ...baseParams(),
      lease: LEASE,
      command: "bash",
      args: ["-c", "echo hello | wc -l"],
    });

    expect(mockedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        command: `cd '/home/ubuntu/paperclip' && echo hello | wc -l`,
      }),
    );
  });

  it("uses S3 large-output capture above the timeout threshold when a bucket is set", async () => {
    mockedRun.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const harness = makeHarness();
    const config = { ...BASE_CONFIG, outputS3Bucket: "my-output-bucket" };

    await harness.execute({
      ...baseParams(config),
      lease: LEASE,
      command: "claude",
      args: ["-p", "do things"],
      timeoutMs: 600_000,
    });

    expect(mockedRun).toHaveBeenCalledWith(
      expect.objectContaining({ largeOutput: true, outputS3Bucket: "my-output-bucket" }),
    );
  });

  it("skips large-output below the threshold or without a bucket", async () => {
    mockedRun.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0, timedOut: false });
    const harness = makeHarness();

    await harness.execute({
      ...baseParams({ ...BASE_CONFIG, outputS3Bucket: "my-output-bucket" }),
      lease: LEASE,
      command: "whoami",
      timeoutMs: 30_000,
    });
    await harness.execute({
      ...baseParams(),
      lease: LEASE,
      command: "whoami",
      timeoutMs: 600_000,
    });

    for (const call of mockedRun.mock.calls) {
      expect(call[0]).toMatchObject({ largeOutput: false });
    }
  });

  it("maps a timed-out run to exitCode null", async () => {
    mockedRun.mockResolvedValue({ stdout: "", stderr: "", exitCode: null, timedOut: true });
    const harness = makeHarness();

    const result = await harness.execute({
      ...baseParams(),
      lease: LEASE,
      command: "sleep",
      args: ["999"],
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("fails fast when lease metadata is missing the instance", async () => {
    const harness = makeHarness();
    await expect(
      harness.execute({
        ...baseParams(),
        lease: { providerLeaseId: "x", metadata: {} },
        command: "whoami",
      }),
    ).rejects.toThrow(/missing instanceId/);
  });
});

describe("full lifecycle ordering", () => {
  it("acquire → realize → execute → release round-trips through the harness", async () => {
    givenHealthyInstance();
    const harness = makeHarness();

    const lease = await harness.acquireLease({ ...baseParams(), runId: "run-1" });
    await harness.realizeWorkspace({ ...baseParams(), lease, workspace: {} });
    await harness.execute({ ...baseParams(), lease, command: "whoami" });
    await harness.releaseLease({
      ...baseParams(),
      providerLeaseId: lease.providerLeaseId,
      leaseMetadata: lease.metadata,
    });

    assertEnvironmentEventOrder(harness.environmentEvents, [
      "acquireLease",
      "realizeWorkspace",
      "execute",
      "releaseLease",
    ]);
    assertLeaseLifecycle(harness.environmentEvents, ENV_ID);
    assertExecutionLifecycle(harness.environmentEvents, ENV_ID);
  });
});
