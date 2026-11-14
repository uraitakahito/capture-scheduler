import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, describe, it, expect, beforeAll } from "vitest";

import { jobArgsTree } from "./helpers/jobs.js";
import {
  FIXTURES,
  ledger,
  mintToken,
  requestCounts,
  resetFixtures,
  WINDMILL,
  windmillToken,
  WORKSPACE,
} from "./helpers/stack.js";
import {
  membersContaining,
  readWacz,
  settingsOf,
  textOf,
  type WaczMembers,
} from "./helpers/wacz.js";

/**
 * **クロールごとの値 —— 変数とシークレット —— が、capture-ledger → flow → crawl_host → BrowserHive → 頁 と運ばれ、
 * 残るべき所にだけ残る。**
 *
 * 単体で見えるのは「crawl_host が要求に載せる形」までで、flow が `variables` / `secrets` を運ぶか
 * (`flow.yaml` の input_transforms) と、頁の中の受け皿 (`defineParams` が読む `__bh.vars` と `__bh.secrets`)
 * に届くかは、本物を通さないと言えない。判定は 3 か所で採る:
 *
 *   - **頁の中に届いたか** —— その場の TS が印を capture-fixtures に送る。相手のリクエストログで見る
 *   - **capture-ledger の行** —— `GET /api/crawls/:id` の `variables` (値) と `secrets` (名前と path と `archive`)
 *   - **BrowserHive WACZ** —— `datapackage.json` の `browserhive:capture.settings.variables` (値) と
 *     `browserhive:capture.settings.secrets` (名前だけ)。シークレットの値は **全 member のどこにも無い**。
 *     同じ探し方で、変数として渡した値は見つかる (対照)
 *
 * シークレットを通信に載せた場面も見る (BrowserHive v29.0.0 は WARC の中でも値を隠す)。宣言に `archive: "keep"` と
 * 書いた物だけが、capture-ledger → flow の `secret_archive` → crawl_host → BrowserHive の `secretArchive` と運ばれて WARC に
 * 値のまま残る。隠す場面と keep の場面を同じ探し方で並べ、keep が対照になる (探し方が壊れていれば両方が同じ答えになる)。
 * 探すのは値の綴りだけではない: 値の中に乱数の 12 字 (16 進) を入れ、その字でも探す —— 16 進の字はどの符号化でも
 * 同じ字のまま残るので、綴りの一覧 (BrowserHive の実装と同じ見方) が見落とした形でも見つかる。
 *
 * シークレットは Windmill の変数 `f/waggle_secrets/<名前>` に試験自身が置く。値は毎回無作為なので、
 * 前の回の WACZ や run の履歴に残っていても、この回の判定には混ざらない。
 */

/** 印を送る、その場の TS。変数は `defineParams` で読む (capture-scripts v0.11.0 の `types/host.d.ts`)。 */
const sendsVariable = (name: string): string =>
  `import { z } from "zod";\n\n(async () => {\n  const { ${name} } = defineParams(z.object({ ${name}: z.string().min(1) }));\n  void fetch("/plain-html?var=" + encodeURIComponent(${name}));\n})();\n`;

/**
 * シークレットの**長さだけ**を送る。頁に届いたかだけを見る試験で使う (値そのものを通信に載せる場面は、下の
 * `sendsSecret` の試験)。
 */
const sendsSecretLength = (name: string): string =>
  `(() => {\n  void fetch("/plain-html?len=" + String(globalThis.__bh.secrets.${name} ?? "").length);\n})();\n`;

/**
 * シークレットの値を**通信に載せる**。capture-fixtures の `/echo/text?v=` は値を HTML で返すので、値は要求の URL と
 * 応答の本文の両方に載る。応答を読み切るまで待つ (BrowserHive は Promise の終わりを待つ)。
 */
const sendsSecret = (name: string): string =>
  `(async () => {\n  const value = globalThis.__bh.secrets.${name} ?? "";\n  await fetch("/echo/text?v=" + encodeURIComponent(value)).then((response) => response.text());\n})();\n`;

/**
 * 通信に載せる値。毎回無作為で、乱数の 12 字 (16 進) を持つ。8 字以上 (BrowserHive は 8 字未満の隠す値を断る) で、
 * `%`・HTML・JSON で綴りが変わる字を持つ。`#` と `'` は入れない (`#` は URL で割れ、`'` は query でブラウザが `%27` に
 * 直すので、証人の要求ログの綴りが読めなくなる。探す側は乱数の字で足りる)。
 */
const valueWithNonce = (): { value: string; nonce: string } => {
  const nonce = randomBytes(6).toString("hex");
  return { value: `MARK p@ss+${nonce}&é"<`, nonce };
};

const SECRET_NAME = "e2e_probe";
const SECRET_PATH = `f/waggle_secrets/${SECRET_NAME}`;
const CRAWL_HOST = "f/waggle/crawl_host";

/**
 * WACZ の中で探す字: 値の綴り 2 つ (UTF-8 のバイト列のまま・`%` の符号化) と、乱数の 12 字。member は latin1 で
 * 字にする (`textOf`) ので、綴りも UTF-8 のバイト列を latin1 で読んだ字にして渡す。
 */
const needlesOf = (value: string, nonce: string): string[] => [
  Buffer.from(value, "utf-8").toString("latin1"),
  encodeURIComponent(value),
  nonce,
];

/** WACZ の中の WARC (`archive/`) を、全部字にして繋ぐ。 */
const warcTextOf = (members: WaczMembers): string =>
  [...members.entries()]
    .filter(([name]) => name.startsWith("archive/"))
    .map(([name, bytes]) => textOf(name, bytes))
    .join("\n");

/**
 * 値がサイトに届いたか (証人)。要求ログの綴りは `%` の符号化で変わるので、`/echo/text` の要求を乱数の字で探す。
 */
const echoedWith = (counts: Record<string, number>, nonce: string): boolean =>
  Object.entries(counts).some(
    ([url, count]) => url.startsWith("/echo/text?") && url.includes(nonce) && count > 0,
  );

/** 値を通信に載せるその場の TS を、シークレットの宣言を添えて 1 本始め、終わりまで待つ。 */
const startSending = async (params: Record<string, unknown>[]) =>
  api.finished(
    await api.start({
      seeds: [`${FIXTURES}/plain-html`],
      maxDepth: 0,
      scripts: [
        {
          inline: { name: "probe", phase: "behavior", source: sendsSecret(SECRET_NAME), params },
        },
      ],
    }),
  );

/** Windmill の変数を置く。在れば値を入れ替える (create → 在れば update)。 */
const upsertSecret = async (value: string): Promise<void> => {
  const headers = {
    authorization: `Bearer ${windmillToken()}`,
    "content-type": "application/json",
  };
  const created = await fetch(`${WINDMILL}/api/w/${WORKSPACE}/variables/create`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      path: SECRET_PATH,
      value,
      is_secret: true,
      description: "capture-scheduler の e2e が置く。消してよい",
    }),
  });
  if (created.ok) return;
  const why = await created.text();
  const updated = await fetch(`${WINDMILL}/api/w/${WORKSPACE}/variables/update/${SECRET_PATH}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ value }),
  });
  expect(
    updated.ok,
    `variables/update → ${String(updated.status)} ${await updated.text()} (create は ${String(created.status)} ${why})`,
  ).toBe(true);
};

let api: ReturnType<typeof ledger>;

beforeAll(async () => {
  api = ledger(await mintToken());
});

/** 置いた変数は消す。残しても害は無い (値は毎回無作為) が、登録したスクリプトの broken の試験と同じく後を残さない。 */
afterAll(async () => {
  if ((process.env["WINDMILL_TOKEN"] ?? "") === "") return;
  await fetch(`${WINDMILL}/api/w/${WORKSPACE}/variables/delete/${SECRET_PATH}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${windmillToken()}` },
  });
});

describe("クロールごとの値 —— 変数とシークレット", () => {
  it("変数が頁に届き、capture-ledger の行と WACZ の settings に同じ値が残る", async () => {
    await resetFixtures();
    const value = `v-${randomUUID().slice(0, 8)}`;
    const seed = `${FIXTURES}/plain-html`;

    const got = await api.finished(
      await api.start({
        seeds: [seed],
        maxDepth: 0,
        variables: { probe: value },
        scripts: [
          {
            inline: {
              name: "probe",
              phase: "behavior",
              source: sendsVariable("probe"),
            },
          },
        ],
      }),
    );
    expect(got["state"], String(got["error"])).toBe("succeeded");

    // ① 頁の中に届いた —— 受け皿の __bh.vars から読んだ値が、相手のリクエストログに在る
    const counts = await requestCounts();
    expect(counts["/plain-html"], "取り込みが届いていない").toBeGreaterThan(0);
    expect(
      counts[`/plain-html?var=${encodeURIComponent(value)}`] ?? 0,
      "変数が頁に届いていない —— flow の variables・crawl_host・BrowserHive の受け皿のどれかで切れている",
    ).toBeGreaterThan(0);

    // ② capture-ledger の行に固定された値
    expect(got["variables"]).toEqual({ probe: value });
    expect(got["secrets"]).toEqual([]);

    // ③ WACZ の settings。値は記録に残る物 (settings.variables)、secrets は空の列
    const archive = await api.archiveOf(seed, String(got["startedAt"]));
    const members = await readWacz(await api.signedUrl(archive.id));
    const settings = settingsOf(members);
    expect(settings["variables"]).toEqual({ probe: value });
    expect(settings["secrets"]).toEqual([]);
    expect(membersContaining(members, value), "値が WACZ のどこにも無い").toContain(
      "datapackage.json",
    );
  });

  it("シークレットが頁に届き、WACZ にも capture-ledger にも Windmill の run にも値は残らない", async () => {
    await resetFixtures();
    // 16 進 24 字。8 字以上なので BrowserHive のログの伏せ字にも掛かる長さ
    const value = randomBytes(12).toString("hex");
    await upsertSecret(value);
    const seed = `${FIXTURES}/plain-html`;

    const got = await api.finished(
      await api.start({
        seeds: [seed],
        maxDepth: 0,
        scripts: [
          {
            inline: {
              name: "probe",
              phase: "behavior",
              source: sendsSecretLength(SECRET_NAME),
              params: [{ name: SECRET_NAME, kind: "secret", required: true, summary: "e2e の鍵" }],
            },
          },
        ],
      }),
    );
    expect(got["state"], String(got["error"])).toBe("succeeded");

    // ① 頁の中に届いた —— 長さの印。値そのものは通信に出していない
    const counts = await requestCounts();
    expect(counts["/plain-html"], "取り込みが届いていない").toBeGreaterThan(0);
    expect(
      counts[`/plain-html?len=${String(value.length)}`] ?? 0,
      "シークレットが頁に届いていない —— flow の secrets・crawl_host の getVariable・BrowserHive の受け皿のどれかで切れている",
    ).toBeGreaterThan(0);

    // ② capture-ledger の行: 名前と path だけ。値はどこにも無い
    expect(got["variables"]).toEqual({});
    expect(got["secrets"]).toMatchObject([{ name: SECRET_NAME, path: SECRET_PATH }]);
    expect(JSON.stringify(got), "capture-ledger の答えにシークレットの値が在る").not.toContain(
      value,
    );

    // ③ WACZ: settings.secrets に名前だけ。値は全 member のどこにも無い
    const archive = await api.archiveOf(seed, String(got["startedAt"]));
    const members = await readWacz(await api.signedUrl(archive.id));
    const settings = settingsOf(members);
    expect(settings["secrets"]).toEqual([SECRET_NAME]);
    expect(settings["variables"]).toEqual({});
    expect(membersContaining(members, value), "シークレットの値が WACZ に残っている").toEqual([]);

    // ④ Windmill の run: flow と各段の引数に値は無く、path は在る (読む場所を間違えていない対照)
    const lastJob = got["lastJob"] as { id: string } | null;
    expect(lastJob, "capture-ledger が run の id を持っていない").not.toBeNull();
    const jobs = await jobArgsTree(String(lastJob?.id), {
      windmill: WINDMILL,
      workspace: WORKSPACE,
      token: windmillToken(),
    });
    expect(jobs.length, "flow の中の段まで辿れていない").toBeGreaterThan(1);
    expect(JSON.stringify(jobs), "Windmill の run の引数にシークレットの値が在る").not.toContain(
      value,
    );
    expect(
      jobs.some((job) => JSON.stringify(job.args).includes(SECRET_PATH)),
      "run の引数に path が無い —— 引数を読めていない",
    ).toBe(true);
  });

  /**
   * **隠すシークレットを通信に載せる (CAPTURE-166)。** 宣言が `archive` を省けば、capture-ledger は `secret_archive` に名前を
   * 載せず、BrowserHive は WARC の中でも値を `***` に置き換える。値はサイトには届いている (証人) のに、WACZ のどこにも
   * 無い。対照は次の keep の試験。
   */
  it("隠すシークレットは、通信に載せても WACZ のどこにも値が無く、WARC は *** に置き換えて名乗る。サイトには届いている", async () => {
    await resetFixtures();
    const { value, nonce } = valueWithNonce();
    await upsertSecret(value);

    const got = await startSending([
      { name: SECRET_NAME, kind: "secret", required: true, summary: "e2e の鍵" },
    ]);
    expect(got["state"], String(got["error"])).toBe("succeeded");

    // ① 証人: 値はサイトに届いた。届いていなければ、下の「無い」は何も言っていない
    expect(
      echoedWith(await requestCounts(), nonce),
      "値がサイトに届いていない —— flow の secrets・crawl_host・BrowserHive の受け皿のどれかで切れている",
    ).toBe(true);

    // ② capture-ledger の行: 隠す (archive は null)。値は無い
    expect(got["secrets"]).toMatchObject([{ name: SECRET_NAME, path: SECRET_PATH, archive: null }]);
    expect(JSON.stringify(got), "capture-ledger の答えにシークレットの値が在る").not.toContain(
      nonce,
    );

    // ③ WACZ: 残すと言った物は無く、値は綴りでも乱数の字でも、全 member のどこにも無い
    const archive = await api.archiveOf(`${FIXTURES}/plain-html`, String(got["startedAt"]));
    const members = await readWacz(await api.signedUrl(archive.id));
    expect(settingsOf(members)["secretArchive"]).toEqual({});
    for (const needle of needlesOf(value, nonce)) {
      expect(
        membersContaining(members, needle),
        `${needle === nonce ? "乱数の字" : "値の綴り"}が WACZ に残っている`,
      ).toEqual([]);
    }
    // 置き換えた印。WARC を読めている (探し方が空振りしていない) ことの証でもある
    const warc = warcTextOf(members);
    expect(warc).toContain("BrowserHive-Redacted:");
    expect(warc).toContain("/echo/text?v=***");
  });

  /**
   * **対照: keep。** 宣言に `archive: "keep"` と書けば、capture-ledger → flow の `secret_archive` → crawl_host → BrowserHive の
   * `secretArchive` と運ばれ、同じ探し方で WARC に値のまま見つかる。flow が `secret_archive` を運び忘れると、ここだけが
   * 赤くなる (値が隠れる)。
   */
  it("対照: keep と宣言したシークレットは、capture-ledger → flow → crawl_host → BrowserHive と運ばれ、同じ探し方で WARC に値のまま見つかる", async () => {
    await resetFixtures();
    const { value, nonce } = valueWithNonce();
    await upsertSecret(value);

    const got = await startSending([
      { name: SECRET_NAME, kind: "secret", required: true, summary: "e2e の鍵", archive: "keep" },
    ]);
    expect(got["state"], String(got["error"])).toBe("succeeded");
    expect(echoedWith(await requestCounts(), nonce), "値がサイトに届いていない").toBe(true);

    // ① capture-ledger の行: keep
    expect(got["secrets"]).toMatchObject([
      { name: SECRET_NAME, path: SECRET_PATH, archive: "keep" },
    ]);

    // ② Windmill の run: crawl_host の段の引数に secret_archive が載っている (flow が運んだ)
    const lastJob = got["lastJob"] as { id: string } | null;
    expect(lastJob, "capture-ledger が run の id を持っていない").not.toBeNull();
    const jobs = await jobArgsTree(String(lastJob?.id), {
      windmill: WINDMILL,
      workspace: WORKSPACE,
      token: windmillToken(),
    });
    const crawlHost = jobs.find((job) => job.path === CRAWL_HOST);
    expect(crawlHost, "crawl_host の段まで辿れていない").toBeDefined();
    expect(
      (crawlHost?.args as Record<string, unknown> | undefined)?.["secret_archive"],
      "flow が secret_archive を crawl_host に運んでいない (flow.yaml の input_transforms)",
    ).toEqual({ [SECRET_NAME]: "keep" });

    // ③ WACZ: settings に keep が残り、値は通信の記録 (WARC) に値のまま在る。置き換えた印は無い
    const archive = await api.archiveOf(`${FIXTURES}/plain-html`, String(got["startedAt"]));
    const members = await readWacz(await api.signedUrl(archive.id));
    expect(settingsOf(members)["secretArchive"]).toEqual({ [SECRET_NAME]: "keep" });
    expect(
      membersContaining(members, nonce).some((name) => name.startsWith("archive/")),
      "keep の値が WARC に無い —— capture-ledger の secret_archive・flow・crawl_host のどれかで keep が落ちている",
    ).toBe(true);
    expect(warcTextOf(members)).not.toContain("BrowserHive-Redacted:");
  });

  /**
   * **対照。** 上の「値が WACZ に無い」は、探し方が壊れていても緑で通る。同じ値を変数として渡した取り込みでは、
   * 同じ探し方で見つかること。
   */
  it("対照: 同じ文字列を変数で渡せば、同じ探し方で WACZ に見つかる", async () => {
    await resetFixtures();
    const value = randomBytes(12).toString("hex");
    const seed = `${FIXTURES}/plain-html`;

    const got = await api.finished(
      await api.start({
        seeds: [seed],
        maxDepth: 0,
        variables: { probe: value },
        scripts: [
          {
            inline: {
              name: "probe",
              phase: "behavior",
              source: sendsVariable("probe"),
            },
          },
        ],
      }),
    );
    expect(got["state"], String(got["error"])).toBe("succeeded");

    const archive = await api.archiveOf(seed, String(got["startedAt"]));
    const members = await readWacz(await api.signedUrl(archive.id));
    const found = membersContaining(members, value);
    expect(found, "探し方が壊れている —— 変数の値すら見つからない").toContain("datapackage.json");
    // 変数の値は通信にも出した (印の URL) ので、WARC か索引にも残る
    expect(found.some((name) => name.startsWith("archive/") || name.startsWith("indexes/"))).toBe(
      true,
    );
  });

  /**
   * **必須の変数を渡さなければ、始める前に断る (CAPTURE-20)。** 判定は ts-compile-service の `BH0001` で、capture-ledger が行を
   * 立てる前に訊く。行は立たず、相手のサイトへの要求も 1 本も出ない。
   */
  it("必須の変数を渡さなければ、400 と BH0001 で断り、行も相手への要求も残らない", async () => {
    await resetFixtures();
    const { status, text } = await api.post({
      seeds: [`${FIXTURES}/plain-html`],
      maxDepth: 0,
      scripts: [{ inline: { name: "probe", phase: "behavior", source: sendsVariable("probe") } }],
    });
    expect(status, text).toBe(400);
    const body = JSON.parse(text) as {
      error?: string;
      names?: string[];
      diagnostics?: { code: string; file: string }[];
    };
    expect(body.error).toBe("missing variables");
    expect(body.names).toEqual(["probe"]);
    expect(body.diagnostics).toMatchObject([{ code: "BH0001", file: "inline-probe.ts" }]);

    const running = await api.get("/api/crawls?state=running");
    expect(running["crawls"], "断ったのにクロールが立っている").toEqual([]);
    expect(await requestCounts(), "断ったのに相手へ要求が飛んだ").toEqual(
      expect.not.objectContaining({ "/plain-html": expect.anything() as unknown }),
    );
  });

  it("宣言の形に合わない値は、400 invalid variables で断る", async () => {
    const { status, text } = await api.post({
      seeds: [`${FIXTURES}/plain-html`],
      maxDepth: 0,
      variables: { probe: "" },
      scripts: [{ inline: { name: "probe", phase: "behavior", source: sendsVariable("probe") } }],
    });
    expect(status, text).toBe(400);
    const body = JSON.parse(text) as { error?: string; names?: string[] };
    expect(body.error).toBe("invalid variables");
    expect(body.names).toEqual(["probe"]);
  });

  /**
   * **宣言した required のシークレットが Windmill に無ければ、capture-ledger はクロールを始めない。** 400 が名前と path を言い、
   * 行は立たない (立てば以後のクロールが 409 で塞がる)。capture-ledger の単体の反証を、端から端で。
   */
  it("宣言した required のシークレットが Windmill に無ければ、capture-ledger が 400 で名指し、行は立たない", async () => {
    const name = `nope_${randomUUID().slice(0, 8).replace(/-/g, "")}`;
    const { status, text } = await api.post({
      seeds: [`${FIXTURES}/plain-html`],
      maxDepth: 0,
      scripts: [
        {
          inline: {
            name: "probe",
            phase: "behavior",
            source: sendsSecretLength(name),
            params: [{ name, kind: "secret", required: true, summary: "無い鍵" }],
          },
        },
      ],
    });
    expect(status, text).toBe(400);
    const body = JSON.parse(text) as { error?: string; secrets?: { name: string; path: string }[] };
    expect(body.error).toBe("unknown secrets");
    expect(body.secrets).toMatchObject([{ name, path: `f/waggle_secrets/${name}` }]);

    const running = await api.get("/api/crawls?state=running");
    expect(running["crawls"], "断ったのにクロールが立っている").toEqual([]);
  });
});
