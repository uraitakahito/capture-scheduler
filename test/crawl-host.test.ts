import { describe, it, expect } from "vitest";
import {
  captureHost,
  parseEndpoints,
  ServerUnavailable,
  toTarget,
  type BusyRetry,
  type Endpoint,
} from "../windmill/f/waggle/crawl_host.js";

/**
 * 1 ホストぶんの取り込み。**礼儀と、口の選び方と、結果の判定。**
 *
 * `captureHost` は口 (`Endpoint`) を引数で受け、`call()` は `client[method](req, opts, cb)` を
 * 呼ぶだけなので、偽物はただのオブジェクトで足りる —— gRPC も Windmill も要らない。
 *
 * **fake timer は使わない。** capture 系の sleep はここで race される形になりうるし、
 * browserhive で一度それに溶かしている (PR #253)。実タイマーの ms スケールで回す
 * (busy の待ち幅 `FAST` を 1〜2ms にできるのはそのため)。
 */

interface Call {
  target: string;
  url: string;
  at: number;
}

/**
 * 試験で使う取り込みの設定。
 *
 * **既定値を持たせない形にしてある**ので、呼ぶ側が必ず渡す。渡し忘れを既定値が
 * 隠すと、`png` を頼んだ配備が黙って `wacz` だけを取り続けることになる。
 */
const CAPTURE = {
  formats: { png: false, webp: false, html: false, links: true, mhtml: false, wacz: true },
  signing: false,
};

/** busy の待ち。既定の 0.5〜1.5 秒では試験が秒単位になる。 */
const FAST: BusyRetry = { minMs: 1, maxMs: 2 };

/** gRPC の誤りの形。実物は `code` を持った Error なので、それに寄せる。 */
const grpcError = (code: number, message: string): Error =>
  Object.assign(new Error(message), { code });

/** 1 回の `Capture` が返す report の中身。`responses` で順に指定し、最後のものが以後ずっと返る。 */
interface Reply {
  status?: string;
  errorType?: string;
  links?: string;
  /**
   * 応答の manifest の結末。省くと「書けた」(`outcome: "location"`)。`null` は欄の無い応答。
   * 形は proto-loader (`oneofs: true`, `defaults: true`) が実際に返すもの。
   */
  manifest?: { outcome?: string; location?: string; error?: string } | null;
}

/**
 * 偽の BrowserHive の口。`capture(req, opts, cb)` だけを持つ。
 *
 * - `busyTimes`: 先頭から何回 `RESOURCE_EXHAUSTED` を返すか (走行中の口)
 * - `down`: 常に `UNAVAILABLE` (居ない口)
 * - `error`: この誤りをそのまま返す
 * - `failOn`: この URL は code の無い誤りで落とす (投入そのものの失敗)
 */
const fakeEndpoint = (
  target: string,
  options: {
    responses?: Reply[];
    busyTimes?: number;
    down?: boolean;
    error?: Error;
    failOn?: string[];
    calls?: Call[];
    seen?: unknown[];
  } = {},
): Endpoint => {
  const responses = options.responses ?? [{}];
  let busyLeft = options.busyTimes ?? 0;
  let n = 0;
  return {
    target,
    client: {
      capture: (req: { url: string }, _opts: unknown, cb: (e: unknown, r?: unknown) => void) => {
        options.calls?.push({ target, url: req.url, at: Date.now() });
        options.seen?.push(req);
        if (options.down === true) return cb(grpcError(14, "no connection established"));
        if (busyLeft > 0) {
          busyLeft -= 1;
          return cb(grpcError(8, "a capture is already running on this browser"));
        }
        if (options.error !== undefined) return cb(options.error);
        if (options.failOn?.includes(req.url) === true) return cb(new Error("投げられなかった"));
        const reply = responses[Math.min(n, responses.length - 1)] ?? {};
        n += 1;
        const status = reply.status ?? "CAPTURE_STATUS_SUCCESS";
        cb(null, {
          taskId: `task-${req.url}@${target}`,
          report: {
            status,
            artifacts: { links: reply.links ?? "s3://b/x.links.json" },
            ...(reply.errorType === undefined
              ? {}
              : { errorDetails: { type: reply.errorType, message: "boom" } }),
          },
          manifest:
            reply.manifest === undefined
              ? { outcome: "location", location: `s3://b/task-${req.url}.result.json` }
              : reply.manifest,
        });
      },
    } as unknown as Record<string, unknown>,
  };
};

const run = (endpoints: Endpoint[], urls: string[], delayMs = 0, initialDelayMs = 0) =>
  captureHost(endpoints, "m", urls, "c1", CAPTURE, delayMs, initialDelayMs, FAST);

describe("間隔をどこに置くか", () => {
  it("間隔は完了の後に入る（投入の前ではない）", async () => {
    // 取り込みにかかる時間は前もって分からないので、投入から測った間隔は相手が感じる
    // 間隔と無関係。間隔が意味を持つのは「前のページが終わってから、次を投げるまで」に
    // 置いたときだけ。
    const calls: Call[] = [];
    const started = Date.now();

    await run([fakeEndpoint("bh-1", { calls })], ["a", "b", "c"], 60);

    // 3 件、投入の間隔が 60ms 以上空いていること。
    expect(calls).toHaveLength(3);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(55);
    expect(calls[2]!.at - calls[1]!.at).toBeGreaterThanOrEqual(55);
    // 1 件目の前には待たない。
    expect(calls[0]!.at - started).toBeLessThan(50);
  });

  it("initial_delay_ms は 1 件目の前に効く", async () => {
    // 段をまたぐぶん。これが無いと段の境目だけ間隔が空かない (実測 521ms)。
    const calls: Call[] = [];
    const started = Date.now();
    await run([fakeEndpoint("bh-1", { calls })], ["a"], 0, 80);
    expect(calls[0]!.at - started).toBeGreaterThanOrEqual(75);
  });

  it("間隔が 0 なら待たない", async () => {
    const started = Date.now();
    await run([fakeEndpoint("bh-1")], ["a", "b"]);
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe("結果の判定", () => {
  it("SUCCESS なら captured、taskId と時刻を運ぶ", async () => {
    const [result] = await run([fakeEndpoint("bh-1")], ["a"]);

    expect(result!.status).toBe("captured");
    expect(result!.taskId).toBe("task-a@bh-1");
    expect(result!.correlationId).toBe("c1");
    expect(result!.submittedAt).toBeDefined();
    expect(result!.finishedAt).toBeDefined();
  });

  it("SUCCESS でなければ失敗として、理由に status と message を残す", async () => {
    // 1 往復で答えが返るので、「まだ終わっていない」状態は存在しない。SUCCESS でない
    // report はそれ自体が失敗。taskId は必ず載せる —— capture-ledger が manifest から
    // 拾い直す鍵で、落とすと成果物が S3 に在っても永久に台帳へ入らない。
    const endpoint = fakeEndpoint("bh-1", {
      responses: [{ status: "CAPTURE_STATUS_HTTP_ERROR", errorType: "ERROR_TYPE_HTTP" }],
    });
    const [result] = await run([endpoint], ["a"]);

    expect(result!.status).toBe("failed");
    expect(result!.skipReason).toBe("CAPTURE_STATUS_HTTP_ERROR: boom");
    expect(result!.taskId).toBe("task-a@bh-1");
  });
});

describe("成果物の場所", () => {
  it("成功していれば linksLocation を運ぶ", async () => {
    const [result] = await run([fakeEndpoint("bh-1")], ["a"]);
    expect(result!.linksLocation).toBe("s3://b/x.links.json");
  });

  it("空文字なら linksLocation を付けない", async () => {
    // 空文字を成果物の場所として渡すと、capture-ledger 側が S3 の鍵として使ってしまう。
    const [result] = await run([fakeEndpoint("bh-1", { responses: [{ links: "" }] })], ["a"]);
    expect(result).not.toHaveProperty("linksLocation");
  });

  it("失敗していれば linksLocation を付けない", async () => {
    const endpoint = fakeEndpoint("bh-1", { responses: [{ status: "CAPTURE_STATUS_FAILED" }] });
    const [result] = await run([endpoint], ["a"]);
    expect(result).not.toHaveProperty("linksLocation");
  });
});

describe("manifest の結末", () => {
  /**
   * **綴りはこちらで組まない。** 見本の場所は BrowserHive の命名規則では作れない綴りに
   * してある —— 規則どおりの名前だと、taskId から組み直す実装でも同じ値になって緑で通る。
   */
  it("書けた場所をそのまま運ぶ", async () => {
    const location = "s3://b/elsewhere/x y+z.result.json";
    const [result] = await run(
      [fakeEndpoint("bh-1", { responses: [{ manifest: { outcome: "location", location } }] })],
      ["a"],
    );
    expect(result!.manifestLocation).toBe(location);
    expect(result).not.toHaveProperty("manifestError");
  });

  it("書けなかった理由を運ぶ", async () => {
    const error = "s3://b/t_.result.json: not written within 10000ms";
    const [result] = await run(
      [fakeEndpoint("bh-1", { responses: [{ manifest: { outcome: "error", error } }] })],
      ["a"],
    );
    expect(result!.manifestError).toBe(error);
    expect(result).not.toHaveProperty("manifestLocation");
  });

  // v10.0.0 より前の BrowserHive。capture-ledger は結末の無い報告を 400 で断るので、
  // 「無かった」ことを理由として運ぶ。
  it("応答に結末が無ければ、無いと報告する", async () => {
    const [result] = await run([fakeEndpoint("bh-1", { responses: [{ manifest: null }] })], ["a"]);
    expect(result!.manifestError).toMatch(/no manifest outcome/);
    expect(result).not.toHaveProperty("manifestLocation");
  });

  // proto3 の oneof は空文字でも「立っている」。値だけを見る実装はここで場所を運んでしまう。
  it("空の場所は書けたと扱わない", async () => {
    const [result] = await run(
      [fakeEndpoint("bh-1", { responses: [{ manifest: { outcome: "location", location: "" } }] })],
      ["a"],
    );
    expect(result).not.toHaveProperty("manifestLocation");
    expect(result!.manifestError).toMatch(/no manifest outcome/);
  });

  // 投入が通っていないので taskId が無い。結末の欄も付けない —— capture-ledger は
  // 結末だけの報告も 400 にする。
  it("投入が通らなければ、結末の欄も付けない", async () => {
    const [result] = await run([fakeEndpoint("bh-1", { failOn: ["a"] })], ["a"]);
    expect(result!.taskId).toBeUndefined();
    expect(result).not.toHaveProperty("manifestLocation");
    expect(result).not.toHaveProperty("manifestError");
  });
});

describe("1 件の失敗", () => {
  it("残りを止めない", async () => {
    // 木の 1 枝が折れても、他の枝は進めてよい。ここで投げると段が丸ごと落ちる。
    const results = await run([fakeEndpoint("bh-1", { failOn: ["b"] })], ["a", "b", "c"]);

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.status)).toEqual(["captured", "failed", "captured"]);
    expect(results[1]!.skipReason).toBe("投げられなかった");
  });

  it("投入そのものが落ちたときは taskId が無い", async () => {
    // **これは取りこぼしではない。** 投入が通っていないので id は存在しない。
    // capture-ledger 側も「taskId を持つもの」だけを拾い直すので、対象にならないのが正しい。
    const [page] = await run([fakeEndpoint("bh-1", { failOn: ["a"] })], ["a"]);
    expect(page!.status).toBe("failed");
    expect(page!.taskId).toBeUndefined();
  });

  it("deadline を過ぎたら 1 ページの失敗で、taskId は無い", async () => {
    // server が固まって deadline に当たった。答えを受け取っていないので id も無い。
    const endpoint = fakeEndpoint("bh-1", { error: grpcError(4, "Deadline exceeded") });
    const [page] = await run([endpoint], ["a"]);
    expect(page!.status).toBe("failed");
    expect(page!.skipReason).toContain("deadline");
    expect(page!.taskId).toBeUndefined();
  });
});

describe("口を選ぶ", () => {
  /**
   * **BrowserHive は browser 1 台に口 1 つ。** 走行中の口は RESOURCE_EXHAUSTED で断るので、
   * 空いている口を探すのはこちらの仕事。
   */
  it("busy の口は飛ばして次の口に投げる", async () => {
    const calls: Call[] = [];
    const busy = fakeEndpoint("bh-1", { busyTimes: 1, calls });
    const free = fakeEndpoint("bh-2", { calls });
    const [result] = await run([busy, free], ["a"]);

    expect(calls.map((c) => c.target)).toEqual(["bh-1", "bh-2"]);
    expect(result!.status).toBe("captured");
    expect(result!.taskId).toBe("task-a@bh-2");
  });

  it("全部 busy なら少し待ってもう一周する", async () => {
    const calls: Call[] = [];
    const a = fakeEndpoint("bh-1", { busyTimes: 1, calls });
    const b = fakeEndpoint("bh-2", { busyTimes: 1, calls });
    const [result] = await run([a, b], ["a"]);

    // 1 周目は 2 つとも busy、2 周目の先頭で通る。
    expect(calls.map((c) => c.target)).toEqual(["bh-1", "bh-2", "bh-1"]);
    expect(result!.status).toBe("captured");
  });

  it("ページごとに試す順をずらす", async () => {
    // 固定だと先頭の口ばかりに当たり、2 つ目は 1 つ目が busy のときにしか使われない。
    const calls: Call[] = [];
    const a = fakeEndpoint("bh-1", { calls });
    const b = fakeEndpoint("bh-2", { calls });
    await run([a, b], ["a", "b", "c"]);

    expect(calls.map((c) => `${c.url}@${c.target}`)).toEqual(["a@bh-1", "b@bh-2", "c@bh-1"]);
  });

  it("居ない口は飛ばし、残りの口で取り込む", async () => {
    const calls: Call[] = [];
    const down = fakeEndpoint("bh-1", { down: true, calls });
    const ok = fakeEndpoint("bh-2", { calls });
    const [result] = await run([down, ok], ["a"]);

    expect(result!.status).toBe("captured");
    expect(calls.map((c) => c.target)).toEqual(["bh-1", "bh-2"]);
  });

  /**
   * **ここが「server が落ちているクロールが成功で完了する」を止めている。**
   *
   * 潰すと、届かなかったことが「このページは取れない」として台帳に残り、しかも
   * リンクが辿れないので木がそこで切れる。取れなかったのはページのせいではない。
   */
  it("全部居なければ 1 ページの失敗にせず、段ごと落とす", async () => {
    const a = fakeEndpoint("bh-1", { down: true });
    const b = fakeEndpoint("bh-2", { down: true });
    await expect(run([a, b], ["https://example.com/a"])).rejects.toThrow(ServerUnavailable);
  });

  it("居ない口の名前を誤りに載せる", async () => {
    // 2 台のうちどちらを見に行けばよいか、名指しで分かること。
    await expect(run([fakeEndpoint("bh-1", { down: true })], ["a"])).rejects.toThrow("bh-1");
  });
});

describe("一過性の失敗の再試行", () => {
  /**
   * server 側の再試行は v9 で無くなった —— あちらで再試行すると、間隔を測っている
   * こちらを素通りして相手に 2 回目が届く。だから再試行はここで、間隔を空けてから。
   */
  it("一過性の型なら間隔を空けてもう一度だけ試す", async () => {
    const calls: Call[] = [];
    const endpoint = fakeEndpoint("bh-1", {
      calls,
      responses: [{ status: "CAPTURE_STATUS_FAILED", errorType: "ERROR_TYPE_CONNECTION" }, {}],
    });
    const [result] = await run([endpoint], ["a"], 40);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(35);
    expect(result!.status).toBe("captured");
  });

  it("2 回目も駄目なら失敗として返す", async () => {
    const calls: Call[] = [];
    const endpoint = fakeEndpoint("bh-1", {
      calls,
      responses: [{ status: "CAPTURE_STATUS_TIMEOUT", errorType: "ERROR_TYPE_TIMEOUT" }],
    });
    const [result] = await run([endpoint], ["a"]);

    expect(calls).toHaveLength(2);
    expect(result!.status).toBe("failed");
    expect(result!.skipReason).toBe("CAPTURE_STATUS_TIMEOUT: boom");
    expect(result!.taskId).toBe("task-a@bh-1");
  });

  it("一過性でない型は再試行しない", async () => {
    // 404 はもう一度取りに行っても 404。相手に無駄なアクセスを 1 回増やすだけ。
    const calls: Call[] = [];
    const endpoint = fakeEndpoint("bh-1", {
      calls,
      responses: [{ status: "CAPTURE_STATUS_HTTP_ERROR", errorType: "ERROR_TYPE_HTTP" }],
    });
    const [result] = await run([endpoint], ["a"]);

    expect(calls).toHaveLength(1);
    expect(result!.status).toBe("failed");
  });

  it("書き込み先の失敗 (ARTIFACT_SINK) は再試行しない —— 壊れた保管庫にページを撮り直さない", async () => {
    // v10.0.0 から、答えない保管庫はこの型で返る。撮り直しても同じ保管庫に書くだけ。
    const calls: Call[] = [];
    const endpoint = fakeEndpoint("bh-1", {
      calls,
      responses: [{ status: "CAPTURE_STATUS_FAILED", errorType: "ERROR_TYPE_ARTIFACT_SINK" }],
    });
    const [result] = await run([endpoint], ["a"]);

    expect(calls).toHaveLength(1);
    expect(result!.status).toBe("failed");
  });
});

describe("宛先の正規化", () => {
  it("scheme を落とす", () => {
    // gRPC の宛先は URL ではなく `host:port`。scheme を残したまま渡すと
    // `http` という名前の host を DNS に引きに行く。
    expect(toTarget("http://browserhive-1.capture-ledger:50051")).toBe(
      "browserhive-1.capture-ledger:50051",
    );
    expect(toTarget("https://bh:50051")).toBe("bh:50051");
  });

  it("末尾のスラッシュを落とす", () => {
    expect(toTarget("browserhive-1.capture-ledger:50051/")).toBe(
      "browserhive-1.capture-ledger:50051",
    );
  });

  it("すでに host:port ならそのまま", () => {
    expect(toTarget("localhost:50051")).toBe("localhost:50051");
  });
});

describe("口の一覧の読み方", () => {
  it("文字列の JSON 配列を、正規化した宛先の配列にする", () => {
    expect(parseEndpoints('["http://bh-1:50051/", "bh-2:50051"]')).toEqual([
      "bh-1:50051",
      "bh-2:50051",
    ]);
  });

  it("JSON でなければ落ちる", () => {
    // 旧 `browserhive_target` の値 (素の host:port) をそのまま入れた配備がここで止まる。
    expect(() => parseEndpoints("browserhive-1.capture-ledger:50051")).toThrow("JSON");
  });

  it("空の配列は落ちる", () => {
    // 黙って空にすると「口が 1 つも無い」が「全部 busy」と同じ待ちに化ける。
    expect(() => parseEndpoints("[]")).toThrow("空でない");
  });

  it("文字列でない要素は落ちる", () => {
    expect(() => parseEndpoints('[{"target":"bh-1:50051"}]')).toThrow("空でない");
  });
});

describe("取り込む形式", () => {
  it("渡された 6 つをそのまま送る", async () => {
    // **6 つ全部を送る。** proto3 では未設定と false が別物で、落とすと
    // 「指定なし」として届く。何を立てるかを決めるのは capture-ledger 側。
    const seen: unknown[] = [];
    const capture = {
      formats: { png: true, webp: false, html: true, links: false, mhtml: false, wacz: true },
      signing: true,
    };
    await captureHost([fakeEndpoint("bh-1", { seen })], "m", ["a"], "c1", capture, 0, 0, FAST);

    expect((seen[0] as { captureFormats: unknown }).captureFormats).toEqual(capture.formats);
    expect((seen[0] as { signing: unknown }).signing).toBe(true);
  });
});

describe("成果物の送り先", () => {
  const formats = { png: false, webp: false, html: false, links: false, mhtml: false, wacz: true };

  it("渡されたらそのまま送る", async () => {
    const seen: unknown[] = [];
    const sink = { url: "http://capture-ledger:7070/api/sink/c1", token: "tok" };

    await captureHost(
      [fakeEndpoint("bh-1", { seen })],
      "m",
      ["a"],
      "c1",
      { formats, signing: false, artifactSink: sink },
      0,
      0,
      FAST,
    );

    expect((seen[0] as { artifactSink?: unknown }).artifactSink).toEqual(sink);
  });

  it("渡されなければ載せない —— 従来どおり自前の保管庫へ書かせる", async () => {
    // **ここが空でないと、受け口を建てていない配備で取り込みが全部失敗する。**
    const seen: unknown[] = [];

    await captureHost(
      [fakeEndpoint("bh-1", { seen })],
      "m",
      ["a"],
      "c1",
      { formats, signing: false },
      0,
      0,
      FAST,
    );

    expect((seen[0] as { artifactSink?: unknown }).artifactSink).toBeUndefined();
  });
});
