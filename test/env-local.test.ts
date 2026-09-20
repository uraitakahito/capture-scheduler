/**
 * 道具が書く 2 枚（`scripts/env-local.ts`）の試験。
 *
 * ここで守りたいのは **2 枚の性格の違い**。`.env.local` は行ごとの差し替えで
 * 他の行を残し、引き渡しファイルは丸ごと書き直して古い行を残さない。逆にすると、
 * 前者は別の道具の値を消し、後者は作り直しても古い token が生き残る。
 *
 * どちらも走らせた repo の中だけを書く。**跨いで書かないこと自体**は試験にできない
 * （書かないことは見えない）ので、根を引数で渡す形にして、試験は使い捨ての場所を渡す。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ENV_LOCAL, HANDOFF, upsertEnvLocal, writeHandoff } from "../scripts/env-local.js";

const roots: string[] = [];

const root = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "capture-scheduler-env-"));
  roots.push(dir);
  return dir;
};

const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() ?? "", { recursive: true, force: true });
});

describe("upsertEnvLocal", () => {
  it("無ければ、手で書かないと断る見出しを付けて作る", () => {
    const dir = root();
    const { changed } = upsertEnvLocal({ WINDMILL_TOKEN: "abc" }, dir);
    const body = read(dir, ENV_LOCAL);
    expect(body).toContain("**手で書かない**");
    expect(body.trimEnd().endsWith("WINDMILL_TOKEN=abc")).toBe(true);
    expect(changed).toEqual(["WINDMILL_TOKEN"]);
  });

  it("同じ名前は行ごと差し替え、他の道具が書いた行は順番ごと残す", () => {
    const dir = root();
    writeFileSync(join(dir, ENV_LOCAL), "# 見出し\nOTHER_TOOL=x\nWINDMILL_TOKEN=old\n");
    upsertEnvLocal({ WINDMILL_TOKEN: "new" }, dir);
    expect(read(dir, ENV_LOCAL)).toBe("# 見出し\nOTHER_TOOL=x\nWINDMILL_TOKEN=new\n");
  });

  it("値が同じなら、変わったとは言わない", () => {
    const dir = root();
    upsertEnvLocal({ WINDMILL_TOKEN: "abc" }, dir);
    expect(upsertEnvLocal({ WINDMILL_TOKEN: "abc" }, dir).changed).toEqual([]);
  });

  it("改行を含む値は落とす —— 次の行が黙って別の変数になるため", () => {
    const dir = root();
    expect(() => upsertEnvLocal({ WINDMILL_TOKEN: "a\nB=c" }, dir)).toThrow("改行");
  });
});

describe("writeHandoff", () => {
  it(".dev/ が無くても書ける —— 消してよいファイルなので、消した人が次に打つのはこれ", () => {
    const dir = root();
    const path = writeHandoff(["A=1", "B=2"], dir);
    expect(existsSync(path)).toBe(true);
    expect(read(dir, HANDOFF)).toContain("A=1\nB=2\n");
  });

  it("丸ごと書き直す —— 古い行が生き残ると、変わったはずの token が残る", () => {
    const dir = root();
    writeHandoff(["CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=old", "STALE=1"], dir);
    writeHandoff(["CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=new"], dir);
    const body = read(dir, HANDOFF);
    expect(body).toContain("CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=new");
    expect(body).not.toContain("old");
    expect(body).not.toContain("STALE");
  });

  it("読む側の名前を書いておく —— 手で貼るファイルだと読み違えられないように", () => {
    const dir = root();
    writeHandoff(["A=1"], dir);
    expect(read(dir, HANDOFF)).toContain("pnpm run connect");
  });
});
