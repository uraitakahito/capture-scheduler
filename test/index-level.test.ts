import { describe, it, expect, vi, afterEach } from "vitest";
import { main } from "../windmill/f/waggle/index_level.js";

/**
 * 索引の step。**判断はゼロで、渡すのは crawl_id だけ** —— 押さえるのはその形と、答えの読み分け。
 *
 * どの archive がまだ索引されていないかは capture-ledger が知っている
 * (`archives.indexed_at IS NULL`)。id の一覧をここで組み立てる形に変わったら、
 * 「何を索引すべきか」の判断が flow へ移ったということ。
 *
 * 検索は台帳の必須の部品 (CAPTURE-53) なので、**どの失敗も黙らせない** —— 以前は 404 を
 * 「検索の無い配備」として飛ばしていたが、その配備はもう無い。
 */

const VARS: Record<string, string> = {
  "u/admin/waggle_api_url": "http://capture-ledger:7070",
  "u/admin/waggle_token": "tok",
};

vi.mock("windmill-client", () => ({
  getVariable: (path: string) => Promise.resolve(VARS[path]),
}));

/** 応答を決める fetch。渡された Request の中身を記録する。 */
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
        text: () => Promise.resolve(JSON.stringify(body)),
      } as Response);
    }),
  );
  return seen;
};

const OK = { pending: 3, indexed: 3, failed: 0, pages: 7 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("capture-ledger への頼み方", () => {
  it("crawl_id だけを URL に載せ、本文は送らない", async () => {
    const seen = responding(202, OK);
    await main("c-1");

    expect(seen[0]!.url).toBe("http://capture-ledger:7070/api/crawls/c-1/index");
    expect(seen[0]!.init.method).toBe("POST");
    expect(seen[0]!.init.body).toBeUndefined();
  });

  it("content-type を送らない", async () => {
    // **本文の無い POST に `application/json` を名乗ると、Fastify が
    // `FST_ERR_CTP_EMPTY_JSON_BODY` で 400 を返す。** 実際に踏んで、flow の
    // index step が赤くなった。「JSON だと言ったのに空」という言い分は正しい。
    const seen = responding(202, { pending: 0, indexed: 0, failed: 0, pages: 0 });
    await main("c-1");

    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers).not.toHaveProperty("content-type");
    expect(headers["authorization"]).toBe("Bearer tok");
  });

  it("4 つの数をそのまま返し、1 行のログに書く", async () => {
    responding(202, OK);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(main("c-1")).resolves.toEqual(OK);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(
      /待っていたアーカイブ 3 本.*載せた 3 本.*載せられなかった 0 本.*索引の件数 7/,
    );
  });
});

describe("載らなかったら段を落とす", () => {
  it("載せられなかったアーカイブがあれば投げる（202 でも）", async () => {
    // 1 本の失敗を、台帳は 202 のまま failed に数える。ここで黙ると、索引に 1 本も無いまま緑になる。
    responding(202, { pending: 2, indexed: 1, failed: 1, pages: 2 });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(main("c-1")).rejects.toThrow(/索引に入らなかったアーカイブが 1 本/);
  });

  it("404 は投げる —— クロールが無いか、許可が無い", async () => {
    // 以前は「検索の無い配備」として飛ばしていた。台帳は検索なしでは起動しなくなったので、
    // 404 はクロールが無いか、トークンの名前に can_submit が無いことしか意味しない。
    responding(404, { error: "not found" });
    await expect(main("c-1")).rejects.toThrow(/404.*can_submit/);
  });

  it("503 は投げ、OpenSearch が答えないと言う", async () => {
    responding(503, { error: "search unavailable" });
    await expect(main("c-1")).rejects.toThrow(/503.*OpenSearch が答えない/);
  });

  it("500 は投げる", async () => {
    responding(500, { error: "internal error" });
    await expect(main("c-1")).rejects.toThrow(/500/);
  });

  it("401 も投げる", async () => {
    responding(401, { error: "unauthenticated" });
    await expect(main("c-1")).rejects.toThrow(/401/);
  });

  it("答えの形が古い（pending・failed が無い）なら投げる", async () => {
    // capture-ledger が古いと `{ indexed, pages }` しか返さない —— 載せられなかった数が分からないので通さない。
    responding(202, { indexed: 3, pages: 3 });
    await expect(main("c-1")).rejects.toThrow(/答えの形が違う/);
  });
});
