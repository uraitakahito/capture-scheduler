import { describe, it, expect, vi, afterEach } from "vitest";
import {
  endpointCount,
  exemptionProblem,
  main,
  parallelismFor,
  robotsToken,
  type Candidate,
  type RobotsExemption,
} from "../windmill/f/waggle/plan_level.js";

/**
 * 段の計画。**この repo の Windmill script で唯一、判断が集まっている場所。**
 *
 * IO は robots.txt を取る `fetch` 1 つだけなので、それを差し替えれば全部見える。
 * Windmill も capture-ledger も browserhive も要らない。
 *
 * ここに試験が無かった間に、`respect_robots` が `null` で届いて robots が一度も
 * 読まれない状態が出荷された。**クロールは成功し、アーカイブも正常に見えた** ——
 * capture-fixtures のフィクスチャで実際に取りに行った先を見るまで気づけなかった。
 */

/** BrowserHive のエンドポイントの一覧。並列度の上限になる。試験は 2 つで固定。 */
const VARS: Record<string, string> = {
  "u/admin/browserhive_endpoints": JSON.stringify(["bh-1:50051", "bh-2:50051"]),
};

vi.mock("windmill-client", () => ({
  getVariable: (path: string) => Promise.resolve(VARS[path]),
}));

/** robots.txt を返す fetch。呼ばれた URL を記録する。 */
const robotsServing = (body: string | undefined) => {
  const calls: string[] = [];
  const fake = vi.fn((input: string | URL) => {
    calls.push(String(input));
    if (body === undefined) return Promise.resolve({ ok: false, status: 404 } as Response);
    return Promise.resolve({ ok: true, text: () => Promise.resolve(body) } as Response);
  });
  vi.stubGlobal("fetch", fake);
  return calls;
};

const at = (url: string, lastFinishedAt?: string | null): Candidate => ({
  url,
  host: new URL(url).host,
  ...(lastFinishedAt === undefined ? {} : { lastFinishedAt }),
});

const HIDDEN = "User-agent: *\nDisallow: /links/hidden\n";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("robots を読むかどうか", () => {
  it("respect_robots が null でも読む", async () => {
    // **これが本丸。** flow の input_transform は、渡されていない引数を JavaScript の
    // `undefined` として評価するが、Windmill はそれを JSON の `null` にして渡す。
    // TypeScript の既定引数が効くのは `undefined` のときだけなので、`null` は素通りし、
    // falsy なので robots が一度も読まれない。
    //
    // schema に `default: true` があっても救われない —— 既定値は UI からの実行にしか
    // 埋まらず、capture-ledger は webhook で起こす (実測で確認済み)。守っているのは
    // `?? true` の 1 か所だけ。
    const calls = robotsServing(HIDDEN);
    const plan = await main([at("http://m:8080/links/hidden")], 1000, null);

    expect(calls).toEqual(["http://m:8080/robots.txt"]);
    expect(plan.groups).toHaveLength(0);
    expect(plan.skipped).toEqual([{ url: "http://m:8080/links/hidden", reason: "robots" }]);
  });

  it("respect_robots を渡さなくても読む", async () => {
    const calls = robotsServing(HIDDEN);
    const plan = await main([at("http://m:8080/links/hidden")], 1000);
    expect(calls).toHaveLength(1);
    expect(plan.skipped).toHaveLength(1);
  });

  it("false なら一度も取りに行かない", async () => {
    // 「尊重しない」と「取得に失敗した」を同じ挙動にしない。取りに行かないことを
    // 押さえるので、`fetchRobots` が握り潰す形に変わっても赤くなる。
    const calls = robotsServing(HIDDEN);
    const plan = await main([at("http://m:8080/links/hidden")], 1000, false);

    expect(calls).toEqual([]);
    expect(plan.groups[0]!.urls).toEqual(["http://m:8080/links/hidden"]);
    expect(plan.skipped).toEqual([]);
  });

  it("robots が無ければ制限なしとして扱う", async () => {
    // 404 も接続失敗も同じ。robots.txt が無いことは「取ってはいけない」ではない。
    robotsServing(undefined);
    const plan = await main([at("http://m:8080/links/hidden")], 1000, true);
    expect(plan.groups[0]!.urls).toHaveLength(1);
  });

  it("取得が投げても止まらない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))),
    );
    const plan = await main([at("http://m:8080/a")], 1000, true);
    expect(plan.groups[0]!.urls).toEqual(["http://m:8080/a"]);
  });
});

describe("robots を照らす名前", () => {
  const TWO_GROUPS = [
    "User-agent: BrowserHive",
    "Disallow: /named-only",
    "Crawl-delay: 7",
    "",
    "User-agent: *",
    "Disallow: /everyone",
    "Crawl-delay: 3",
    "",
  ].join("\n");
  const CANDIDATES = [at("http://m:8080/named-only"), at("http://m:8080/everyone")];

  it("字に BrowserHive があれば、名指しの組で照らす", async () => {
    robotsServing(TWO_GROUPS);
    const plan = await main(CANDIDATES, 1000, true, null, "{chrome} BrowserHive");
    expect(plan.skipped).toEqual([{ url: "http://m:8080/named-only", reason: "robots" }]);
    expect(plan.groups[0]!.urls).toEqual(["http://m:8080/everyone"]);
  });

  it("空の字なら * の組で照らす", async () => {
    robotsServing(TWO_GROUPS);
    const plan = await main(CANDIDATES, 1000, true, null, "");
    expect(plan.skipped).toEqual([{ url: "http://m:8080/everyone", reason: "robots" }]);
    expect(plan.groups[0]!.urls).toEqual(["http://m:8080/named-only"]);
  });

  it("届かなければ（null）* の組で照らす", async () => {
    robotsServing(TWO_GROUPS);
    const plan = await main(CANDIDATES, 1000, true, null, null);
    expect(plan.skipped).toEqual([{ url: "http://m:8080/everyone", reason: "robots" }]);
  });

  it("Crawl-delay も同じ組から読む", async () => {
    robotsServing(TWO_GROUPS);
    const named = await main([at("http://m:8080/a")], 500, true, null, "Probe/1 BrowserHive");
    expect(named.groups[0]!.delayMs).toBe(7000);
    robotsServing(TWO_GROUPS);
    const everyone = await main([at("http://m:8080/a")], 500, true, null, "");
    expect(everyone.groups[0]!.delayMs).toBe(3000);
  });

  it("名指しの組が無ければ、BrowserHive でも * の組に落ちる", async () => {
    robotsServing(HIDDEN);
    const plan = await main(
      [at("http://m:8080/links/hidden")],
      1000,
      true,
      null,
      "{chrome} BrowserHive",
    );
    expect(plan.skipped).toEqual([{ url: "http://m:8080/links/hidden", reason: "robots" }]);
  });

  it("名前は語として探す", () => {
    expect(robotsToken("{chrome} BrowserHive")).toBe("BrowserHive");
    expect(robotsToken("BrowserHive/25")).toBe("BrowserHive");
    expect(robotsToken("NotBrowserHiveAtAll")).toBe("*");
    expect(robotsToken("")).toBe("*");
    expect(robotsToken(null)).toBe("*");
  });
});

describe("Crawl-delay の扱い", () => {
  it("robots のほうが長ければ robots を採る", async () => {
    robotsServing("User-agent: *\nCrawl-delay: 3\n");
    const plan = await main([at("http://m:8080/a")], 500, true);
    expect(plan.groups[0]!.delayMs).toBe(3000);
  });

  it("設定のほうが長ければ設定を採る", async () => {
    // **上と対になっていることに意味がある。** ただし理由は `Math.min` ではない ——
    // それは上の 1 本でも赤くなる (反証で確認)。この 1 本だけが捕まえるのは
    // **「robots があれば常に robots を採る」** という実装。上の 1 本は素通りする。
    // 「長いほうを採る」を言い切るには、設定のほうが長い場合が要る。
    robotsServing("User-agent: *\nCrawl-delay: 1\n");
    const plan = await main([at("http://m:8080/a")], 5000, true);
    expect(plan.groups[0]!.delayMs).toBe(5000);
  });

  it("Crawl-delay が無ければ設定のまま", async () => {
    robotsServing("User-agent: *\n");
    const plan = await main([at("http://m:8080/a")], 2000, true);
    expect(plan.groups[0]!.delayMs).toBe(2000);
  });
});

describe("段をまたぐ待ち", () => {
  it("直前に触っていれば残りぶんだけ待つ", async () => {
    // 3000ms の間隔で、1000ms 前に終わっている → 残り 2000ms。
    robotsServing("User-agent: *\n");
    const oneSecondAgo = new Date(Date.now() - 1000).toISOString();
    const plan = await main([at("http://m:8080/a", oneSecondAgo)], 3000, true);

    // 実時間が僅かに進むので幅で見る。押さえたいのは「差し引いている」こと。
    expect(plan.groups[0]!.initialDelayMs).toBeGreaterThan(1800);
    expect(plan.groups[0]!.initialDelayMs).toBeLessThanOrEqual(2000);
  });

  it("間隔より前に終わっていれば待たない", async () => {
    // 負の値を返さないこと。`Math.max(0, …)` が無いと負の待ちが段に載る。
    robotsServing("User-agent: *\n");
    const longAgo = new Date(Date.now() - 60_000).toISOString();
    const plan = await main([at("http://m:8080/a", longAgo)], 3000, true);
    expect(plan.groups[0]!.initialDelayMs).toBe(0);
  });

  it("最初の段は待たない", async () => {
    // `lastFinishedAt` が null。触ったことがないので差し引くものが無い。
    robotsServing("User-agent: *\n");
    const plan = await main([at("http://m:8080/a", null)], 3000, true);
    expect(plan.groups[0]!.initialDelayMs).toBe(0);
  });
});

describe("ホストで束ねる", () => {
  it("ホストごとに 1 group にまとめる", async () => {
    // 束ねる単位が並列度の単位になる。崩れると 1 ホストに同時に当たる。
    robotsServing("User-agent: *\n");
    const plan = await main(
      [at("http://a:8080/1"), at("http://b:8080/1"), at("http://a:8080/2")],
      1000,
      true,
    );

    expect(plan.groups).toHaveLength(2);
    expect(plan.groups.find((g) => g.host === "a:8080")!.urls).toEqual([
      "http://a:8080/1",
      "http://a:8080/2",
    ]);
  });

  it("robots を引くのはホストにつき 1 回", async () => {
    const calls = robotsServing("User-agent: *\n");
    await main([at("http://a:8080/1"), at("http://a:8080/2"), at("http://a:8080/3")], 1000, true);
    expect(calls).toEqual(["http://a:8080/robots.txt"]);
  });

  it("全部 disallow されたホストは group ごと消える", async () => {
    // 空の group を段に残さない。残すと flow の for-loop が空回りし、
    // 「触ったが 0 件だった」と「触らなかった」の区別が付かなくなる。
    robotsServing("User-agent: *\nDisallow: /\n");
    const plan = await main([at("http://a:8080/1"), at("http://a:8080/2")], 1000, true);

    expect(plan.groups).toEqual([]);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skipped.every((s) => s.reason === "robots")).toBe(true);
  });

  it("同じホストで許可と禁止が混ざれば許可だけ残る", async () => {
    robotsServing(HIDDEN);
    const plan = await main(
      [at("http://m:8080/links/hidden"), at("http://m:8080/links/leaf/1")],
      1000,
      true,
    );

    expect(plan.groups[0]!.urls).toEqual(["http://m:8080/links/leaf/1"]);
    expect(plan.skipped).toEqual([{ url: "http://m:8080/links/hidden", reason: "robots" }]);
  });
});

/**
 * robots.txt の例外 (t-6bc6)。組織の admin が capture-ledger に登録した行に当たる頁は、robots.txt が断っていても撮る。
 *
 * **判じるのはここ 1 か所**なので、ここで言い切る: 外すのは robots.txt が断った頁だけ・範囲と深さ・残りの枚数・
 * 名乗り・間隔の下限・壊れた行は当てない。行を選ぶ側 (組織・期限・取り消し) は capture-ledger の試験が見る。
 */
describe("robots.txt の例外", () => {
  /** capture-fixtures の場面と同じ形: `/exempt/` の下を全部断る。Crawl-delay は無い。 */
  const EXEMPT = "User-agent: *\nDisallow: /exempt/\n";
  const AGENT = "BrowserHive/1.0 (+https://site.test/bot)";
  const HUB = "http://m:8080/exempt/hub";
  const STATUS_1 = "http://m:8080/exempt/status/1";
  const STATUS_2 = "http://m:8080/exempt/status/2";
  const LIKES = "http://m:8080/exempt/likes";

  const row = (over: Partial<RobotsExemption> = {}): RobotsExemption => {
    const base = {
      id: "7",
      host: "m:8080",
      pathPattern: "/exempt/status/*",
      scope: "links" as const,
      userAgent: AGENT,
      remaining: 5,
      ...over,
    };
    return {
      ...base,
      declaration: over.declaration ?? {
        exemptionId: base.id,
        reason: "公開の告知を残す",
        pathPattern: base.pathPattern,
        scope: base.scope,
        grantedBy: "admin@acme",
        grantedAt: "2026-11-28T00:00:00Z",
        expiresAt: "2026-12-28T00:00:00Z",
      },
    };
  };

  /** クロールの User-Agent は空、並列度は既定で、深さと行だけを替えて呼ぶ。 */
  const plan = (urls: string[], depth: number | null, rows: unknown, delayMs = 1000) =>
    main(
      urls.map((url) => at(url)),
      delayMs,
      true,
      null,
      "",
      depth,
      rows as RobotsExemption[] | null,
    );

  it("robots.txt が断り、型に当たる頁は通し、行の番号と申告を載せる", async () => {
    robotsServing(EXEMPT);
    const exemption = row();
    const got = await plan([STATUS_1], 1, [exemption]);

    expect(got.skipped).toEqual([]);
    expect(got.overridden).toEqual([{ url: STATUS_1, exemptionId: "7" }]);
    expect(got.groups).toHaveLength(1);
    expect(got.groups[0]!.urls).toEqual([STATUS_1]);
    // 申告は渡された物のまま (書き換えない)
    expect(got.groups[0]!.robotsOverrides).toEqual({ [STATUS_1]: exemption.declaration });
  });

  it("型に当たらない頁は、今までどおり robots で見送る", async () => {
    robotsServing(EXEMPT);
    const got = await plan([STATUS_1, LIKES], 1, [row()]);

    expect(got.skipped).toEqual([{ url: LIKES, reason: "robots" }]);
    expect(got.overridden).toEqual([{ url: STATUS_1, exemptionId: "7" }]);
    expect(got.groups[0]!.urls).toEqual([STATUS_1]);
  });

  it("型は robots.txt と同じ読み方 —— 末尾の $ は、そこで終わる path にだけ当たる", async () => {
    robotsServing(EXEMPT);
    const got = await plan([HUB, `${HUB}/more`], 0, [row({ pathPattern: "/exempt/hub$" })]);

    expect(got.overridden).toEqual([{ url: HUB, exemptionId: "7" }]);
    expect(got.skipped).toEqual([{ url: `${HUB}/more`, reason: "robots" }]);
  });

  it("https のホストでも型が当たる（型を読ませる base の origin を、候補と揃えている）", async () => {
    robotsServing(EXEMPT);
    const url = "https://secure.test/exempt/status/1";
    const got = await plan([url], 1, [row({ host: "secure.test" })]);
    expect(got.overridden).toEqual([{ url, exemptionId: "7" }]);
  });

  it("範囲が seeds の行は深さ 0 でだけ効き、深さ 1 では効かない（名乗りも変えない）", async () => {
    const seeds = row({ pathPattern: "/exempt/hub$", scope: "seeds" });

    robotsServing(EXEMPT);
    const seed = await plan([HUB], 0, [seeds]);
    expect(seed.overridden).toEqual([{ url: HUB, exemptionId: "7" }]);
    expect(seed.groups[0]!.userAgent).toBe(AGENT);

    robotsServing(EXEMPT);
    const linked = await plan([HUB, "http://m:8080/open"], 1, [seeds]);
    expect(linked.overridden).toEqual([]);
    expect(linked.skipped).toEqual([{ url: HUB, reason: "robots" }]);
    expect(linked.groups[0]!.userAgent).toBe("");
  });

  it("深さが届かなければ（null）、seeds の行は効かない（守る側）", async () => {
    robotsServing(EXEMPT);
    const got = await plan([HUB], null, [row({ pathPattern: "/exempt/hub$", scope: "seeds" })]);
    expect(got.overridden).toEqual([]);
    expect(got.skipped).toEqual([{ url: HUB, reason: "robots" }]);
  });

  it("範囲が links の行は、深さ 0 でも 1 でも効く", async () => {
    for (const depth of [0, 1, 3]) {
      robotsServing(EXEMPT);
      const got = await plan([STATUS_1], depth, [row()]);
      expect(got.overridden, `深さ ${String(depth)}`).toEqual([
        { url: STATUS_1, exemptionId: "7" },
      ]);
    }
  });

  it("残りが 0 の行は外さず、robots-exemption-limit で見送る", async () => {
    robotsServing(EXEMPT);
    const got = await plan([STATUS_1], 1, [row({ remaining: 0 })]);

    expect(got.groups).toEqual([]);
    expect(got.overridden).toEqual([]);
    expect(got.skipped).toEqual([{ url: STATUS_1, reason: "robots-exemption-limit" }]);
  });

  it("残りが 1 で候補が 2 つなら、1 つを通し、1 つを robots-exemption-limit で見送る", async () => {
    robotsServing(EXEMPT);
    const exemption = row({ remaining: 1 });
    const got = await plan([STATUS_1, STATUS_2], 1, [exemption]);

    expect(got.overridden).toEqual([{ url: STATUS_1, exemptionId: "7" }]);
    expect(got.skipped).toEqual([{ url: STATUS_2, reason: "robots-exemption-limit" }]);
    expect(Object.keys(got.groups[0]!.robotsOverrides ?? {})).toEqual([STATUS_1]);
    // 渡された行は書き換えない (残りはこの呼び出しの中でだけ数える)
    expect(exemption.remaining).toBe(1);
  });

  it("当たる行が 2 つなら、型の長い行で外す。長さが同じなら番号の若い行", async () => {
    robotsServing(EXEMPT);
    const longer = await plan([STATUS_1], 1, [
      row({ id: "3", pathPattern: "/exempt/" }),
      row({ id: "9", pathPattern: "/exempt/status/" }),
    ]);
    expect(longer.overridden).toEqual([{ url: STATUS_1, exemptionId: "9" }]);
    expect(longer.groups[0]!.robotsOverrides![STATUS_1]!.exemptionId).toBe("9");

    // 番号は数として比べる ("10" は "9" より後)
    robotsServing(EXEMPT);
    const younger = await plan([STATUS_1], 1, [
      row({ id: "10", pathPattern: "/exempt/status/*" }),
      row({ id: "9", pathPattern: "/exempt/status/1" }),
    ]);
    expect(younger.overridden).toEqual([{ url: STATUS_1, exemptionId: "9" }]);
  });

  it("型の長い行の残りが尽きていれば、当たる次の行で外す", async () => {
    robotsServing(EXEMPT);
    const got = await plan([STATUS_1], 1, [
      row({ id: "9", pathPattern: "/exempt/status/", remaining: 0 }),
      row({ id: "3", pathPattern: "/exempt/" }),
    ]);
    expect(got.overridden).toEqual([{ url: STATUS_1, exemptionId: "3" }]);
  });

  it("robots.txt が断っていない頁には何も付けない（行の型に当たっていても）", async () => {
    robotsServing("User-agent: *\nDisallow: /elsewhere\n");
    const got = await plan([STATUS_1], 1, [row({ remaining: 1 })]);

    expect(got.groups[0]!.urls).toEqual([STATUS_1]);
    expect(got.overridden).toEqual([]);
    expect(got.groups[0]).not.toHaveProperty("robotsOverrides");
    expect(got.skipped).toEqual([]);
  });

  it("robots.txt が読めなかったホストでも、何も付けない", async () => {
    robotsServing(undefined);
    const got = await plan([STATUS_1], 1, [row()]);

    expect(got.groups[0]!.urls).toEqual([STATUS_1]);
    expect(got.overridden).toEqual([]);
    expect(got.groups[0]).not.toHaveProperty("robotsOverrides");
    // 行の在るホストなので、名乗りは行の字
    expect(got.groups[0]!.userAgent).toBe(AGENT);
  });

  it("外した頁の在るホストでも Crawl-delay は効く", async () => {
    robotsServing(`${EXEMPT}Crawl-delay: 3\n`);
    const got = await plan([STATUS_1], 1, [row()], 500);
    expect(got.groups[0]!.delayMs).toBe(3000);
  });

  it("外した頁の在るホストの間隔は 2000ms を下回らない。外していないホストは今までどおり", async () => {
    robotsServing(EXEMPT);
    const got = await main([at(STATUS_1), at("http://other:8080/a")], 500, true, null, "", 1, [
      row(),
    ]);
    expect(got.groups.find((g) => g.host === "m:8080")!.delayMs).toBe(2000);
    expect(got.groups.find((g) => g.host === "other:8080")!.delayMs).toBe(500);
  });

  it("行は在るが 1 枚も外していないホストの間隔は、今までどおり", async () => {
    robotsServing(EXEMPT);
    const got = await plan(["http://m:8080/open"], 1, [row()], 500);
    expect(got.groups[0]!.delayMs).toBe(500);
  });

  it("間隔の設定が 2000ms より長ければ、設定のまま", async () => {
    robotsServing(EXEMPT);
    const got = await plan([STATUS_1], 1, [row()], 5000);
    expect(got.groups[0]!.delayMs).toBe(5000);
  });

  it("行の在るホストは行の名乗り、無いホストはクロールの user_agent を束に載せる", async () => {
    robotsServing(EXEMPT);
    const got = await main(
      [at("http://m:8080/open"), at("http://other:8080/a")],
      1000,
      true,
      null,
      "{chrome} Probe",
      1,
      [row()],
    );
    // 断られていない頁だけのホストでも、行が在れば行の名乗りで撮る
    expect(got.groups.find((g) => g.host === "m:8080")!.userAgent).toBe(AGENT);
    expect(got.groups.find((g) => g.host === "other:8080")!.userAgent).toBe("{chrome} Probe");
  });

  it("クロールの user_agent が届かなくても（null）、束の名乗りは空の字で、null にならない", async () => {
    // crawl_host は null を取り違えとして投げる (askedUserAgent)。束には必ず字を載せる
    robotsServing(EXEMPT);
    const withRows = await main([at("http://other:8080/a")], 1000, true, null, null, 1, [row()]);
    expect(withRows.groups[0]!.userAgent).toBe("");

    robotsServing(EXEMPT);
    const without = await main([at("http://other:8080/a")], 1000, true);
    expect(without.groups[0]!.userAgent).toBe("");
  });

  it("robots.txt を照らす名前は、行の名乗りから決まる（BrowserHive の組が在れば、その組）", async () => {
    // クロールの user_agent は空なので、行が無ければ * の組で照らす。行の名乗りは BrowserHive/… なので名指しの組
    const TWO_GROUPS = [
      "User-agent: BrowserHive",
      "Disallow: /named-only",
      "Crawl-delay: 7",
      "",
      "User-agent: *",
      "Disallow: /everyone",
      "",
    ].join("\n");
    const urls = ["http://m:8080/named-only", "http://m:8080/everyone"];

    robotsServing(TWO_GROUPS);
    const withRow = await plan(urls, 1, [row({ pathPattern: "/nothing" })], 500);
    expect(withRow.skipped).toEqual([{ url: "http://m:8080/named-only", reason: "robots" }]);
    expect(withRow.groups[0]!.urls).toEqual(["http://m:8080/everyone"]);
    expect(withRow.groups[0]!.delayMs).toBe(7000);

    robotsServing(TWO_GROUPS);
    const withoutRow = await plan(urls, 1, [], 500);
    expect(withoutRow.skipped).toEqual([{ url: "http://m:8080/everyone", reason: "robots" }]);
    expect(withoutRow.groups[0]!.delayMs).toBe(500);
  });

  it("別のホストの行は当てない", async () => {
    robotsServing(EXEMPT);
    const got = await plan([STATUS_1], 1, [row({ host: "other:8080" })]);
    expect(got.overridden).toEqual([]);
    expect(got.skipped).toEqual([{ url: STATUS_1, reason: "robots" }]);
  });

  it("robots_exemptions が null・undefined・空なら、出力は今までと同じ（overridden: [] と userAgent が足されるだけ）", async () => {
    const expected = {
      groups: [
        {
          host: "m:8080",
          urls: ["http://m:8080/open"],
          delayMs: 1000,
          initialDelayMs: 0,
          userAgent: "Probe/1 BrowserHive",
        },
      ],
      skipped: [{ url: STATUS_1, reason: "robots" }],
      overridden: [],
      parallelism: 2,
    };
    for (const rows of [null, undefined, []]) {
      robotsServing(EXEMPT);
      const got = await main(
        [at("http://m:8080/open"), at(STATUS_1)],
        1000,
        true,
        null,
        "Probe/1 BrowserHive",
        0,
        rows,
      );
      expect(got, String(rows)).toEqual(expected);
    }
  });

  describe("壊れた行は当てない（今までどおり robots.txt に従う）", () => {
    const refused = async (rows: unknown) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      robotsServing(EXEMPT);
      const got = await plan([STATUS_1], 1, rows);
      const lines = log.mock.calls.flat().join("\n");
      log.mockRestore();
      expect(got.overridden).toEqual([]);
      expect(got.skipped).toEqual([{ url: STATUS_1, reason: "robots" }]);
      return lines;
    };

    it("名乗りの検査に通らない行。log に行の番号と訳を出す", async () => {
      const lines = await refused([row({ userAgent: "BrowserHive/1.0 Chrome/131.0" })]);
      expect(lines).toContain("行 7 を当てない");
      expect(lines).toContain("userAgent");
    });

    it("名乗りの決まりは capture-ledger の登録の検査と同じ", () => {
      const problemOf = (userAgent: string) => exemptionProblem(row({ userAgent }));
      expect(problemOf("BrowserHive/1.0")).toBeUndefined();
      expect(problemOf("BrowserHive/31.2.0-rc.1+build")).toBeUndefined();
      expect(problemOf(AGENT)).toBeUndefined();
      for (const refusedAgent of [
        "",
        "{chrome} BrowserHive",
        "Mozilla/5.0 (compatible; BrowserHive/1.0)",
        "BrowserHive/1.0 (compatible; Googlebot/2.1)",
        // 並びに無い名も、google の 1 語で塞ぐ
        "BrowserHive/1.0 (+https://site.test/AdsBot-Google)",
        "BrowserHive/1.0 (+https://site.test/GPTBot)",
        // 短い印は語の境目で当てる
        "BrowserHive/1.0 (+https://site.test/edge)",
        // URL の中の、製品の印の形
        "BrowserHive/1.0 (+https://site.test/Version/17)",
        // 注は URL 1 つだけ
        "BrowserHive/1.0 (+https://site.test/bot) extra",
        "BrowserHive/1.0 (contact admin)",
        "BrowserHive",
        `BrowserHive/1.0 (+https://site.test/${"a".repeat(512)})`,
      ]) {
        expect(problemOf(refusedAgent), refusedAgent).toBeDefined();
      }
      // 語の一部になる短い印は断らない (knowledge の edg)
      expect(problemOf("BrowserHive/1.0 (+https://site.test/knowledge)")).toBeUndefined();
    });

    it("型の壊れた行（/ で始まらない・空白・#・改行・257 字・字でない）", async () => {
      for (const pathPattern of [
        "exempt/status/",
        "/exempt/status/ x",
        "/exempt/status/#x",
        "/exempt/status/\nAllow: /",
        `/${"a".repeat(256)}`,
        42,
      ]) {
        await refused([{ ...row(), pathPattern }]);
      }
    });

    it("remaining が負・小数・数でない行", async () => {
      for (const remaining of [-1, 1.5, "3", null]) {
        await refused([{ ...row(), remaining }]);
      }
    });

    it("declaration が object でない行、番号が数字の字でない行、範囲が知らない字の行", async () => {
      await refused([{ ...row(), declaration: null }]);
      await refused([{ ...row(), declaration: "x" }]);
      await refused([{ ...row(), declaration: [] }]);
      await refused([{ ...row(), id: "seven" }]);
      await refused([{ ...row(), id: 7 }]);
      await refused([{ ...row(), scope: "all" }]);
      await refused([null]);
    });

    it("並びでない robots_exemptions", async () => {
      await refused({ id: "7" });
    });

    it("壊れた行が混ざっていても、良い行は当てる", async () => {
      robotsServing(EXEMPT);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const got = await plan([STATUS_1], 1, [{ ...row({ id: "8" }), remaining: -1 }, row()]);
      log.mockRestore();
      expect(got.overridden).toEqual([{ url: STATUS_1, exemptionId: "7" }]);
    });

    it("名乗りが 2 種類在るホストの行は、みな当てない。名乗りもクロールの字のまま", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      robotsServing(EXEMPT);
      const got = await main(
        [at(STATUS_1), at("http://m:8080/open")],
        1000,
        true,
        null,
        "{chrome}",
        1,
        [row(), row({ id: "8", pathPattern: "/exempt/", userAgent: "BrowserHive/2.0" })],
      );
      const lines = log.mock.calls.flat().join("\n");
      log.mockRestore();

      expect(got.overridden).toEqual([]);
      expect(got.skipped).toEqual([{ url: STATUS_1, reason: "robots" }]);
      expect(got.groups[0]!.userAgent).toBe("{chrome}");
      expect(lines).toContain("名乗りが 2 種類");
    });

    it("この段で効かない行の名乗りは、数えない（seeds の行と links の行で名乗りが違っても、深さ 1 では links の行が効く）", async () => {
      robotsServing(EXEMPT);
      const got = await plan([STATUS_1], 1, [
        row(),
        row({ id: "8", pathPattern: "/exempt/hub$", scope: "seeds", userAgent: "BrowserHive/2.0" }),
      ]);
      expect(got.overridden).toEqual([{ url: STATUS_1, exemptionId: "7" }]);
      expect(got.groups[0]!.userAgent).toBe(AGENT);
    });
  });
});

describe("並列度は BrowserHive のエンドポイントの数で頭を押さえる", () => {
  /**
   * エンドポイントより多くのホストを同時に回しても、余ったぶんは busy を引いて待つだけで
   * 相手から見た並列度は増えない。決めるのはここで、flow の式には置かない。
   */
  it("host_parallelism がエンドポイントより多ければエンドポイントの数", () => {
    expect(parallelismFor(4, 2)).toBe(2);
  });

  it("host_parallelism がエンドポイントより少なければそのまま", () => {
    expect(parallelismFor(1, 2)).toBe(1);
  });

  it("渡されていなければ flow の schema と同じ既定 (4) から始める", () => {
    // webhook 起動では schema の既定値が埋まらず null で届く。
    expect(parallelismFor(null, 8)).toBe(4);
    expect(parallelismFor(undefined, 2)).toBe(2);
  });

  it("0 以下でも 1 は回す", () => {
    // 0 のままだと for-loop が何も回さず、段が空で「成功」する。
    expect(parallelismFor(0, 2)).toBe(1);
  });

  it("plan に載せる", async () => {
    robotsServing(undefined);
    const plan = await main([at("http://m:8080/a")], 1000, true, 4);
    expect(plan.parallelism).toBe(2);
  });

  it("エンドポイントの一覧が空なら落ちる", () => {
    // 「並列度 0」として通すと、for-loop は何も回さずに段が空で成功する。
    expect(() => endpointCount("[]")).toThrow("空でない");
    expect(() => endpointCount("bh-1:50051")).toThrow("JSON");
  });
});
