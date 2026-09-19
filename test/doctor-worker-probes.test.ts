/**
 * worker の中の curl の終わり方の読み分け。
 *
 * 入力は 2026-09-19 に worker (windmill-worker.capture-scheduler) の中で実測した答え:
 * BrowserHive の口は `415 0`、名前が引けないと `000 6` (container stop した BrowserHive も)、
 * 閉じた口は `000 7`、答えない宛先は `000 28`。
 */
import { describe, expect, it } from "vitest";

import {
  parseCurl,
  readBrowserhiveProbes,
  readContainerApi,
} from "../scripts/doctor/worker-probes.js";

const EP = "browserhive-2.capture-ledger:50051";
const URL = "http://192.168.66.1:7070";
const need = (verdict: { ok: boolean; need?: string }): string => verdict.need ?? "";

describe("parseCurl", () => {
  it("http_code と exitcode を読む", () => {
    expect(parseCurl("415 0")).toEqual({ http: "415", rc: 0 });
    expect(parseCurl("000 28\n")).toEqual({ http: "000", rc: 28 });
  });

  it("curl の答えでなければ undefined (worker に入れなかった)", () => {
    expect(parseCurl("Error: get failed: container x not found")).toBeUndefined();
    expect(parseCurl("")).toBeUndefined();
  });
});

describe("readBrowserhiveProbes", () => {
  const EP1 = "browserhive-1.capture-ledger:50051";
  const probe = (endpoint: string, http: string, rc: number) => ({
    endpoint,
    answer: { http, rc },
  });

  it("どの口も答えれば ✓ (gRPC の口に GET なので 415 が普通)", () => {
    expect(readBrowserhiveProbes([probe(EP1, "415", 0), probe(EP, "415", 0)])).toEqual({
      ok: true,
    });
  });

  it("止めたコンテナは名前が引けない (rc 6) —— 止まっていることを先に言う", () => {
    expect(need(readBrowserhiveProbes([probe(EP1, "415", 0), probe(EP, "000", 6)]))).toBe(
      `名前が引けない: ${EP} —— コンテナが止まっている (cd ../capture-ledger && pnpm run stack:up) か、` +
        "変数 u/admin/browserhive_endpoints の綴り (CAPTURE_LEDGER_BROWSERHIVE_ENDPOINTS)",
    );
  });

  it("2 台とも同じ終わり方なら、直し方は 1 度だけ言う", () => {
    const text = need(readBrowserhiveProbes([probe(EP1, "000", 6), probe(EP, "000", 6)]));
    expect(text).toMatch(new RegExp(`^名前が引けない: ${EP1}・${EP} —— `));
    expect(text.match(/stack:up/g)).toHaveLength(1);
  });

  it("終わり方が違えば分けて言う (rc 7 は動いているコンテナ、rc 28 は答えない)", () => {
    expect(need(readBrowserhiveProbes([probe(EP1, "000", 7), probe(EP, "000", 28)]))).toBe(
      `待っていない: ${EP1} —— BrowserHive が起動中か落ちた (コンテナは動いている)。` +
        `3 秒で答えない: ${EP}`,
    );
  });

  it("知らない終わり方は、rc をそのまま出す", () => {
    expect(need(readBrowserhiveProbes([probe(EP, "000", 56)]))).toBe(`${EP} → curl rc=56`);
  });
});

describe("readContainerApi", () => {
  it("/healthz が 200 なら ✓ (宛先がいまの gateway と違っても、届くなら直さない)", () => {
    expect(
      readContainerApi({
        url: URL,
        answer: { http: "200", rc: 0 },
        expected: "http://10.0.0.1:7070",
      }),
    ).toEqual({ ok: true });
  });

  it("届かず、宛先がいまの gateway と違えば、宛先が古いと言う", () => {
    const verdict = readContainerApi({
      url: "http://192.168.64.1:7070",
      answer: { http: "000", rc: 28 },
      expected: URL,
    });
    expect(need(verdict)).toMatch(/いまの gateway の http:\/\/192\.168\.66\.1:7070 と違う/);
    expect(need(verdict)).toMatch(/windmill:capture-ledger-token$/);
  });

  it("宛先が合っていて refused なら、API が 127.0.0.1 で待っていると言う", () => {
    const verdict = readContainerApi({ url: URL, answer: { http: "000", rc: 7 }, expected: URL });
    expect(need(verdict)).toMatch(/API が 127\.0\.0\.1 で待っている/);
    expect(need(verdict)).toMatch(/CAPTURE_LEDGER_API_HOST=0\.0\.0\.0/);
  });

  it("gateway が分からなければ、curl の答えだけで読む", () => {
    expect(
      need(readContainerApi({ url: URL, answer: { http: "000", rc: 28 }, expected: undefined })),
    ).toBe(`worker から ${URL} が 5 秒で答えない`);
  });

  it("答えたが 200 でなければ、status をそのまま出す", () => {
    expect(
      need(readContainerApi({ url: URL, answer: { http: "503", rc: 0 }, expected: URL })),
    ).toBe(`worker から ${URL}/healthz → curl rc=0 http=503`);
  });
});
