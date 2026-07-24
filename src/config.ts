import { z } from "@paperclipai/plugin-sdk";

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
    outputS3Bucket: z
      .string()
      .trim()
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
