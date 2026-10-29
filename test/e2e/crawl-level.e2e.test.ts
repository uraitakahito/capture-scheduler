import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";

/**
 * クロール 1 本を、**production と同じ経路**で通す。
 *
 * ## flow を直接叩かない
 *
 * Windmill の口 (`/jobs/run/f/...`) を直接叩けば速いが、それでは意味が無い。
 * この試験の目的は **capture-ledger が実際に送る引数**を通すことで、capture-ledger が送るのは
 * `crawl_id` / `depth` / `frontier` / `per_host_delay_ms` / `host_parallelism` /
 * `capture_formats` / `signing` と、受け口を出している配備では `artifact_sink`。
 * `respect_robots` は**送られない**。
 *
 * ## なぜ単体では代わりにならないか
 *
 * 引数を渡すのは flow.yaml であって TypeScript ではない。だから
 *
 *   - 引数名を camelCase で書いて null が届いた事故
 *   - schema の `default: true` が webhook 実行では埋まらない事実
 *
 * のどちらも、単体試験では**定義上**赤くならない。実測でも、必須の引数だけ渡して
 * 起こすと `host_parallelism` も `respect_robots` も「渡されていない」まま届く。
 *
 * ## なぜ Windmill の flow test 機能では代わりにならない
 *
 * あちらは UI からの実行で、**UI 実行だけは schema の既定値が埋まる**。
 * つまり robots が守られているように見えて、webhook では守られていない、という
 * 食い違いを隠す。CLI も無いので CI にも載らない (`wmill lint` は引数名の綴り違いも
 * 存在しない script path も素通しすることを確認済み)。
 *
 * ## 判定は capture-fixtures のリクエストログで採る
 *
 * 台帳は「記録したこと」しか言わない。**相手が何を受け取ったか**は相手しか知らない。
 */

const WAGGLE = process.env["E2E_WAGGLE_URL"] ?? "http://127.0.0.1:7070";
const ISSUER = process.env["E2E_ISSUER_URL"] ?? "http://127.0.0.1:9099";
/**
 * capture-ledger のスタックの capture-fixtures。**宛先が 2 つ要る。**
 *
 * `FIXTURES` は**取り込む側**が引く名前 —— 起点の URL に載り、
 * BrowserHive のコンテナがこれを解決する。`FIXTURES_HOST` は**この試験自身**が叩く口で、loopback。
 *
 * 分けるのは macOS 26 の制限のため: Apple 署名でないバイナリ (node) はコンテナの
 * subnet へ TCP を張れず、DNS 名は引けるのに `EHOSTUNREACH` になる
 * (実測 2026-09-20: 同じ URL に curl は 200、node は EHOSTUNREACH)。
 * **1 つの変数では両方を満たせない** —— コンテナの中から 127.0.0.1 は自分自身を指す。
 */
const FIXTURES = process.env["E2E_FIXTURES_URL"] ?? "http://capture-fixtures.capture-ledger:8080";
const FIXTURES_HOST = process.env["E2E_FIXTURES_HOST_URL"] ?? "http://127.0.0.1:18085";

/**
 * Windmill の口。調べ物の script (`f/waggle/inspect_*`) を走らせるのに使う —— doctor・smoke と同じく、
 * この repo の `.env`・`.env.local` の `WINDMILL_*` で叩く。試験の process にはどちらも読まれていない
 * ので、ここで読む。**`.env.local` が先**: `loadEnvFile` は既に在る値を上書きしないので、先に読んだ
 * 値が勝つ (`--env-file-if-exists=.env --env-file-if-exists=.env.local` と同じ勝ち方)。
 */
for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(fileURLToPath(new URL(`../../${file}`, import.meta.url)));
  } catch {
    // 無ければ素通り。WINDMILL_TOKEN が要る試験だけが、無いと言って落ちる
  }
}
const WINDMILL = process.env["WINDMILL_URL"] ?? "http://127.0.0.1:8000";
const WORKSPACE = process.env["WINDMILL_WORKSPACE"] ?? "crawler";

/** 取り込みを始められる主体。capture-ledger 側でクロールの許可 (`fga:grant submitter`) が要る。 */
const SUBJECT = process.env["E2E_SUBJECT"] ?? "e2e";

let token = "";

const auth = () => ({ authorization: `Bearer ${token}` });

const json = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

/** 1 本始めて crawlId を返す。202 でなければ、台帳の本文を理由に落とす。 */
const startCrawl = async (body: Record<string, unknown>): Promise<string> => {
  const res = await fetch(`${WAGGLE}/api/crawls`, {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, text).toBe(202);
  return String((JSON.parse(text) as Record<string, unknown>)["crawlId"]);
};

/** 走り終えるまで待ち、`GET /api/crawls/:id` の答えを返す。 */
const finished = async (crawlId: string): Promise<Record<string, unknown>> => {
  let got: Record<string, unknown> = { state: "running" };
  for (let i = 0; i < 100 && got["state"] === "running"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    got = await json(await fetch(`${WAGGLE}/api/crawls/${crawlId}`, { headers: auth() }));
  }
  return got;
};

/** capture-fixtures の要求ログ。**query を含む URL ごと**に数える（404 の道も数える）。 */
const requestCounts = async (): Promise<Record<string, number>> =>
  (await json(await fetch(`${FIXTURES_HOST}/__request-counts`))) as Record<string, number>;

const resetFixtures = async (): Promise<void> => {
  await fetch(`${FIXTURES_HOST}/__reset`, { method: "POST" });
};

/** Windmill で script を 1 本走らせ、終わるまで待って結果を返す。失敗した run は、その中身で落とす。 */
const runScript = async (path: string, args: Record<string, unknown>): Promise<unknown> => {
  const token = process.env["WINDMILL_TOKEN"];
  expect(token, "WINDMILL_TOKEN が無い —— pnpm run windmill:bootstrap").toBeTruthy();
  const headers = { authorization: `Bearer ${String(token)}` };
  const run = await fetch(`${WINDMILL}/api/w/${WORKSPACE}/jobs/run/p/${path}`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const id = await run.text();
  expect(
    run.ok,
    `${path} を走らせられない: ${String(run.status)} ${id} (push してありますか)`,
  ).toBe(true);
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const job = await json(
      await fetch(`${WINDMILL}/api/w/${WORKSPACE}/jobs_u/get/${id}`, { headers }),
    );
    if (job["type"] === "CompletedJob") {
      expect(job["success"], JSON.stringify(job["result"])).toBe(true);
      return job["result"];
    }
  }
  throw new Error(`${path} の run ${id} が 60 秒で終わらない`);
};

/**
 * 走った口を、ページの中から印に残すその場の JS。`run` は試験ごとの token、`state` は走ったときの
 * `document.readyState` —— 遷移の前に走れば `loading`、読み込みの後なら `complete` になる。
 *
 * **同じ文字列を behavior でも preload でも送れる形にする**（await を使わない IIFE）。読み込みの後なら、
 * BrowserHive がスクリプトの後でネットワークが静まるのを待つので、要求は撮り終える前に届く。
 */
const probe = (run: string): string =>
  `(() => {\n  void fetch("/plain-html?inline=${run}&state=" + document.readyState);\n})();\n`;

/** `probe(run)` が付ける印の URL。 */
const mark = (run: string, state: "loading" | "complete"): string =>
  `/plain-html?inline=${run}&state=${state}`;

beforeAll(async () => {
  // issuer は起動のたびに鍵を作り直すので、その場で採る。
  const res = await fetch(`${ISSUER}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ subject: SUBJECT, organizations: ["acme"] }),
  });
  expect(res.ok, "issuer からトークンを採れませんでした").toBe(true);
  token = String((await json(res))["access_token"]);
});

describe("クロールが flow を通って索引まで終わる", () => {
  it("robots が禁じたページに触れず、取り込み、検索に出る", async () => {
    // capture-fixtures のリクエストログを白紙に戻す。ここから先に届いたものだけを見る。
    await fetch(`${FIXTURES_HOST}/__reset`, { method: "POST" });

    const started = await fetch(`${WAGGLE}/api/crawls`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        seeds: [`${FIXTURES}/links/hub`],
        maxDepth: 1,
        maxPages: 5,
        // capture-fixtures の robots.txt は Crawl-delay: 3 を宣言している。短い値を渡して、
        // 長いほうが採られること (= robots が実際に読まれていること) も同時に効かせる。
        perHostDelayMs: 500,
      }),
    });
    // **本文は 1 度しか読めない。** expect の第 2 引数は成否によらず評価されるので、
    // そこで `text()` を呼ぶと後段の `json()` が "Body has already been read" で落ちる
    // (実測)。先に文字列で受けて、それを両方に使う。
    const startedBody = await started.text();
    // 404 は「無い」とも「始めてよくない」とも読める —— capture-ledger は列挙を避けるために
    // 両者を区別せずに答える。許可を疑う先をここに書いておく。
    expect(
      started.status,
      startedBody +
        (started.status === 404
          ? ` —— ${SUBJECT} に submitter がありますか` +
            ` (capture-ledger: node dist/fga/ledger-commands.js grant submitter ${SUBJECT} acme)`
          : started.status === 409
            ? " —— 走行中のクロールが残っています。**この試験が途中で落ちると必ずこうなる**" +
              " (flow は非同期に走り続けるため)。片付けてから: " +
              `UPDATE crawls SET state='failed', stop_reason='failed', finished_at=now() WHERE state='running'`
            : ""),
    ).toBe(202);
    const crawlId = String((JSON.parse(startedBody) as Record<string, unknown>)["crawlId"]);

    // 完了を待つ。取り込みは本物のブラウザなので分単位になりうる。
    let state = "running";
    // ③ で「この回の取り込み」を絞るのに使う。台帳が記録した開始時刻で、この試験の時計ではない。
    let startedAt = Number.NaN;
    for (let i = 0; i < 100 && state === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const got = await json(await fetch(`${WAGGLE}/api/crawls/${crawlId}`, { headers: auth() }));
      state = String(got["state"]);
      startedAt = Date.parse(String(got["startedAt"]));
      if (state !== "running") {
        expect(state, `stopReason=${String(got["stopReason"])}`).toBe("succeeded");
        expect(Number(got["pagesCaptured"]), "1 ページも取り込めていない").toBeGreaterThan(0);
      }
    }
    expect(state, "クロールが終わらなかった").not.toBe("running");

    // ── ① robots が守られたか ──────────────────────────────────────
    // capture-fixtures の /robots.txt は /links/hidden を Disallow している。**capture-fixtures 自身が
    // 受け取っていないこと**を見る —— 台帳を見ても「記録しなかった」としか言えない。
    //
    // これを守っているのは `plan_level.ts` の `?? true` **1 か所だけ**。
    // schema の `default: true` は webhook 実行では埋まらないので効いていない。
    const counts = (await json(await fetch(`${FIXTURES_HOST}/__request-counts`))) as Record<
      string,
      number
    >;
    expect(Object.keys(counts), "robots が禁じたページに触れた").not.toContain("/links/hidden");
    // 相手に届いたことの確認。届いていなければ ① は空振りで通る。
    expect(Object.keys(counts)).toContain("/robots.txt");
    expect(Object.keys(counts)).toContain("/links/hub");

    // ── ② 索引まで flow の中で終わったか ────────────────────────────
    // index step は report の後に並んでいる。クロールが succeeded になった時点で
    // 走り終えているはず。検索に出れば、台帳への登録も索引も通っている。
    const found = await json(await fetch(`${WAGGLE}/api/search?q=hub`, { headers: auth() }));
    expect((found["hits"] as unknown[]).length, "索引に載っていない").toBeGreaterThan(0);

    // ── ③ 成果物が受け口を通ったか ──────────────────────────────────
    // **受け口の有無は capture-ledger に訊く。** トークン無しの PUT は、口が在ればトークンの検査で
    // 401、無ければ route ごと無いので 404。走らせる人に env で宣言させる形は採らない ——
    // 宣言を忘れた回が緑で通る。dispatch が口を載せ忘れていた間 (capture-ledger #226 から)、
    // 受け口の値を渡した capture-ledger でもクロールは成功し、成果物は黙って BrowserHive の
    // 自前の保管庫へ置かれていた。
    //
    // **401 と 404 以外は落とす。** 見分けを誤って「口が無い」側に倒すと、この検査が黙って飛ぶ。
    const probe = await fetch(`${WAGGLE}/api/sink/${crawlId}/probe`, { method: "PUT" });
    expect([401, 404], `受け口の有無を見分けられない (PUT → ${String(probe.status)})`).toContain(
      probe.status,
    );
    if (probe.status === 401) {
      // この回の取り込みを、出発点の下の URL とクロールの開始時刻で絞る。`GET /api/crawls/:id`
      // は取り込んだページを返さないので、一覧 (新しい順に 50 件) から採る。見てよいかの判定は
      // ② の検索と同じなので、② が通っていればここでも見える。
      const listed = await json(await fetch(`${WAGGLE}/api/archives`, { headers: auth() }));
      const ours = (
        listed["archives"] as { sourceUrl: string; capturedAt: string; objectKey: string }[]
      ).filter(
        (archive) =>
          archive.sourceUrl.startsWith(`${FIXTURES}/links/`) &&
          Date.parse(archive.capturedAt) >= startedAt,
      );
      expect(ours.length, "この回の取り込みが capture-ledger の一覧に無い").toBeGreaterThan(0);
      for (const archive of ours) {
        // 受け口はクロールを作ったときに決めた `org/<組織>/<YYYY-MM>/` の下に置く。平らな鍵は
        // BrowserHive が自前の保管庫へ書いた印 —— 口が配られていない。
        expect(archive.objectKey, "受け口を通っていない (鍵が平ら)").toMatch(
          /^org\/acme\/\d{4}-\d{2}\//,
        );
      }
    }
  });

  /**
   * **台帳に入れたスクリプトが、ページの中で走ったか。**
   *
   * ここまでの検査は「撮れたか」「記録できたか」しか見ていない。台帳にスクリプトが無くても、flow が
   * `scripts` を落としても、取り込みは成功しアーカイブも出る —— `complete: true` のまま。
   * その差を外から見分ける手が要る。
   *
   * capture-fixtures の `/responsive-images` がそのための面で、fixture 自身がこう書いている:
   * 「1280px・DPR 1 の取り込みは要素ごとに 1 候補しか要求しないので、`autofetch` が
   * 無ければ control の `hero.svg` しか届かない」。
   *
   * つまり **`hero-2x.svg` が相手に届いたこと**が、「台帳 → flow → BrowserHive → ページ」の
   * 鎖が全部通った証拠になる。判定を相手のリクエストログで採るのは ① と同じ理由 ——
   * 台帳は「記録したこと」しか言わない。
   *
   * autofetch は capture-scripts v0.5.0 から既定に入らない（カタログの `default: false`。台帳 v0.64.0 は
   * 全部の版を無効にして持つ）ので、名指して頼む。名指せば、台帳は最新版を配る。
   */
  it("台帳に入れたスクリプトが、ページの中で走る", async () => {
    await fetch(`${FIXTURES_HOST}/__reset`, { method: "POST" });

    const started = await fetch(`${WAGGLE}/api/crawls`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      // 起点は 1 枚、辿らない。届いた要求はこの 1 枚のぶんだけになる。
      body: JSON.stringify({
        seeds: [`${FIXTURES}/responsive-images`],
        maxDepth: 0,
        scripts: [{ catalog: "autofetch" }],
      }),
    });
    const startedBody = await started.text();
    expect(
      started.status,
      startedBody +
        (started.status === 400
          ? " —— 台帳に autofetch は入っていますか (capture-ledger: pnpm run scripts import .upstream/capture-scripts)"
          : started.status === 409
            ? " —— 走行中のクロールが残っています。**この試験が途中で落ちると必ずこうなる**"
            : ""),
    ).toBe(202);
    const crawlId = String((JSON.parse(startedBody) as Record<string, unknown>)["crawlId"]);

    let state = "running";
    for (let i = 0; i < 100 && state === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const got = await json(await fetch(`${WAGGLE}/api/crawls/${crawlId}`, { headers: auth() }));
      state = String(got["state"]);
      if (state !== "running") {
        expect(state, `stopReason=${String(got["stopReason"])}`).toBe("succeeded");
        // 台帳が何を固定したか。**走ったことと、記録したことは別の主張**なので両方見る。
        const scripts = got["scripts"] as {
          id: string;
          sha256: string;
          jsSha256: string | null;
          compiledWith: { typescript: string; hostTypes: string } | null;
        }[];
        expect(
          scripts.map((script) => script.id),
          "台帳が名指した autofetch を配っていない",
        ).toEqual(["autofetch"]);
        // 走った JS の hash と変換の記録が、報告で台帳に戻っている。台帳のスクリプトの sha256 は TS の物なので、
        // JS の物と同じなら「変換されていない」。
        for (const script of scripts) {
          expect(script.jsSha256, `${script.id}: JS の hash が台帳に戻っていない`).toMatch(
            /^[0-9a-f]{64}$/,
          );
          expect(script.jsSha256, `${script.id}: JS の hash が TS の hash と同じ`).not.toBe(
            script.sha256,
          );
          expect(script.compiledWith?.typescript).toMatch(/^\d+\.\d+\.\d+$/);
          expect(script.compiledWith?.hostTypes).toMatch(/^v\d+\.\d+\.\d+$/);
        }
      }
    }
    expect(state, "クロールが終わらなかった").not.toBe("running");

    const counts = (await json(await fetch(`${FIXTURES_HOST}/__request-counts`))) as Record<
      string,
      number
    >;

    // control —— ブラウザが自分で要求する 1 枚。0 なら取り込み自体が届いていないので、
    // 下の判定は空振りになる。**先にここで落とす。**
    expect(counts["/assets/hero.svg"], "取り込みが届いていない").toBeGreaterThan(0);

    // **ここが本題。** 1280px・DPR 1 のブラウザは -2x を要求しない。届いているなら、
    // 台帳の autofetch がページの中で走った。
    expect(
      counts["/assets/hero-2x.svg"],
      "autofetch が走っていない —— 台帳のスクリプト・flow の scripts・BrowserHive の受け皿のどれかで切れている",
    ).toBeGreaterThan(0);
  });

  /**
   * **スクリプトを空にしたクロールは、何も走らせずに成功する。**
   *
   * 上の試験の対照。同じページ・同じ条件で、台帳に `scripts: []` (「何も走らせない」という意思) を渡す。
   * compile の段はスクリプトが空でも 200 で通し (ts-compile-service v0.2.1 から)、BrowserHive はページの中で
   * 何も走らせない。その証拠は fixtures の request log に在る —— autofetch が居なければ hero-2x.svg は
   * 誰も要求しない。これが無いと、上の試験の hero-2x.svg が本当に autofetch の仕業かを、走らなかった
   * ときの姿と比べて言えない。
   *
   * compile の段が空を断る版 (v0.2.0 まで) では、台帳の error に "[compile] compile 400 …" が残って
   * state で落ちる。その文面をそのまま失敗の理由にする。
   */
  it("スクリプトを空にしたクロールは、何も走らせずに成功する", async () => {
    await fetch(`${FIXTURES_HOST}/__reset`, { method: "POST" });

    const started = await fetch(`${WAGGLE}/api/crawls`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        seeds: [`${FIXTURES}/responsive-images`],
        maxDepth: 0,
        scripts: [],
      }),
    });
    const startedBody = await started.text();
    expect(started.status, startedBody).toBe(202);
    const crawlId = String((JSON.parse(startedBody) as Record<string, unknown>)["crawlId"]);

    let got: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      got = await json(await fetch(`${WAGGLE}/api/crawls/${crawlId}`, { headers: auth() }));
      if (got["state"] !== "running") break;
    }
    expect(got["state"], String(got["error"])).toBe("succeeded");
    // 台帳はスクリプトを空で固定した (省略なら台帳の既定が入る)
    expect(got["scripts"]).toEqual([]);

    const counts = (await json(await fetch(`${FIXTURES_HOST}/__request-counts`))) as Record<
      string,
      number
    >;
    // control —— 取り込みは届いている
    expect(counts["/assets/hero.svg"], "取り込みが届いていない").toBeGreaterThan(0);
    // **ここが本題。** autofetch が居ないので -2x は誰も要求しない。上の試験の hero-2x.svg が
    // autofetch の仕業である証拠は、この 0 と対にして初めて言える
    expect(counts["/assets/hero-2x.svg"] ?? 0, "スクリプトが空なのに何かが走った").toBe(0);
  });

  /**
   * **`scripts` を省いたクロールに、autofetch は入らない。**
   *
   * 上の 2 本のもう 1 つの対照。autofetch は capture-scripts v0.5.0 から既定に入らず、台帳は全部の版を
   * 無効にして持つ。だから何も名指さないクロール —— 毎朝の定期のクロールも —— は走らせない。
   * 台帳が固定した顔ぶれと、相手のリクエストログの両方で見る: 顔ぶれに居なくても、ページの中で
   * 走っていれば hero-2x.svg が届く。
   */
  it("scripts を省いたクロールに、autofetch は入らない", async () => {
    await fetch(`${FIXTURES_HOST}/__reset`, { method: "POST" });

    const started = await fetch(`${WAGGLE}/api/crawls`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ seeds: [`${FIXTURES}/responsive-images`], maxDepth: 0 }),
    });
    const startedBody = await started.text();
    expect(started.status, startedBody).toBe(202);
    const crawlId = String((JSON.parse(startedBody) as Record<string, unknown>)["crawlId"]);

    let got: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      got = await json(await fetch(`${WAGGLE}/api/crawls/${crawlId}`, { headers: auth() }));
      if (got["state"] !== "running") break;
    }
    expect(got["state"], String(got["error"])).toBe("succeeded");
    const ids = (got["scripts"] as { id: string }[]).map((script) => script.id);
    // 既定は空ではない（空なら台帳は 400 で断る）。その中に autofetch が居ない
    expect(ids.length, "既定のスクリプトが走っていない").toBeGreaterThan(0);
    expect(
      ids,
      "既定に autofetch が入っている —— 台帳は capture-scripts v0.5.0 以降を取り込んだか",
    ).not.toContain("autofetch");

    const counts = (await json(await fetch(`${FIXTURES_HOST}/__request-counts`))) as Record<
      string,
      number
    >;
    // control —— 取り込みは届いている
    expect(counts["/assets/hero.svg"], "取り込みが届いていない").toBeGreaterThan(0);
    expect(counts["/assets/hero-2x.svg"] ?? 0, "既定のスクリプトの中で autofetch が走った").toBe(0);
  });

  /**
   * **型が通らないスクリプトを台帳に入れると、クロールは compile の段で落ちる。**
   *
   * 台帳のスクリプトは tag を経ずに CLI でも足せる。だから capture-scripts の CI が緑でも、走る前にもう 1 か所の
   * 門番が要る —— flow の `compile` の段 (ts-compile-service)。ここではその門番が本当に段を落とし、
   * 台帳が failed で締められる (fail_crawl) ことを見る。落ちる理由に型エラーの code が載るのは、
   * Windmill の履歴を開かなくても台帳だけで「なぜ落ちたか」が読めるようにするため。
   *
   * 壊れた 1 本は試験の最後に台帳から消す。残すと以後のクロールが全部ここで落ちる。
   */
  it("型が通らないスクリプトを台帳に入れると、クロールは compile の段で落ちる", async () => {
    const ledgerDir = process.env["E2E_LEDGER_DIR"] ?? resolve(process.cwd(), "../capture-ledger");
    const broken = fileURLToPath(new URL("./fixtures/broken-script.txt", import.meta.url));
    const ledger = (...args: string[]): string =>
      execFileSync("pnpm", ["run", "--silent", "scripts", ...args], {
        cwd: ledgerDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });

    ledger("add", "broken", "--file", broken, "--phase", "behavior");
    try {
      const started = await fetch(`${WAGGLE}/api/crawls`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ seeds: [`${FIXTURES}/responsive-images`], maxDepth: 0 }),
      });
      const startedBody = await started.text();
      expect(started.status, startedBody).toBe(202);
      const crawlId = String((JSON.parse(startedBody) as Record<string, unknown>)["crawlId"]);

      let got: Record<string, unknown> = { state: "running" };
      for (let i = 0; i < 100 && got["state"] === "running"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        got = await json(await fetch(`${WAGGLE}/api/crawls/${crawlId}`, { headers: auth() }));
      }
      expect(got["state"], `stopReason=${String(got["stopReason"])}`).toBe("failed");
      // fail_crawl が段の例外の文をそのまま reason に送り、台帳は crawls.error に入れて
      // GET /api/crawls/:id の `error` で返す (stopReason は "failed" の 1 語)。診断の code まで台帳に残る
      const reason = String(got["error"]);
      expect(reason, "落ちた段が compile ではない").toContain("compile 422");
      expect(reason, "型エラーの code が error に無い").toContain("TS2322");
    } finally {
      ledger("rm", "broken");
    }
  });

  /**
   * **その場の JS は、台帳のスクリプトと同じ道でページの中まで届く。** 台帳はスクリプトとして登録せずに行の写しを作り
   * (`inline-<name>`・版 1)、flow は区別せずに変換して BrowserHive へ渡す。並びは頼んだとおり。
   */
  it("その場の JS と台帳のスクリプトを並べると、頼んだ順に写り、どちらもページの中で走る", async () => {
    await resetFixtures();
    const run = randomUUID().slice(0, 8);
    const got = await finished(
      await startCrawl({
        seeds: [`${FIXTURES}/responsive-images`],
        maxDepth: 0,
        scripts: [
          { inline: { name: "probe", phase: "behavior", source: probe(run) } },
          { catalog: "autofetch" },
        ],
      }),
    );
    expect(got["state"], String(got["error"])).toBe("succeeded");
    const scripts = got["scripts"] as {
      id: string;
      jsSha256: string | null;
      inline?: { name: string; phase: string; bytes: number };
    }[];
    // 頼んだ並びのまま写る。その場の物にだけ、頼んだ要素が返る（大きさだけ —— source は運ばない）
    expect(scripts.map((script) => script.id)).toEqual(["inline-probe", "autofetch"]);
    expect(scripts[0]?.inline).toEqual({
      name: "probe",
      phase: "behavior",
      bytes: Buffer.byteLength(probe(run)),
    });
    expect(scripts[1]).not.toHaveProperty("inline");
    // 書いた物は、名前の口から取り戻す（capture-ledger v0.59.0。画面の「欄に戻す」が使う）
    const back = await json(
      await fetch(`${WAGGLE}/api/crawls/${String(got["crawlId"])}/inline/probe`, {
        headers: auth(),
      }),
    );
    expect(back["source"], "名前の口が、書いた JS を返さない").toBe(probe(run));
    // どちらも変換され、走った JS の hash が報告で台帳に戻っている
    for (const script of scripts) {
      expect(script.jsSha256, `${script.id}: JS の hash が台帳に戻っていない`).toMatch(
        /^[0-9a-f]{64}$/,
      );
    }

    const counts = await requestCounts();
    // control —— 取り込みは届いている。0 なら下の判定は空振り
    expect(counts["/assets/hero.svg"], "取り込みが届いていない").toBeGreaterThan(0);
    expect(
      counts[mark(run, "complete")] ?? 0,
      "その場の JS が、読み込みの後に走っていない",
    ).toBeGreaterThan(0);
    expect(counts["/assets/hero-2x.svg"] ?? 0, "台帳の autofetch が走っていない").toBeGreaterThan(
      0,
    );
  });

  /**
   * **同じ JS を、遷移の前で頼み直す。** 2 本とも同じ source なので、2 本目は ts-compile-service の
   * cache に当たる。cache が答えごと覚えていた版 (v0.2.2 まで) は 1 本目の phase (behavior) を返し、
   * crawl_host は読み込みの後で走らせる —— どこにも誤りが出ないまま、印は complete になる。
   *
   * 印の token は 2 本で 1 つにする。変えると source が変わって cache に当たらず、この試験は何も
   * 言わない。どちらのクロールの印かは、間の `/__reset` で分ける。
   */
  it("同じ JS を遷移の前で頼み直すと、遷移の前に走る", async () => {
    const run = randomUUID().slice(0, 8);
    const crawl = async (phase: "behavior" | "preload") =>
      finished(
        await startCrawl({
          seeds: [`${FIXTURES}/plain-html`],
          maxDepth: 0,
          scripts: [{ inline: { name: "probe", phase, source: probe(run) } }],
        }),
      );

    await resetFixtures();
    const first = await crawl("behavior");
    expect(first["state"], String(first["error"])).toBe("succeeded");
    // control —— 印の仕組みそのものが効いている。0 なら下の判定は空振り
    expect(
      (await requestCounts())[mark(run, "complete")] ?? 0,
      "読み込みの後の印が付かない",
    ).toBeGreaterThan(0);

    await resetFixtures();
    const second = await crawl("preload");
    expect(second["state"], String(second["error"])).toBe("succeeded");
    const counts = await requestCounts();
    expect(counts[mark(run, "loading")] ?? 0, "遷移の前に走っていない").toBeGreaterThan(0);
    expect(
      counts[mark(run, "complete")] ?? 0,
      "読み込みの後に走った —— 変換の cache が phase を取り違えた",
    ).toBe(0);
  });

  /**
   * **型の通らないその場の JS は、compile の段でクロールごと落ちる。** 台帳の broken の試験と違い、
   * CLI で台帳に入れて消す手間が無い —— その場の JS は行の写しにだけ在る。
   */
  it("型の通らないその場の JS は、compile の段でクロールごと落ちる", async () => {
    const got = await finished(
      await startCrawl({
        seeds: [`${FIXTURES}/plain-html`],
        maxDepth: 0,
        scripts: [
          {
            inline: {
              name: "broken",
              phase: "behavior",
              source: `(() => {\n  const n: number = "x";\n})();\n`,
            },
          },
        ],
      }),
    );
    expect(got["state"], `stopReason=${String(got["stopReason"])}`).toBe("failed");
    const reason = String(got["error"]);
    expect(reason, "落ちた段が compile ではない").toContain("compile 422");
    expect(reason, "型エラーの code が error に無い").toContain("TS2322");
    expect(reason, "診断が、その場の JS を名指していない").toContain("inline-broken.ts");
  });

  /**
   * **型の誤りがいくつあっても、クロールは failed で締まり、次を塞がない。** 束ねた JS を貼ると
   * 診断は数百件になる。全部を reason に載せると台帳の /failed（2,000 字まで）が 400 で断り、
   * running の行が残って、次のクロールが全部 409 になる（v0.24.2 まで）。
   */
  it("型の誤りが多い JS でも、クロールは failed で締まり、次を塞がない", async () => {
    // 1 行に 1 件（TS2322）。300 件の診断を全部載せると、reason は 2,000 字を大きく超える
    const lines = Array.from({ length: 300 }, (_, i) => `  const v${String(i)}: number = "x";`);
    const got = await finished(
      await startCrawl({
        seeds: [`${FIXTURES}/plain-html`],
        maxDepth: 0,
        scripts: [
          {
            inline: {
              name: "many",
              phase: "behavior",
              source: `(() => {\n${lines.join("\n")}\n})();\n`,
            },
          },
        ],
      }),
    );
    expect(got["state"], "締まらずに running のまま —— 失敗の文を台帳が断った").toBe("failed");
    const reason = String(got["error"]);
    expect(reason, "件数が error に無い").toContain("型の誤り 300 件");
    expect(reason, "最初の診断が、その場の JS の行を名指していない").toContain(
      "inline-many.ts:2:9 TS2322",
    );
    expect(reason.length, "reason が台帳の上限を超えた").toBeLessThanOrEqual(2000);

    // 次を塞がない —— 締まっていなければ、ここは 409 で startCrawl が赤くなる
    const next = await finished(
      await startCrawl({ seeds: [`${FIXTURES}/plain-html`], maxDepth: 0, scripts: [] }),
    );
    expect(next["state"], String(next["error"])).toBe("succeeded");
  });
});

/**
 * **規則の並びで、辿る・撮るだけ・落とすを分ける。** capture-fixtures の `/links/rules` は、規則の決め方
 * ごとにリンクを 1 本ずつ持つ頁 (同じホストのリーフ・暦の罠・落とすドメイン・外のホスト)。
 *
 * 判定は 3 か所で見る。**相手が受け取った物**は capture-fixtures のリクエストログ、**取りに行ったが届かな
 * かった物** (外の 2 本はどちらも `.invalid` で、相手のログには来ない) は台帳の失敗、**台帳が決めた物**は
 * 判断の口と、それを Windmill で描く調べ物の script。
 */
describe("規則の並びで辿る", () => {
  const RULES = [
    { skip: "skipped.invalid" },
    { skip: `${FIXTURES}/links/trap/` },
    { follow: "same-host" },
    { capture: "any" },
  ];

  it("前方一致とドメインで落とし、外は撮るだけにする。台帳の判断と Windmill の調べ物が同じことを言う", async () => {
    await resetFixtures();
    const crawlId = await startCrawl({
      seeds: [`${FIXTURES}/links/rules`],
      maxDepth: 2,
      maxPages: 20,
      rules: RULES,
      // 規則だけを見る。台帳のスクリプトは走らせない (速く、台帳の中身に左右されない)
      scripts: [],
    });
    const crawl = await finished(crawlId);
    expect(crawl["state"], `stopReason=${String(crawl["stopReason"])}`).toBe("succeeded");

    // ① 相手が受け取った物。台帳は「記録したこと」しか言わない
    const paths = Object.keys(await requestCounts());
    expect(paths).toContain("/links/rules");
    expect(paths, "同じホストを辿る規則で、リーフを取っていない").toContain("/links/leaf/1");
    expect(
      paths.filter((path) => path.startsWith("/links/trap/")),
      "前方一致で落としたはずの暦に触れた",
    ).toEqual([]);

    // ② 外の 2 本。撮るだけの外へは撮りに行き (届かずに失敗)、落としたドメインへは行かない
    const failures = (crawl["failures"] as { url: string }[]).map((failure) => failure.url);
    expect(failures, "撮るだけの外へ撮りに行っていない").toContain("http://outside.invalid/page");
    expect(failures, "落としたはずのドメインへ撮りに行った").not.toContain(
      "http://skipped.invalid/page",
    );

    // ③ 台帳が残した判断。どの規則も別々の URL 1 本ずつ。/links/rules に robots で禁じた頁は無い
    const decided = await json(
      await fetch(`${WAGGLE}/api/crawls/${crawlId}/decisions`, { headers: auth() }),
    );
    const byRule: Record<string, number> = {};
    for (const row of decided["decisions"] as { rule: number; links: number }[]) {
      byRule[String(row.rule)] = (byRule[String(row.rule)] ?? 0) + row.links;
    }
    expect(byRule).toEqual({ "1": 1, "2": 1, "3": 1, "4": 1 });
    expect(decided["robots"]).toEqual([]);

    // ④ Windmill で調べ物の script を走らせると、落としたドメインの表にこのクロールが居る
    const result = (await runScript("f/waggle/inspect_domain", {
      domain: "skipped.invalid",
      days: 1,
    })) as { render_all: Record<string, unknown>[] };
    const table = result.render_all.find((item) => "table-row-object" in item)?.[
      "table-row-object"
    ] as Record<string, unknown>[] | undefined;
    expect(
      (table ?? []).slice(1).map((row) => row["クロール"]),
      JSON.stringify(result),
    ).toContain(crawlId.slice(0, 8));
  });

  it("前の規則に覆われた規則で頼むと、400 で名指されてクロールは立たない", async () => {
    const res = await fetch(`${WAGGLE}/api/crawls`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        seeds: [`${FIXTURES}/links/rules`],
        rules: [{ follow: "any" }, { skip: "skipped.invalid" }],
        scripts: [],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "rules that can never match",
      rules: [{ rule: 2, coveredBy: 1 }],
    });
    const running = await json(
      await fetch(`${WAGGLE}/api/crawls?state=running`, { headers: auth() }),
    );
    expect(running["crawls"], "断ったのにクロールが立っている").toEqual([]);
  });
});
