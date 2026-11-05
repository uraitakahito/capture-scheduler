import { describe, it, expect, vi, afterEach } from "vitest";
import { main } from "../windmill/f/waggle/replay_bundle_level.js";

/**
 * 合本の段 (CAPTURE-57)。**判断はゼロで、渡すのは crawl_id と段の深さだけ** —— 押さえるのはその形と、
 * 答えの読み分け。
 *
 * どの WACZ を入れるかは capture-ledger が知っている (`archives.crawl_id`)。版も台帳が払い出す。
 *
 * 索引の段と違い、**台帳が 200 で返す失敗では投げない** —— 合本は作り直せる派生物で、投げると後ろの索引の段が
 * 飛び、failure_module がクロールを failed で締める。投げるのは 200 で答えなかったときと、答えの形が違うときだけ。
 */

const VARS: Record<string, string> = {
  "u/admin/waggle_api_url": "http://ledger.test:7070",
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

/** 書けた答え。 */
const WROTE = { rev: 2, pages: 7, members: 3, skipped: 1, failed: 0, error: null };

/** ログを黙らせ、呼ばれた文を返す。 */
const quietLog = () => vi.spyOn(console, "log").mockImplementation(() => undefined);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("capture-ledger への頼み方", () => {
  it("crawl_id を URL に、段の深さを JSON の本文に載せて POST する", async () => {
    const seen = responding(200, WROTE);
    quietLog();
    await main("c-1", 2);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://ledger.test:7070/api/crawls/c-1/replay-bundle");
    expect(seen[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ depth: 2 });
  });

  it("起点の段（深さ 0）でも depth を本文に入れる", async () => {
    // 0 は偽値。`depth && …` の形で組むと鍵ごと落ち、台帳は depth が無いと言って 400 を返す。
    const seen = responding(200, WROTE);
    quietLog();
    await main("c-1", 0);

    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ depth: 0 });
  });

  it("本文があるので content-type に application/json を名乗り、Bearer で名乗る", async () => {
    // `index_level` と逆。あちらは本文の無い POST なので名乗ってはいけない。こちらは名乗らないと、
    // Fastify が本文を JSON として読まず、台帳は depth が無いと言って 400 を返す。
    const seen = responding(200, WROTE);
    quietLog();
    await main("c-1", 1);

    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["authorization"]).toBe("Bearer tok");
  });

  it("書けた答えをそのまま返し、版と数を 1 行のログに書く", async () => {
    responding(200, WROTE);
    const log = quietLog();

    await expect(main("c-1", 2)).resolves.toEqual(WROTE);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(
      /r2 を書いた.*頁 7.*WACZ 3 本.*記録が 0 で外した 1 本/,
    );
  });
});

describe("台帳が 200 で返す失敗では投げない（クロールを止めない）", () => {
  it("保管庫に書けなかった（error）は投げずに返し、理由をログに書く", async () => {
    const answer = {
      rev: 3,
      pages: 9,
      members: 4,
      skipped: 0,
      failed: 0,
      error: "could not write r3 to the store: connect ECONNREFUSED",
    };
    responding(200, answer);
    const log = quietLog();

    await expect(main("c-1", 1)).resolves.toEqual(answer);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/r3 を保管庫に書けなかった.*ECONNREFUSED/);
  });

  it("検められなかった WACZ（failed）があっても投げず、数をログに書く", async () => {
    const answer = { ...WROTE, failed: 2 };
    responding(200, answer);
    const log = quietLog();

    await expect(main("c-1", 1)).resolves.toEqual(answer);
    expect(String(log.mock.calls[0]?.[0])).toMatch(/r2 を書いた.*検められなかった WACZ 2 本/);
  });

  it("入れる WACZ がまだ無く書かなかった（rev が null）なら投げない", async () => {
    // 入れる WACZ が 1 本も無い (撮れた頁の無い段・検められなかった WACZ しか無い段)。払い出した版は欠番になる
    const answer = { rev: null, pages: 0, members: 0, skipped: 0, failed: 1, error: null };
    responding(200, answer);
    const log = quietLog();

    await expect(main("c-1", 0)).resolves.toEqual(answer);
    expect(String(log.mock.calls[0]?.[0])).toMatch(
      /まだ無いので書かなかった.*検められなかった WACZ 1 本/,
    );
  });
});

describe("200 で答えなかったら段を落とす", () => {
  it("404 は投げる —— クロールが無いか、許可が無い", async () => {
    responding(404, { error: "not found" });
    await expect(main("c-1", 0)).rejects.toThrow(/replay-bundle → 404.*can_submit/);
  });

  it("口ごと無い 404（capture-ledger が古い）は、そう言って投げる", async () => {
    // Fastify が route を知らないときの本文。台帳の 404 とは本文で分かれる
    responding(404, {
      message: "Route POST:/api/crawls/c-1/replay-bundle not found",
      error: "Not Found",
      statusCode: 404,
    });
    await expect(main("c-1", 0)).rejects.toThrow(/合本の口が無い \(capture-ledger が古い\)/);
  });

  it("401 は投げる", async () => {
    responding(401, { error: "unauthenticated" });
    await expect(main("c-1", 0)).rejects.toThrow(/replay-bundle → 401/);
  });

  it("400 は投げ、depth が渡っているかを見させる", async () => {
    responding(400, { message: "body must have required property 'depth'" });
    await expect(main("c-1", 0)).rejects.toThrow(/replay-bundle → 400.*depth を渡しているか/);
  });

  it("500 は投げる", async () => {
    responding(500, { error: "internal error" });
    await expect(main("c-1", 0)).rejects.toThrow(/replay-bundle → 500/);
  });

  it("答えの形が違う（failed が無い）なら投げる", async () => {
    // 段 2 の計画の形 (failed の無い答え)。検められなかった数が分からないので通さない
    responding(200, { rev: 1, pages: 2, members: 1, skipped: 0, error: null });
    await expect(main("c-1", 0)).rejects.toThrow(/答えの形が違う/);
  });

  it("答えの形が違う（版が 0・error が文字列でない）なら投げる", async () => {
    responding(200, { ...WROTE, rev: 0 });
    await expect(main("c-1", 0)).rejects.toThrow(/答えの形が違う/);
    responding(200, { ...WROTE, error: { message: "x" } });
    await expect(main("c-1", 0)).rejects.toThrow(/答えの形が違う/);
  });
});
