import { describe, it, expect, vi, afterEach } from "vitest";
import { LEDGER_CLIENT_VAR, answeringToken } from "./helpers/ledger-token.js";
import { main } from "../windmill/f/waggle/report_level.js";

/**
 * 段の報告。**判断は全部 capture-ledger 側**で、ここが送るのは「何が起きたか」だけ。
 *
 * 範囲の絞り込みも重複排除も上限の判定も capture-ledger が持つ。ここに写すと、
 * 2 か所が食い違ったときにどちらが正しいか言えなくなる。
 */

const VARS: Record<string, string> = {
  "u/admin/waggle_api_url": "http://capture-ledger:7070",
  "u/admin/ledger_client": LEDGER_CLIENT_VAR,
};

vi.mock("windmill-client", () => ({
  getVariable: (path: string) => Promise.resolve(VARS[path]),
}));

const responding = (status: number, body: unknown) => {
  const seen: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    answeringToken((url: string, init: RequestInit) => {
      seen.push({ url: String(url), init });
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
      } as Response);
    }),
  );
  return seen;
};

const CAPTURED = [
  {
    url: "http://m/a",
    status: "captured" as const,
    taskId: "t1",
    manifestLocation: "s3://b/t1_c-1.result.json",
  },
];

/** compile の段の出力そのもの。source も運ばれてくるが、capture-ledger へは身元と hash だけを送る。 */
const COMPILED = {
  typescript: "6.0.3",
  hostTypes: "v0.2.0",
  cached: false,
  scripts: [
    {
      id: "autoscroll",
      version: 3,
      phase: "behavior",
      source: '"use strict";\n',
      sha256: "b".repeat(64),
      options: {},
    },
  ],
};
const SENT = {
  typescript: "6.0.3",
  hostTypes: "v0.2.0",
  scripts: [{ id: "autoscroll", version: 3, sha256: "b".repeat(64) }],
};

/** 段の鍵 (CAPTURE-180)。capture-ledger が flow の引数 level_key で渡し、report_level が Idempotency-Key で返す。 */
const LEVEL_KEY = "7a1c0f00-5d2e-4b6a-9c3d-0000000000c1";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("報告の送り方", () => {
  it("深さと結果と、走った JS の hash を本文に載せる (source は運ばない)", async () => {
    const seen = responding(200, { next: [], stopReason: null });
    await main("c-1", 2, LEVEL_KEY, CAPTURED, COMPILED);

    expect(seen[0]!.url).toBe("http://capture-ledger:7070/api/crawls/c-1/pages");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      depth: 2,
      results: CAPTURED,
      compiled: SENT,
    });
  });

  it("段の鍵を Idempotency-Key で返す —— 同じ段の報告の 2 回目に、capture-ledger は最初の答えを返す", async () => {
    const seen = responding(200, { next: [], stopReason: null });
    await main("c-1", 0, LEVEL_KEY, CAPTURED, COMPILED);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe(LEVEL_KEY);
  });

  it("本文があるので content-type を送る", async () => {
    // `index_level` と対。**あちらは本文が無いので送ってはいけない。**
    // 同じ形に揃えたくなるが、Fastify の扱いが逆になる。
    const seen = responding(200, { next: [], stopReason: null });
    await main("c-1", 0, LEVEL_KEY, CAPTURED, COMPILED);

    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  it("次の段と打ち切りの理由をそのまま返す", async () => {
    const next = [{ url: "http://m/b", host: "m", depth: 1 }];
    responding(200, { next, stopReason: "max_pages" });
    await expect(main("c-1", 0, LEVEL_KEY, CAPTURED, COMPILED)).resolves.toEqual({
      next,
      stopReason: "max_pages",
    });
  });
});

describe("run のログ", () => {
  it("終わった理由を書き、打ち切りとは言わない", async () => {
    // `completed` は全部辿った印。「completed で打ち切り」と書くと、ログが逆のことを言う。
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    responding(200, { next: [], stopReason: "completed" });
    await main("c-1", 1, LEVEL_KEY, CAPTURED, COMPILED);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("(終わり: completed)"));
    expect(log.mock.calls.flat().join()).not.toContain("打ち切り");
    log.mockRestore();
  });

  it("次の段があるときは理由を書かない", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    responding(200, { next: [{ url: "http://m/b", host: "m", depth: 1 }], stopReason: null });
    await main("c-1", 0, LEVEL_KEY, CAPTURED, COMPILED);
    expect(log.mock.calls.flat().join()).not.toContain("終わり");
    log.mockRestore();
  });
});

describe("失敗したときの言い分", () => {
  it("401 にはプールの作り直しの示唆を付ける", async () => {
    // **この一言で原因が即分かった実績がある。** Floci はプールをメモリに持つので、スタックを作り直すと
    // Windmill に入れてある資格が黙って無効になる。status だけでは辿れない。
    responding(401, { error: "unauthenticated" });
    await expect(main("c-1", 0, LEVEL_KEY, CAPTURED, COMPILED)).rejects.toThrow(
      /dev:up --from idp/,
    );
  });

  it("404 には許可の示唆を付ける", async () => {
    // capture-ledger は「見てはいけない」と「存在しない」を区別せずに答えるので、
    // 404 だけでは足りない。クロールの許可を疑う先を書いておく。
    responding(404, { error: "not found" });
    await expect(main("c-1", 0, LEVEL_KEY, CAPTURED, COMPILED)).rejects.toThrow(/idp:grant/);
  });

  it("本文を必ず読む", async () => {
    // status だけだと capture-ledger が返している理由が消える。
    responding(500, "crawl is not running");
    await expect(main("c-1", 0, LEVEL_KEY, CAPTURED, COMPILED)).rejects.toThrow(
      /crawl is not running/,
    );
  });
});
