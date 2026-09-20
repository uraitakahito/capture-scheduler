#!/usr/bin/env node
/**
 * `.env.example` と、コードが実際に読んでいる環境変数を突き合わせる。
 *
 * capture-ledger の同名スクリプトと同じ狙い: **`.env.example` を唯一の出どころに保つ**。
 * 変数を足したのに書き忘れると、`setup.sh` が写した `.env` にその行が無く、
 * 使う人は「なぜ動かないか」を名前も知らないまま探すことになる。
 *
 * 検査は 2 方向。片方だけだと、消し忘れた行と書き忘れた行のどちらかが素通りする。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_ENV, OPTIONAL_ENV, repoRoot } from "./env.js";

const root = repoRoot();

const declared = [...OPTIONAL_ENV, ...GENERATED_ENV];

/** `.env.example` が名前を挙げている変数。`NAME=` も `#NAME=` も拾う。 */
const documented = (): Set<string> => {
  const text = readFileSync(join(root, ".env.example"), "utf8");
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^#?([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match) names.add(match[1]);
  }
  return names;
};

/**
 * `scripts/` が実際に読んでいる変数。
 *
 * **拡張子を 2 つ見るのは移行中だから。** ここを `.mjs` だけにしていたので、
 * TypeScript 化の途中で「読んでいるのに宣言が無い」の検査が **無言で無力化** した
 * (走査対象が 0 件になり、検査は緑のまま何も見ていない状態)。移行が終わったら
 * `.ts` だけに絞ってよいが、**絞るときは必ずこの検査器が赤くなることを確かめる**
 * こと —— 対象が消えても緑で通る検査器は、在っても意味がない。
 */
const used = (): Set<string> => {
  const names = new Set<string>();
  const sources = readdirSync(join(root, "scripts")).filter(
    (f) => f.endsWith(".ts") || f.endsWith(".mjs"),
  );
  for (const file of sources) {
    const text = readFileSync(join(root, "scripts", file), "utf8");
    for (const m of text.matchAll(/(?:optional|required)\(\s*"([A-Z][A-Z0-9_]*)"/g)) {
      names.add(m[1]);
    }
    for (const m of text.matchAll(/process\.env\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g)) {
      names.add(m[1]);
    }
  }
  return names;
};

const fail = (lines: string[]): never => {
  process.stderr.write(`${lines.join("\n")}\n\n`);
  process.stderr.write(
    ".env.example が .env の唯一の出どころです (setup.sh はこれを写すだけ)。\n" +
      "新しい変数を足したら、値の例と「なぜ要るか」も一緒に書くこと ——\n" +
      "名前だけでは何を入れるべきか分かりません。\n",
  );
  process.exit(1);
};

/**
 * この repo の設定ではない、外から来る変数。**明示した分だけを見逃す。**
 *
 * 以前はここが「`.env.example` に在るものだけ照合する」という条件だった。
 * それだと **env.ts にも .env.example にも無い新しい変数が黙って通る** ——
 * 宣言を忘れたときこそ鳴ってほしいのに、忘れた瞬間だけ鳴らない形になっていた
 * (実際に `CAPTURE_LEDGER_BROWSERHIVE_TLS_CA_PEM` を足したとき素通りした)。
 */
const EXTERNAL_ENV = ["NO_COLOR"];

const inExample = documented();
const inCode = used();
const problems: string[] = [];

for (const name of declared) {
  if (!inExample.has(name)) problems.push(`  - ${name}: env.ts にあるが .env.example に無い`);
}
for (const name of inExample) {
  if (!declared.includes(name)) problems.push(`  - ${name}: .env.example にあるが env.ts に無い`);
}
for (const name of inCode) {
  if (!declared.includes(name) && !EXTERNAL_ENV.includes(name)) {
    problems.push(`  - ${name}: 読んでいるのに env.ts の一覧に無い`);
  }
}

if (problems.length > 0) fail(["環境変数の食い違い:", ...problems]);

process.stdout.write(
  `✓ env check passed: ${String(declared.length)} 個、すべて .env.example にある\n`,
);
