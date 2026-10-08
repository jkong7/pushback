import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

const common = { bundle: true, sourcemap: "inline", logLevel: "warning", define: { "process.env.NODE_ENV": '"production"' } };

await Promise.all([
  build({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main.js", platform: "node", format: "esm", external: ["electron"], target: "node24", banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } }),
  build({ ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload.cjs", platform: "node", format: "cjs", external: ["electron"], target: "node24" }),
  build({ ...common, entryPoints: { app: "src/renderer/app.tsx", card: "src/renderer/card.ts" }, outdir: "dist", platform: "browser", format: "esm", target: "chrome140", jsx: "automatic" }),
]);

for (const f of ["app.html", "card.html", "styles.css"]) cpSync(`src/renderer/${f}`, `dist/${f}`);
console.log("built dist/");
