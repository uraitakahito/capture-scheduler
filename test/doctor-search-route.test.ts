/**
 * capture-ledger に全文検索の口が在るかの読み分け。
 *
 * 名乗らずに引くので、口が在れば 401、無ければ 404。404 を ✓ にすると、検索の無い台帳の上で
 * flow の索引の段が毎回落ちるのを、doctor が見逃す (CAPTURE-53 から、索引の段は 404 を飛ばさない)。
 */
import { describe, expect, it } from "vitest";

import { readSearchRoute, SEARCH_PROBE } from "../scripts/doctor/search-route.js";

const need = (verdict: { ok: boolean; need?: string }): string => verdict.need ?? "";

describe("readSearchRoute", () => {
  it("名乗らずに 401 なら、口が在る（✓）", () => {
    expect(readSearchRoute({ status: 401, body: '{"error":"unauthenticated"}' })).toEqual({
      ok: true,
    });
  });

  it("404 なら、台帳に検索の口が無いと言い、OPENSEARCH_URL を名指す", () => {
    const verdict = readSearchRoute({
      status: 404,
      body: '{"message":"Route GET:/api/search?q=x not found"}',
    });
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("検索の口が無い");
    expect(need(verdict)).toContain("CAPTURE_LEDGER_OPENSEARCH_URL");
  });

  it("届かなければ、API を起こすよう言う", () => {
    const verdict = readSearchRoute({ status: undefined, body: "" });
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("pnpm run api");
  });

  it("名乗らずに 200 なら ✗（認可が外れている。口が在る印にしない）", () => {
    const verdict = readSearchRoute({ status: 200, body: '{"hits":[],"total":0}' });
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("200");
  });

  it("引く口は q つきの GET /api/search", () => {
    expect(SEARCH_PROBE).toBe("/api/search?q=x");
  });
});
