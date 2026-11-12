import { beforeAll, describe, expect, it } from "vitest";

import { FIXTURES, ledger, mintToken, requestCounts, resetFixtures } from "./helpers/stack.js";

/**
 * **枠の中のリンクを、本物の一式で辿る**（CAPTURE-245）。
 *
 * capture-fixtures の `/links/frameset` は、一番上の文書に `<a` を 1 つも持たず、hub の 4 本を枠の中の
 * `/links/frame/menu` に置く。BrowserHive v29.1.0 は同じ origin の枠の文書からもリンクを読み、capture-ledger が
 * 規則で決め、flow が次の段を撮る。一番上の文書しか読まない一式は 1 ページで締め、leaf は 1 本も要求されない。
 *
 * 判定は capture-fixtures のリクエストログで採る —— capture-ledger は「記録したこと」しか言えない。
 *
 * もう 1 本は、辿るよう頼んだのにリンクが 1 本も無いクロール。capture-ledger は `no_links` で締める
 * （`completed` と言うと、1 ページで黙って終わったことが緑に見える）。
 *
 * capture-ledger v0.96.0（BrowserHive v29.1.0・capture-fixtures v0.35.0 の pin）より前の一式では赤。
 */
let api: ReturnType<typeof ledger>;

beforeAll(async () => {
  api = ledger(await mintToken());
});

describe("枠の中のリンクを辿る", () => {
  it("frameset の起点から、menu の枠のリンクを辿る（robots の禁じた頁は要求しない）", async () => {
    await resetFixtures();
    const crawlId = await api.start({
      seeds: [`${FIXTURES}/links/frameset`],
      maxDepth: 1,
      maxPages: 10,
    });
    const got = await api.finished(crawlId);
    expect(got["state"], `stopReason=${String(got["stopReason"])}`).toBe("succeeded");

    const paths = Object.keys(await requestCounts());
    // 枠の文書は、頁を描くときに Chrome が取る。
    expect(paths).toContain("/links/frame/menu");
    // 次の段: menu の枠の中のリンク。一番上の文書だけを読む一式では 1 本も来ない。
    for (const leaf of ["/links/leaf/1", "/links/leaf/2", "/links/leaf/3"]) {
      expect(paths, `${leaf} が要求されていない`).toContain(leaf);
    }
    expect(paths, "robots が禁じた頁に触れた").not.toContain("/links/hidden");
    // leaf にはリンクが無いので、深さ 1 で残りは無い。
    expect(got["stopReason"]).toBe("completed");
    expect(Number(got["pagesCaptured"])).toBe(4);
  });

  it("辿るよう頼んだのにリンクが 1 本も無ければ no_links で締める", async () => {
    const crawlId = await api.start({
      seeds: [`${FIXTURES}/links/leaf/1`],
      maxDepth: 1,
      maxPages: 5,
    });
    const got = await api.finished(crawlId);
    expect(got["state"]).toBe("succeeded");
    expect(got["stopReason"]).toBe("no_links");
    expect(Number(got["pagesDiscovered"])).toBe(0);
  });
});
