/**
 * capture-ledger に合本の口が在るかの読み分け (CAPTURE-57)。
 *
 * 名乗らずに、形の合う本文で叩くので、口が在れば 401。404 を ✓ にすると、合本の口の無い古い台帳の上で、どの
 * クロールも合本の段で落ちるのを doctor が見逃す (合本の段は 404 で投げる)。
 */
import { describe, expect, it } from "vitest";

import {
  readReplayBundleRoute,
  REPLAY_BUNDLE_PROBE,
  REPLAY_BUNDLE_PROBE_BODY,
} from "../scripts/doctor/replay-bundle-route.js";

const need = (verdict: { ok: boolean; need?: string }): string => verdict.need ?? "";

describe("readReplayBundleRoute", () => {
  it("名乗らずに叩いて 401 なら ✓（口が在り、名乗りで止まった）", () => {
    expect(readReplayBundleRoute({ status: 401, body: '{"error":"unauthenticated"}' })).toEqual({
      ok: true,
    });
  });

  it("404 なら ✗ で、台帳に合本の口が無い（capture-ledger が古い）と言う", () => {
    const verdict = readReplayBundleRoute({
      status: 404,
      body: `{"message":"Route POST:${REPLAY_BUNDLE_PROBE} not found","error":"Not Found","statusCode":404}`,
    });
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("合本の口が無い");
    expect(need(verdict)).toContain("capture-ledger が古い");
  });

  it("400 なら ✗ で、本文の形が合っていないと言う（口の在る印にしない）", () => {
    const verdict = readReplayBundleRoute({
      status: 400,
      body: '{"message":"body must NOT have additional properties"}',
    });
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("400");
    expect(need(verdict)).toContain("版の組");
  });

  it("名乗っていないのに 200 なら ✗（名乗りを見ない台帳）", () => {
    const verdict = readReplayBundleRoute({ status: 200, body: "{}" });
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("401 のはず");
  });

  it("届かなければ、API を起こすよう言う", () => {
    const verdict = readReplayBundleRoute({ status: undefined, body: "" });
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("pnpm run api");
  });

  it("叩く口は uuid の形の id の replay-bundle で、本文は depth だけ", () => {
    expect(REPLAY_BUNDLE_PROBE).toMatch(
      /^\/api\/crawls\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/replay-bundle$/,
    );
    expect(JSON.parse(REPLAY_BUNDLE_PROBE_BODY)).toEqual({ depth: 0 });
  });
});
