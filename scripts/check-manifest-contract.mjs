// Asserts the built manifest honors the contract the Paperclip plugin loader
// and environment-driver registry depend on. Runs against dist/, so it also
// proves the manifest bundle is loadable by plain Node.
import { pathToFileURL } from "node:url";
import path from "node:path";

const manifestPath = path.resolve("dist/manifest.js");
const { default: manifest } = await import(pathToFileURL(manifestPath).href);

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

check(manifest && typeof manifest === "object", "manifest default export must be an object");
check(manifest.id === "aws-ssm-environment", `manifest.id must be "aws-ssm-environment" (got ${manifest?.id})`);
check(manifest.apiVersion === 1, "manifest.apiVersion must be 1");
check(typeof manifest.version === "string" && /^\d+\.\d+\.\d+/.test(manifest.version), "manifest.version must be semver");
check(manifest.entrypoints?.worker === "./dist/worker.js", "entrypoints.worker must be ./dist/worker.js");
check(
  Array.isArray(manifest.capabilities) && manifest.capabilities.includes("environment.drivers.register"),
  "capabilities must include environment.drivers.register",
);

const drivers = manifest.environmentDrivers;
check(Array.isArray(drivers) && drivers.length === 1, "environmentDrivers must declare exactly one driver");
const driver = drivers?.[0] ?? {};
check(driver.driverKey === "aws-ssm", `driverKey must be "aws-ssm" (got ${driver.driverKey})`);
check(
  driver.kind === "sandbox_provider",
  "driver.kind must be sandbox_provider — environment_driver has no UI discovery or run-execution wiring in the host",
);
check(driver.supportsReusableLeases === true, "driver must set supportsReusableLeases");
check(driver.configSchema?.type === "object", "driver.configSchema must be a JSON Schema object");
for (const field of ["region", "tagKey", "tagValue", "remoteWorkspacePath"]) {
  check(driver.configSchema?.required?.includes(field), `configSchema.required must include ${field}`);
  check(!!driver.configSchema?.properties?.[field], `configSchema.properties must define ${field}`);
}
check(
  driver.configSchema?.additionalProperties === true,
  "configSchema.additionalProperties must be true (host probes overlay reuseLease/archiveOnRelease keys)",
);

if (failures.length > 0) {
  console.error("Manifest contract check FAILED:");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("Manifest contract check passed.");
