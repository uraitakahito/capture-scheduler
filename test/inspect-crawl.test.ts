import { describe, it, expect, vi, afterEach } from "vitest";
import {
  main,
  renderCrawl,
  resolveCrawl,
  type CrawlDetail,
  type Decisions,
  type Getter,
} from "../windmill/f/waggle/inspect_crawl.js";

/**
 * クロール 1 本の判断を読む調べ物の script。
 *
 * 判断そのものは台帳の物で、ここは引いて描くだけ。押さえるのは **違うクロールを読まないこと**
 * (前の字の引き当て) と、**読み違えない描き方** (0 回の規則の印・どれにも当たらない物・robots)。
 */

const VARS: Record<string, string> = {
  "u/admin/waggle_api_url": "http://capture-ledger:7070",
  "u/admin/waggle_token": "tok",
};

vi.mock("windmill-client", () => ({
  getVariable: (path: string) => Promise.resolve(VARS[path]),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const ID = "5b0c0007-1111-4222-8333-444455556666";
const listed = (crawlId: string, startedAt: string) => ({
  crawlId,
  startedAt,
  seeds: ["http://capture-fixtures.capture-ledger:8080/links/rules"],
});

/** 一覧のページを順に返す偽の台帳。引かれた path を記録する。 */
const pages = (...answers: { crawls: unknown[] }[]) => {
  const asked: string[] = [];
  const get = (<T>(path: string): Promise<T> => {
    asked.push(path);
    return Promise.resolve((answers.shift() ?? { crawls: [] }) as T);
  }) as Getter;
  return { get, asked };
};

describe("クロールの id を引き当てる", () => {
  it("id を全部書けば、そのまま使い、一覧を引かない", async () => {
    const { get, asked } = pages();
    expect(await resolveCrawl(` ${ID.toUpperCase()} `, get)).toBe(ID);
    expect(asked).toEqual([]);
  });

  it("前の 8 字なら一覧を新しい順に読み、前のページの最後の開始時刻で次を引く", async () => {
    const { get, asked } = pages(
      { crawls: [listed("aaaaaaaa-1111-4222-8333-444455556666", "2026-10-25T10:00:00.000Z")] },
      { crawls: [listed(ID, "2026-10-24T09:00:00.000Z")] },
    );
    expect(await resolveCrawl("5b0c0007", get)).toBe(ID);
    expect(asked).toEqual([
      "/api/crawls",
      `/api/crawls?before=${encodeURIComponent("2026-10-25T10:00:00.000Z")}`,
      `/api/crawls?before=${encodeURIComponent("2026-10-24T09:00:00.000Z")}`,
    ]);
  });

  it("当たるクロールが無ければ、id を全部書くよう言って止める", async () => {
    const { get } = pages({ crawls: [listed("aaaaaaaa-1111-4222-8333-444455556666", "x")] });
    await expect(resolveCrawl("5b0c0007", get)).rejects.toThrow("5b0c0007 で始まるクロールが");
  });

  it("2 本当たれば、どちらも選ばずに 2 本とも名指して止める", async () => {
    const twin = "5b0c0007-9999-4222-8333-444455556666";
    const { get } = pages({
      crawls: [listed(ID, "2026-10-25T10:00:00.000Z"), listed(twin, "2026-10-25T09:00:00.000Z")],
    });
    const failed = resolveCrawl("5b0c0007", get);
    await expect(failed).rejects.toThrow("2 本あります");
    await expect(
      resolveCrawl("5b0c0007", pages({ crawls: [listed(ID, "a"), listed(twin, "b")] }).get),
    ).rejects.toThrow(twin);
  });

  it("id の字でない物は、一覧を引く前に断る", async () => {
    const { get, asked } = pages();
    await expect(resolveCrawl("hello", get)).rejects.toThrow("クロールの id か");
    expect(asked).toEqual([]);
  });
});

const DETAIL: CrawlDetail = {
  crawlId: ID,
  seeds: ["http://capture-fixtures.capture-ledger:8080/links/rules"],
  rules: [
    { skip: "skipped.invalid" },
    { skip: "http://capture-fixtures.capture-ledger:8080/links/trap/" },
    { follow: "same-host" },
    { capture: "any" },
    { skip: "tracker.example.net" },
  ],
  state: "succeeded",
  stopReason: "max_depth",
  maxDepth: 2,
  maxPages: 20,
};

const GOT: Decisions = {
  rules: DETAIL.rules,
  decisions: [
    {
      depth: 1,
      rule: 1,
      action: "skip",
      hostname: "skipped.invalid",
      links: 1,
      samples: ["http://skipped.invalid/page"],
    },
    {
      depth: 1,
      rule: 3,
      action: "follow",
      hostname: "capture-fixtures.capture-ledger",
      links: 1,
      samples: ["http://capture-fixtures.capture-ledger:8080/links/leaf/1"],
    },
    {
      depth: 1,
      rule: 4,
      action: "capture",
      hostname: "outside.invalid",
      links: 1,
      samples: ["http://outside.invalid/page"],
    },
    {
      depth: 2,
      rule: 1,
      action: "skip",
      hostname: "skipped.invalid",
      links: 2,
      samples: ["http://skipped.invalid/a", "http://skipped.invalid/b"],
    },
    {
      depth: 2,
      rule: 0,
      action: "skip",
      hostname: "nowhere.invalid",
      links: 1,
      samples: ["http://nowhere.invalid/"],
    },
  ],
  robots: [
    {
      hostname: "capture-fixtures.capture-ledger",
      pages: 1,
      samples: ["http://capture-fixtures.capture-ledger:8080/links/hidden"],
    },
  ],
};

/** `render_all` の n 番目の表。見出しの行を除いた行。 */
const table = (rendered: { render_all: Record<string, unknown>[] }, n: number) =>
  (
    rendered.render_all.filter((item) => "table-row-object" in item)[n]?.[
      "table-row-object"
    ] as unknown[]
  ).slice(1);

describe("クロール 1 本の判断を描く", () => {
  it("見出しに id の前 8 字・起点・段・枚数・状態を出す", () => {
    const rendered = renderCrawl(DETAIL, GOT);
    expect(rendered.render_all[0]).toEqual({
      markdown:
        "**クロール 5b0c0007**（起点 http://capture-fixtures.capture-ledger:8080/links/rules・2 段・20 枚まで）—— succeeded・max_depth",
    });
  });

  it("規則ごとに段を跨いで足し、0 回の規則に印を付け、どれにも当たらない物を最後の行に出す", () => {
    expect(table(renderCrawl(DETAIL, GOT), 0)).toEqual([
      { 規則: "1. 落とす", 当てる物: "skipped.invalid", "URL の数": 3, 印: "" },
      {
        規則: "2. 落とす",
        当てる物: "http://capture-fixtures.capture-ledger:8080/links/trap/",
        "URL の数": 0,
        印: "当たっていない",
      },
      { 規則: "3. 撮って辿る", 当てる物: "same-host", "URL の数": 1, 印: "" },
      { 規則: "4. 撮るだけ", 当てる物: "any", "URL の数": 1, 印: "" },
      { 規則: "5. 落とす", 当てる物: "tracker.example.net", "URL の数": 0, 印: "当たっていない" },
      { 規則: "どれにも当たらない（落とす）", 当てる物: "", "URL の数": 1, 印: "" },
    ]);
  });

  it("落とした物は、規則で落とした物と robots.txt で取らなかったページ。辿った物と撮るだけの物は出さない", () => {
    expect(table(renderCrawl(DETAIL, GOT), 1)).toEqual([
      {
        なぜ: "規則 1",
        ホスト名: "skipped.invalid",
        段: 1,
        "URL の数": 1,
        例: "http://skipped.invalid/page",
      },
      {
        なぜ: "規則 1",
        ホスト名: "skipped.invalid",
        段: 2,
        "URL の数": 2,
        例: "http://skipped.invalid/a",
      },
      {
        なぜ: "どれにも当たらない",
        ホスト名: "nowhere.invalid",
        段: 2,
        "URL の数": 1,
        例: "http://nowhere.invalid/",
      },
      {
        なぜ: "robots.txt",
        ホスト名: "capture-fixtures.capture-ledger",
        段: "",
        "URL の数": 1,
        例: "http://capture-fixtures.capture-ledger:8080/links/hidden",
      },
    ]);
  });

  it("落とした物が無ければ、表の代わりにそう言う", () => {
    const rendered = renderCrawl(DETAIL, { ...GOT, decisions: [], robots: [] });
    expect(rendered.render_all.at(-1)).toEqual({ markdown: "落とした物はありません。" });
  });
});

describe("台帳を引く", () => {
  it("クロールの答えと判断を、変数の宛先とトークンで引いて描く", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization") });
        const body = String(url).endsWith("/decisions") ? GOT : DETAIL;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        } as Response);
      }),
    );
    const rendered = await main(ID);
    expect(seen).toEqual([
      { url: `http://capture-ledger:7070/api/crawls/${ID}`, auth: "Bearer tok" },
      { url: `http://capture-ledger:7070/api/crawls/${ID}/decisions`, auth: "Bearer tok" },
    ]);
    expect(rendered.render_all).toHaveLength(5);
  });

  it("台帳が断れば、状態と本文を言って落ちる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          text: () => Promise.resolve('{"error":"not found"}'),
        } as Response),
      ),
    );
    await expect(main(ID)).rejects.toThrow(`GET /api/crawls/${ID} → 404 {"error":"not found"}`);
  });
});
