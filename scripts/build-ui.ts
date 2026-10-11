// Builds the person UI (React, SDK client, @opt2-tealbrick/ui) into dist/ui, where the SDK serves it under /a/knowledge/.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
const out = `${root}dist/ui`;
const require = createRequire(import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [`${root}src/ui/main.tsx`],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  outfile: `${out}/app.js`,
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
});
copyFileSync(require.resolve("@opt2-tealbrick/ui/tokens.css"), `${out}/tokens.css`);
copyFileSync(require.resolve("@opt2-tealbrick/ui/components.css"), `${out}/components.css`);
copyFileSync(`${root}src/ui/app.css`, `${out}/app.css`);
// Relative asset URLs: the page is served under /a/knowledge/<path>, with an SPA fallback for /configure.
writeFileSync(
  `${out}/index.html`,
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Knowledge</title>
<base href="/a/knowledge/">
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="components.css">
<link rel="stylesheet" href="app.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="app.js"></script>
</body>
</html>
`,
);
console.log("ui built:", out);
