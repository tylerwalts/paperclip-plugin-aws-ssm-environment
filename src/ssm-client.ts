import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import {
  SSMClient,
  DescribeInstanceInformationCommand,
  SendCommandCommand,
  GetCommandInvocationCommand,
  StartSessionCommand,
  TerminateSessionCommand,
  type InstanceInformation,
} from "@aws-sdk/client-ssm";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-provider-ini";

const execFileP = promisify(execFile);

/** Raised for operator-actionable SSM failures (bad config, unreachable instance, …). */
export class SsmDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsmDriverError";
  }
}

// Plugin workers run under a stripped environment (no HOME, no AWS_*). The AWS
// SDK's ini credential provider and the session-manager-plugin/aws CLIs all
// resolve config through HOME, so every subprocess and credential lookup must
// receive an explicit fallback to the daemon user's home directory.
function subprocessEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: process.env.HOME ?? os.homedir(),
  };
}

export interface SsmResolveTagInput {
  region: string;
  awsProfile: string | null;
  tagKey: string;
  tagValue: string;
}

export interface SsmResolvedInstance {
  instanceId: string;
  pingStatus: string;
  computerName: string | null;
  platformType: string | null;
}

export interface SsmSessionHandle {
  sessionId: string;
  process: ChildProcess;
  region: string;
  instanceId: string;
  terminate(): Promise<void>;
}

function buildSsmClient(input: { region: string; awsProfile: string | null }): SSMClient {
  if (input.awsProfile && input.awsProfile.trim().length > 0) {
    return new SSMClient({
      region: input.region,
      credentials: fromIni({ profile: input.awsProfile.trim() }),
    });
  }
  return new SSMClient({ region: input.region });
}

export async function resolveSsmInstanceByTag(
  input: SsmResolveTagInput,
): Promise<SsmResolvedInstance> {
  const tagKey = input.tagKey.trim();
  const tagValue = input.tagValue.trim();
  if (!tagKey || !tagValue) {
    throw new SsmDriverError("SSM tag key and tag value are both required.");
  }

  const client = buildSsmClient(input);
  let response;
  try {
    response = await client.send(
      new DescribeInstanceInformationCommand({
        Filters: [{ Key: `tag:${tagKey}`, Values: [tagValue] }],
        MaxResults: 50,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SsmDriverError(`Failed to query AWS SSM for tag ${tagKey}=${tagValue}: ${message}`);
  } finally {
    client.destroy();
  }

  const matches = (response.InstanceInformationList ?? []).filter(
    (entry): entry is InstanceInformation & { InstanceId: string } =>
      typeof entry.InstanceId === "string" &&
      entry.InstanceId.length > 0 &&
      entry.PingStatus === "Online",
  );

  if (matches.length === 0) {
    throw new SsmDriverError(
      `No online SSM-managed instance matches tag ${tagKey}=${tagValue} in ${input.region}.`,
    );
  }
  if (matches.length > 1) {
    const ids = matches.map((entry) => entry.InstanceId).join(", ");
    throw new SsmDriverError(
      `Multiple SSM-managed instances match tag ${tagKey}=${tagValue} in ${input.region}: ${ids}. Narrow the tag value to a single host.`,
    );
  }

  const match = matches[0];
  return {
    instanceId: match.InstanceId,
    pingStatus: match.PingStatus ?? "Online",
    computerName: match.ComputerName ?? null,
    platformType: match.PlatformType ?? null,
  };
}

export interface SsmStartSessionInput {
  region: string;
  awsProfile: string | null;
  instanceId: string;
  command?: string[];
}

export async function startSsmSession(input: SsmStartSessionInput): Promise<SsmSessionHandle> {
  const client = buildSsmClient(input);
  let sessionResponse;
  try {
    sessionResponse = await client.send(
      new StartSessionCommand({
        Target: input.instanceId,
        DocumentName: "AWS-StartInteractiveCommand",
        Parameters: {
          command: [input.command?.join(" ") ?? "bash -l"],
        },
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SsmDriverError(
      `Failed to start SSM session on ${input.instanceId} in ${input.region}: ${message}`,
    );
  } finally {
    client.destroy();
  }

  if (!sessionResponse.SessionId) {
    throw new SsmDriverError(
      `SSM StartSession returned no SessionId for ${input.instanceId} in ${input.region}.`,
    );
  }

  const endpoint = `https://ssm.${input.region}.amazonaws.com`;
  const requestParams = JSON.stringify({ Target: input.instanceId });

  const child = spawn(
    "session-manager-plugin",
    [
      JSON.stringify(sessionResponse),
      input.region,
      "StartSession",
      input.awsProfile ?? "",
      requestParams,
      endpoint,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: subprocessEnv(),
    },
  );

  const sessionId = sessionResponse.SessionId;

  return {
    sessionId,
    process: child,
    region: input.region,
    instanceId: input.instanceId,
    async terminate() {
      child.kill("SIGTERM");
      const terminateClient = buildSsmClient({ region: input.region, awsProfile: input.awsProfile });
      try {
        await terminateClient.send(
          new TerminateSessionCommand({ SessionId: sessionId }),
        );
      } catch {
        // Best-effort cleanup — the session will expire on its own
      } finally {
        terminateClient.destroy();
      }
    },
  };
}

export interface SsmRunCommandInput {
  region: string;
  awsProfile: string | null;
  instanceId: string;
  command: string;
  stdin?: string;
  timeoutMs?: number;
  /** When true, capture stdout/stderr via S3 to avoid the 24KB GetCommandInvocation limit. */
  largeOutput?: boolean;
  /** S3 bucket for large output capture. Required when largeOutput is true. */
  outputS3Bucket?: string;
}

export interface SsmRunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export async function runSsmCommand(input: SsmRunCommandInput): Promise<SsmRunCommandResult> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const timeoutSec = Math.max(30, Math.floor(timeoutMs / 1000));

  // For commands that may produce >24KB output, use S3 output capture.
  // This must be checked BEFORE the stdin path since the largeOutput handler
  // also handles stdin (writes it to a file).
  if (input.largeOutput) {
    console.error(`[ssm-largeOutput] activated for instance=${input.instanceId} bucket=${input.outputS3Bucket} hasStdin=${!!(input.stdin?.length)}`);
    return await runSsmCommandLargeOutput(input, timeoutMs, timeoutSec);
  }

  // AWS-RunShellScript doesn't support stdin. When stdin is provided, we
  // upload it to a temp file in chunks first, then redirect it into the command.
  if (input.stdin != null && input.stdin.length > 0) {
    return await runSsmCommandWithStdin(input as SsmRunCommandInput & { stdin: string }, timeoutMs, timeoutSec);
  }

  const client = buildSsmClient(input);
  const command = input.command;

  let commandId: string;
  try {
    const sendResponse = await client.send(
      new SendCommandCommand({
        InstanceIds: [input.instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: {
          commands: [command],
          executionTimeout: [String(timeoutSec)],
        },
        TimeoutSeconds: timeoutSec + 10,
      }),
    );
    commandId = sendResponse.Command?.CommandId ?? "";
    if (!commandId) {
      throw new Error("SendCommand returned no CommandId.");
    }
  } catch (error) {
    client.destroy();
    const message = error instanceof Error ? error.message : String(error);
    throw new SsmDriverError(
      `Failed to start SSM command session on ${input.instanceId} in ${input.region}: ${message}`,
    );
  }

  const pollIntervalMs = 2000;
  const deadline = Date.now() + timeoutMs + 15_000;
  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let timedOut = false;

  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      let invocation;
      try {
        invocation = await client.send(
          new GetCommandInvocationCommand({
            CommandId: commandId,
            InstanceId: input.instanceId,
          }),
        );
      } catch (error) {
        const code = (error as { name?: string }).name;
        if (code === "InvocationDoesNotExist") continue;
        throw error;
      }

      const status = invocation.Status;
      if (status === "InProgress" || status === "Pending" || status === "Delayed") {
        continue;
      }

      stdout = invocation.StandardOutputContent ?? "";
      stderr = invocation.StandardErrorContent ?? "";

      if (status === "Success") {
        exitCode = 0;
      } else if (status === "TimedOut") {
        timedOut = true;
      } else if (status === "Failed") {
        exitCode = typeof invocation.ResponseCode === "number" ? invocation.ResponseCode : 1;
      } else {
        exitCode = 1;
      }

      break;
    }

    if (exitCode === null && !timedOut) {
      timedOut = true;
    }
  } finally {
    client.destroy();
  }

  return { stdout, stderr, exitCode, timedOut };
}

async function runSsmCommandLargeOutput(
  input: SsmRunCommandInput,
  timeoutMs: number,
  timeoutSec: number,
): Promise<SsmRunCommandResult> {
  const bucket = input.outputS3Bucket;
  if (!bucket) {
    throw new Error("largeOutput requires outputS3Bucket to be set.");
  }

  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const s3Prefix = `ssm-output/${tag}`;
  const client = buildSsmClient(input);

  // Write the command to a script file first (avoids quoting/multiline issues)
  const scriptFile = `/tmp/.paperclip-script-${tag}`;
  const stdinFile = input.stdin ? `/tmp/.paperclip-stdin-${tag}` : null;
  const writeResult = await runSsmCommandWithStdin(
    { ...input, command: `cat > '${scriptFile}' && chmod +x '${scriptFile}'`, stdin: input.command },
    timeoutMs,
    30,
  );
  if (writeResult.exitCode !== 0 || writeResult.timedOut) {
    return writeResult;
  }

  // If stdin is provided, upload it to a file too
  if (stdinFile && input.stdin) {
    const stdinWriteResult = await runSsmCommandWithStdin(
      { ...input, command: `cat > '${stdinFile}'`, stdin: input.stdin },
      timeoutMs,
      30,
    );
    if (stdinWriteResult.exitCode !== 0 || stdinWriteResult.timedOut) {
      return stdinWriteResult;
    }
  }

  // Execute script via SendCommand with S3 output
  const execCommand = stdinFile
    ? `bash '${scriptFile}' < '${stdinFile}'; __rc=$?; rm -f '${scriptFile}' '${stdinFile}'; exit $__rc`
    : `bash '${scriptFile}'; __rc=$?; rm -f '${scriptFile}'; exit $__rc`;
  let commandId: string;
  try {
    const sendResponse = await client.send(
      new SendCommandCommand({
        InstanceIds: [input.instanceId],
        DocumentName: "AWS-RunShellScript",
        Parameters: {
          commands: [execCommand],
          executionTimeout: [String(timeoutSec)],
        },
        TimeoutSeconds: timeoutSec + 10,
        OutputS3BucketName: bucket,
        OutputS3KeyPrefix: s3Prefix,
      }),
    );
    commandId = sendResponse.Command?.CommandId ?? "";
    if (!commandId) throw new Error("SendCommand returned no CommandId.");
  } catch (error) {
    client.destroy();
    const message = error instanceof Error ? error.message : String(error);
    throw new SsmDriverError(`Failed to start SSM command on ${input.instanceId}: ${message}`);
  }

  // Poll for completion
  const pollIntervalMs = 3000;
  const deadline = Date.now() + timeoutMs + 15_000;
  let status = "";
  let responseCode: number | undefined;
  let timedOut = false;
  // SSM returns the first 24KB of each stream inline even when S3 capture is
  // configured. Keep it: it is the fallback when the S3 copy is unreadable.
  let inlineStdout = "";
  let inlineStderr = "";

  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      let invocation;
      try {
        invocation = await client.send(
          new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: input.instanceId }),
        );
      } catch (error) {
        if ((error as { name?: string }).name === "InvocationDoesNotExist") continue;
        throw error;
      }
      status = invocation.Status ?? "";
      responseCode = invocation.ResponseCode;
      inlineStdout = invocation.StandardOutputContent ?? "";
      inlineStderr = invocation.StandardErrorContent ?? "";
      if (status === "InProgress" || status === "Pending" || status === "Delayed") continue;
      break;
    }
    if (!status || status === "InProgress" || status === "Pending" || status === "Delayed") {
      timedOut = true;
    }
  } finally {
    client.destroy();
  }

  if (timedOut) {
    return { stdout: "", stderr: "", exitCode: null, timedOut: true };
  }

  const exitCode = status === "Success" ? 0
    : status === "TimedOut" ? null
    : (typeof responseCode === "number" ? responseCode : 1);

  // Read stdout/stderr from S3, falling back to what SSM returned inline.
  const s3Client = buildS3Client(input);
  const keyFor = (stream: string) =>
    `${s3Prefix}/${commandId}/${input.instanceId}/awsrunShellScript/0.awsrunShellScript/${stream}`;
  let stdout: string;
  let stderr: string;
  try {
    stdout = await readCommandStream({
      client: s3Client, bucket, key: keyFor("stdout"), inline: inlineStdout, stream: "stdout",
    });
    stderr = await readCommandStream({
      client: s3Client, bucket, key: keyFor("stderr"), inline: inlineStderr, stream: "stderr",
    });
  } finally {
    s3Client.destroy();
  }

  if (status === "TimedOut") {
    return { stdout, stderr, exitCode: null, timedOut: true };
  }

  return { stdout, stderr, exitCode, timedOut: false };
}

function buildS3Client(input: { region: string; awsProfile: string | null }): S3Client {
  if (input.awsProfile && input.awsProfile.trim().length > 0) {
    return new S3Client({ region: input.region, credentials: fromIni({ profile: input.awsProfile.trim() }) });
  }
  return new S3Client({ region: input.region });
}

/** Ceiling on what GetCommandInvocation returns per stream. */
const SSM_INLINE_OUTPUT_LIMIT = 24_000;

const S3_MISSING_OBJECT_ERROR_NAMES = new Set(["NoSuchKey", "NotFound"]);

/**
 * Read one command stream, preferring the uncapped S3 copy.
 *
 * A stream that produced no bytes gets no S3 object at all — SSM writes each
 * key only when that stream had output — so a missing object is the ordinary
 * "empty" case. Note the reader also sees a plain 403 there when it lacks
 * s3:ListBucket on the bucket, because S3 hides existence from principals that
 * cannot list; missing and forbidden are genuinely indistinguishable then.
 *
 * So an unreadable S3 copy must not be reported as "the command printed
 * nothing": that is what turned a bucket name with an `s3://` prefix into a
 * command that looked like a clean success with no output, and killed the
 * caller far away with `JSON.parse("")`. Fall back to the inline copy SSM
 * returns regardless of S3 capture, which covers every output under 24KB —
 * including all of the small control-plane commands. Only when the inline copy
 * is itself at the cap is there no correct answer available, and that is worth
 * failing over rather than silently truncating.
 */
async function readCommandStream(input: {
  client: S3Client;
  bucket: string;
  key: string;
  inline: string;
  stream: "stdout" | "stderr";
}): Promise<string> {
  try {
    const response = await input.client.send(
      new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
    return await response.Body?.transformToString("utf8") ?? "";
  } catch (error) {
    const name = (error as { name?: string }).name ?? "";
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (S3_MISSING_OBJECT_ERROR_NAMES.has(name) || status === 404) return "";

    const msg = error instanceof Error ? error.message : String(error);
    if (input.inline.length >= SSM_INLINE_OUTPUT_LIMIT) {
      throw new SsmDriverError(
        `SSM command ${input.stream} exceeds the 24KB inline limit and its S3 copy could not be read `
          + `(bucket=${input.bucket} key=${input.key}): ${msg}. Check the environment's outputS3Bucket `
          + "setting — it must be a bucket name, not an s3:// URL — and that both the instance role and "
          + "the Paperclip host can access that bucket.",
      );
    }
    console.error(
      `[ssm-largeOutput] S3 ${input.stream} unreadable, using SSM's inline copy instead: `
        + `bucket=${input.bucket} key=${input.key} error=${msg}`,
    );
    return input.inline;
  }
}

// Max chars per SendCommand printf chunk. Keep well under 100KB API limit.
const SSM_STDIN_CHUNK_SIZE = 32_000;

async function runSsmCommandWithStdin(
  input: SsmRunCommandInput & { stdin: string },
  timeoutMs: number,
  _timeoutSec: number,
): Promise<SsmRunCommandResult> {
  const tmpFile = `/tmp/.paperclip-stdin-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const stdinData = input.stdin;

  // Upload stdin text in chunks to a temp file using base64 encoding to avoid
  // shell quoting issues with arbitrary content (scripts with quotes, etc).
  const b64Data = Buffer.from(stdinData, "utf8").toString("base64");
  for (let offset = 0; offset < b64Data.length; offset += SSM_STDIN_CHUNK_SIZE) {
    const chunk = b64Data.slice(offset, offset + SSM_STDIN_CHUNK_SIZE);
    const op = offset === 0 ? ">" : ">>";
    const appendCmd = `printf '%s' '${chunk}' ${op} '${tmpFile}.b64'`;
    const chunkResult = await runSsmCommand({
      region: input.region,
      awsProfile: input.awsProfile,
      instanceId: input.instanceId,
      command: appendCmd,
      timeoutMs,
    });
    if (chunkResult.exitCode !== 0 || chunkResult.timedOut) {
      await runSsmCommand({
        region: input.region,
        awsProfile: input.awsProfile,
        instanceId: input.instanceId,
        command: `rm -f '${tmpFile}' '${tmpFile}.b64'`,
        timeoutMs: 30_000,
      });
      return chunkResult;
    }
  }
  // Decode the base64 file to get the original content
  const decodeResult = await runSsmCommand({
    region: input.region,
    awsProfile: input.awsProfile,
    instanceId: input.instanceId,
    command: `base64 -d < '${tmpFile}.b64' > '${tmpFile}' && rm -f '${tmpFile}.b64'`,
    timeoutMs,
  });
  if (decodeResult.exitCode !== 0 || decodeResult.timedOut) {
    await runSsmCommand({
      region: input.region,
      awsProfile: input.awsProfile,
      instanceId: input.instanceId,
      command: `rm -f '${tmpFile}' '${tmpFile}.b64'`,
      timeoutMs: 30_000,
    });
    return decodeResult;
  }

  // Run the actual command with stdin redirected from the temp file.
  // Wrap in a subshell so the redirect feeds stdin to the entire script,
  // not just the last simple command in the pipeline.
  const result = await runSsmCommand({
    region: input.region,
    awsProfile: input.awsProfile,
    instanceId: input.instanceId,
    command: `(${input.command}) < '${tmpFile}'; __exit=$?; rm -f '${tmpFile}'; exit $__exit`,
    timeoutMs,
  });

  return result;
}

let cliCheckCache: { ok: true } | { ok: false; reason: string } | null = null;

/** Test-only hook: reset the cached CLI availability check. */
export function resetSsmCliCheckCache(): void {
  cliCheckCache = null;
}

export async function assertSsmCliAvailable(): Promise<void> {
  if (cliCheckCache?.ok === true) return;

  const errors: string[] = [];
  try {
    await execFileP("session-manager-plugin", ["--version"], {
      timeout: 5_000,
      env: subprocessEnv(),
    });
  } catch (error) {
    errors.push(
      `session-manager-plugin is not installed or not on PATH (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  if (errors.length > 0) {
    const reason = `${errors.join(" ")} See the plugin README for install instructions.`;
    cliCheckCache = { ok: false, reason };
    throw new SsmDriverError(reason);
  }
  cliCheckCache = { ok: true };
}
