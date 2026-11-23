/**
 * `scripts/env.ts` の、環境変数を読む関数の試験。
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
  HOST_TS_COMPILE,
  ledgerEnv,
  optional,
  parseWorkerGateway,
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

/**
 * capture-ledger に渡す行 (`connect` が向こうの `.env.local` に写す)。以前は webhook の 2 行だけで、
 * 残り (待ち受けと当時の issuer) を書き漏らした API で 2 度止まった (2026-09-19・20)。ts-compile の宛先は
 * 2026-11-05 に、人が書き足すまで API が起動で止まった。
 */
describe("ledgerEnv", () => {
  it("capture-ledger の変数名で、webhook の URL・token・待ち受け・ts-compile の宛先を返す", () => {
    expect(
      ledgerEnv({
        windmillUrl: "http://127.0.0.1:8000",
        workspace: "crawler",
        token: "tok",
      }),
    ).toEqual([
      "CAPTURE_LEDGER_CRAWL_WEBHOOK_URL=http://127.0.0.1:8000/api/w/crawler/jobs/run/f/f/waggle/crawl_level",
      "CAPTURE_LEDGER_CRAWL_WEBHOOK_TOKEN=tok",
      "CAPTURE_LEDGER_API_HOST=0.0.0.0",
      "CAPTURE_LEDGER_TS_COMPILE_URL=http://127.0.0.1:28080",
    ]);
  });

  // iss は capture-ledger の idp:bootstrap が .env.local に書く (Floci のプールの ID が入る)。
  // こちらの引き渡しが古い iss を持つと、connect がそれで上書きしてしまう。
  it("JWT の名乗りの行 (CAPTURE_LEDGER_OIDC_*) は渡さない", () => {
    const lines = ledgerEnv({
      windmillUrl: "http://127.0.0.1:8000",
      workspace: "crawler",
      token: "tok",
    });
    expect(lines.filter((line) => line.startsWith("CAPTURE_LEDGER_OIDC_"))).toEqual([]);
  });

  it("ts-compile の宛先は、doctor が host から叩く宛先と同じ値", () => {
    const lines = ledgerEnv({
      windmillUrl: "http://127.0.0.1:8000",
      workspace: "crawler",
      token: "tok",
    });
    expect(lines).toContain(`CAPTURE_LEDGER_TS_COMPILE_URL=${HOST_TS_COMPILE}`);
  });
});

/**
 * 2026-11-23 のこの Mac の `container inspect windmill-worker.capture-scheduler` の出力から、
 * `status.networks` と識別に要る所だけを残した物（MAC・IPv6 は例の値に替えた）。gateway は、
 * ネットワークの記録（`container network inspect default` は 192.168.65.1 と言っていた）でなく、
 * worker に実際に配られていた 192.168.64.1。
 */
const INSPECT_WORKER = readFileSync(
  join(repoRoot(), "test/fixtures/container-inspect-worker.json"),
  "utf8",
);

describe("parseWorkerGateway", () => {
  it("worker が実際に持つ gateway を取り出す（実際の出力で）", () => {
    expect(parseWorkerGateway(INSPECT_WORKER)).toBe("192.168.64.1");
  });

  it("ネットワーク default に付いた行を選ぶ（先頭が別のネットワークでも）", () => {
    const json = JSON.stringify([
      {
        status: {
          networks: [
            { network: "probe", ipv4Gateway: "192.168.66.1" },
            { network: "default", ipv4Gateway: "192.168.64.1" },
          ],
        },
      },
    ]);
    expect(parseWorkerGateway(json)).toBe("192.168.64.1");
  });

  it("default に付いた行が無ければ、先頭の行", () => {
    const json = JSON.stringify([
      { status: { networks: [{ network: "probe", ipv4Gateway: "192.168.66.1" }] } },
    ]);
    expect(parseWorkerGateway(json)).toBe("192.168.66.1");
  });

  it.each([
    ["空の配列", "[]"],
    ["networks が無い", '[{"status":{"state":"stopped"}}]'],
    ["networks が空", '[{"status":{"networks":[]}}]'],
    ["IPv4 でない", '[{"status":{"networks":[{"network":"default","ipv4Gateway":"fd89::1"}]}}]'],
    ["JSON でない", "container: command not found"],
  ])(
    "読めなければ、決め打ちへ落とさず CAPTURE_LEDGER_API_URL を名指しして投げる（%s）",
    (_, json) => {
      expect(() => parseWorkerGateway(json)).toThrow(/CAPTURE_LEDGER_API_URL/);
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

  it("書いてあれば、それを使う（worker は訊かない）", () => {
    process.env[KEY_API_URL] = "http://10.0.0.1:7070";
    const inspect = vi.fn(() => INSPECT_WORKER);
    expect(ledgerApiUrl(inspect)).toBe("http://10.0.0.1:7070");
    expect(inspect).not.toHaveBeenCalled();
  });

  it("書いていなければ、worker が実際に持つ gateway から組む", () => {
    expect(ledgerApiUrl(() => INSPECT_WORKER)).toBe("http://192.168.64.1:7070");
  });

  it("worker を訊けなければ、compose を起こす手と CAPTURE_LEDGER_API_URL を名指しして投げる", () => {
    const inspect = () => {
      throw new Error("spawnSync container ENOENT");
    };
    expect(() => ledgerApiUrl(inspect)).toThrow(
      /ENOENT.*container-compose up -d.*CAPTURE_LEDGER_API_URL/,
    );
  });
});
