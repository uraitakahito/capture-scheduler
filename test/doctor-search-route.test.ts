/**
 * capture-ledger の全文検索が働いているかの読み分け。
 *
 * flow の資格のトークンで引くので、働いていれば 200。名乗らずに引いていた頃は 401 を ✓ にしていたが、
 * それでは OpenSearch が止まっていても ✓ だった (台帳は名乗りを見てから OpenSearch に訊く)。404 を ✓ に
 * すると、検索の無い台帳の上で flow の索引の段が毎回落ちるのを、doctor が見逃す (CAPTURE-53 から、
 * 索引の段は 404 を飛ばさない)。
 */
import { describe, expect, it } from "vitest";

import { readSearchRoute, SEARCH_PROBE } from "../scripts/doctor/search-route.js";

const need = (verdict: { ok: boolean; need?: string }): string => verdict.need ?? "";

describe("readSearchRoute", () => {
  it("200 なら ✓（エンドポイントが在り、OpenSearch まで届いた）", () => {
    expect(readSearchRoute({ status: 200, body: '{"hits":[],"total":0}' })).toEqual({ ok: true });
  });

  it("503 なら ✗ で、OpenSearch を起こす手と索引を作り直す手を言う", () => {
    const verdict = readSearchRoute({
      status: 503,
      body: '{"error":"search unavailable","message":"OpenSearch did not answer — …"}',
    });
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("OpenSearch が答えない");
    expect(need(verdict)).toContain("pnpm run dev:up --from search");
    expect(need(verdict)).toContain("pnpm run search:reindex");
  });

  it("名乗って引いたのに 401 なら ✗（エンドポイントが在る印にしない）", () => {
    // 名乗らずに引いていた頃の ✓ の形。いまは、OpenSearch が止まっていても返る答えでしかない。
    const verdict = readSearchRoute({ status: 401, body: '{"error":"unauthenticated"}' });
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("401");
  });

  it("404 なら、台帳に検索のエンドポイントが無いと言い、OPENSEARCH_URL を名指す", () => {
    const verdict = readSearchRoute({
      status: 404,
      body: '{"message":"Route GET:/api/search?q=x not found"}',
    });
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("検索のエンドポイントが無い");
    expect(need(verdict)).toContain("CAPTURE_LEDGER_OPENSEARCH_URL");
  });

  it("届かなければ、API を起こすよう言う", () => {
    const verdict = readSearchRoute({ status: undefined, body: "" });
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("pnpm run api");
  });

  it("引くエンドポイントは q つきの GET /api/search", () => {
    expect(SEARCH_PROBE).toBe("/api/search?q=x");
  });
});
