/**
 * `windmill/wmill-lock.yaml` の鍵が、いま在る script と flow に当たること。
 *
 * script や flow を消しても、wmill のどの命令もこのファイルの行を消さない。
 * 手で消し忘れると、在りもしない物の hash が残り続ける (`_shape_probe` がそうだった)。
 * hash の値は見ない —— 値は wmill が決める。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { repoRoot } from "../scripts/env.js";

describe("wmill-lock.yaml", () => {
  const lock = parse(readFileSync(join(repoRoot(), "windmill", "wmill-lock.yaml"), "utf8")) as {
    version: string;
    locks: Record<string, string>;
  };
  const keys = Object.keys(lock.locks);

  it("version は v2 で、鍵が 1 本以上ある", () => {
    expect(lock.version).toBe("v2");
    expect(keys.length).toBeGreaterThan(0);
  });

  it("鍵は全部 repo の script か flow に当たる（消した物の行は手で消す）", () => {
    const missing = keys.filter((key) => {
      const base = key.split("+")[0] ?? key;
      const file = key.includes(".flow+") ? join(base, "flow.yaml") : `${base}.script.yaml`;
      return !existsSync(join(repoRoot(), "windmill", file));
    });
    expect(missing).toEqual([]);
  });
});
