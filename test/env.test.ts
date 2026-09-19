/**
 * `scripts/env.ts` の読み口の試験。
 *
 * **TypeScript 化で初めて書けるようになったもの。** `.mjs` だった頃は
 * 型が無く、vitest から import しても補完も検査も効かなかったので、
 * scripts に対する単体試験は 1 本も無かった (host 側の道具は「動かして
 * 確かめる」しかなかった)。
 *
 * ここで試すのは **空文字の扱い**に絞る。この repo が `??` ではなく
 * `optional` を使う理由そのもので、間違えると「`.env` に `NAME=` と
 * 書いた人が、名前の出ないエラーを遠くで踏む」という形で壊れる。
 * dist ではなくソース (`../scripts/env.js`) を import しているのは、
 * 試験が build に依存すると「ソースが悪いのか古い dist を見ているのか」
 * が分からなくなるため。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CRAWL_FLOW_PATH,
  ledgerApiUrl,
  ledgerWebhookEnv,
  optional,
  parseGateway,
  repoRoot,
  required,
} from "../scripts/env.js";

const KEY = "CAPTURE_SCHEDULER_TEST_ONLY";

describe("optional", () => {
  beforeEach(() => {
    delete process.env[KEY];
  });
  afterEach(() => {
    delete process.env[KEY];
  });

  it("未設定なら既定値を返す", () => {
    expect(optional(KEY, "fallback")).toBe("fallback");
  });

  it("値があればそれを返す", () => {
    process.env[KEY] = "value";
    expect(optional(KEY, "fallback")).toBe("value");
  });

  it("空文字は「無い」と同じに扱う —— `??` との違いはここ", () => {
    process.env[KEY] = "";
    expect(optional(KEY, "fallback")).toBe("fallback");
  });
});

describe("required", () => {
  beforeEach(() => {
    delete process.env[KEY];
  });
  afterEach(() => {
    delete process.env[KEY];
  });

  it("未設定なら名前を含めて投げる", () => {
    expect(() => required(KEY)).toThrow(KEY);
  });

  it("空文字でも投げる（既定値を潰したまま先へ進ませない）", () => {
    process.env[KEY] = "";
    expect(() => required(KEY)).toThrow(KEY);
  });

  it("hint を渡すとメッセージに載る", () => {
    expect(() => required(KEY, "setup.sh を走らせること")).toThrow("setup.sh を走らせること");
  });

  it("値があればそれを返す", () => {
    process.env[KEY] = "value";
    expect(required(KEY)).toBe("value");
  });
});

describe("repoRoot", () => {
  it("cwd を返す —— dist 経由で動いても根を見失わないため", () => {
    expect(repoRoot()).toBe(process.cwd());
  });
});

/**
 * capture-ledger に渡す値。**docs に書き写していた値を、道具が出すようにしたもの。**
 * 書き写しは 2 度古くなった —— webhook の URL の flow の名前 (`…/f/waggle/crawl`) と、
 * コンテナから見た host の IP (`192.168.64.1`)。
 */
describe("CRAWL_FLOW_PATH", () => {
  it("flow の実体が windmill/ の下に在る（名前を変えたら webhook の URL が古くなる）", () => {
    expect(existsSync(join(repoRoot(), "windmill", `${CRAWL_FLOW_PATH}.flow`, "flow.yaml"))).toBe(
      true,
    );
  });
});

describe("ledgerWebhookEnv", () => {
  it("capture-ledger の変数名で、webhook の URL と token の 2 行を返す", () => {
    expect(
      ledgerWebhookEnv({
        windmillUrl: "http://127.0.0.1:8000",
        workspace: "crawler",
        token: "tok",
      }),
    ).toEqual([
      "CAPTURE_LEDGER_CRAWL_WEBHOOK_URL=http://127.0.0.1:8000/api/w/crawler/jobs/run/f/f/waggle/crawl_level",
      "CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=tok",
    ]);
  });
});

/** 2026-09-19 のこの Mac の `container network inspect default` の出力（prettier で空白だけ整えた）。 */
const INSPECT_DEFAULT = readFileSync(
  join(repoRoot(), "test/fixtures/container-network-inspect-default.json"),
  "utf8",
);

describe("parseGateway", () => {
  it("default ネットワークの gateway を取り出す（実際の出力で）", () => {
    expect(parseGateway(INSPECT_DEFAULT)).toBe("192.168.66.1");
  });

  it.each([
    ["空の配列", "[]"],
    ["status が無い", '[{"id":"default"}]'],
    ["IPv4 でない", '[{"status":{"ipv4Gateway":"fd89::1"}}]'],
    ["JSON でない", "container: command not found"],
  ])(
    "読めなければ、決め打ちへ落とさず CAPTURE_LEDGER_API_URL を名指しして投げる（%s）",
    (_, json) => {
      expect(() => parseGateway(json)).toThrow(/CAPTURE_LEDGER_API_URL/);
    },
  );
});

describe("ledgerApiUrl", () => {
  const KEY_API_URL = "CAPTURE_LEDGER_API_URL";
  const saved = process.env[KEY_API_URL];
  beforeEach(() => {
    delete process.env[KEY_API_URL];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY_API_URL];
    else process.env[KEY_API_URL] = saved;
  });

  it("書いてあれば、それを使う（network は訊かない）", () => {
    process.env[KEY_API_URL] = "http://10.0.0.1:7070";
    const inspect = vi.fn(() => INSPECT_DEFAULT);
    expect(ledgerApiUrl(inspect)).toBe("http://10.0.0.1:7070");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("書いていなければ、default ネットワークの gateway から組む", () => {
    expect(ledgerApiUrl(() => INSPECT_DEFAULT)).toBe("http://192.168.66.1:7070");
  });

  it("network を訊けなければ、CAPTURE_LEDGER_API_URL を名指しして投げる", () => {
    const inspect = () => {
      throw new Error("spawnSync container ENOENT");
    };
    expect(() => ledgerApiUrl(inspect)).toThrow(/ENOENT.*CAPTURE_LEDGER_API_URL/);
  });
});
