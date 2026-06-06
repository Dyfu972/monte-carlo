// Build robuste (API JS esbuild) — évite les soucis de quoting du --define en ligne de commande.
import { build } from "esbuild";

build({
  entryPoints: ["main.jsx"],
  bundle: true,
  minify: true,
  format: "iife",
  jsx: "automatic",
  loader: { ".jsx": "jsx" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  outfile: "bundle.js",
})
  .then(() => console.log("Built bundle.js (production)"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
