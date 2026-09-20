/**
 * 1 つのホストぶんの URL を取り込む。**礼儀はここで守る。**
 *
 * ## なぜ逐次なのか
 *
 * このスクリプトが 1 度に触るホストは 1 つで、その中の URL は **1 件ずつ順に**処理する。
 * flow 側の for-loop がホストを並列にするので、全体としては
 * 「ホストは同時に何本か、1 ホストの中は 1 本ずつ」になる。
 *
 * Windmill の per-key concurrency limit を使わないのは、**Community Edition で効かない**
 * から。実装は `jobs_ee.rs` にあり、OSS ビルドは常に許可を返すスタブになっている
 * (`update_concurrency_counter` が `Ok((true, None))`)。設定は保存も読み取りもされるので、
 * UI では効いて見えて、ゲートだけが素通しになる。**無言で失敗する機能には乗せない。**
 *
 * ## なぜ間隔を「完了の後」に置くのか
 *
 * 取り込みにかかる時間は前もって分からない (2 秒で終わるページも 2 分かかるページもある)。
 * 投入から測った間隔は相手が感じる間隔と無関係で、前が終わった直後に次が届きうる ——
 * **投入時の間隔は相手のサーバに届かない。**
 *
 * 間隔は「前のページが終わってから、次を投げるまで」に置く。そうして初めて、相手から見た
 * アクセスの間隔になる。
 *
 * ## 1 ページは 1 リクエストではない
 *
 * ブラウザはサブリソースまで取るので、1 回の取り込みは相手から見れば数十本のバースト。
 * 既定の 2 秒はそれを踏まえた値で、robots.txt に `Crawl-delay` があればそちらが勝つ。
 *
 * ## BrowserHive は browser 1 台に口 1 つ
 *
 * BrowserHive (v9) は queue も pool も持たない。取り込みは 1 回の `Capture` 呼び出しで
 * 終わり、走行中に呼ばれれば `RESOURCE_EXHAUSTED` で断る。だから「空いている口を選ぶ」
 * のはここの仕事 —— endpoint を順に試し、busy なら次、全部 busy なら少し待ってもう一周。
 * server 側の再試行も無くなったので、一過性の失敗をもう一度だけ試すのもここ
 * (間隔を空けてから。再試行も相手から見れば 1 回のアクセス)。
 */
import * as wmill from "windmill-client";

type CaptureStatus =
  | "CAPTURE_STATUS_UNSPECIFIED"
  | "CAPTURE_STATUS_SUCCESS"
  | "CAPTURE_STATUS_FAILED"
  | "CAPTURE_STATUS_TIMEOUT"
  | "CAPTURE_STATUS_HTTP_ERROR";

/** `CaptureErrorDetails.type`。proto-loader に `enums: String` を指定しているので名前で届く。 */
type ErrorType =
  | "ERROR_TYPE_UNSPECIFIED"
  | "ERROR_TYPE_HTTP"
  | "ERROR_TYPE_TIMEOUT"
  | "ERROR_TYPE_CONNECTION"
  | "ERROR_TYPE_SIGNING"
  | "ERROR_TYPE_INTERNAL"
  | "ERROR_TYPE_ARTIFACT_SINK"
  | "ERROR_TYPE_CANCELLED";

/**
 * 何をどう取り込むか。**capture-ledger が決めて、dispatch の payload で渡す。**
 *
 * ここに既定値を置かないのは意図的 —— flow の schema の既定値は webhook 起動では
 * 埋まらないので、「渡し忘れ」を既定値が隠すと、`png` を頼んだ配備が黙って
 * `wacz` だけを取り続ける。渡されなければ落ちるのが正しい。
 */
export interface CaptureSettings {
  formats: {
    png: boolean;
    webp: boolean;
    html: boolean;
    links: boolean;
    mhtml: boolean;
    wacz: boolean;
  };
  signing: boolean;
  /**
   * 成果物の押し出し先。**在れば BrowserHive は自前の保管庫へ書かない。**
   *
   * capture-ledger が crawl ごとに 1 回きりで発行するので、ここには「運んできたもの」しか
   * 入らない —— この層は中身を見ないし、作りもしない。
   */
  artifactSink?: { url: string; token: string };
}

export interface PageResult {
  url: string;
  status: "captured" | "failed" | "skipped";
  skipReason?: string;
  taskId?: string;
  correlationId?: string;
  /** 礼儀の証拠。capture-ledger がこの 2 つを保存し、後から間隔と重なりを測れるようにする。 */
  submittedAt?: string;
  finishedAt?: string;
  /**
   * `.links.json` の置き場所。**中身は読まない。**
   *
   * 読むのは capture-ledger の仕事にしてある —— あちらは既に S3 の client を持っていて、
   * 範囲の絞り込みと重複排除もあちらに在る。ここで読むと、S3 の資格情報を Windmill にも
   * 配ることになり、「見つけた URL は何か」の判断材料が 2 か所に散る。
   *
   * 到達性は理由ではない: store は crawler で 1 つ (`seaweedfs.crawler-storage`) で、
   * **別ドメインのコンテナからも host からも届く** (実測)。
   */
  linksLocation?: string;
  /**
   * `.result.json` を書けた場所 (`s3://…`)。**綴りはこちらで組まない** —— BrowserHive
   * (または受け口) が応答で答えた場所をそのまま運ぶ。capture-ledger はこれを鍵にして
   * manifest を読み、台帳に書き留める。
   */
  manifestLocation?: string;
  /**
   * 書けなかった理由。**`taskId` を持つ結果は、この 2 つのどちらか一方を必ず持つ** ——
   * capture-ledger は、どちらも持たない報告を 400 で断る。
   */
  manifestError?: string;
}

/**
 * 1 回の `Capture` の deadline。内訳は 3 つ:
 *
 *   130 秒  BrowserHive の取り込みの予算 (`taskTotalMs`。成果物の書き込みまで含む)
 *    10 秒  結果の記録 (manifest) を書く予算。v10.0.0 から、server は書き終えてから答える
 *     5 秒  応答を組み立てて届くまでの余裕
 *
 * server の予算が尽きれば TIMEOUT の report が先に返るので、ここに当たるのは server が
 * 固まったときだけ。server の 2 つの予算のどちらかを広げるなら、先にここを広げること。
 */
const CAPTURE_DEADLINE_MS = 130_000 + 10_000 + 5_000;

/** 全 endpoint が busy だったとき、もう一周するまでの待ち。この幅で散らす。 */
export interface BusyRetry {
  minMs: number;
  maxMs: number;
}
const BUSY_RETRY: BusyRetry = { minMs: 500, maxMs: 1500 };

/**
 * 一過性の失敗はもう一度だけ試す。server 側の再試行は v9 で無くなった ——
 * あちらで再試行すると、間隔を測っているこちらを素通りして相手に 2 回目が届く。
 *
 * `ERROR_TYPE_ARTIFACT_SINK` (成果物を書き込み先へ置けなかった) は**入れない**。
 * BrowserHive v10.0.0 から、書き込みに答えない保管庫はこの型で返る (無通信 15 秒 × 3 回、
 * 最悪 65 秒)。保管庫が壊れているときにページごと撮り直すと、1 ページあたり撮影と 65 秒を
 * 捨て、相手へのアクセスも 1 回増える —— 直すべきは保管庫で、ページではない。
 * v9 までは同じ事故が `TIMEOUT` や `INTERNAL` を名乗っていたので、ここで再試行されていた。
 */
const MAX_ATTEMPTS = 2;
const RETRYABLE: ReadonlySet<string> = new Set<ErrorType>([
  "ERROR_TYPE_CONNECTION",
  "ERROR_TYPE_TIMEOUT",
  "ERROR_TYPE_INTERNAL",
]);

/**
 * gRPC の status code。**数値は wire protocol の一部**なので変わらない
 * (`@grpc/grpc-js` の `status` と同じ値)。
 *
 * ここで名前を付けているのは、`@grpc/grpc-js` を module の先頭で import すると
 * この file の試験に gRPC が要るようになるから —— `captureHost` を偽の client で
 * 回せることがこの分割の取り柄で、それを潰したくない。
 */
const GRPC_DEADLINE_EXCEEDED = 4;
const GRPC_RESOURCE_EXHAUSTED = 8;
const GRPC_UNAVAILABLE = 14;

/**
 * BrowserHive に届かない。**1 ページの失敗として扱ってはいけない。**
 *
 * 潰すと、server が落ちているクロールが「全ページ失敗のクロール」として
 * **成功で完了する**。取れなかったのはページのせいではないのに、台帳には
 * 「このページは取れない」と残り、しかもリンクが辿れないので木がそこで切れる。
 *
 * flow は `skip_failures: false` なので、ここで throw すれば段ごと失敗し、
 * capture-ledger が `crawls` を `failed` で締める。
 */
export class ServerUnavailable extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** gRPC の誤りから status code を取り出す。code を持たないものは `undefined`。 */
const grpcStatus = (err: unknown): number | undefined =>
  typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "number"
    ? (err as { code: number }).code
    : undefined;

/**
 * BrowserHive の口。`client` は proto-loader が作った stub で、`capture(req, opts, cb)` を持つ。
 *
 * `target` は log のため —— 「どの口が居ないか」を名指しできないと、2 台のうち
 * どちらを見に行けばよいか分からない。
 */
export interface Endpoint {
  target: string;
  client: Record<string, unknown>;
}

/**
 * gRPC の宛先は URL ではなく `host:port`。それでも scheme を書く設定 —— 癖で、
 * あるいは HTTP 転送の時代に書かれたものから —— に対しては、`http` という名前の
 * host へ繋ぎに行くのではなく scheme を落とす。capture-ledger の `rpc/client.ts` と同じ規則。
 */
export const toTarget = (server: string): string =>
  server.replace(/^[a-z]+:\/\//, "").replace(/\/+$/, "");

/**
 * `u/admin/browserhive_endpoints` の中身。**文字列の JSON 配列**で、1 要素が 1 つの口。
 *
 * 書くのは `scripts/capture-ledger-token.ts`。形が違えばここで落とす —— 黙って空の
 * 一覧にすると、「口が 1 つも無い」が「全部 busy」と同じ待ちに化ける。
 */
export const parseEndpoints = (raw: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`browserhive_endpoints が JSON ではありません: ${raw.slice(0, 80)}`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((e): e is string => typeof e === "string" && e.trim() !== "")
  ) {
    throw new Error(
      `browserhive_endpoints は空でない文字列の配列にしてください: ${raw.slice(0, 80)}`,
    );
  }
  return parsed.map(toTarget);
};

/**
 * proto を実行時に読み、口ごとに client を 1 つ作る。
 *
 * 生成コードを持ち込まないのは、6308 行を Windmill の script に置きたくないから。
 * proto は自己完結なので、`proto-loader` で足りる。中身は `scripts/push-proto.ts` が
 * resource に入れている。
 */
const connectAll = async (targets: string[], caPem: string): Promise<Endpoint[]> => {
  const [protoLoader, grpc, fs, path, os] = await Promise.all([
    import("@grpc/proto-loader"),
    import("@grpc/grpc-js"),
    import("node:fs"),
    import("node:path"),
    import("node:os"),
  ]);
  // 変数ではなく resource。proto は 16KB あり、変数の上限を超える。
  const { proto: source } = (await wmill.getResource("u/admin/browserhive_proto")) as {
    proto: string;
  };

  // `loadSync` はファイルしか受けないので、一度だけ書き出す。
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bh-")), "capture.proto");
  fs.writeFileSync(file, source);

  const definition = protoLoader.loadSync(file, {
    keepCase: false,
    longs: String,
    // enum を名前で受け取る。数値だと `0` が UNSPECIFIED なのか未設定なのか読めない。
    enums: String,
    defaults: true,
    oneofs: true,
  });
  // 写しが古ければ、1 件も取り込む前に止める (下の `assertKnowsManifestOutcome`)。
  assertKnowsManifestOutcome(definition);
  const pkg = grpc.loadPackageDefinition(definition) as unknown as {
    browserhive: { v1: { CaptureService: new (t: string, c: unknown) => Record<string, unknown> } };
  };
  // **CA が名指しされているときだけ TLS。** 「システムの root で TLS」は用意しない ——
  // BrowserHive の TLS は私設 CA を想定したもので、公開の証明書が要るということは
  // server が公開インターネット上に在るという意味になるが、そうではない。
  const creds =
    caPem === ""
      ? grpc.credentials.createInsecure()
      : grpc.credentials.createSsl(Buffer.from(caPem, "utf8"));
  return targets.map((target) => ({
    target,
    client: new pkg.browserhive.v1.CaptureService(target, creds),
  }));
};

/** 1 回の呼び出し。deadline を必ず付ける —— 付けないと固まった server を永遠に待つ。 */
const call = <T>(
  client: Record<string, unknown>,
  method: string,
  request: unknown,
  deadlineMs: number,
): Promise<T> =>
  new Promise((resolve, reject) => {
    (
      client[method] as (
        req: unknown,
        options: { deadline: number },
        cb: (e: unknown, r: T) => void,
      ) => void
    )(request, { deadline: Date.now() + deadlineMs }, (err, res) =>
      err ? reject(err instanceof Error ? err : new Error(String(err))) : resolve(res),
    );
  });

interface CaptureResponse {
  taskId: string;
  report?: {
    status: CaptureStatus;
    artifacts?: { links?: string };
    errorDetails?: { type: ErrorType; message: string };
  };
  /**
   * manifest (`.result.json`) の結末。proto の `oneof outcome`。proto-loader に
   * `oneofs: true` を渡しているので、立っている側の名前が `outcome` に入る。欄そのものが
   * 無ければ `null` (`defaults: true`)。どれも実測で確かめた形。
   */
  manifest?: { outcome?: "location" | "error"; location?: string; error?: string } | null;
}

/**
 * 応答の manifest の結末を、報告の欄にする。**export は試験のため。**
 *
 * **`outcome` で分ける。** proto3 の oneof は空文字でも「立っている」ので、`location` の
 * 値だけを見ると空の場所を「書けた」と読んでしまう。欄の無い応答 (v10.0.0 より前の
 * BrowserHive) と空の場所は「書けた」と言えないので、理由を付けて error の側に倒す ——
 * capture-ledger はどちらかを必ず受け取る。
 */
/**
 * 読み込んだ proto が、応答の manifest の結末 (`ManifestOutcome`) を知っているか。
 * **export は試験のため。**
 *
 * proto は resource (`u/admin/browserhive_proto`) から読み、その写しは `windmill:push` では
 * 更新されない (`windmill:push-proto` が別に要る)。古い写しのままだと、proto-loader は応答の
 * `manifest` 欄を知らない欄として **黙って落とし**、すべての取り込みが「結末が無い」と
 * 報告される。capture-ledger は鍵の無い取り込みを台帳に入れられないので、**クロールは成功と
 * 記録されるのに台帳には 1 件も入らない** —— 2026-09-14 に実際にそうなった (resource が
 * BrowserHive v10.0.0 より前の 508 行のままだった)。黙って欠けるより、ここで名指しして止める。
 *
 * 欄を知っている写しで、それでも応答に結末が無い (BrowserHive が v10.0.0 より前) ときは
 * 止めない —— そちらは `manifestFields` が理由として運ぶ。
 */
export const assertKnowsManifestOutcome = (definition: Record<string, unknown>): void => {
  if (definition["browserhive.v1.ManifestOutcome"] === undefined) {
    throw new Error(
      "u/admin/browserhive_proto に ManifestOutcome がありません (BrowserHive v10.0.0 より前の写し)。" +
        "このままでは manifest の場所を運べず、台帳に何も入りません。" +
        "capture-scheduler で pnpm run windmill:push-proto を実行してください",
    );
  }
};

export const manifestFields = (
  manifest: CaptureResponse["manifest"],
): { manifestLocation: string } | { manifestError: string } => {
  if (
    manifest?.outcome === "location" &&
    manifest.location !== undefined &&
    manifest.location !== ""
  ) {
    return { manifestLocation: manifest.location };
  }
  if (manifest?.outcome === "error" && manifest.error !== undefined && manifest.error !== "") {
    return { manifestError: manifest.error };
  }
  return { manifestError: "the capture response carried no manifest outcome" };
};

/** 全 endpoint が busy だったときの待ち。幅の中で散らす —— 揃って待つと揃って当たる。 */
const busyWait = (retry: BusyRetry): Promise<void> =>
  sleep(retry.minMs + Math.random() * (retry.maxMs - retry.minMs));

/**
 * 空いている口に 1 件投げ、答えを持ち帰る。
 *
 * **`RESOURCE_EXHAUSTED` と `UNAVAILABLE` だけは種類が違う。** 他の誤りは「この取り込みは
 * 駄目だった」だが、前者は「この口は走行中」なので次の口へ、後者は「この口は居ない」
 * なので以後この呼び出しでは飛ばす。全部 busy なら少し待ってもう一周。全部居なければ
 * `ServerUnavailable` —— 次のページを試しても同じ答えしか返らない。
 *
 * 試す順はページごとにずらす (`start`)。固定だと先頭の口ばかりに当たり、
 * 2 つ目は 1 つ目が busy のときにしか使われない。
 */
const captureOnAny = async (
  endpoints: Endpoint[],
  request: unknown,
  start: number,
  retry: BusyRetry,
  log: (message: string) => void,
): Promise<CaptureResponse> => {
  const down = new Set<Endpoint>();
  for (;;) {
    for (let i = 0; i < endpoints.length; i += 1) {
      const endpoint = endpoints[(start + i) % endpoints.length];
      if (endpoint === undefined || down.has(endpoint)) continue;
      try {
        return await call<CaptureResponse>(
          endpoint.client,
          "capture",
          request,
          CAPTURE_DEADLINE_MS,
        );
      } catch (err) {
        const code = grpcStatus(err);
        if (code === GRPC_RESOURCE_EXHAUSTED) continue;
        if (code === GRPC_UNAVAILABLE) {
          log(`${endpoint.target} に届かない、以後飛ばす`);
          down.add(endpoint);
          continue;
        }
        throw err;
      }
    }
    if (down.size === endpoints.length) {
      throw new ServerUnavailable(
        `BrowserHive に届きません: ${[...down].map((e) => e.target).join(", ")}`,
      );
    }
    log("全 endpoint が busy、少し待ってもう一周");
    await busyWait(retry);
  }
};

/**
 * 1 件取り込む。1 往復で答えが返る —— 待つのは gRPC の deadline だけ。
 *
 * **report が SUCCESS でなければ失敗**。一過性の型 (`RETRYABLE`) なら間隔を空けて
 * もう一度だけ試し、それでも駄目ならそのまま返す。`taskId` は必ず載せる ——
 * capture-ledger はこれを鍵に `.result.json` を引き直すので、落とすと成果物が S3 に
 * 在っても台帳へ入らない。
 */
const captureOne = async (
  endpoints: Endpoint[],
  url: string,
  /** このホストの中で何件目か。口を試す順をずらすのに使う。 */
  index: number,
  crawlId: string,
  capture: CaptureSettings,
  delayMs: number,
  retry: BusyRetry,
  log: (message: string) => void,
): Promise<PageResult> => {
  const request = {
    url,
    labels: [],
    correlationId: crawlId,
    // **6 つ全部を送る。** proto3 では未設定と false が別物で、落とすと
    // 「指定なし」として届く。何を立てるかを決めるのは capture-ledger。
    captureFormats: capture.formats,
    signing: capture.signing,
    // 在れば BrowserHive はここへ押し出し、自前の保管庫へは書かない。
    ...(capture.artifactSink === undefined ? {} : { artifactSink: capture.artifactSink }),
  };

  for (let attempt = 1; ; attempt += 1) {
    const submittedAt = new Date().toISOString();
    let response: CaptureResponse;
    try {
      response = await captureOnAny(endpoints, request, index % endpoints.length, retry, log);
    } catch (err) {
      if (err instanceof ServerUnavailable) throw err;
      // deadline を過ぎた、または知らない誤り。**投入は通っていない**ので taskId は無く、
      // capture-ledger の拾い直しの対象にもならない —— それで正しい。
      const reason =
        grpcStatus(err) === GRPC_DEADLINE_EXCEEDED
          ? `deadline ${String(CAPTURE_DEADLINE_MS)}ms を過ぎた`
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        url,
        status: "failed",
        submittedAt,
        finishedAt: new Date().toISOString(),
        skipReason: reason,
      };
    }

    const finishedAt = new Date().toISOString();
    const report = response.report;
    const ok = report?.status === "CAPTURE_STATUS_SUCCESS";
    const links = report?.artifacts?.links;
    const errorType = report?.errorDetails?.type;

    if (!ok && attempt < MAX_ATTEMPTS && errorType !== undefined && RETRYABLE.has(errorType)) {
      // **再試行も相手から見れば 1 回のアクセス。** 間隔を空けてから。
      log(`${url} を再試行 (${errorType})、${String(delayMs)}ms 空ける`);
      if (delayMs > 0) await sleep(delayMs);
      continue;
    }

    const message = report?.errorDetails?.message;
    return {
      url,
      status: ok ? "captured" : "failed",
      taskId: response.taskId,
      correlationId: crawlId,
      submittedAt,
      finishedAt,
      // taskId を持つ結果には、manifest の結末を必ず載せる (上の `manifestFields`)。
      ...manifestFields(response.manifest),
      ...(ok
        ? {}
        : {
            skipReason:
              (report?.status ?? "no report") +
              (message !== undefined && message !== "" ? `: ${message}` : ""),
          }),
      ...(ok && links !== undefined && links !== "" ? { linksLocation: links } : {}),
    };
  }
};

/**
 * 1 ホストぶんを順に取り込む。**礼儀の本体はここ。**
 *
 * `main` から切り出してあるのは、**endpoint を受け取る形なら試験できる**から。
 * `call()` は `client[method](req, opts, cb)` を呼ぶだけなので、偽物はただのオブジェクトで
 * 足りる —— gRPC も Windmill も要らない。`main` に残るのは「変数を読む →
 * つなぐ → ここへ委ねる」だけで、そちらは往復でしか確かめられない。
 *
 * `retry` (busy のときの待ち幅) を引数にしているのも試験のため。既定の 0.5〜1.5 秒の
 * ままだと busy の試験が 1 件ごとに秒単位でかかる。**fake timer は使わない** ——
 * capture 系の sleep で一度溶かしている (browserhive PR #253)。実タイマーの ms スケールで回す。
 */
export const captureHost = async (
  endpoints: Endpoint[],
  host: string,
  urls: string[],
  crawlId: string,
  capture: CaptureSettings,
  perHostDelayMs: number,
  initialDelayMs = 0,
  retry: BusyRetry = BUSY_RETRY,
): Promise<PageResult[]> => {
  const results: PageResult[] = [];
  const log = (message: string): void => {
    console.log(`[${host}] ${message}`);
  };

  // #region pacing
  // **段をまたぐぶんの待ち。** 前の段でこのホストを触っていれば、その完了からの経過を
  // 差し引いた残りをここで待つ。これが無いと段の境目だけ間隔が空かない (実測 521ms)。
  if (initialDelayMs > 0) {
    log(`前の段からの間隔を空ける: ${String(initialDelayMs)}ms`);
    await sleep(initialDelayMs);
  }

  for (const [index, url] of urls.entries()) {
    // **間隔は完了の後。** 1 件目の前は上で済ませてある。
    if (index > 0 && perHostDelayMs > 0) await sleep(perHostDelayMs);

    // #endregion pacing

    log(`${String(index + 1)}/${String(urls.length)} ${url}`);
    // **server が居ないなら、次を試しても同じ答えしか返らない。** `ServerUnavailable` は
    // ここを素通りして段ごと落とす。1 ページの失敗は `captureOne` が自分で
    // `failed` にして返すので、ここで拾うものは無い。
    results.push(
      await captureOne(endpoints, url, index, crawlId, capture, perHostDelayMs, retry, log),
    );
  }

  return results;
};

export async function main(
  crawl_id: string,
  host: string,
  urls: string[],
  per_host_delay_ms: number,
  capture_formats: CaptureSettings["formats"],
  signing: boolean,
  initial_delay_ms = 0,
  /**
   * 成果物の押し出し先。capture-ledger が crawl ごとに 1 回きりで発行する。
   *
   * **省ける。** 省けば BrowserHive は従来どおり自前の保管庫へ書くので、2 つの経路が
   * 同時に生きる。ここを必須にすると、受け口を建てていない配備が動かなくなる。
   *
   * flow は運ぶだけで中身を見ない —— 発行するのも、置き場所を決めるのも capture-ledger。
   */
  artifact_sink?: { url: string; token: string },
): Promise<PageResult[]> {
  // **設定は変数から読む。引数では受けない。**
  // Windmill は schema の既定値を UI からの実行にしか埋めない —— webhook で起こすと
  // 引数は素通りで、宛先が undefined のまま「Channel target must be a string」で
  // 落ちる (実測)。capture-ledger は自分がコンテナからどう見えるかを知らないので、
  // 送らせることもできない。
  const targets = parseEndpoints(await wmill.getVariable("u/admin/browserhive_endpoints"));
  // **空文字は「TLS を使わない」。** 変数そのものが無いなら落ちるのが正しい ——
  // 黙って平文に落ちると、TLS のつもりの配備が気づかないまま平文で喋る。
  const caPem = await wmill.getVariable("u/admin/browserhive_tls_ca");
  const endpoints = await connectAll(targets, caPem);
  return captureHost(
    endpoints,
    host,
    urls,
    crawl_id,
    {
      formats: capture_formats,
      signing,
      ...(artifact_sink === undefined ? {} : { artifactSink: artifact_sink }),
    },
    per_host_delay_ms,
    initial_delay_ms,
  );
}
