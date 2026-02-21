const esbuild = require("esbuild");

const isWatch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: [
    "src/popup.js",
    "src/background.js",
    "src/content.js",
    "src/dashboard.js",
  ],
  bundle: true,
  outdir: "dist",
  format: "esm",
  target: "chrome110",
  minify: !isWatch,
  sourcemap: isWatch,
  logLevel: "info",
};

async function main() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await esbuild.build(buildOptions);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
