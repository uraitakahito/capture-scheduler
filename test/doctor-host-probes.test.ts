/**
 * host から、compose が loopback に出した ts-compile の口を叩いた答えの読み分け。
 *
 * 200 が返っても、答えたのが ts-compile とは限らない (同じ番号を別のスタックが持ちうる)。
 * だから `/healthz` の形まで見る —— 形を見なければ、下の「ts-compile の形でない」は ✓ になる。
 */
import { describe, expect, it } from "vitest";

import { HOST_TS_COMPILE, readHostTsCompile } from "../scripts/doctor/host-probes.js";

const need = (verdict: { ok: boolean; need?: string }): string => verdict.need ?? "";
const health = JSON.stringify({ ok: true, typescript: "6.0.2", hostTypes: "v0.6.1" });

describe("readHostTsCompile", () => {
  it("/healthz が 200 で、ts-compile の形なら ✓", () => {
    expect(readHostTsCompile({ status: 200, body: health })).toEqual({ ok: true });
  });

  it("届かなければ、口を出していないか落ちたと言って container-compose up -d ts-compile を指す", () => {
    const verdict = readHostTsCompile({ status: undefined, body: "" });
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain(HOST_TS_COMPILE);
    expect(need(verdict)).toContain("container-compose up -d ts-compile");
  });

  it("200 でも ts-compile の形でなければ ✗ (同じ番号で別の物が答えている)", () => {
    const fixtures = readHostTsCompile({ status: 200, body: "<html>capture-fixtures</html>" });
    expect(fixtures.ok).toBe(false);
    expect(need(fixtures)).toContain("ts-compile でない");
    const otherJson = readHostTsCompile({ status: 200, body: JSON.stringify({ ok: true }) });
    expect(otherJson.ok).toBe(false);
  });

  it("200 以外の答えは status ごと出す (5xx で起きている物を ✓ にしない)", () => {
    expect(need(readHostTsCompile({ status: 503, body: health }))).toContain("http 503");
  });
});
