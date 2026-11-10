#!/usr/bin/env node
/**
 * `wmill` を `.env` の設定で呼ぶ。
 *
 * CLI 自身も `wmill workspace add` で接続先を覚えられるが、それは **`~/.config` に
 * 状態を作る** —— このマシンでだけ動く設定が repo の外に生まれ、`.env` を書き換えても
 * 効かなくなる。接続先は毎回 flag で渡し、出どころを `.env` 1 つに保つ。
 *
 * `wmill.yaml` は `windmill/` に在るので、そこを cwd にして呼ぶ。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { guardEnv, optional, repoRoot, required, windmillUrl, windmillWorkspace } from "./env.js";

guardEnv();

const syncRoot = join(repoRoot(), "windmill");

/**
 * `wmill` の実体を **PATH に頼らずに** 引く。
 *
 * `pnpm run` から呼ぶときは `node_modules/.bin` が PATH に入るが、
 * `node dist/scripts/wmill.js` と直に叩くと入らない —— そのとき ENOENT になって
 * 「pnpm install は済んでいますか」と的外れなことを言う羽目になる (実際に踏んだ)。
 */
const binary = join(repoRoot(), "node_modules", ".bin", "wmill");
if (!existsSync(binary)) {
  process.stderr.write(`${binary} がありません。pnpm install を実行してください。\n`);
  process.exit(1);
}

const token = required(
  "WINDMILL_TOKEN",
  "pnpm run windmill:bootstrap の出力を .env に貼ってください",
);

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write("usage: pnpm run windmill:cli <wmill の引数...>\n");
  process.exit(1);
}

// `--base-url` を使うときは `--token` と `--workspace` が必須。3 つ揃えて渡す。
const result = spawnSync(
  binary,
  [...args, "--base-url", windmillUrl(), "--token", token, "--workspace", windmillWorkspace()],
  {
    cwd: syncRoot,
    stdio: "inherit",
    env: { ...process.env, NO_COLOR: optional("NO_COLOR", "") === "" ? undefined : "1" },
  },
);

if (result.error !== undefined) {
  process.stderr.write(`wmill を起動できません: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
