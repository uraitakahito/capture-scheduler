/**
 * worker の中から変換サービスを叩いた curl の答えの読み分け。
 *
 * 終わり方は `doctor-worker-probes.test.ts` と同じ実測 (`000 6` は名前が引けない、`000 7` は
 * refused、`000 28` は答えない)。違うのは直し方 —— ts-compile はこの repo の compose の service。
 */
import { describe, expect, it } from "vitest";

import { readTsCompileProbe } from "../scripts/doctor/worker-probes.js";

const URL = "http://ts-compile.capture-scheduler:8080";
const need = (verdict: { ok: boolean; need?: string }): string => verdict.need ?? "";

describe("readTsCompileProbe", () => {
  it("/healthz が 200 なら ✓", () => {
    expect(readTsCompileProbe({ url: URL, answer: { http: "200", rc: 0 } })).toEqual({ ok: true });
  });

  it("名前が引けなければ、compose に居ないと言って container-compose up を指す", () => {
    const verdict = readTsCompileProbe({ url: URL, answer: { http: "000", rc: 6 } });
    expect(verdict.ok).toBe(false);
    expect(need(verdict)).toContain("compose に居ない");
    expect(need(verdict)).toContain("container-compose up -d");
  });

  it("refused と、答えないのは、言い分けが違う", () => {
    expect(need(readTsCompileProbe({ url: URL, answer: { http: "000", rc: 7 } }))).toContain(
      "refused",
    );
    expect(need(readTsCompileProbe({ url: URL, answer: { http: "000", rc: 28 } }))).toContain(
      "答えない",
    );
  });

  it("200 以外の答えは status ごと出す (5xx で起きている物を ✓ にしない)", () => {
    expect(need(readTsCompileProbe({ url: URL, answer: { http: "500", rc: 0 } }))).toContain(
      "http=500",
    );
  });
});
