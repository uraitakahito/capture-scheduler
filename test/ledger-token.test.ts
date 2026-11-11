import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { LEDGER_CLIENT, LEDGER_CLIENT_VAR, TOKEN } from "./helpers/ledger-token.js";

/**
 * flow の段が台帳に名乗るトークンの取り方 (`ledgerToken`)。
 *
 * Windmill の relative import で 1 本にまとめず、6 本の段に同じ関数を写してある (この版の
 * Windmill で効くかを確かめていないため)。写しが 1 本だけ古くなると、その段だけが別の取り方で
 * 名乗る —— だから写しが同じであることを、ここで見る。
 */
const SCRIPTS = [
  "fail_crawl",
  "index_level",
  "inspect_crawl",
  "inspect_domain",
  "replay_bundle_level",
  "report_level",
];
const BEGIN = "// ── 台帳に名乗るトークン";
const END = "// ── ここまで ──";

const block = (name: string) => {
  const text = readFileSync(`windmill/f/waggle/${name}.ts`, "utf8");
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  return start === -1 || end === -1 ? undefined : text.slice(start, end);
};

describe("6 本の写し", () => {
  it("どの段も同じ ledgerToken を持つ", () => {
    const blocks = SCRIPTS.map(block);
    expect(blocks.every((b) => b !== undefined && b.includes("const ledgerToken"))).toBe(true);
    expect(new Set(blocks).size).toBe(1);
  });

  it("前の変数 (30 日のトークン) を読む段は残っていない", () => {
    for (const name of SCRIPTS) {
      expect(readFileSync(`windmill/f/waggle/${name}.ts`, "utf8")).not.toContain("waggle_token");
    }
  });
});

const VARS: Record<string, string> = {
  "u/admin/waggle_api_url": "http://capture-ledger:7070",
  "u/admin/ledger_client": LEDGER_CLIENT_VAR,
};
vi.mock("windmill-client", () => ({
  getVariable: (path: string) => Promise.resolve(VARS[path]),
}));
const { main } = await import("../windmill/f/waggle/index_level.js");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("取り方 (index_level で見る)", () => {
  it("client credentials で取り、取ったトークンで台帳に名乗る", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init: RequestInit) => {
        seen.push({ url: String(url), init });
        const body =
          String(url) === LEDGER_CLIENT.tokenUrl
            ? { access_token: TOKEN }
            : { pending: 0, indexed: 0, failed: 0, pages: 0 };
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(""),
        } as Response);
      }),
    );
    await main("c-1");

    expect(seen.map((s) => s.url)).toEqual([
      LEDGER_CLIENT.tokenUrl,
      "http://capture-ledger:7070/api/crawls/c-1/index",
    ]);
    const token = new Headers(seen[0]!.init.headers);
    expect(token.get("authorization")).toBe(
      `Basic ${btoa(`${LEDGER_CLIENT.clientId}:${LEDGER_CLIENT.clientSecret}`)}`,
    );
    expect(String(seen[0]!.init.body)).toBe(
      "grant_type=client_credentials&scope=capture-ledger%2Fcrawl",
    );
    expect(new Headers(seen[1]!.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  // 違う secret・プールを作り直した後。台帳を叩く前に、取れなかったと言って止まる。
  it("token endpoint が断れば、台帳を叩かずに理由と直し方を言う", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        seen.push(String(url));
        return Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('{"error":"invalid_client"}'),
        } as Response);
      }),
    );
    await expect(main("c-1")).rejects.toThrow(
      /トークンを取れない: .* 400 .*invalid_client.*dev:up --from idp/,
    );
    expect(seen).toEqual([LEDGER_CLIENT.tokenUrl]);
  });

  it("答えに access_token が無ければ落ちる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ token_type: "Bearer" }),
          text: () => Promise.resolve(""),
        } as Response),
      ),
    );
    await expect(main("c-1")).rejects.toThrow(/access_token が無い/);
  });
});
