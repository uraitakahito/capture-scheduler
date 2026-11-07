/**
 * クロールの語を、旧い言い方で書いていないかを見張る。規則は下の RULES の 8 つ。
 *
 * ## なぜ要るのか
 *
 * - **クロールの seed は「起点」と書く。** 2026-10 に「種」から「起点」へそろえた（docs・コメント・
 *   試験の注記・Windmill の説明で 15 か所）。capture-ledger も同じ日にそろえている。「種」は読み手に
 *   通じにくく、単独では「しゅ」（種類）とも読める
 * - **クロールは「始める」と書く。** 2026-10 に「起こす」から「始める」へそろえた（doctor・smoke・
 *   Windmill の summary・docs で 51 か所。capture-ledger と capture-workbench も同じ）。目的語の無い「起こす」は
 *   「目を覚まさせる」に読める。プロセス・job・flow の「起こす」（API を起こし直す・webhook で起こす・
 *   次の段を起こす）は別の意味で、見ない
 * - **ページで走らせる物は「スクリプト」、置き場は「台帳」と書く。** 2026-10 に「目録」からそろえた
 *   （doctor の点検の名前「スクリプト」・Windmill の説明・docs・試験の文で 62 か所。capture-ledger と capture-workbench も同じ）。
 *   「目録」は browserhive と wacz-validator では WACZ の中の storage の目録を指す。この repo はそれを
 *   持たないので、全部見る
 * - **network は「通信」と書く。** 2026-11 に「網」（network の 1 字の直訳）から「通信」へそろえた（docs・
 *   試験とコメントの注記で 8 か所。browserhive・capture-ledger・capture-workbench も同じ日にそろえている）。「網」は
 *   読み手に通じにくい。基盤のネットワーク（私設ネットワーク・default ネットワーク）は「ネットワーク」と
 *   書く。「安全網」「網羅」は別の語で、見ない
 * - **クロールの頼みに書く物は「その場の TS」と書く。** 2026-11 に（Jira CAPTURE-83）、「その場の JS」から
 *   そろえた（docs と試験で 17 行）。`scripts` の `inline` は compile の段で strict の TypeScript として検査されるのに、
 *   JS と名乗っていた。JS になるのは変換の後なので、走った JS・JS の hash・束ねた JS はそのまま（capture-ledger と
 *   capture-workbench も見張っている）
 * - **スクリプトの `sites` は「対象サイト」と書く。** 2026-11 に「札」からそろえた。「札」は tag を 1 字で写した
 *   書き手の癖で、読み手に通じない（browserhive・capture-ledger・capture-workbench も見張っている）
 * - **repo の一式は「Web Capture」と書く。** 2026-11 に「crawler」からそろえた。crawler はふつうの名詞と紛れ、
 *   動いている識別子（`crawler-storage`・Windmill の workspace の id）とも同じ字になる（capture-ledger も見張っている）
 * - **7080 番の Web アプリは「capture-workbench」、文で短く書くときは「workbench」と書く。** 2026-11 に「dashboard」から
 *   そろえた（repo の改名に合わせて）。この repo に Grafana の dashboard は無いので、語を全部見る（capture-ledger も同じ）
 *
 * 書き手（人と Claude）は長くこの形で書いてきたので、見張らなければ戻ってくる。
 *
 * ## 何を見るか
 *
 * git が repo の中身と見なす text のファイル（追跡している物と、まだ add していない物）の全行。docs に限らない
 * —— 語は、書かれる場所を選ばずに広がる。
 *
 * - 「種」: 熟語（種類・種別）と、数のあとの「N 種」の外に立つ「種」。種類の意味でも、単独の「種」は
 *   書かない（「この種の」は「こうした」と書く）
 * - 「起こす」: クロールを始める意味の形（OKOSU。capture-ledger・capture-workbench と同じ並び）
 * - 「目録」: 全部
 * - 「網」: 「安全網」「網羅」の外に立つ「網」
 * - 「その場の JS」: 形の並び（OLD_INLINE。capture-ledger・capture-workbench と同じ並び）
 * - 「札」: 全部
 * - 「crawler」: 一式の意味の形の並び（OLD_SUITE。capture-ledger と同じ並び）。`crawler-storage`・`/w/crawler/`・
 *   `workspace crawler`・試験の入力値・ふつうの名詞は見ない
 * - 「dashboard」: 全部（大文字小文字を問わない）
 *
 * ## 見ないもの
 *
 *   - lockfile。この repo の言葉ではない
 *   - この file 自身。説明と、探す字そのものを書くため
 *   - 「起点」を seed の意味で使っているか、「起こす」がクロールの意味か。語の意味は機械には
 *     見えないので、「起こす」は形の並びで見る（並びに無い言い回しは止まらない）
 */
import { readFileSync } from "node:fs";

import { repoFiles } from "./repo-files.js";

const SELF = "scripts/check-terms.ts";
/** 許す形。足すときは、その形が seed の意味を持ちえないことを確かめる。 */
const ALLOWED = /種類|種別|\d\s?種/gu;
/** 「網」を network の意味に取れない形（安全網・網羅）。 */
const NOT_NET = /安全網|網羅/gu;
/**
 * クロールを始める意味の「起こす」の形。capture-ledger・capture-workbench と同じ並び。
 * 足すときは、プロセス・job・flow の「起こす」（webhook で起こす・次の段を起こす）に当たらないことを確かめる。
 */
const OKOSU =
  /クロールを起こ|クロールは起こ|取り込みを起こ|取り込みの実行を起こ|起こしたクロール|起こせ(ます|ません|る|ない|れば|ば|て)|起こす(面|欄|口)|起こした(人|本人|行)|起こしました|起こしてよ|下敷きにして起こ|「起こす」|"起こす"/u;

/**
 * その場で書く物の古い呼び名（2026-11 まで）。JS になるのは変換の後なので、走った JS・JS の hash は当てない。
 * 足すときは、それらと `jsSha256` に当たらないことを確かめる。
 */
const OLD_INLINE =
  /その場の JS|その場で書いた JS|JS の名前|JS の箱|書きかけの JS|この JS の id|その JS の id|\binline JS\b/u;

/**
 * repo の一式の古い呼び名（2026-11 まで）。capture-ledger と同じ並び。
 * 足すときは、動いている識別子（`crawler-storage`・`/w/crawler/`・`workspace crawler`）と、ふつうの名詞
 * （The crawler honoured robots）に当たらないことを確かめる。
 */
const OLD_SUITE =
  /(?<!workspace )\bcrawler ?(の|で|が|を|全体)|\bcrawler repo(s|sitory|sitories)\b|\ball of crawler\b|\b[Tt]he crawler's development\b/u;

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
  {
    find: (line) => line.replace(NOT_NET, "").includes("網"),
    say: "「網」が残っています。network は「通信」（通信の記録・通信が静まる・通信に載せる）、基盤のネットワークは「ネットワーク」と書きます。",
  },
  {
    find: (line) => OLD_INLINE.test(line),
    say: "その場で書く物の古い呼び名が残っています。書く物は TypeScript なので、「その場の TS」と書きます（走った JS・JS の hash はそのまま）。",
  },
  {
    find: (line) => line.includes("札"),
    say: "「札」が残っています。スクリプトの `sites` は「対象サイト」と書きます。",
  },
  {
    find: (line) => OLD_SUITE.test(line),
    say: "repo の一式の古い呼び名が残っています。一式は「Web Capture」と書きます（crawler-storage・workspace の id・ふつうの名詞の crawler はそのまま）。",
  },
  {
    find: (line) => /dashboard/iu.test(line),
    say: "「dashboard」が残っています。7080 番の Web アプリは「capture-workbench」、文で短く書くときは「workbench」と書きます。",
  },
];

// 追跡している物と、まだ add していない新しい物（`repo-files.ts`）。
const files = repoFiles(process.cwd()).filter((f) => f !== SELF && f !== "pnpm-lock.yaml");

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
