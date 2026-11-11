import { describe, it, expect } from "vitest";
import {
  askedUserAgent,
  captureHost,
  describeRefusal,
  given,
  keptSecrets,
  parseEndpoints,
  resolveSecrets,
  SECRETS_FOLDER,
  ServerUnavailable,
  type Answer,
  type BusyRetry,
  type Endpoint,
} from "../windmill/f/waggle/crawl_host.js";
import { SECRETS_FOLDER_NAME } from "../scripts/doctor/windmill-contents.js";

/**
 * 1 ホストぶんの取り込み。**礼儀と、エンドポイントの選び方と、結果の判定。**
 *
 * `captureHost` はエンドポイント (`Endpoint`) を引数で受け、`Endpoint.capture` は答え (`Answer`) を返す
 * だけなので、偽物はただの関数で足りる —— HTTP も Windmill も要らない。
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
  // 走らせるものを持たないクロール。**これは異常ではない** —— capture-ledger が空配列を渡せば、
  // ページの中では何も走らない。ここでは注入の形ではなく礼儀と再試行を見ているので、
  // いちばん静かな値を置く。
  scripts: [],
};

/** busy の待ち。既定の 0.5〜1.5 秒では試験が秒単位になる。 */
const FAST: BusyRetry = { minMs: 1, maxMs: 2 };

/** deadline に当たった fetch。`AbortSignal.timeout` が投げる形 (name が TimeoutError)。 */
const deadlineError = (): Error =>
  Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

/** 1 回の `Capture` が返す report の中身。`responses` で順に指定し、最後のものが以後ずっと返る。 */
interface Reply {
  status?: string;
  errorType?: string;
  links?: string;
  /**
   * 応答の manifest の結末。省くと「書けた」(`{ location }`)。`null` は欄の無い応答。
   * 形は model の union そのまま。
   */
  manifest?: { location?: string; error?: string } | null;
}

/**
 * 偽の BrowserHive のエンドポイント。
 *
 * - `busyTimes`: 先頭から何回 429 (`Busy`) を返すか (走行中のエンドポイント)
 * - `down`: 常に届かない (fetch が投げる形)
 * - `error`: この誤りをそのまま投げる (deadline など)
 * - `refuse`: この答えをそのまま返す (400 / 500 など、200 でない答え)
 * - `failOn`: この URL は 400 で断る (投入そのものの失敗)
 */
const fakeEndpoint = (
  target: string,
  options: {
    responses?: Reply[];
    busyTimes?: number;
    down?: boolean;
    error?: Error;
    refuse?: Answer;
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
    capture: (req: unknown) => {
      const { url } = req as { url: string };
      options.calls?.push({ target, url, at: Date.now() });
      options.seen?.push(req);
      if (options.down === true) return Promise.reject(new TypeError("fetch failed"));
      if (busyLeft > 0) {
        busyLeft -= 1;
        return Promise.resolve({
          status: 429,
          errorType: "Busy",
          body: { message: "a capture is already running on this browser" },
        });
      }
      if (options.error !== undefined) return Promise.reject(options.error);
      if (options.refuse !== undefined) return Promise.resolve(options.refuse);
      if (options.failOn?.includes(url) === true) {
        return Promise.resolve({
          status: 400,
          errorType: "ValidationException",
          body: { message: "投げられなかった" },
        });
      }
      const reply = responses[Math.min(n, responses.length - 1)] ?? {};
      n += 1;
      const status = reply.status ?? "success";
      return Promise.resolve({
        status: 200,
        errorType: null,
        body: {
          taskId: `task-${url}@${target}`,
          report: {
            status,
            artifacts: { links: reply.links ?? "s3://b/x.links.json" },
            ...(reply.errorType === undefined
              ? {}
              : { errorDetails: { type: reply.errorType, message: "boom" } }),
          },
          manifest:
            reply.manifest === undefined
              ? { location: `s3://b/task-${url}.result.json` }
              : reply.manifest,
        },
      });
    },
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
  it("success なら captured、taskId と時刻を運ぶ", async () => {
    const [result] = await run([fakeEndpoint("bh-1")], ["a"]);

    expect(result!.status).toBe("captured");
    expect(result!.taskId).toBe("task-a@bh-1");
    expect(result!.correlationId).toBe("c1");
    expect(result!.submittedAt).toBeDefined();
    expect(result!.finishedAt).toBeDefined();
  });

  it("success でなければ失敗として、理由に status と message を残す", async () => {
    // 1 往復で答えが返るので、「まだ終わっていない」状態は存在しない。success でない
    // report はそれ自体が失敗。taskId は必ず載せる —— capture-ledger が manifest から
    // 拾い直す鍵で、落とすと成果物が S3 に在っても永久に capture-ledger へ入らない。
    const endpoint = fakeEndpoint("bh-1", {
      responses: [{ status: "http_error", errorType: "http" }],
    });
    const [result] = await run([endpoint], ["a"]);

    expect(result!.status).toBe("failed");
    expect(result!.skipReason).toBe("http_error: boom");
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
    const endpoint = fakeEndpoint("bh-1", { responses: [{ status: "failed" }] });
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
      [fakeEndpoint("bh-1", { responses: [{ manifest: { location } }] })],
      ["a"],
    );
    expect(result!.manifestLocation).toBe(location);
    expect(result).not.toHaveProperty("manifestError");
  });

  it("書けなかった理由を運ぶ", async () => {
    const error = "s3://b/t_.result.json: not written within 10000ms";
    const [result] = await run(
      [fakeEndpoint("bh-1", { responses: [{ manifest: { error } }] })],
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

  // 空の場所を「書けた」と読む実装はここで場所を運んでしまう。
  it("空の場所は書けたと扱わない", async () => {
    const [result] = await run(
      [fakeEndpoint("bh-1", { responses: [{ manifest: { location: "" } }] })],
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
    expect(results[1]!.skipReason).toBe("400 ValidationException: 投げられなかった");
  });

  it("投入そのものが断られたときは taskId が無い", async () => {
    // **これは取りこぼしではない。** 投入が通っていないので id は存在しない。
    // capture-ledger 側も「taskId を持つもの」だけを拾い直すので、対象にならないのが正しい。
    const [page] = await run([fakeEndpoint("bh-1", { failOn: ["a"] })], ["a"]);
    expect(page!.status).toBe("failed");
    expect(page!.taskId).toBeUndefined();
  });

  it("server の失敗 (500) も 1 ページの失敗で、名前と status を理由に残す", async () => {
    // 生成 server の InternalFailure は本文が空 (`{}`)。名前と status だけが手掛かり。
    const endpoint = fakeEndpoint("bh-1", {
      refuse: { status: 500, errorType: "InternalFailure", body: {} },
    });
    const [page] = await run([endpoint], ["a"]);
    expect(page!.status).toBe("failed");
    expect(page!.skipReason).toBe("500 InternalFailure");
    expect(page!.taskId).toBeUndefined();
  });

  it("deadline を過ぎたら 1 ページの失敗で、taskId は無い", async () => {
    // server が固まって deadline に当たった。答えを受け取っていないので id も無い。
    const endpoint = fakeEndpoint("bh-1", { error: deadlineError() });
    const [page] = await run([endpoint], ["a"]);
    expect(page!.status).toBe("failed");
    expect(page!.skipReason).toContain("deadline");
    expect(page!.taskId).toBeUndefined();
  });
});

describe("断られた答えの読み方", () => {
  it("status と error の名前と message を 1 行に", () => {
    expect(
      describeRefusal({
        status: 400,
        errorType: "ValidationException",
        body: { message: "1 validation error detected", fieldList: [{ path: "/viewport/width" }] },
      }),
    ).toBe("400 ValidationException: 1 validation error detected");
  });

  it("本文が JSON でなければ、先頭だけを添える", () => {
    expect(
      describeRefusal({ status: 502, errorType: null, body: "<html>bad gateway</html>" }),
    ).toBe("502: <html>bad gateway</html>");
  });
});

describe("エンドポイントを選ぶ", () => {
  /**
   * **BrowserHive は browser 1 台にエンドポイント 1 つ。** 走行中のエンドポイントは 429 (`Busy`) で断るので、
   * 空いているエンドポイントを探すのはこちらの仕事。
   */
  it("busy のエンドポイントは飛ばして次のエンドポイントに投げる", async () => {
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
    // 固定だと先頭のエンドポイントばかりに当たり、2 つ目は 1 つ目が busy のときにしか使われない。
    const calls: Call[] = [];
    const a = fakeEndpoint("bh-1", { calls });
    const b = fakeEndpoint("bh-2", { calls });
    await run([a, b], ["a", "b", "c"]);

    expect(calls.map((c) => `${c.url}@${c.target}`)).toEqual(["a@bh-1", "b@bh-2", "c@bh-1"]);
  });

  it("居ないエンドポイントは飛ばし、残りのエンドポイントで取り込む", async () => {
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
   * 潰すと、届かなかったことが「このページは取れない」として capture-ledger に残り、しかも
   * リンクが辿れないので木がそこで切れる。取れなかったのはページのせいではない。
   */
  it("全部居なければ 1 ページの失敗にせず、段ごと落とす", async () => {
    const a = fakeEndpoint("bh-1", { down: true });
    const b = fakeEndpoint("bh-2", { down: true });
    await expect(run([a, b], ["https://site.test/a"])).rejects.toThrow(ServerUnavailable);
  });

  it("居ないエンドポイントの名前を誤りに載せる", async () => {
    // 2 台のうちどちらを見に行けばよいか、名指しで分かること。
    await expect(run([fakeEndpoint("bh-1", { down: true })], ["a"])).rejects.toThrow("bh-1");
  });

  it("deadline はエンドポイントを飛ばす理由にしない —— 投入は通っているかもしれない", async () => {
    // 固まったエンドポイントの次のエンドポイントで撮り直すと、相手に 2 回目が届く。1 ページの失敗として返す。
    const calls: Call[] = [];
    const stuck = fakeEndpoint("bh-1", { error: deadlineError(), calls });
    const ok = fakeEndpoint("bh-2", { calls });
    const [page] = await run([stuck, ok], ["a"]);
    expect(calls.map((c) => c.target)).toEqual(["bh-1"]);
    expect(page!.status).toBe("failed");
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
      responses: [{ status: "failed", errorType: "connection" }, {}],
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
      responses: [{ status: "timeout", errorType: "timeout" }],
    });
    const [result] = await run([endpoint], ["a"]);

    expect(calls).toHaveLength(2);
    expect(result!.status).toBe("failed");
    expect(result!.skipReason).toBe("timeout: boom");
    expect(result!.taskId).toBe("task-a@bh-1");
  });

  it("一過性でない型は再試行しない", async () => {
    // 404 はもう一度取りに行っても 404。相手に無駄なアクセスを 1 回増やすだけ。
    const calls: Call[] = [];
    const endpoint = fakeEndpoint("bh-1", {
      calls,
      responses: [{ status: "http_error", errorType: "http" }],
    });
    const [result] = await run([endpoint], ["a"]);

    expect(calls).toHaveLength(1);
    expect(result!.status).toBe("failed");
  });

  it("方針を守れなかった失敗 (policy) は再試行しない —— 撮り直しても同じ要求が相手に届く", async () => {
    // BrowserHive v18.0.0 から。deny に当たる WebSocket を開いた頁は、撮り直しても同じ WebSocket を開く。
    const calls: Call[] = [];
    const endpoint = fakeEndpoint("bh-1", {
      calls,
      responses: [{ status: "failed", errorType: "policy" }],
    });
    const [result] = await run([endpoint], ["a"]);

    expect(calls).toHaveLength(1);
    expect(result!.status).toBe("failed");
  });

  it("failed のときは、理由の頭に status でなく型を書く —— 行の状態と重ねて failed: failed: にしない", async () => {
    const endpoint = fakeEndpoint("bh-1", {
      responses: [{ status: "failed", errorType: "renderer_crashed" }],
    });
    const [result] = await run([endpoint], ["a"]);

    expect(result!.status).toBe("failed");
    expect(result!.skipReason).toBe("renderer_crashed: boom");
  });

  it("failed で型が無ければ、理由は failed のまま", async () => {
    const endpoint = fakeEndpoint("bh-1", { responses: [{ status: "failed" }] });
    const [result] = await run([endpoint], ["a"]);

    expect(result!.skipReason).toBe("failed");
  });

  it("主の頁の renderer の crash (renderer_crashed) は再試行しない —— 同じ頁は同じ所で落ちる", async () => {
    // BrowserHive v28.0.0 から。v27 までは同じ事故が timeout を名乗り、ここで撮り直していた。
    const calls: Call[] = [];
    const endpoint = fakeEndpoint("bh-1", {
      calls,
      responses: [{ status: "failed", errorType: "renderer_crashed" }],
    });
    const [result] = await run([endpoint], ["a"]);

    expect(calls).toHaveLength(1);
    expect(result!.status).toBe("failed");
  });

  it("書き込み先の失敗 (artifact_sink) は再試行しない —— 壊れた保管庫にページを撮り直さない", async () => {
    // v10.0.0 から、答えない保管庫はこの型で返る。撮り直しても同じ保管庫に書くだけ。
    const calls: Call[] = [];
    const endpoint = fakeEndpoint("bh-1", {
      calls,
      responses: [{ status: "failed", errorType: "artifact_sink" }],
    });
    const [result] = await run([endpoint], ["a"]);

    expect(calls).toHaveLength(1);
    expect(result!.status).toBe("failed");
  });
});

describe("エンドポイントの一覧の読み方", () => {
  it("URL の JSON 配列を、末尾の / を落として返す", () => {
    expect(parseEndpoints('["http://bh-1:50051/", "https://bh-2:50051"]')).toEqual([
      "http://bh-1:50051",
      "https://bh-2:50051",
    ]);
  });

  it("JSON でなければ落ちる", () => {
    // 旧 `browserhive_target` の値 (素の host:port) をそのまま入れた配備がここで止まる。
    expect(() => parseEndpoints("browserhive-1.capture-ledger:50051")).toThrow("JSON");
  });

  it("scheme の無い宛先は落ちる —— v11 までの host:port", () => {
    // gRPC 時代の綴りのまま v12 のエンドポイントに向けると `http` という名前の host を引きに行く前に止める。
    expect(() => parseEndpoints('["browserhive-1.capture-ledger:50051"]')).toThrow("http(s)://");
  });

  it("空の配列は落ちる", () => {
    // 黙って空にすると「エンドポイントが 1 つも無い」が「全部 busy」と同じ待ちに化ける。
    expect(() => parseEndpoints("[]")).toThrow("空でない");
  });

  it("文字列でない要素は落ちる", () => {
    expect(() => parseEndpoints('[{"target":"http://bh-1:50051"}]')).toThrow("空でない");
  });
});

describe("取り込む形式", () => {
  it("渡された 6 つをそのまま送る", async () => {
    // **6 つ全部を送る。** 何を立てるかを決めるのは capture-ledger 側。
    const seen: unknown[] = [];
    const capture = {
      formats: { png: true, webp: false, html: true, links: false, mhtml: false, wacz: true },
      signing: true,
      scripts: [],
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
      { formats, signing: false, scripts: [], artifactSink: sink },
      0,
      0,
      FAST,
    );

    expect((seen[0] as { artifactSink?: unknown }).artifactSink).toEqual(sink);
  });

  it("渡されなければ載せない —— 従来どおり自前の保管庫へ書かせる", async () => {
    // **ここが空でないと、受け取り先を建てていない配備で取り込みが全部失敗する。**
    const seen: unknown[] = [];

    await captureHost(
      [fakeEndpoint("bh-1", { seen })],
      "m",
      ["a"],
      "c1",
      { formats, signing: false, scripts: [] },
      0,
      0,
      FAST,
    );

    expect((seen[0] as { artifactSink?: unknown }).artifactSink).toBeUndefined();
  });
});

/**
 * **走らせるものを運ぶ。** BrowserHive v11.0.0 から、サーバは顔ぶれを持たない ——
 * 送らなければページの中では何も走らず、それでも取り込みは成功してアーカイブも出る。
 *
 * この層は中身を見ない。見ているのは「capture-ledger が渡したものが、2 つの phase に正しく分かれて、
 * 並びを保ったまま本文に載るか」だけ。欄の綴りは BrowserHive の model (`Script` は
 * id / source / sha256 / options、`behaviors` と `preload` は素の配列) —— 届く形は
 * e2e が本物の server で確かめる。
 */
describe("ページで走らせるスクリプト", () => {
  const formats = { png: false, webp: false, html: false, links: false, mhtml: false, wacz: true };
  const script = (
    id: string,
    phase: "preload" | "behavior",
    options: Record<string, unknown> = {},
  ) => ({ id, version: 3, phase, source: `/* ${id} */`, sha256: "e".repeat(64), options });

  const sendWith = async (scripts: ReturnType<typeof script>[]) => {
    const seen: unknown[] = [];
    await captureHost(
      [fakeEndpoint("bh-1", { seen })],
      "m",
      ["a"],
      "c1",
      { formats, signing: false, scripts },
      0,
      0,
      FAST,
    );
    return seen[0] as {
      behaviors?: Record<string, unknown>[];
      preload?: Record<string, unknown>[];
    };
  };

  it("phase で 2 つに分ける", async () => {
    // 同じ形の 1 本でも、入る phase で約束が違う —— behavior は読み込みの後・主フレーム、
    // preload は遷移の前・全フレーム。混ぜると、どちらで走ったのかを誰も言えない。
    const req = await sendWith([script("autoscroll", "behavior"), script("hide", "preload")]);

    expect(req.behaviors?.map((i) => i["id"])).toEqual(["autoscroll"]);
    expect(req.preload?.map((i) => i["id"])).toEqual(["hide"]);
  });

  it("並びを保つ —— 並びがそのまま実行順", async () => {
    const req = await sendWith([
      script("b", "behavior"),
      script("a", "behavior"),
      script("c", "behavior"),
    ]);
    expect(req.behaviors?.map((i) => i["id"])).toEqual(["b", "a", "c"]);
  });

  it("version は送らない —— 版は capture-ledger の言葉", async () => {
    // BrowserHive の `Script` は id / source / sha256 / options しか持たない。
    // どの版が走ったかは `crawls.scripts` とサーバのログが答える。
    const req = await sendWith([script("autoscroll", "behavior")]);
    expect(req.behaviors?.[0]).toEqual({
      id: "autoscroll",
      source: "/* autoscroll */",
      sha256: "e".repeat(64),
    });
  });

  it("options は JSON の document のまま載せ、空なら載せない", async () => {
    // model では任意の document。`{}` を送ることと省くことは受け側では同じなので、
    // 意味の無い欄を本文に増やさない。
    const req = await sendWith([
      script("autoscroll", "behavior", { maxSteps: 60 }),
      script("autofetch", "behavior"),
    ]);
    expect(req.behaviors?.[0]?.["options"]).toEqual({ maxSteps: 60 });
    expect(req.behaviors?.[1]).not.toHaveProperty("options");
  });

  it("空なら、どちらの鍵も送らない", async () => {
    // **これは異常ではない。** capture-ledger が「何も走らせない」と決めた形。
    const req = await sendWith([]);
    expect(req).not.toHaveProperty("behaviors");
    expect(req).not.toHaveProperty("preload");
  });

  it("片方しか無ければ、その phase だけを送る", async () => {
    const req = await sendWith([script("hide", "preload")]);
    expect(req).not.toHaveProperty("behaviors");
    expect(req.preload).toHaveLength(1);
  });
});

/**
 * **クロールごとの値を運ぶ。** 変数は capture-ledger が固定した名前 → 値、シークレットは `main` が Windmill の
 * 変数から解いた名前 → 値。この層は中身を見ず、要求の `variables` / `secrets` に載せるだけ。
 * 頁の中では受け皿の `__bh.vars` (スクリプトは `defineParams` で読む) / `__bh.secrets` になる。
 */
describe("頼まれた User-Agent", () => {
  const formats = { png: false, webp: false, html: false, links: false, mhtml: false, wacz: true };
  const sendWith = async (userAgent?: string) => {
    const seen: unknown[] = [];
    await captureHost(
      [fakeEndpoint("bh-1", { seen })],
      "m",
      ["a"],
      "c1",
      { formats, signing: false, scripts: [], ...(userAgent !== undefined && { userAgent }) },
      0,
      0,
      FAST,
    );
    return seen[0] as { userAgent?: unknown };
  };

  it("打った字のまま要求に載せる（{chrome} を解かない）", async () => {
    expect((await sendWith("{chrome} BrowserHive")).userAgent).toBe("{chrome} BrowserHive");
  });

  it("空の字なら鍵ごと送らない", async () => {
    expect(await sendWith("")).not.toHaveProperty("userAgent");
  });

  it("届かなければ投げる。null は flow か capture-ledger の取り違えで、黙って Headless のまま撮らせない", () => {
    expect(() => askedUserAgent(null)).toThrow(/user_agent/);
    expect(() => askedUserAgent(undefined)).toThrow(/user_agent/);
  });

  it("空の字は「指定なし」としてそのまま通す", () => {
    expect(askedUserAgent("")).toBe("");
    expect(askedUserAgent("{chrome} BrowserHive")).toBe("{chrome} BrowserHive");
  });
});

describe("クロールごとの値", () => {
  const formats = { png: false, webp: false, html: false, links: false, mhtml: false, wacz: true };
  const sendWith = async (extra: {
    variables?: Record<string, string>;
    secrets?: Record<string, string>;
    secretArchive?: Record<string, "keep">;
  }) => {
    const seen: unknown[] = [];
    await captureHost(
      [fakeEndpoint("bh-1", { seen })],
      "m",
      ["a"],
      "c1",
      { formats, signing: false, scripts: [], ...extra },
      0,
      0,
      FAST,
    );
    return seen[0] as { variables?: unknown; secrets?: unknown };
  };

  it("変数とシークレットを、名前 → 値のまま別々の欄に載せる", async () => {
    const req = await sendWith({
      variables: { query: "個人情報" },
      secrets: { api_token: "s3cr3t-value-1234" },
    });
    expect(req.variables).toEqual({ query: "個人情報" });
    expect(req.secrets).toEqual({ api_token: "s3cr3t-value-1234" });
  });

  it("空なら鍵ごと送らない —— v21 までの BrowserHive は知らない欄を 400 で断る", async () => {
    const req = await sendWith({ variables: {}, secrets: {} });
    expect(req).not.toHaveProperty("variables");
    expect(req).not.toHaveProperty("secrets");
  });

  it("渡されなければ載せない", async () => {
    const req = await sendWith({});
    expect(req).not.toHaveProperty("variables");
    expect(req).not.toHaveProperty("secrets");
  });

  it("WARC に残すシークレットは、送る secrets に在る名前だけを secretArchive に載せる（無い名前は BrowserHive がクロールの取り込みを全部 400 で断る）", async () => {
    const seen: unknown[] = [];
    await captureHost(
      [fakeEndpoint("bh-1", { seen })],
      "m",
      ["a"],
      "c1",
      {
        formats,
        signing: false,
        scripts: [],
        secrets: { note: "kept-value-1234", password: "hidden-value-5678" },
        secretArchive: { note: "keep", absent: "keep" },
      },
      0,
      0,
      FAST,
    );
    const req = seen[0] as { secrets?: unknown; secretArchive?: unknown };
    expect(req.secrets).toEqual({ note: "kept-value-1234", password: "hidden-value-5678" });
    expect(req.secretArchive).toEqual({ note: "keep" });
  });

  it("送るシークレットが無ければ、secretArchive は鍵ごと送らない（capture-ledger が keep を送っていても）", async () => {
    const without = await sendWith({});
    expect(without).not.toHaveProperty("secretArchive");
    const seen: unknown[] = [];
    await captureHost(
      [fakeEndpoint("bh-1", { seen })],
      "m",
      ["a"],
      "c1",
      { formats, signing: false, scripts: [], secrets: {}, secretArchive: { note: "keep" } },
      0,
      0,
      FAST,
    );
    expect(seen[0]).not.toHaveProperty("secretArchive");
    expect(seen[0]).not.toHaveProperty("secrets");
  });

  it("残すシークレットが無ければ secretArchive は鍵ごと送らず、隠すシークレットだけを載せる", async () => {
    const seen: unknown[] = [];
    await captureHost(
      [fakeEndpoint("bh-1", { seen })],
      "m",
      ["a"],
      "c1",
      {
        formats,
        signing: false,
        scripts: [],
        secrets: { password: "hidden-value-5678" },
        secretArchive: {},
      },
      0,
      0,
      FAST,
    );
    expect(seen[0]).toMatchObject({ secrets: { password: "hidden-value-5678" } });
    expect(seen[0]).not.toHaveProperty("secretArchive");
  });

  it("keptSecrets は secrets に在る名前だけを残し、どちらかが無ければ空", () => {
    expect(keptSecrets({ a: "v", b: "w" }, { a: "keep", c: "keep" })).toEqual({ a: "keep" });
    expect(keptSecrets(undefined, { a: "keep" })).toEqual({});
    expect(keptSecrets({ a: "v" }, undefined)).toEqual({});
    // 名前は own property で照らす（prototype の名前を在ると読まない）
    expect(keptSecrets({}, Object.fromEntries([["toString", "keep" as const]]))).toEqual({});
  });

  it("シークレットの値は結果に出ない", async () => {
    // 値が在るのは BrowserHive への要求の本文だけ。PageResult に写れば、capture-ledger の行と Windmill の
    // run の履歴に残る。
    const results = await captureHost(
      [fakeEndpoint("bh-1")],
      "m",
      ["a"],
      "c1",
      { formats, signing: false, scripts: [], secrets: { api_token: "s3cr3t-value-1234" } },
      0,
      0,
      FAST,
    );
    expect(JSON.stringify(results)).not.toContain("s3cr3t-value-1234");
  });
});

describe("flow が省いた入力", () => {
  // Windmill CE の実測: flow の schema に在って capture-ledger が送らなかった欄は null で届く (undefined ではない)。
  it("null も undefined も「無い」", () => {
    expect(given(null)).toBeUndefined();
    expect(given(undefined)).toBeUndefined();
  });

  it("値はそのまま", () => {
    const sink = { url: "http://capture-ledger:7070/api/sink/c1", token: "tok" };
    expect(given(sink)).toBe(sink);
    expect(given({})).toEqual({});
  });
});

describe("シークレットを解く", () => {
  const reads = (values: Record<string, string>) => {
    const asked: string[] = [];
    const read = (path: string): Promise<string> => {
      asked.push(path);
      const value = values[path];
      return value === undefined
        ? Promise.reject(new Error(`Variable ${path} not found`))
        : Promise.resolve(value);
    };
    return { asked, read };
  };

  it("名前 → path を、名前 → 値にする", async () => {
    const { asked, read } = reads({ [`${SECRETS_FOLDER}api_token`]: "s3cr3t-value-1234" });
    await expect(
      resolveSecrets({ api_token: `${SECRETS_FOLDER}api_token` }, read),
    ).resolves.toEqual({ api_token: "s3cr3t-value-1234" });
    expect(asked).toEqual([`${SECRETS_FOLDER}api_token`]);
  });

  it("フォルダの外の path は読まずに投げ、名前と path を言う", async () => {
    // capture-ledger が path を組むので届かないはず。届いたら運ぶ途中で入れ替わったか capture-ledger が壊れたかで、
    // 黙って他の変数 (ledger_client など) を読んで頁に渡してはいけない。
    const { asked, read } = reads({ "u/admin/ledger_client": "the-ledger-client" });
    await expect(resolveSecrets({ api_token: "u/admin/ledger_client" }, read)).rejects.toThrow(
      /secret api_token: u\/admin\/ledger_client は f\/waggle_secrets\/ の下ではない/,
    );
    expect(asked).toEqual([]);
  });

  it("前方一致で似せた path も外", async () => {
    // "f/waggle_secrets_x/…" や "f/waggle_secretsx" のような綴りは、フォルダの区切りまで見ないと通る。
    const { read } = reads({});
    await expect(resolveSecrets({ a: "f/waggle_secretsx/a" }, read)).rejects.toThrow(/下ではない/);
    await expect(resolveSecrets({ a: "xf/waggle_secrets/a" }, read)).rejects.toThrow(/下ではない/);
  });

  it("無い変数は読みが投げたまま (段ごと落ちる)", async () => {
    const { read } = reads({});
    await expect(resolveSecrets({ gone: `${SECRETS_FOLDER}gone` }, read)).rejects.toThrow(
      /not found/,
    );
  });

  it("空なら何も読まない", async () => {
    const { asked, read } = reads({});
    await expect(resolveSecrets({}, read)).resolves.toEqual({});
    expect(asked).toEqual([]);
  });

  it("doctor が見るフォルダの名前と同じ", () => {
    // crawl_host (bun で走る) と doctor (node) は import し合えないので、定数が 2 つ在る。
    // 片方だけ直すと、doctor は ✓ なのに crawl_host が断る (または逆) になる。
    expect(SECRETS_FOLDER).toBe(`f/${SECRETS_FOLDER_NAME}/`);
  });
});
