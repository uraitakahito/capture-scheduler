import { describe, it, expect, vi, afterEach } from "vitest";
import { main, renderDomain, type DomainAnswer } from "../windmill/f/waggle/inspect_domain.js";

/**
 * あるドメインを落としたクロールを引く調べ物の script。
 *
 * 照らし方 (ラベルの境目・日数・動き) は台帳の物で、ここは引いて描くだけ。押さえるのは、頼みが
 * 崩れずに台帳へ届くことと、読み違えない描き方 (クロールの数え方・どれにも当たらない物・切った印)。
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

const row = (crawlId: string, rule: number, hostname: string, pattern: string | null) => ({
  crawlId,
  startedAt: "2026-10-25T09:30:12.345Z",
  seeds: ["http://capture-fixtures.capture-ledger:8080/links/rules"],
  rule,
  action: "skip" as const,
  pattern,
  hostname,
  links: 2,
});

const A = "5b0c0007-1111-4222-8333-444455556666";
const B = "7a1e0001-1111-4222-8333-444455556666";

describe("ドメインの判断を描く", () => {
  it("見出しはクロールの本数を数え（行の数ではない）、表はクロールの前 8 字と当たった規則を出す", () => {
    const got: DomainAnswer = {
      decisions: [
        row(A, 1, "skipped.invalid", "skipped.invalid"),
        row(A, 1, "a.skipped.invalid", "skipped.invalid"),
        row(B, 0, "skipped.invalid", null),
      ],
      truncated: false,
    };
    const rendered = renderDomain("skipped.invalid", 7, "skip", got);
    expect(rendered.render_all[0]).toEqual({
      markdown: "**skipped.invalid** とその下を落としたクロール: 2 本（7 日のうち）",
    });
    expect(rendered.render_all[1]).toEqual({
      "table-row-object": [
        ["始めた", "クロール", "起点", "規則", "ホスト名", "URL の数"],
        {
          始めた: "2026-10-25 09:30",
          クロール: "5b0c0007",
          起点: "http://capture-fixtures.capture-ledger:8080/links/rules",
          規則: "1. skipped.invalid",
          ホスト名: "skipped.invalid",
          "URL の数": 2,
        },
        {
          始めた: "2026-10-25 09:30",
          クロール: "5b0c0007",
          起点: "http://capture-fixtures.capture-ledger:8080/links/rules",
          規則: "1. skipped.invalid",
          ホスト名: "a.skipped.invalid",
          "URL の数": 2,
        },
        {
          始めた: "2026-10-25 09:30",
          クロール: "7a1e0001",
          起点: "http://capture-fixtures.capture-ledger:8080/links/rules",
          規則: "どれにも当たらない",
          ホスト名: "skipped.invalid",
          "URL の数": 2,
        },
      ],
    });
  });

  it("動きで見出しの言い方を変え、台帳が切ったら見出しでそう言う", () => {
    const rendered = renderDomain("outside.invalid", 90, "capture", {
      decisions: [row(A, 4, "outside.invalid", "any")],
      truncated: true,
    });
    expect(rendered.render_all[0]?.["markdown"]).toBe(
      "**outside.invalid** とその下を撮るだけにしたクロール: 1 本（90 日のうち） —— 台帳が行の上限で切りました。days を短くして走らせ直してください",
    );
  });

  it("1 本も無ければ、表の代わりにそう言う", () => {
    const rendered = renderDomain("skipped.invalid", 90, "skip", {
      decisions: [],
      truncated: false,
    });
    expect(rendered.render_all[1]).toEqual({ markdown: "ありません。" });
  });
});

describe("台帳を引く", () => {
  it("ドメイン・日数・動きを崩さずに、変数の宛先とトークンで引く", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        seen.push({ url: String(url), auth: new Headers(init.headers).get("authorization") });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ decisions: [], truncated: false }),
        } as Response);
      }),
    );
    await main("skipped.invalid", 1);
    expect(seen).toEqual([
      {
        url: "http://capture-ledger:7070/api/decisions?domain=skipped.invalid&days=1&action=skip",
        auth: "Bearer tok",
      },
    ]);
  });

  it("台帳が断れば（読めないドメイン）、状態と本文を言って落ちる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          text: () => Promise.resolve('{"error":"invalid domain"}'),
        } as Response),
      ),
    );
    await expect(main("ADS.site.test")).rejects.toThrow('400 {"error":"invalid domain"}');
  });
});
