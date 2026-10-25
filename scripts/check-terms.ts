/**
 * クロールの語を、旧い言い方で書いていないかを見張る。規則は下の RULES の 3 つ。
 *
 * ## なぜ要るのか
 *
 * - **クロールの seed は「起点」と書く。** 2026-10 に「種」から「起点」へそろえた（docs・コメント・
 *   試験の注記・Windmill の説明で 15 か所）。capture-ledger も同じ日にそろえている。「種」は読み手に
 *   通じにくく、単独では「しゅ」（種類）とも読める
 * - **クロールは「始める」と書く。** 2026-10 に「起こす」から「始める」へそろえた（doctor・smoke・
 *   Windmill の summary・docs で 51 か所。capture-ledger と dashboard も同じ）。目的語の無い「起こす」は
 *   「目を覚まさせる」に読める。プロセス・job・flow の「起こす」（API を起こし直す・webhook で起こす・
 *   次の段を起こす）は別の意味で、見ない
 * - **ページで走らせる物は「スクリプト」、置き場は「台帳」と書く。** 2026-10 に「目録」からそろえた
 *   （doctor の札「スクリプト」・Windmill の説明・docs・試験の文で 62 か所。capture-ledger と dashboard も同じ）。
 *   「目録」は browserhive と wacz-validator では WACZ の中の storage の目録を指す。この repo はそれを
 *   持たないので、全部見る
 *
 * 書き手（人と Claude）は長くこの形で書いてきたので、見張らなければ戻ってくる。
 *
 * ## 何を見るか
 *
 * git が追跡する text のファイルの全行。docs に限らない —— 語は、書かれる場所を選ばずに広がる。
 *
 * - 「種」: 熟語（種類・種別）と、数のあとの「N 種」の外に立つ「種」。種類の意味でも、単独の「種」は
 *   書かない（「この種の」は「こうした」と書く）
 * - 「起こす」: クロールを始める意味の形（OKOSU。capture-ledger・dashboard と同じ並び）
 * - 「目録」: 全部
 *
 * ## 見ないもの
 *
 *   - lockfile。この repo の言葉ではない
 *   - この file 自身。説明と、探す字そのものを書くため
 *   - 「起点」を seed の意味で使っているか、「起こす」がクロールの意味か。語の意味は機械には
 *     見えないので、「起こす」は形の並びで見る（並びに無い言い回しは止まらない）
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SELF = "scripts/check-terms.ts";
/** 許す形。足すときは、その形が seed の意味を持ちえないことを確かめる。 */
const ALLOWED = /種類|種別|\d\s?種/gu;
/**
 * クロールを始める意味の「起こす」の形。capture-ledger・dashboard と同じ並び。
 * 足すときは、プロセス・job・flow の「起こす」（webhook で起こす・次の段を起こす）に当たらないことを確かめる。
 */
const OKOSU =
  /クロールを起こ|クロールは起こ|取り込みを起こ|取り込みの実行を起こ|起こしたクロール|起こせ(ます|ません|る|ない|れば|ば|て)|起こす(面|欄|口)|起こした(人|本人|行)|起こしました|起こしてよ|下敷きにして起こ|「起こす」|"起こす"/u;

const RULES: { find: (line: string) => boolean; say: string }[] = [
  {
    find: (line) => line.replace(ALLOWED, "").includes("種"),
    say: "「種」が残っています。クロールの seed は「起点」と書きます（本で数えるなら「起点の URL が N 本」、種類の意味なら「こうした」など）。",
  },
  {
    find: (line) => OKOSU.test(line),
    say: "「起こす」が残っています。クロールは「始める」と書きます（「始められるか」「始めました」）。",
  },
  {
    find: (line) => line.includes("目録"),
    say: "「目録」が残っています。ページで走らせる物は「スクリプト」、置き場は「台帳」（台帳にスクリプトが無い）と書きます。",
  },
];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f !== "" && f !== SELF && f !== "pnpm-lock.yaml");

const hits: string[][] = RULES.map(() => []);
for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // index に在って手元に無い path（消した直後など）
  }
  if (text.includes("\0")) continue; // 画像などの binary
  text.split("\n").forEach((line, i) => {
    RULES.forEach((rule, r) => {
      if (rule.find(line)) hits[r].push(`${file}:${i + 1}: ${line.trim()}`);
    });
  });
}

for (const [r, rule] of RULES.entries()) {
  if (hits[r].length === 0) continue;
  console.error(rule.say);
  for (const hit of hits[r]) console.error(`  ${hit}`);
}
if (hits.some((list) => list.length > 0)) process.exit(1);
console.log(`check:terms: ${files.length} ファイルを見て、0 件`);
