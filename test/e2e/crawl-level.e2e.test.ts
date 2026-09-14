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
/** capture-ledger のスタックの capture-fixtures。コンテナからも host からも同じ名前で引ける。 */
const FIXTURES = process.env["E2E_FIXTURES_URL"] ?? "http://capture-fixtures.capture-ledger:8080";

/** 取り込みを起こせる主体。capture-ledger 側で `submitter` の付与が要る。 */
const SUBJECT = process.env["E2E_SUBJECT"] ?? "e2e";

let token = "";

const auth = () => ({ authorization: `Bearer ${token}` });

const json = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

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
    await fetch(`${FIXTURES}/__reset`, { method: "POST" });

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
    // 404 は「無い」とも「起こしてよくない」とも読める —— capture-ledger は列挙を避けるために
    // 両者を区別せずに答える。付与を疑う先をここに書いておく。
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
    const counts = (await json(await fetch(`${FIXTURES}/__request-counts`))) as Record<
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
});
