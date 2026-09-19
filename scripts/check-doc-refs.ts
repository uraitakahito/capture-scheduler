/**
 * docs-site/ の Starlight のドキュメントが嘘をつかないことを確かめる。
 *
 * **`astro build` はこれを守らない。** region が欠けていると
 * "Failed to parse Markdown file" と log には出るのに、Starlight の docs loader が
 * 例外を捕まえるので、全ページをビルドしたと報告して 0 で終わる (capture-ledger と capture-fixtures が
 * 実測して docstring に残している)。ビルドに任せると、ドキュメントは空のコード
 * フェンスのまま出てしまう。
 *
 * 見るのは 6 つ:
 *
 *   1. 訳の欠落 —— 日本語版の無い英語ページ、あるいは英語の原文が無い日本語ページ。
 *      Starlight はページが無いと黙って英語に落とすので、**半分だけ訳したサイトも
 *      緑でビルドできる**。読み手が違う言語に着地するまで誰も気づかない。
 *   2. 壊れた `#region` の抜粋。
 *   3. 死んだソースのパス —— コードスパンに書かれた `windmill/….ts` のうち、その後
 *      名前が変わったか消えたもの。
 *   4. スクリーンショットの参照 —— windmill-ui のページが import する画像が実在するか。
 *      **両方向** で見る: assets/windmill-ui/ に在るのにどのページからも import され
 *      ない置き去りの PNG も落とす (撮ったが使われない写真は腐る)。shots-manifest.json は
 *      台帳なので参照検査から除く。
 *   5. スクショの版 —— shots-manifest.json の windmillVersion が docker-compose.yml の
 *      windmill の pin と一致するか。**compose を上げたら撮り直せ** を機械で言う。
 *      UI が変わったのに写真が古い、を緑で出荷させない (pnpm run docs:shots が撮る)。
 *   6. doctor と smoke が指す節 —— ✗ に添える URL の anchor が、build 後の HTML の見出しの id に
 *      在るか (`scripts/doctor/sections.ts`)。見出しを書き換えると id が変わり、URL は黙って
 *      ページの先頭に落ちる。
 *
 * 訳について見るのはページの **存在** だけで、構造は一切見ない。両方の言語に同じ
 * 見出しを強いると日本語が悪くなる。ページの歩調を合わせるのは人の仕事で、
 * ページが消えないようにするのがこちらの仕事。
 *
 * ## 他の repo との違い
 *
 * capture-ledger と capture-fixtures の同名スクリプトは `src/` を直書きしている。**capture-scheduler に `src/` は
 * 無い** —— TypeScript は `windmill/f/waggle/` に在り、Windmill の worker (bun) が
 * 動かす。そのまま持ってくると capture-fixtures 版は ENOENT で落ちる。
 *
 * `pnpm run site:check` (ビルド + このスクリプト) から走る。問題の一覧を出して 1 で
 * 終わるので、CI が PR を落とす。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { SECTIONS } from "./doctor/sections.js";
import { repoRoot } from "./env.js";

const ROOT = repoRoot();
const DOCS = resolve(ROOT, "docs-site/src/content/docs");
const JA = resolve(DOCS, "ja");
/** ソースの根。capture-ledger / capture-fixtures はここが `src`。 */
const SOURCE_ROOT = "windmill/f";

/** 配下のページを再帰で集める。`ja/` は呼ぶ側が分ける。 */
const pagesIn = (dir: string, skipJa = false): string[] => {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (skipJa && full === JA) continue;
        walk(full);
      } else if (/\.mdx?$/.test(entry.name)) {
        out.push(relative(skipJa ? DOCS : JA, full));
      }
    }
  };
  walk(skipJa ? DOCS : JA);
  return out;
};

const problems: string[] = [];

// ── 1. 訳の対応 ──────────────────────────────────────────────────────
const en = pagesIn(DOCS, true);
const ja = new Set(existsSync(JA) ? pagesIn(JA) : []);

for (const page of en) {
  if (!ja.has(page)) {
    problems.push(`ja/${page} is missing (English page has no Japanese counterpart)`);
  }
}
for (const page of ja) {
  if (!en.includes(page)) {
    problems.push(`${page} is missing (orphan Japanese page with no English original)`);
  }
}

// ── 2. ソースへの参照 ────────────────────────────────────────────────
for (const page of [...en.map((p) => join(DOCS, p)), ...[...ja].map((p) => join(JA, p))]) {
  const rel = relative(ROOT, page);
  const text = readFileSync(page, "utf8");

  // コードスパンに書かれたソースのパス。
  for (const [, path] of text.matchAll(
    new RegExp("`(" + SOURCE_ROOT + "/[A-Za-z0-9_\\-/]+\\.ts)`", "g"),
  )) {
    if (!existsSync(resolve(ROOT, path))) {
      problems.push(`${rel}: \`${path}\` does not exist (renamed or moved?)`);
    }
  }

  // 埋め込み: ```ts file="windmill/…#region"
  for (const [, path, region] of text.matchAll(/file="([^"#]+)#([^"]+)"/g)) {
    const abs = resolve(ROOT, path);
    if (!existsSync(abs)) {
      problems.push(`${rel}: file="${path}" does not exist`);
      continue;
    }
    // 名前は行末まで続いていなければならない。extract.ts と同じ規則。`\b` では
    // 足りない: `y` と `-` の間に単語の境界が在るので、`delay` を求めると
    // `#region delay-v2` という印にも当たってしまう —— そして非 0 で終わるのは
    // この検査だけなので、ここが緩いとずれがそのまま出荷される。
    const re = new RegExp(
      String.raw`//\s*#region\s+${region}[ \t]*\r?$[\s\S]*?//\s*#endregion`,
      "m",
    );
    if (!re.test(readFileSync(abs, "utf8"))) {
      problems.push(
        `${rel}: region "${region}" not found in ${path} (renamed, removed, or missing #endregion?)`,
      );
    }
  }
}

// ── 4. スクリーンショットの参照 (両方向) ─────────────────────────────
const SHOTS_DIR = resolve(ROOT, "docs-site/src/assets/windmill-ui");
if (existsSync(SHOTS_DIR)) {
  const onDisk = new Set(readdirSync(SHOTS_DIR).filter((f) => f.endsWith(".png")));
  const referenced = new Set();
  for (const page of [...en.map((p) => join(DOCS, p)), ...[...ja].map((p) => join(JA, p))]) {
    const text = readFileSync(page, "utf8");
    // import x from "…/assets/windmill-ui/NN-….png"
    for (const [, file] of text.matchAll(/assets\/windmill-ui\/([\w-]+\.png)/g)) {
      referenced.add(file);
      if (!onDisk.has(file)) {
        problems.push(`${relative(ROOT, page)}: 参照する ${file} が assets/windmill-ui/ に無い`);
      }
    }
  }
  for (const file of onDisk) {
    if (!referenced.has(file)) {
      problems.push(`assets/windmill-ui/${file} はどのページからも import されていない (置き去り)`);
    }
  }

  // ── 5. スクショの版 == compose の pin ──────────────────────────────
  const manifestPath = join(SHOTS_DIR, "shots-manifest.json");
  if (!existsSync(manifestPath)) {
    problems.push("assets/windmill-ui/shots-manifest.json が無い (pnpm run docs:shots で撮ること)");
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const compose = readFileSync(resolve(ROOT, "docker-compose.yml"), "utf8");
    const pin = /windmill-labs\/windmill:(\d+\.\d+\.\d+)/.exec(compose);
    if (pin === null) {
      problems.push("docker-compose.yml に windmill の pin が見つからない");
    } else if (manifest.windmillVersion !== pin[1]) {
      problems.push(
        `スクショが古い: shots-manifest.json は windmill ${String(manifest.windmillVersion)} だが ` +
          `compose の pin は ${pin[1]} —— UI が変わっている。pnpm run docs:shots で撮り直すこと`,
      );
    }
  }
}

// ── 6. doctor と smoke が指す節 ─────────────────────────────────────
// build 後の HTML を読む (site:check は build の後にこれを走らせる)。id は Starlight が
// 見出しから作るので、ソースの見出しから計算し直すより、出来上がったものを見るほうが確か。
for (const section of Object.values(SECTIONS)) {
  const html = resolve(ROOT, "docs-site/dist/ja", section.page, "index.html");
  if (!existsSync(html)) {
    problems.push(
      `doctor が指す docs-site/dist/ja/${section.page}/ が無い (build の前に走らせた?)`,
    );
  } else if (!readFileSync(html, "utf8").includes(`id="${section.anchor}"`)) {
    problems.push(
      `doctor が指す節「${section.title}」の #${section.anchor} が ja/${section.page}/ に無い ` +
        "(見出しを変えたなら scripts/doctor/sections.ts も)",
    );
  }
}

if (problems.length > 0) {
  console.error("doc-ref check failed:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(
  `✓ doc-ref check passed: ${en.length} pages in English and Japanese, ` +
    `all source paths, screenshots and doctor's sections resolve`,
);
