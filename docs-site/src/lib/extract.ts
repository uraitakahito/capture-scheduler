/**
 * The one place documentation pulls facts out of the source.
 *
 * capture-scheduler only needs a single extractor — `// #region` snippets, so a page can
 * show real code rather than a copy that quietly drifts. BrowserHive's version
 * of this file also builds a glossary and type tables via ts-morph; capture-scheduler has
 * neither a glossary nor an interface worth tabulating, so this reads the file
 * directly and drops the dependency.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The capture-scheduler root. `docs-site` sits directly under it, and every script
// (astro dev/build, node) runs with `docs-site` as its cwd — so the parent is
// the repo. `import.meta.url` is not usable here: the astro build bundles this
// file and the URL becomes a path inside `dist`.
const ROOT = resolve(process.cwd(), "..");

/**
 * The current text between `// #region <name>` and `// #endregion`.
 *
 * Throws when the region is gone. Whether that stops the build depends on the
 * page's extension, the Starlight/Astro version and the content cache, so it
 * was measured rather than assumed:
 *
 *   .mdx — the throw surfaces through @astrojs/mdx's vite plugin and the
 *          build fails, exit 1.
 *   .md  — Starlight's docs loader catches it and logs
 *          `[ERROR] [starlight-docs-loader] Error rendering …`. With a cold
 *          cache (as in CI) the build exits 1 here; an older Starlight, and a
 *          warm cache, finished with exit 0 and "Complete!".
 *
 * The .md behaviour belongs to Starlight and the cache, not to this repo, and
 * has varied. So do not rely on `site:build` for it:
 * scripts/check-doc-refs.ts reads .md and .mdx alike and exits non-zero on a
 * missing region. `pnpm run site:check` runs both, and the workflows run it,
 * never `site:build` alone.
 *
 * The name must run to the end of its line. `\b` is not enough: a word
 * boundary sits between `s` and `-`, so a region named `scenarios` would also
 * match a marker reading `#region scenarios-v2` and quietly serve the wrong
 * snippet — the exact drift this mechanism exists to prevent.
 */
export function sourceRegion(file: string, region: string): string {
  const text = readFileSync(resolve(ROOT, file), "utf8");
  const re = new RegExp(
    String.raw`//\s*#region\s+${region}[ \t]*\r?$([\s\S]*?)//\s*#endregion`,
    "m",
  );
  const m = re.exec(text);
  if (!m) throw new Error(`region '${region}' not found in ${file}`);
  return (m[1] ?? "").replace(/^\n/, "").replace(/\s+$/, "");
}
