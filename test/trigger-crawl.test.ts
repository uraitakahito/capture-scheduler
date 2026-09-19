import { describe, it, expect, vi, afterEach } from "vitest";
import { main } from "../windmill/f/waggle/trigger_crawl.js";

/**
 * 日次の引き金。**import が 1 つも無く、接続先もトークンも引数で受ける** ——
 * 5 本の中で最も試験しやすい。
 *
 * 待機ループも見ている。`poll_interval_ms` を引数に出したので、実タイマーの
 * ms スケールで回せる (fake timer は使わない —— capture 系の sleep で一度
 * 溶かしている)。
 *
 * **日次の実行が成功したかどうかを決めているのはこのループだけ**で、e2e が触るのは
 * クロールの経路。だからここが唯一の覆い。
 */

/** 1 つの応答。`responding` と待機ループの試験の両方が使う。 */
const reply = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  }) as Response;

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("起こし方", () => {
  it("limit を渡さなければ fromTargets は空のまま", async () => {
    // 空の `fromTargets` が「登録済みの一覧を全部」。上限は capture-ledger 側の既定に委ねる。
    // **`{}` だけを送ってはいけない** —— capture-ledger は「どちらか一方」を要求するので 400 になる。
    const seen = responding(409, {});
    await main("http://capture-ledger:7070", "tok");

    expect(seen[0]!.url).toBe("http://capture-ledger:7070/api/crawls");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ fromTargets: {} });
  });

  it("limit を渡せば載せる", async () => {
    const seen = responding(409, {});
    await main("http://capture-ledger:7070", "tok", 5);
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ fromTargets: { limit: 5 } });
  });

  it("トークンを Bearer で送る", async () => {
    const seen = responding(409, {});
    await main("http://capture-ledger:7070", "tok");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tok");
  });
});

describe("既に走っているとき", () => {
  it("409 は見送りで、再試行しない", async () => {
    // capture-ledger は走行中の 2 本目を部分 unique index で弾く。ここで再試行すると
    // 定期実行が終わらない —— 見送るのが正しい。
    const seen = responding(409, { error: "run already in progress" });
    await expect(main("http://capture-ledger:7070", "tok")).resolves.toEqual({
      outcome: "skipped",
    });

    // **問い合わせに進んでいないこと。** 進むと存在しない runId を追いかける。
    expect(seen).toHaveLength(1);
  });
});

describe("失敗したときの言い分", () => {
  it("401 には issuer 再起動の示唆を付ける", async () => {
    responding(401, { error: "unauthenticated" });
    await expect(main("http://capture-ledger:7070", "tok")).rejects.toThrow(/issuer/);
  });

  it("404 には付与のしかたまで書く", async () => {
    // 「見てはいけない」と「存在しない」を capture-ledger は区別せずに答えるので、
    // 404 だけでは辿れない。叩くべきコマンドまで書いてある。
    responding(404, { error: "not found" });
    await expect(main("http://capture-ledger:7070", "tok")).rejects.toThrow(/fga:grant submitter/);
  });

  it("route が無い 404 には webhook の 2 行を示し、付与は疑わせない", async () => {
    // capture-ledger が webhook の 2 行無しで起動していると、route ごと無い。本文は Fastify のもの。
    responding(404, {
      message: "Route POST:/api/crawls not found",
      error: "Not Found",
      statusCode: 404,
    });
    const err = (await main("http://capture-ledger:7070", "tok").catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/CAPTURE_LEDGER_CRAWL_WEBHOOK_URL/);
    expect(err.message).not.toMatch(/fga:grant/);
  });

  it("付与の 404 には webhook を疑わせない", async () => {
    // 同じ 404 でも、本文が capture-ledger のものなら route は在る。
    responding(404, { error: "not found" });
    const err = (await main("http://capture-ledger:7070", "tok").catch((e: unknown) => e)) as Error;
    expect(err.message).not.toMatch(/WEBHOOK/);
  });

  it("本文を必ず読む", async () => {
    // status だけだと capture-ledger が返している理由が消える。
    responding(500, { error: "internal error" });
    await expect(main("http://capture-ledger:7070", "tok")).rejects.toThrow(/internal error/);
  });

  it("202 でも 409 でもない成功系は失敗として扱う", async () => {
    // 200 は「起こした」を意味しない。202 だけが受理。
    responding(200, { crawlId: "c1" });
    await expect(main("http://capture-ledger:7070", "tok")).rejects.toThrow(/200/);
  });
});

describe("完了を待つ", () => {
  /** POST は 202、その後の GET は与えた並びを順に返す。最後のものが以後ずっと返る。 */
  const polling = (crawls: unknown[]) => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        if (n === 0) {
          n += 1;
          return Promise.resolve(reply(202, { crawlId: "c1" }));
        }
        const body = crawls[Math.min(n - 1, crawls.length - 1)];
        n += 1;
        return Promise.resolve(reply(200, body));
      }),
    );
  };

  it("running の間は問い合わせ続ける", async () => {
    // **これが無いと走行中を「終わった」と読む。** counts は 0 のまま succeeded で
    // 返り、日次の実行は毎晩緑になる。
    polling([{ state: "running" }, { state: "running" }, { state: "succeeded", pagesCaptured: 3 }]);
    await expect(main("http://w", "tok", undefined, 60_000, 5)).resolves.toMatchObject({
      outcome: "succeeded",
      pagesCaptured: 3,
    });
  });

  it("failed は投げる", async () => {
    // 失敗を成功として返さない。
    polling([{ state: "failed", error: "browserhive unreachable" }]);
    await expect(main("http://w", "tok", undefined, 60_000, 5)).rejects.toThrow(
      /browserhive unreachable/,
    );
  });

  it("理由が無い失敗も投げる", async () => {
    polling([{ state: "failed" }]);
    await expect(main("http://w", "tok", undefined, 60_000, 5)).rejects.toThrow(/理由なし/);
  });

  it("知らない状態を succeeded に落とさない", async () => {
    // **改名の砦。** capture-ledger が field 名を変えると `crawl.state` が undefined になり、
    // running でも failed でもないので、砦が無ければ succeeded で返ってしまう。
    // capture-ledger が古い `status` を返してきた場合。実測でも、改名前の script を
    // 改名後の capture-ledger に当てて、ここが発火することを確かめてある。
    polling([{ status: "succeeded", pagesCaptured: 3 }]);
    await expect(main("http://w", "tok", undefined, 60_000, 5)).rejects.toThrow(
      /知らない状態「undefined」/,
    );
  });

  it("件数が null なら 0 として返す", async () => {
    polling([{ state: "succeeded", pagesDiscovered: null, pagesCaptured: null, stopReason: null }]);
    await expect(main("http://w", "tok", undefined, 60_000, 5)).resolves.toEqual({
      outcome: "succeeded",
      crawlId: "c1",
      pagesDiscovered: 0,
      pagesCaptured: 0,
      stopReason: null,
    });
  });

  it("max_depth で終わっても成功として扱う", async () => {
    // **対象一覧からの取り込みは常にこれ。** 深さ 0 なので「次の段は無い」が
    // 「深さの上限に当たった」として記録される。異常ではないので緑で返す。
    polling([{ state: "succeeded", pagesCaptured: 2, stopReason: "max_depth" }]);
    await expect(main("http://w", "tok", undefined, 60_000, 5)).resolves.toMatchObject({
      outcome: "succeeded",
      stopReason: "max_depth",
    });
  });

  it("問い合わせが失敗したら投げる", async () => {
    // POST 側の失敗とは別の経路。こちらも本文を読む。
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        n += 1;
        return Promise.resolve(
          n === 1 ? reply(202, { crawlId: "c1" }) : reply(500, { error: "boom" }),
        );
      }),
    );
    await expect(main("http://w", "tok", undefined, 60_000, 5)).rejects.toThrow(/boom/);
  });

  it("期限を過ぎたら諦める", async () => {
    // 走ったまま残る —— capture-ledger に中断の口が無いので、ここで殺す術は無い。
    polling([{ state: "running" }]);
    await expect(main("http://w", "tok", undefined, -1, 5)).rejects.toThrow(/終わりませんでした/);
  });
});
