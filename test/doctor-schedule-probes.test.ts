import { describe, expect, it } from "vitest";

import { readScheduledRun, readTokenExpiry } from "../scripts/doctor/schedule-probes.js";
import { readSchedules } from "../scripts/doctor/windmill-contents.js";

const need = (verdict: { ok: boolean; need?: string }): string => verdict.need ?? "";

describe("readSchedules", () => {
  it("1 本も無ければ ✓", () => {
    expect(readSchedules([])).toEqual({ ok: true });
  });

  it("残っていれば名指し、push を勧める", () => {
    const verdict = readSchedules(["f/waggle/daily"]);
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("f/waggle/daily");
    expect(need(verdict)).toContain("pnpm run windmill:push");
  });
});

describe("readTokenExpiry", () => {
  const NOW = Date.parse("2026-11-07T00:00:00.000Z");
  const tokenWith = (claims: Record<string, unknown>): string =>
    `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
  const expIn = (hours: number) => tokenWith({ exp: NOW / 1000 + hours * 3600 });

  it("24 時間より先なら ✓", () => {
    expect(readTokenExpiry(expIn(25), NOW)).toEqual({ ok: true });
  });

  it("24 時間を切れば ✗ で、残りと直し方を言う", () => {
    const verdict = readTokenExpiry(expIn(5), NOW);
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("5 時間");
    expect(need(verdict)).toContain("pnpm run windmill:capture-ledger-token");
  });

  it("切れていれば切れていると言う", () => {
    expect(need(readTokenExpiry(expIn(-1), NOW))).toContain("切れている");
  });

  it("exp の無いトークンは切れないので ✓", () => {
    expect(readTokenExpiry(tokenWith({ sub: "windmill" }), NOW)).toEqual({ ok: true });
  });

  it("JWT の形でなければ ✗", () => {
    expect(readTokenExpiry("not-a-jwt", NOW).ok).toBe(false);
    expect(readTokenExpiry("a.%%%.c", NOW).ok).toBe(false);
  });
});

describe("readScheduledRun", () => {
  const answer = (crawls: unknown[]) => ({ status: 200, body: JSON.stringify({ crawls }) });

  it("走っている行が無ければ ✓", () => {
    expect(readScheduledRun(answer([]))).toEqual({ ok: true });
  });

  it("手で始めた行は見ない（409 の文に任せる）", () => {
    expect(readScheduledRun(answer([{ crawlId: "abcdef012345", schedule: null }]))).toEqual({
      ok: true,
    });
  });

  it("定期の回が走っていれば、予定の名前と行を名指す", () => {
    const verdict = readScheduledRun(
      answer([{ crawlId: "abcdef012345", schedule: { id: "s", name: "毎朝" } }]),
    );
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("毎朝");
    expect(need(verdict)).toContain("abcdef01");
  });

  it("訊けなければ ✗", () => {
    expect(readScheduledRun({ status: 500, body: "" }).ok).toBe(false);
    expect(readScheduledRun({ status: undefined, body: "" }).ok).toBe(false);
  });
});
