import { z } from "@paperclipai/plugin-sdk";

// S3 bucket naming rules, narrowed to what matters here: 3-63 chars, lowercase
// alphanumerics plus dot and hyphen, starting and ending alphanumeric. Enough
// to reject a scheme, a path, or a key prefix — the mistakes that actually
// reach this field.
const S3_BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

// Mirrors the manifest configSchema. `passthrough` is required: host-side
// probes overlay extra keys (reuseLease, archiveOnRelease, driver, …) onto the
// saved config before calling the driver.
const ssmDriverConfigSchema = z
  .object({
    region: z.string().trim().min(1, "region is required"),
    awsProfile: z
      .string()
      .trim()
      .transform((value) => (value.length > 0 ? value : null))
      .nullish()
      .transform((value) => value ?? null),
    tagKey: z.string().trim().min(1, "tagKey is required"),
    tagValue: z.string().trim().min(1, "tagValue is required"),
    remoteWorkspacePath: z.string().trim().min(1, "remoteWorkspacePath is required"),
    // Bucket NAME, never a URL. Operators reach for the `s3://bucket` form the
    // console shows them, and nothing downstream rejects it: SSM stores
    // whatever string it is given in OutputS3BucketName without validating it,
    // and the S3 SDK's client-side check fires only when the plugin later
    // reads the output back. The result is a command that runs fine and
    // returns no output at all, which surfaces far away as a bogus parse
    // error in the caller. Accept the URL form, and refuse anything that
    // still cannot be a bucket name rather than storing it unusable.
    outputS3Bucket: z
      .string()
      .trim()
      .transform((value) => value.replace(/^s3:\/\//i, "").replace(/\/+$/, "").trim())
      .refine(
        (value) => value.length === 0 || S3_BUCKET_NAME_PATTERN.test(value),
        "outputS3Bucket must be an S3 bucket name (e.g. my-output-bucket), not an s3:// URL with a key prefix or a path",
      )
      .transform((value) => (value.length > 0 ? value : null))
      .nullish()
      .transform((value) => value ?? null),
    largeOutputTimeoutThresholdMs: z.number().int().positive().default(300_000),
    reuseLease: z.boolean().default(true),
  })
  .passthrough();

export type SsmDriverConfig = z.output<typeof ssmDriverConfigSchema>;

export interface ParsedSsmDriverConfig {
  ok: boolean;
  config?: SsmDriverConfig;
  errors?: string[];
}

export function parseSsmDriverConfig(raw: Record<string, unknown>): ParsedSsmDriverConfig {
  const result = ssmDriverConfigSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      ),
    };
  }
  return { ok: true, config: result.data };
}

export function requireSsmDriverConfig(raw: Record<string, unknown>): SsmDriverConfig {
  const parsed = parseSsmDriverConfig(raw);
  if (!parsed.ok || !parsed.config) {
    throw new Error(`Invalid AWS SSM driver config: ${(parsed.errors ?? []).join("; ")}`);
  }
  return parsed.config;
}
