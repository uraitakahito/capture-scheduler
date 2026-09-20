/**
 * 道具が書くファイル。**人が書く `.env` には触らない。**
 *
 * 分けるのは持ち主が違うから —— `.env` は人が決めた値、ここは **走らせてみないと
 * 決まらない値** (Windmill の token と、その token から組み立てた 4 行)。混ぜると、
 * 道具が人の編集を踏む日が来る。
 *
 * ## 書くのは、この repo の中だけ
 *
 * `windmill:bootstrap` は capture-scheduler で打つコマンドなので、capture-scheduler の
 * 中にしか書かない。**打った repo の外が変わるのは、打った人の予想に反する。**
 * capture-ledger に渡したい 4 行は「引き渡しファイル」として自分の中に置き、
 * 取りに行くのは向こうの仕事 (capture-ledger の `pnpm run connect`)。
 *
 * ## 2 枚の性格が違う
 *
 * - `.env.local` —— **行ごとに差し替える**。node が `.env` の後に読むので、名前が
 *   重なればこちらが勝つ。他の行は順番ごと保つ (別の道具の行を消さないため)。
 * - `.dev/capture-ledger.env` —— **丸ごと書き直す**。1 つの道具が 1 度に出す 1 組で、
 *   古い行が生き残るほうが危ない (token が変わっても古い行が残り続ける)。
 *
 * どちらも token を持つので、`.gitignore` に入っていること。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { repoRoot } from "./env.js";

export const ENV_LOCAL = ".env.local";
/** capture-ledger に渡す 4 行の置き場。**読むのは向こうの `pnpm run connect`。** */
export const HANDOFF = join(".dev", "capture-ledger.env");

const ENV_LOCAL_HEADER = `# capture-scheduler の道具が書くファイル。**手で書かない**（手で書くのは .env）。
#
# node は --env-file-if-exists=.env の後にこれを読むので、名前が重なればこちらが勝つ。
# 書くのは pnpm run windmill:bootstrap。消してよい —— 走らせ直せば作り直せる。
`;

const HANDOFF_HEADER = `# capture-scheduler が書いた、capture-ledger に渡す値。
# **読むのは capture-ledger の \`pnpm run connect\`。** 手で貼る必要はない。
#
# 生成: pnpm run windmill:bootstrap（token を作り直すたびに書き換わる）
`;

/**
 * `.env.local` に `名前=値` を書き足す（同じ名前が在れば、その行を置き換える）。
 *
 * @returns 値が動いた名前。「書いた」ではなく「変わった」を言うために要る。
 */
export const upsertEnvLocal = (
  values: Record<string, string>,
  root: string = repoRoot(),
): { path: string; changed: string[] } => {
  const path = join(root, ENV_LOCAL);
  const before = existsSync(path) ? readFileSync(path, "utf8") : ENV_LOCAL_HEADER;
  const lines = before.split("\n");
  const changed: string[] = [];

  for (const [name, value] of Object.entries(values)) {
    // 値の改行は、次の行を黙って別の変数に変えてしまう。名前ごと消える形なので落とす。
    if (/[\r\n]/.test(value)) throw new Error(`${name} の値に改行が入っている`);
    const at = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (at === -1) {
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      lines.push(`${name}=${value}`);
      changed.push(name);
    } else {
      if (lines[at] !== `${name}=${value}`) changed.push(name);
      lines[at] = `${name}=${value}`;
    }
  }

  writeFileSync(path, `${lines.join("\n").replace(/\n+$/, "")}\n`);
  return { path, changed };
};

/**
 * capture-ledger に渡す行を、引き渡しファイルへ **丸ごと** 書く。
 *
 * `.dev/` ごと作る —— 無い前提で走らせても止まらないこと (消してよいファイルなので、
 * 消した人が次に打つのはこのコマンドになる)。
 */
export const writeHandoff = (lines: string[], root: string = repoRoot()): string => {
  const path = join(root, HANDOFF);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${HANDOFF_HEADER}${lines.join("\n")}\n`);
  return path;
};
