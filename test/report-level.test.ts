import { describe, it, expect, vi, afterEach } from "vitest";
import { main } from "../windmill/f/waggle/report_level.js";

/**
 * 段の報告。**判断は全部 capture-ledger 側**で、ここが送るのは「何が起きたか」だけ。
 *
 * 範囲の絞り込みも重複排除も上限の判定も capture-ledger が持つ。ここに写すと、
 * 2 か所が食い違ったときにどちらが正しいか言えなくなる。
 */

const VARS: Record<string, string> = {
  "u/admin/waggle_api_url": "http://capture-ledger:7070",
  "u/admin/waggle_token": "tok",
};

vi.mock("windmill-client", () => ({
  getVariable: (path: string) => Promise.resolve(VARS[path]),
}));

const responding = (status: number, body: unknown) => {
  const seen: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
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

/** compile の段の出力そのもの。source も運ばれてくるが、台帳へは身元と hash だけを送る。 */
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("報告の送り方", () => {
  it("深さと結果と、走った JS の hash を本文に載せる (source は運ばない)", async () => {
    const seen = responding(200, { next: [], stopReason: null });
    await main("c-1", 2, CAPTURED, COMPILED);

    expect(seen[0]!.url).toBe("http://capture-ledger:7070/api/crawls/c-1/pages");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({
      depth: 2,
      results: CAPTURED,
      compiled: SENT,
    });
  });

  it("本文があるので content-type を送る", async () => {
    // `index_level` と対。**あちらは本文が無いので送ってはいけない。**
    // 同じ形に揃えたくなるが、Fastify の扱いが逆になる。
    const seen = responding(200, { next: [], stopReason: null });
    await main("c-1", 0, CAPTURED, COMPILED);

    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
  });

  it("次の段と打ち切りの理由をそのまま返す", async () => {
    const next = [{ url: "http://m/b", host: "m", depth: 1 }];
    responding(200, { next, stopReason: "max_pages" });
    await expect(main("c-1", 0, CAPTURED, COMPILED)).resolves.toEqual({
      next,
      stopReason: "max_pages",
    });
  });
});

describe("失敗したときの言い分", () => {
  it("401 には issuer 再起動の示唆を付ける", async () => {
    // **この一言で原因が即分かった実績がある。** issuer は起動のたびに鍵を作り直すので、
    // Windmill に入れてあるトークンが黙って無効になる。status だけでは辿れない。
    responding(401, { error: "unauthenticated" });
    await expect(main("c-1", 0, CAPTURED, COMPILED)).rejects.toThrow(/issuer/);
  });

  it("404 には許可の示唆を付ける", async () => {
    // capture-ledger は「見てはいけない」と「存在しない」を区別せずに答えるので、
    // 404 だけでは足りない。クロールの許可を疑う先を書いておく。
    responding(404, { error: "not found" });
    await expect(main("c-1", 0, CAPTURED, COMPILED)).rejects.toThrow(/fga:grant submitter/);
  });

  it("本文を必ず読む", async () => {
    // status だけだと capture-ledger が返している理由が消える。
    responding(500, "crawl is not running");
    await expect(main("c-1", 0, CAPTURED, COMPILED)).rejects.toThrow(/crawl is not running/);
  });
});
