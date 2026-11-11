import { describe, expect, it } from "vitest";

import { readScheduledRun } from "../scripts/doctor/schedule-probes.js";
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
