#!/usr/bin/env node
/**
 * クイックスタートの手が済んでいるかを、節ごとに点検する (`pnpm run doctor`)。
 *
 * 全部 ✓ なら、クロールを起こせば最後まで走る設定になっている。✗ は、何を直すかと、
 * クイックスタートのどの節の手かを言う。親が ✗ の点検は走らせない (`doctor/run.ts`)。
 *
 * **直さない。** push や fga:grant を代わりに打たない —— 認可の判断と、Windmill への
 * push の確かめは人に残す。名指しするだけ。
 *
 * `--e2e` を付けると、e2e の試験が要るもの (capture-fixtures と、試験が名乗る名前の許可) も
 * 見る。`pretest:e2e` がそれ。**vitest の中ではなくここに置く。** globalSetup が throw すると
 * vitest は必ず「No test files found, exiting with code 1」を先に出す (browserhive で実測して
 * ある)。メッセージがどれだけ良くても、読む人はまずファイルのフィルタを疑う。
 *
 * 待たない。profile を間違えて立てたものは待っても来ない。
 */
import { guardEnv } from "./env.js";
import { runDoctor } from "./doctor/checks.js";
import { formatFixes, formatTable } from "./doctor/run.js";

guardEnv();

const results = await runDoctor({ e2e: process.argv.includes("--e2e") });
for (const line of formatTable(results)) console.log(line);

const fixes = formatFixes(results);
if (fixes.length > 0) {
  console.error("");
  for (const line of fixes) console.error(line);
  process.exit(1);
}
