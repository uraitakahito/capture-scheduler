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
 * BrowserHive (v9 以降) は queue も pool も持たない。取り込みは 1 回の `POST /captures` で
 * 終わり、走行中に呼ばれれば 429 (`Busy`) で断る。だから「空いている口を選ぶ」のはここの
 * 仕事 —— endpoint を順に試し、busy なら次、全部 busy なら少し待ってもう一周。
 * server 側の再試行も無くなったので、一過性の失敗をもう一度だけ試すのもここ
 * (間隔を空けてから。再試行も相手から見れば 1 回のアクセス)。
 *
 * ## 契約は HTTP の JSON (BrowserHive v12.0.0)
 *
 * v11 までは gRPC で、proto の写しを Windmill の resource に置き、実行時に読んでいた。
 * v12 から口は restJson1 の HTTP で、契約は browserhive の `model/main.smithy` (OpenAPI は
 * `generated/openapi.json`)。運ぶ物は無くなり、この script が使うのは `fetch` だけ。
 * 断られ方は `x-amzn-errortype` ヘッダ (error の名前) と status で読む ——
 * `ValidationException` (400) と `Busy` (429)。
 */
import * as wmill from "windmill-client";

/** report の `status`。model の綴りそのまま。 */
type CaptureStatus = "success" | "failed" | "timeout" | "http_error";

/** `errorDetails.type`。model の綴りそのまま。 */
type ErrorType =
  | "http"
  | "timeout"
  | "connection"
  | "signing"
  | "internal"
  | "artifact_sink"
  | "cancelled";

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
   * ページの中で走らせるもの。**capture-ledger が目録から解決して、並びごと渡す。**
   *
   * BrowserHive v11.0.0 から、サーバは走らせるものの顔ぶれを持たない —— 送らなければ
   * ページでは何も走らず、それでも取り込みは成功してアーカイブも出る。**この層は
   * 中身を見ない**: 何を走らせるかを決めるのも、順番を決めるのも capture-ledger。
   *
   * 必須にしてある。省ける形にすると、渡し忘れが「スクロールも遅延読み込みもしない
   * クロール」として黙って成功する —— `capture_formats` を必須にしたのと同じ理由。
   */
  scripts: CrawlScript[];
  /**
   * 成果物の押し出し先。**在れば BrowserHive は自前の保管庫へ書かない。**
   *
   * capture-ledger が crawl ごとに 1 回きりで発行するので、ここには「運んできたもの」しか
   * 入らない —— この層は中身を見ないし、作りもしない。
   */
  artifactSink?: { url: string; token: string };
}

/**
 * 走らせるもの 1 本。台帳の目録から解決済みで、ここを素通りして BrowserHive へ行く。
 *
 * `phase` が入る口を決める。`behavior` は読み込みの後・主フレーム・1 回、
 * `preload` は遷移の**前**・iframe を含む全フレーム・遷移のたび。BrowserHive では
 * それぞれ `behaviors` と `preload` という別の欄になる。
 *
 * `sha256` は **BrowserHive が `source` と照合する**。食い違えば `ValidationException` (400)
 * で拒まれる —— 運ぶ途中で入れ替わっていないか、だけを見る仕掛け。
 */
export interface CrawlScript {
  id: string;
  version: number;
  phase: "preload" | "behavior";
  source: string;
  sha256: string;
  options: Record<string, unknown>;
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
 * server の予算が尽きれば `timeout` の report が先に返るので、ここに当たるのは server が
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
 * `artifact_sink` (成果物を書き込み先へ置けなかった) は**入れない**。
 * BrowserHive v10.0.0 から、書き込みに答えない保管庫はこの型で返る (無通信 15 秒 × 3 回、
 * 最悪 65 秒)。保管庫が壊れているときにページごと撮り直すと、1 ページあたり撮影と 65 秒を
 * 捨て、相手へのアクセスも 1 回増える —— 直すべきは保管庫で、ページではない。
 * v9 までは同じ事故が `timeout` や `internal` を名乗っていたので、ここで再試行されていた。
 */
const MAX_ATTEMPTS = 2;
const RETRYABLE: ReadonlySet<string> = new Set<ErrorType>(["connection", "timeout", "internal"]);

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

/** BrowserHive の答え。届いた HTTP の応答をそのまま (status・error の名前・本文)。 */
export interface Answer {
  status: number;
  /** `x-amzn-errortype` ヘッダ —— model の error の名前 (`Busy` / `ValidationException` …)。無ければ null。 */
  errorType: string | null;
  body: unknown;
}

/**
 * BrowserHive の口。`capture` は `POST /captures` を 1 回投げて答えを持ち帰る。
 *
 * **届かなければ投げる** (DNS・拒否・切断・TLS —— `fetch` が投げるもの)。deadline を過ぎたときも
 * 投げる (`name` が `TimeoutError`)。答えが在れば、4xx でも 5xx でも `Answer` で返す。
 *
 * `target` は log のため —— 「どの口が居ないか」を名指しできないと、2 台のうち
 * どちらを見に行けばよいか分からない。
 */
export interface Endpoint {
  target: string;
  capture: (request: unknown) => Promise<Answer>;
}

/** deadline に当たった `fetch`。`AbortSignal.timeout` は `TimeoutError` という名前で投げる。 */
const isDeadline = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError";

/**
 * `u/admin/browserhive_endpoints` の中身。**`http(s)://` で始まる URL の JSON 配列**で、
 * 1 要素が 1 つの口。TLS か平文かは URL の scheme が言う (`https://` なら
 * `u/admin/browserhive_tls_ca` の CA で検証する)。
 *
 * 書くのは `scripts/capture-ledger-token.ts`。形が違えばここで落とす —— 黙って空の
 * 一覧にすると、「口が 1 つも無い」が「全部 busy」と同じ待ちに化ける。v11 までの
 * `host:port` (scheme 無し) もここで止まる。
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
  return parsed.map((entry) => {
    const target = entry.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(target)) {
      throw new Error(
        `browserhive_endpoints は http(s):// の URL にしてください (BrowserHive v12 から HTTP): ${target}`,
      );
    }
    return target;
  });
};

/**
 * 口ごとに `fetch` を包む。
 *
 * **CA が名指しされているときだけ TLS の検証に使う。** 「システムの root で TLS」は用意しない ——
 * BrowserHive の TLS は私設 CA を想定したもので、公開の証明書が要るということは server が
 * 公開インターネット上に在るという意味になるが、そうではない。CA は Bun の `fetch` の
 * `tls.ca` に渡す (Windmill の TypeScript の script は Bun で走る。Node の `fetch` には
 * この口が無い)。平文の口 (`http://`) には効かない。
 */
export const httpEndpoint = (target: string, caPem: string): Endpoint => ({
  target,
  capture: async (request) => {
    const init: RequestInit & { tls?: { ca: string } } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      // 固まった server を永遠に待たない。過ぎれば TimeoutError。
      signal: AbortSignal.timeout(CAPTURE_DEADLINE_MS),
      ...(caPem === "" ? {} : { tls: { ca: caPem } }),
    };
    const res = await fetch(`${target}/captures`, init);
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, errorType: res.headers.get("x-amzn-errortype"), body };
  },
});

interface CaptureResponse {
  taskId?: string;
  report?: {
    status?: CaptureStatus;
    artifacts?: { links?: string };
    errorDetails?: { type?: ErrorType; message?: string };
  };
  /**
   * manifest (`.result.json`) の結末。model の union —— `location` か `error` のどちらか一方が
   * 立つ。欄そのものが無い応答 (v10.0.0 より前の BrowserHive) は `undefined` / `null`。
   */
  manifest?: { location?: string; error?: string } | null;
}

/**
 * 応答の manifest の結末を、報告の欄にする。**export は試験のため。**
 *
 * 欄の無い応答と空の場所は「書けた」と言えないので、理由を付けて error の側に倒す ——
 * capture-ledger はどちらかを必ず受け取る。
 */
export const manifestFields = (
  manifest: CaptureResponse["manifest"],
): { manifestLocation: string } | { manifestError: string } => {
  if (manifest?.location !== undefined && manifest.location !== "") {
    return { manifestLocation: manifest.location };
  }
  if (manifest?.error !== undefined && manifest.error !== "") {
    return { manifestError: manifest.error };
  }
  return { manifestError: "the capture response carried no manifest outcome" };
};

/**
 * 200 でない答えを 1 行にする。**export は試験のため。**
 *
 * 400 (`ValidationException`) は本文の `message` が理由を言う (落ちた欄は `fieldList`)。
 * 500 は生成 server の `InternalFailure` で本文は空。どちらも投入は通っていない ——
 * taskId は無く、capture-ledger の拾い直しの対象にもならない。
 */
export const describeRefusal = (answer: Answer): string => {
  const body = answer.body;
  const message =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { message?: unknown }).message === "string"
      ? (body as { message: string }).message
      : typeof body === "string" && body !== ""
        ? body.slice(0, 200)
        : "";
  const name = answer.errorType ?? "";
  return `${String(answer.status)}${name === "" ? "" : ` ${name}`}${message === "" ? "" : `: ${message}`}`;
};

/** 全 endpoint が busy だったときの待ち。幅の中で散らす —— 揃って待つと揃って当たる。 */
const busyWait = (retry: BusyRetry): Promise<void> =>
  sleep(retry.minMs + Math.random() * (retry.maxMs - retry.minMs));

/**
 * 空いている口に 1 件投げ、答えを持ち帰る。
 *
 * **429 と「届かない」だけは種類が違う。** 他の答えは「この取り込みは駄目だった」だが、
 * 前者は「この口は走行中」なので次の口へ、後者は「この口は居ない」なので以後この呼び出しでは
 * 飛ばす。全部 busy なら少し待ってもう一周。全部居なければ `ServerUnavailable` ——
 * 次のページを試しても同じ答えしか返らない。deadline に当たったときは投げ直す —— 投入は
 * 通っているかもしれず、口を飛ばす理由にはならない。
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
): Promise<Answer> => {
  const down = new Set<Endpoint>();
  for (;;) {
    for (let i = 0; i < endpoints.length; i += 1) {
      const endpoint = endpoints[(start + i) % endpoints.length];
      if (endpoint === undefined || down.has(endpoint)) continue;
      let answer: Answer;
      try {
        answer = await endpoint.capture(request);
      } catch (err) {
        if (isDeadline(err)) throw err;
        log(
          `${endpoint.target} に届かない、以後飛ばす (${err instanceof Error ? err.message : String(err)})`,
        );
        down.add(endpoint);
        continue;
      }
      // model で 429 を返すのは Busy だけ。走行中の口なので次へ。
      if (answer.status === 429) continue;
      return answer;
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
 * 目録の 1 本を、BrowserHive の `Script` の形にする。
 *
 * **`version` は送らない。** あちらは `id` / `source` / `sha256` / `options` しか
 * 持たない —— 版は台帳の言葉で、走る側には関係が無い。どの版が走ったかは
 * `crawls.scripts` とサーバのログが答える。
 *
 * `options` は空のときに送らない。model では任意の document で、`{}` を送ることと省くことは、
 * 受け側 (`__bh.opts[<id>]` が `undefined` になる) では同じ。
 */
const toScript = (script: CrawlScript): Record<string, unknown> => ({
  id: script.id,
  source: script.source,
  sha256: script.sha256,
  ...(Object.keys(script.options).length === 0 ? {} : { options: script.options }),
});

/** 読み込みの後に走らせるもの。**並びがそのまま実行順**になる。 */
const toBehaviors = (scripts: CrawlScript[]): Record<string, unknown> => {
  const items = scripts.filter((s) => s.phase === "behavior").map(toScript);
  return items.length === 0 ? {} : { behaviors: items };
};

/** 遷移の前に入れるもの。**登録した順**に、すべてのフレームで走る。 */
const toPreload = (scripts: CrawlScript[]): Record<string, unknown> => {
  const items = scripts.filter((s) => s.phase === "preload").map(toScript);
  return items.length === 0 ? {} : { preload: items };
};

/**
 * 1 件取り込む。1 往復で答えが返る —— 待つのは deadline だけ。
 *
 * **report が `success` でなければ失敗**。一過性の型 (`RETRYABLE`) なら間隔を空けて
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
    // **6 つ全部を送る。** 何を立てるかを決めるのは capture-ledger。
    captureFormats: capture.formats,
    signing: capture.signing,
    // **口が 2 つある。** `behaviors` は読み込みの後、`preload` は遷移の前。
    // 空なら鍵ごと送らない —— 本文に意味の無い欄を増やさない。
    ...toBehaviors(capture.scripts),
    ...toPreload(capture.scripts),
    // 在れば BrowserHive はここへ押し出し、自前の保管庫へは書かない。
    ...(capture.artifactSink === undefined ? {} : { artifactSink: capture.artifactSink }),
  };

  for (let attempt = 1; ; attempt += 1) {
    const submittedAt = new Date().toISOString();
    let answer: Answer;
    try {
      answer = await captureOnAny(endpoints, request, index % endpoints.length, retry, log);
    } catch (err) {
      if (err instanceof ServerUnavailable) throw err;
      // deadline を過ぎた。**答えを受け取っていない**ので taskId は無く、
      // capture-ledger の拾い直しの対象にもならない —— それで正しい。
      const reason = isDeadline(err)
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
    if (answer.status !== 200) {
      // 断られた (400) か、server の失敗 (500)。投入は通っていないので taskId は無い。
      return {
        url,
        status: "failed",
        submittedAt,
        finishedAt,
        skipReason: describeRefusal(answer),
      };
    }
    const response = answer.body as CaptureResponse;
    const report = response.report;
    const ok = report?.status === "success";
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
      ...(response.taskId === undefined ? {} : { taskId: response.taskId }),
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
 * `Endpoint.capture` は答えを返すだけなので、偽物はただの関数で足りる —— HTTP も
 * Windmill も要らない。`main` に残るのは「変数を読む → 口を包む → ここへ委ねる」だけで、
 * そちらは往復でしか確かめられない。
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
  /**
   * ページの中で走らせるもの。capture-ledger が目録から解決して、**並びごと**渡す。
   *
   * **省けない。** 省ける形にすると、渡し忘れが「何も走らないクロール」として
   * 黙って成功する。空配列を渡すことは意思表示として通る。
   */
  scripts: CrawlScript[],
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
  // 引数は素通りで、宛先が undefined のまま落ちる (実測)。capture-ledger は自分が
  // コンテナからどう見えるかを知らないので、送らせることもできない。
  const targets = parseEndpoints(await wmill.getVariable("u/admin/browserhive_endpoints"));
  // **空文字は「TLS を使わない」。** 変数そのものが無いなら落ちるのが正しい ——
  // 黙って平文に落ちると、TLS のつもりの配備が気づかないまま平文で喋る。
  const caPem = await wmill.getVariable("u/admin/browserhive_tls_ca");
  const endpoints = targets.map((target) => httpEndpoint(target, caPem));
  return captureHost(
    endpoints,
    host,
    urls,
    crawl_id,
    {
      formats: capture_formats,
      signing,
      scripts,
      ...(artifact_sink === undefined ? {} : { artifactSink: artifact_sink }),
    },
    per_host_delay_ms,
    initial_delay_ms,
  );
}
