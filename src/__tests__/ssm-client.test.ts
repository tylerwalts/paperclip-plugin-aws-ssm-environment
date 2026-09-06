import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SSMClient,
  DescribeInstanceInformationCommand,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SsmDriverError, resolveSsmInstanceByTag, runSsmCommand } from "../ssm-client.js";

const ssmMock = mockClient(SSMClient);
const s3Mock = mockClient(S3Client);

describe("ssm-client helpers", () => {
  beforeEach(() => {
    ssmMock.reset();
  });
  afterEach(() => {
    ssmMock.reset();
  });

  describe("resolveSsmInstanceByTag", () => {
    const baseInput = {
      region: "us-east-1",
      awsProfile: null,
      tagKey: "Paperclip",
      tagValue: "runner-prod",
    } as const;

    it("returns the single matching online instance", async () => {
      ssmMock.on(DescribeInstanceInformationCommand).resolves({
        InstanceInformationList: [
          {
            InstanceId: "i-deadbeef",
            PingStatus: "Online",
            PlatformType: "Linux",
            ComputerName: "ip-10-0-0-1",
          },
        ],
      });

      const resolved = await resolveSsmInstanceByTag(baseInput);
      expect(resolved.instanceId).toBe("i-deadbeef");
      expect(resolved.platformType).toBe("Linux");
      expect(resolved.pingStatus).toBe("Online");
    });

    it("rejects when no instances match", async () => {
      ssmMock.on(DescribeInstanceInformationCommand).resolves({
        InstanceInformationList: [],
      });

      await expect(resolveSsmInstanceByTag(baseInput)).rejects.toBeInstanceOf(SsmDriverError);
      await expect(resolveSsmInstanceByTag(baseInput)).rejects.toMatchObject({
        message: expect.stringContaining("No online SSM-managed instance"),
      });
    });

    it("rejects when multiple instances match", async () => {
      ssmMock.on(DescribeInstanceInformationCommand).resolves({
        InstanceInformationList: [
          { InstanceId: "i-aaa", PingStatus: "Online" },
          { InstanceId: "i-bbb", PingStatus: "Online" },
        ],
      });

      await expect(resolveSsmInstanceByTag(baseInput)).rejects.toMatchObject({
        message: expect.stringContaining("Multiple SSM-managed instances"),
      });
    });

    it("rejects when tagKey or tagValue is empty", async () => {
      await expect(
        resolveSsmInstanceByTag({ ...baseInput, tagKey: "" }),
      ).rejects.toBeInstanceOf(SsmDriverError);
      await expect(
        resolveSsmInstanceByTag({ ...baseInput, tagValue: "   " }),
      ).rejects.toBeInstanceOf(SsmDriverError);
    });

    it("ignores offline instances", async () => {
      ssmMock.on(DescribeInstanceInformationCommand).resolves({
        InstanceInformationList: [
          { InstanceId: "i-offline", PingStatus: "ConnectionLost" },
          { InstanceId: "i-online", PingStatus: "Online" },
        ],
      });

      const resolved = await resolveSsmInstanceByTag(baseInput);
      expect(resolved.instanceId).toBe("i-online");
    });

    it("wraps SDK errors with context", async () => {
      ssmMock.on(DescribeInstanceInformationCommand).rejects(new Error("AccessDenied"));
      await expect(resolveSsmInstanceByTag(baseInput)).rejects.toMatchObject({
        message: expect.stringContaining("Failed to query AWS SSM"),
      });
    });
  });

  describe("runSsmCommand", () => {
    it("rejects when SendCommand fails", async () => {
      ssmMock.on(SendCommandCommand).rejects(new Error("AccessDenied"));
      await expect(
        runSsmCommand({
          region: "us-east-1",
          awsProfile: null,
          instanceId: "i-abc123",
          command: "whoami",
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("Failed to start SSM command"),
      });
    });

    it("rejects when SendCommand returns no CommandId", async () => {
      ssmMock.on(SendCommandCommand).resolves({ Command: {} });
      await expect(
        runSsmCommand({
          region: "us-east-1",
          awsProfile: null,
          instanceId: "i-abc123",
          command: "whoami",
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("SendCommand returned no CommandId"),
      });
    });

    it("returns stdout/stderr when command succeeds", async () => {
      ssmMock.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-123" } });
      ssmMock.on(GetCommandInvocationCommand).resolves({
        Status: "Success",
        StandardOutputContent: "ubuntu\n",
        StandardErrorContent: "",
        ResponseCode: 0,
      });

      const result = await runSsmCommand({
        region: "us-east-1",
        awsProfile: null,
        instanceId: "i-abc123",
        command: "whoami",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("ubuntu\n");
      expect(result.stderr).toBe("");
      expect(result.timedOut).toBe(false);
    });

    it("returns exit code when command fails", async () => {
      ssmMock.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-456" } });
      ssmMock.on(GetCommandInvocationCommand).resolves({
        Status: "Failed",
        StandardOutputContent: "",
        StandardErrorContent: "command not found\n",
        ResponseCode: 127,
      });

      const result = await runSsmCommand({
        region: "us-east-1",
        awsProfile: null,
        instanceId: "i-abc123",
        command: "unknown-command",
      });

      expect(result.exitCode).toBe(127);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("command not found\n");
      expect(result.timedOut).toBe(false);
    });

    it("reports timeout when command times out", async () => {
      ssmMock.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-789" } });
      ssmMock.on(GetCommandInvocationCommand).resolves({
        Status: "TimedOut",
        StandardOutputContent: "",
        StandardErrorContent: "",
      });

      const result = await runSsmCommand({
        region: "us-east-1",
        awsProfile: null,
        instanceId: "i-abc123",
        command: "sleep 100",
        timeoutMs: 1000,
      });

      expect(result.exitCode).toBeNull();
      expect(result.timedOut).toBe(true);
    });
  });

  describe("runSsmCommand with S3 large-output capture", () => {
    const largeOutputInput = {
      region: "us-east-1",
      awsProfile: null,
      instanceId: "i-abc123",
      command: "claude -p 'do things'",
      largeOutput: true,
      outputS3Bucket: "my-output-bucket",
      // Above the poll interval so the single poll pass suffices; the command
      // itself is mocked, so nothing actually waits this long.
      timeoutMs: 20_000,
    } as const;

    const mockInvocation = (inlineStdout: string, inlineStderr = "") => {
      ssmMock.on(SendCommandCommand).resolves({ Command: { CommandId: "cmd-large" } });
      ssmMock.on(GetCommandInvocationCommand).resolves({
        Status: "Success",
        StandardOutputContent: inlineStdout,
        StandardErrorContent: inlineStderr,
        ResponseCode: 0,
      });
    };

    beforeEach(() => {
      s3Mock.reset();
      mockInvocation("");
    });

    it("prefers the S3 copy over SSM's capped inline copy", async () => {
      mockInvocation("truncated");
      s3Mock.on(GetObjectCommand).callsFake((input: { Key?: string }) => ({
        Body: { transformToString: async () => (input.Key?.endsWith("/stdout") ? "full output\n" : "") },
      }));

      const result = await runSsmCommand({ ...largeOutputInput });

      expect(result.stdout).toBe("full output\n");
    }, 30_000);

    it("treats a missing S3 object as empty output, not a failure", async () => {
      // SSM writes the stderr object only when the command wrote to stderr, so
      // NoSuchKey is the ordinary "nothing on this stream" case.
      const missing = new Error("The specified key does not exist.");
      missing.name = "NoSuchKey";
      s3Mock.on(GetObjectCommand).callsFake((input: { Key?: string }) => {
        if (input.Key?.endsWith("/stdout")) {
          return { Body: { transformToString: async () => "hello\n" } };
        }
        throw missing;
      });

      const result = await runSsmCommand({ ...largeOutputInput });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("hello\n");
      expect(result.stderr).toBe("");
    }, 30_000);

    it("falls back to SSM's inline copy when the S3 copy is unreadable", async () => {
      // The bug this guards: an `s3://`-prefixed bucket name made every read
      // fail, the plugin reported an empty stdout with exit 0, and the caller
      // died parsing "" as JSON — nowhere near the real cause. SSM returns the
      // first 24KB inline regardless of S3 capture, so that answer was always
      // available.
      mockInvocation('{"uploaded":true}\n');
      s3Mock.on(GetObjectCommand).rejects(
        new Error("Bucket name shouldn't contain '/', received 's3://my-output-bucket'"),
      );

      const result = await runSsmCommand({ ...largeOutputInput });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('{"uploaded":true}\n');
    }, 30_000);

    it("refuses to silently truncate when inline is capped and S3 is unreadable", async () => {
      mockInvocation("x".repeat(24_000));
      s3Mock.on(GetObjectCommand).rejects(new Error("Access Denied"));

      await expect(runSsmCommand({ ...largeOutputInput })).rejects.toMatchObject({
        message: expect.stringContaining("exceeds the 24KB inline limit"),
      });
    }, 30_000);
  });
});
