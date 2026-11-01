import { randomBytes, randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";

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
import { datapackageOf, membersContaining, readWacz } from "./helpers/wacz.js";

/**
 * **クロールごとの値 —— 変数とシークレット —— が、台帳 → flow → crawl_host → BrowserHive → 頁 と運ばれ、
 * 残るべき所にだけ残る。**
 *
 * 単体で見えるのは「crawl_host が要求に載せる形」までで、flow が `variables` / `secrets` を運ぶか
 * (`flow.yaml` の input_transforms) と、頁の中の受け皿 (`__bh.vars` / `__bh.secrets`。BrowserHive v22.0.0)
 * に届くかは、本物を通さないと言えない。判定は 3 か所で採る:
 *
 *   - **頁の中に届いたか** —— その場の JS が印を capture-fixtures に送る。相手のリクエストログで見る
 *   - **台帳の行** —— `GET /api/crawls/:id` の `variables` (値) と `secrets` (名前と path)
 *   - **WACZ** —— `datapackage.json` の `settings.variables` (値) と `settings.secrets` (名前だけ)。シークレットの値は
 *     **全 member のどこにも無い**。同じ探し方で、変数として渡した値は見つかる (対照)
 *
 * シークレットは Windmill の変数 `f/waggle_secrets/<名前>` に試験自身が置く。値は毎回無作為なので、
 * 前の回の WACZ や run の履歴に残っていても、この回の判定には混ざらない。
 */

/** 印を送る、その場の JS。読む口は `__bh.vars` / `__bh.secrets` (capture-scripts v0.6.0 の `types/host.d.ts`)。 */
const sendsVariable = (name: string): string =>
  `(() => {\n  void fetch("/plain-html?var=" + encodeURIComponent(String(globalThis.__bh.vars.${name})));\n})();\n`;

/** シークレットは**長さだけ**を送る。値を網に送れば WARC に残り、「残らない」の判定が自分で崩れる。 */
const sendsSecretLength = (name: string): string =>
  `(() => {\n  void fetch("/plain-html?len=" + String(globalThis.__bh.secrets.${name} ?? "").length);\n})();\n`;

const SECRET_NAME = "e2e_probe";
const SECRET_PATH = `f/waggle_secrets/${SECRET_NAME}`;

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

describe("クロールごとの値 —— 変数とシークレット", () => {
  it("変数が頁に届き、台帳の行と WACZ の settings に同じ値が残る", async () => {
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
              params: [{ name: "probe", kind: "variable", required: true, summary: "印にする値" }],
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

    // ② 台帳の行に固定された値
    expect(got["variables"]).toEqual({ probe: value });
    expect(got["secrets"]).toEqual([]);

    // ③ WACZ の settings。値は記録に残る物 (settings.variables)、secrets は空の列
    const archive = await api.archiveOf(seed, String(got["startedAt"]));
    const members = await readWacz(await api.signedUrl(archive.id));
    const settings = (datapackageOf(members)["settings"] ?? {}) as Record<string, unknown>;
    expect(settings["variables"]).toEqual({ probe: value });
    expect(settings["secrets"]).toEqual([]);
    expect(membersContaining(members, value), "値が WACZ のどこにも無い").toContain(
      "datapackage.json",
    );
  });

  it("シークレットが頁に届き、WACZ にも台帳にも Windmill の run にも値は残らない", async () => {
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

    // ① 頁の中に届いた —— 長さの印。値そのものは網に出していない
    const counts = await requestCounts();
    expect(counts["/plain-html"], "取り込みが届いていない").toBeGreaterThan(0);
    expect(
      counts[`/plain-html?len=${String(value.length)}`] ?? 0,
      "シークレットが頁に届いていない —— flow の secrets・crawl_host の getVariable・BrowserHive の受け皿のどれかで切れている",
    ).toBeGreaterThan(0);

    // ② 台帳の行: 名前と path だけ。値はどこにも無い
    expect(got["variables"]).toEqual({});
    expect(got["secrets"]).toMatchObject([{ name: SECRET_NAME, path: SECRET_PATH }]);
    expect(JSON.stringify(got), "台帳の答えにシークレットの値が在る").not.toContain(value);

    // ③ WACZ: settings.secrets に名前だけ。値は全 member のどこにも無い
    const archive = await api.archiveOf(seed, String(got["startedAt"]));
    const members = await readWacz(await api.signedUrl(archive.id));
    const settings = (datapackageOf(members)["settings"] ?? {}) as Record<string, unknown>;
    expect(settings["secrets"]).toEqual([SECRET_NAME]);
    expect(settings["variables"]).toEqual({});
    expect(membersContaining(members, value), "シークレットの値が WACZ に残っている").toEqual([]);

    // ④ Windmill の run: flow と各段の引数に値は無く、path は在る (読む場所を間違えていない対照)
    const lastJob = got["lastJob"] as { id: string } | null;
    expect(lastJob, "台帳が run の id を持っていない").not.toBeNull();
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
              params: [{ name: "probe", kind: "variable", required: true, summary: "対照" }],
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
    // 変数の値は網にも出した (印の URL) ので、WARC か索引にも残る
    expect(found.some((name) => name.startsWith("archive/") || name.startsWith("indexes/"))).toBe(
      true,
    );
  });

  /**
   * **宣言した required のシークレットが Windmill に無ければ、台帳はクロールを始めない。** 400 が名前と path を言い、
   * 行は立たない (立てば以後のクロールが 409 で塞がる)。台帳の単体の反証を、端から端で。
   */
  it("宣言した required のシークレットが Windmill に無ければ、台帳が 400 で名指し、行は立たない", async () => {
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
