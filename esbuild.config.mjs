import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({});
const watch = process.argv.includes("--watch");

// The AWS SDK ships CJS internals that require() node builtins at runtime;
// esbuild's ESM output needs a real require for those to resolve.
const workerConfig = {
  ...presets.esbuild.worker,
  banner: {
    js: "import { createRequire as __pcCreateRequire } from 'node:module'; const require = __pcCreateRequire(import.meta.url);",
  },
};

const workerCtx = await esbuild.context(workerConfig);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch()]);
  console.log("esbuild watch mode enabled for worker and manifest");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose()]);
}
