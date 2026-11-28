import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FIXTURES,
  FIXTURES_HOST,
  json,
  ledger,
  mintToken,
  requestCounts,
  resetFixtures,
  WAGGLE,
} from "./helpers/stack.js";
import { datapackageOf, readWacz } from "./helpers/wacz.js";

/**
 * **robots.txt の例外が、capture-ledger の行 → flow → plan_level → crawl_host → BrowserHive → 相手 と通る**（t-6bc6）。
 *
 * 単体で見えるのは「plan_level がどう判じるか」「crawl_host と report_level が何を載せるか」までで、capture-ledger が
 * 行を `robots_exemptions` で渡すか、flow が束の名乗りと申告を運ぶか (`flow.yaml` の input_transforms)、BrowserHive が
 * 申告を受けるかは、本物を通さないと言えない。判定は 4 か所で採る:
 *
 *   - **相手が受けた要求** —— capture-fixtures の `/__request-counts`（どの頁に届いたか）と `/__requests`（名乗り）
 *   - **capture-ledger の頁の行** —— `GET /api/crawls/:id/pages` の `robotsExemptionId` と、見送りの理由
 *   - **WACZ** —— `datapackage.json` の `browserhive:capture.robotsOverride`
 *
 * 撮るのは capture-fixtures の場面（v0.39.0 から）: `/robots.txt` が `Disallow: /exempt/` で、`/exempt/hub` が
 * `/exempt/status/1`・`/exempt/status/2`・`/exempt/likes` に link を持つ。hub の行（`/exempt/hub$`・seeds）と status の行
 * （`/exempt/status/*`・links）を登録すると、撮れるのは hub と status の 2 枚で、likes は撮れない。
 *
 * ## 要る一式
 *
 *   - **試験の主体 (`E2E_SUBJECT`。既定は `e2e`) が、組織 `acme` の admin であること。** 行の登録と取り消しは、人の admin だけ
 *     (`POST /api/robots-exemptions` は admin でなければ 403)。capture-ledger で
 *     `pnpm run fga:grant admin <e2e の sub> acme`。クロールの許可 (`idp:grant --user e2e`) だけでは足りない
 *   - capture-ledger が JWT で名乗る経路で動いていること (ヘッダで名乗る経路では、登録は 403)
 *   - robots.txt の例外を知る capture-ledger (行の API・`robots_exemptions` を送る・報告の `robotsExemptionId` を受ける)、
 *     `robotsOverride` を受ける BrowserHive、capture-fixtures v0.39.0 以上。それより前の一式では赤
 *
 * ## 残る物
 *
 * 登録した行は、試験の終わりに取り消す。途中で落ちて行が残ると、次の登録が 409 (同じホストと型の効いている行が在る) に
 * なるので、始めに capture-fixtures のホストの効いている行を取り消す —— **この試験は、そのホストの行を自分の物として扱う。**
 */

/** 行が当たるホスト (`url.host` の形)。 */
const HOST = new URL(FIXTURES).host;
/** 行の名乗り。capture-ledger の検査に通る形 (`BrowserHive/<版>` と、説明の頁の URL)。 */
const AGENT = "BrowserHive/e2e (+https://site.test/robots-exemption-e2e)";

const HUB = `${FIXTURES}/exempt/hub`;
const STATUS_1 = `${FIXTURES}/exempt/status/1`;
const STATUS_2 = `${FIXTURES}/exempt/status/2`;
const LIKES = `${FIXTURES}/exempt/likes`;

interface Exemption {
  id: string;
  host: string;
  state: string;
}

interface Page {
  url: string;
  state: string;
  reason: string | null;
  robotsExemptionId?: string | null;
}

interface Logged {
  url: string;
  userAgent?: string;
}

let token = "";
let api: ReturnType<typeof ledger>;

const auth = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

const listed = async (): Promise<Exemption[]> =>
  (await api.get("/api/robots-exemptions"))["exemptions"] as Exemption[];

/** 行を 1 つ登録して番号を返す。201 でなければ、capture-ledger の本文を理由に落とす。 */
const register = async (pathPattern: string, scope: "seeds" | "links"): Promise<string> => {
  const res = await fetch(`${WAGGLE}/api/robots-exemptions`, {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({
      orgId: "acme",
      host: HOST,
      pathPattern,
      scope,
      userAgent: AGENT,
      reason: "capture-scheduler の e2e (robots-exemptions.e2e.test.ts)",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }),
  });
  const text = await res.text();
  expect(
    res.status,
    text +
      (res.status === 403
        ? " —— 試験の主体が acme の admin ではない (capture-ledger: pnpm run fga:grant admin <sub> acme)"
        : ""),
  ).toBe(201);
  return String((JSON.parse(text) as Exemption).id);
};

/** 取り消す。本文は無いので content-type を送らない。 */
const revoke = async (id: string): Promise<void> => {
  const res = await fetch(`${WAGGLE}/api/robots-exemptions/${id}/revoke`, {
    method: "POST",
    headers: auth(),
  });
  expect(res.status, await res.text()).toBe(200);
};

/** capture-fixtures のホストの、効いている行をみな取り消す。 */
const revokeActive = async (): Promise<void> => {
  for (const row of await listed()) {
    if (row.host === HOST && row.state === "active") await revoke(row.id);
  }
};

const pagesOf = async (crawlId: string): Promise<Page[]> =>
  (await api.get(`/api/crawls/${crawlId}/pages`))["pages"] as Page[];

/** 相手が見た要求のうち、`/exempt/` の下の物と、`/robots.txt` (plan_level が取る)。 */
const seenByFixtures = async (): Promise<{ exempt: Logged[]; robots: Logged[] }> => {
  const { requests } = (await json(await fetch(`${FIXTURES_HOST}/__requests`))) as unknown as {
    requests: Logged[];
  };
  const pathOf = (r: Logged) => new URL(r.url, "http://x").pathname;
  return {
    exempt: requests.filter((r) => pathOf(r).startsWith("/exempt/")),
    robots: requests.filter((r) => pathOf(r) === "/robots.txt"),
  };
};

/** 起点の hub から 1 段だけ辿るクロールを 1 本通す。 */
const crawlHub = async (): Promise<{ crawlId: string; got: Record<string, unknown> }> => {
  const crawlId = await api.start({ seeds: [HUB], maxDepth: 1, maxPages: 10 });
  return { crawlId, got: await api.finished(crawlId) };
};

beforeAll(async () => {
  token = await mintToken();
  api = ledger(token);
  await revokeActive();
});

afterAll(async () => {
  await revokeActive();
  await resetFixtures();
});

describe("robots.txt の例外", () => {
  it("行が無ければ、robots.txt が断った起点は今までどおり見送る", async () => {
    await resetFixtures();

    const { crawlId } = await crawlHub();

    const counts = await requestCounts();
    expect(counts["/exempt/hub"] ?? 0, "行が無いのに、断られた起点に触れた").toBe(0);
    const hub = (await pagesOf(crawlId)).find((page) => page.url === HUB);
    expect(hub?.state).toBe("skipped");
    expect(hub?.reason).toBe("robots");
  });

  it("行に当たる頁だけを、行の名乗りで撮り、頁の行と WACZ に例外が残る。取り消した後は見送る", async () => {
    await resetFixtures();
    const hubRow = await register("/exempt/hub$", "seeds");
    const statusRow = await register("/exempt/status/*", "links");

    const { crawlId, got } = await crawlHub();
    expect(got["state"], String(got["error"])).toBe("succeeded");

    // 相手に届いたのは hub と status の 2 枚。likes は robots.txt が断り、どの行の型にも当たらない
    const counts = await requestCounts();
    expect(counts["/exempt/hub"], "起点が撮れていない").toBeGreaterThan(0);
    expect(counts["/exempt/status/1"], "型に当たる link が撮れていない").toBeGreaterThan(0);
    expect(counts["/exempt/status/2"], "型に当たる link が撮れていない").toBeGreaterThan(0);
    expect(counts["/exempt/likes"] ?? 0, "型に当たらない link に触れた").toBe(0);

    // 名乗りは行の字 (クロールの User-Agent は頼んでいない)。robots.txt も行の名乗りで読む (CAPTURE-508)
    const { exempt: seen, robots } = await seenByFixtures();
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen.map((r) => r.userAgent)), "行の名乗りでない要求が在る").toEqual(
      new Set([AGENT]),
    );
    expect(robots.length, "robots.txt が取られていない").toBeGreaterThan(0);
    expect(
      new Set(robots.map((r) => r.userAgent)),
      "robots.txt を行の名乗りで読んでいない",
    ).toEqual(new Set([AGENT]));

    // 頁の行に、外した行の番号が残る。likes は robots の見送りのまま
    const pages = await pagesOf(crawlId);
    const exemptionOf = (url: string) => pages.find((page) => page.url === url)?.robotsExemptionId;
    expect(exemptionOf(HUB)).toBe(hubRow);
    expect(exemptionOf(STATUS_1)).toBe(statusRow);
    expect(exemptionOf(STATUS_2)).toBe(statusRow);
    const likes = pages.find((page) => page.url === LIKES);
    expect(likes?.state).toBe("skipped");
    expect(likes?.reason).toBe("robots");
    expect(likes?.robotsExemptionId ?? null).toBeNull();

    // WACZ に、求めた側の申告が在る (BrowserHive は確かめずに書く)
    const archive = await api.archiveOf(HUB, String(got["startedAt"]));
    const capture = datapackageOf(await readWacz(await api.signedUrl(archive.id)))[
      "browserhive:capture"
    ] as { robotsOverride?: Record<string, unknown> } | undefined;
    expect(capture?.robotsOverride, "WACZ に robotsOverride が無い").toMatchObject({
      exemptionId: hubRow,
      pathPattern: "/exempt/hub$",
      scope: "seeds",
    });

    // 取り消した後に始めたクロールは、今までどおり見送る
    await revoke(hubRow);
    await revoke(statusRow);
    await resetFixtures();
    const after = await crawlHub();
    expect((await requestCounts())["/exempt/hub"] ?? 0, "取り消した後に、起点に触れた").toBe(0);
    const hub = (await pagesOf(after.crawlId)).find((page) => page.url === HUB);
    expect(hub?.state).toBe("skipped");
    expect(hub?.reason).toBe("robots");
  });
});
