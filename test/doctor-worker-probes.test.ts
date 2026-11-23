/**
 * worker の中の curl の終わり方の読み分け。
 *
 * 入力は 2026-09-19 に worker (windmill-worker.capture-scheduler) の中で実測した答え:
 * 名前が引けないと `000 6` (container stop した BrowserHive も)、閉じたポートは `000 7`、
 * 答えない宛先は `000 28` (止めた直後の数秒の BrowserHive も —— 約 5 秒で 6 に変わった)。
 * BrowserHive のエンドポイントは v12 から HTTP で、`GET /status` が `200 0` (v11 までの gRPC のエンドポイントは `415 0` だった)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { repoRoot, WORKER_CONTAINER, WORKER_INSPECT_ARGS } from "../scripts/env.js";

import {
  expectedApiUrl,
  parseCurl,
  readBrowserhiveProbes,
  readContainerApi,
} from "../scripts/doctor/worker-probes.js";

const EP = "http://browserhive-2.capture-ledger:50051";
const URL = "http://192.168.66.1:7070";
const FROM_WORKER = { url: URL, from: "worker" } as const;
const need = (verdict: { ok: boolean; need?: string }): string => verdict.need ?? "";

describe("parseCurl", () => {
  it("http_code と exitcode を読む", () => {
    expect(parseCurl("200 0")).toEqual({ http: "200", rc: 0 });
    expect(parseCurl("000 28\n")).toEqual({ http: "000", rc: 28 });
  });

  it("curl の答えでなければ undefined (worker に入れなかった)", () => {
    expect(parseCurl("Error: get failed: container x not found")).toBeUndefined();
    expect(parseCurl("")).toBeUndefined();
  });
});

describe("readBrowserhiveProbes", () => {
  const EP1 = "http://browserhive-1.capture-ledger:50051";
  const probe = (endpoint: string, http: string, rc: number) => ({
    endpoint,
    answer: { http, rc },
  });

  it("どのエンドポイントも GET /status に 200 で答えれば ✓", () => {
    expect(readBrowserhiveProbes([probe(EP1, "200", 0), probe(EP, "200", 0)])).toEqual({
      ok: true,
    });
  });

  it("答えたが 200 でないエンドポイントは、status を添えて言う (v11 の gRPC のエンドポイントなら 415)", () => {
    expect(need(readBrowserhiveProbes([probe(EP1, "200", 0), probe(EP, "415", 0)]))).toBe(
      `${EP}/status → http=415`,
    );
  });

  it("止めたコンテナは名前が引けない (rc 6) —— 止まっていることを先に言う", () => {
    expect(need(readBrowserhiveProbes([probe(EP1, "200", 0), probe(EP, "000", 6)]))).toBe(
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
        `3 秒で答えない: ${EP} —— 止めた直後 (名前が消えるまでの数秒) か、BrowserHive が詰まっている`,
    );
  });

  it("落ちたエンドポイントと 200 でないエンドポイントが混ざれば、両方言う", () => {
    const text = need(readBrowserhiveProbes([probe(EP1, "000", 7), probe(EP, "503", 0)]));
    expect(text).toMatch(/^待っていない: /);
    expect(text).toMatch(new RegExp(`${EP}/status → http=503$`));
  });

  it("知らない終わり方は、rc をそのまま出す", () => {
    expect(need(readBrowserhiveProbes([probe(EP, "000", 56)]))).toBe(`${EP} → curl rc=56`);
  });
});

describe("readContainerApi", () => {
  it("/healthz が 200 なら ✓ (宛先が worker の今の gateway と違っても、届くなら直さない)", () => {
    expect(
      readContainerApi({
        url: URL,
        answer: { http: "200", rc: 0 },
        expected: { url: "http://10.0.0.1:7070", from: "worker" },
      }),
    ).toEqual({ ok: true });
  });

  it("届かず、宛先が worker の今の gateway と違えば、宛先が古いと言う", () => {
    const verdict = readContainerApi({
      url: "http://192.168.64.1:7070",
      answer: { http: "000", rc: 28 },
      expected: FROM_WORKER,
    });
    expect(need(verdict)).toMatch(/worker の今の gateway の http:\/\/192\.168\.66\.1:7070 と違う/);
    expect(need(verdict)).toMatch(/windmill:capture-ledger-token/);
    expect(need(verdict)).toMatch(/dev:up --from token/);
  });

  it("宛先が合っていて refused なら、API が 127.0.0.1 で待っていると言う", () => {
    const verdict = readContainerApi({
      url: URL,
      answer: { http: "000", rc: 7 },
      expected: FROM_WORKER,
    });
    expect(need(verdict)).toMatch(/API が 127\.0\.0\.1 で待っている/);
    expect(need(verdict)).toMatch(/CAPTURE_LEDGER_API_HOST=0\.0\.0\.0/);
    expect(need(verdict)).toMatch(/capture-ledger で pnpm run connect を打ち/);
  });

  it("gateway が分からなければ、curl の答えだけで読む", () => {
    expect(
      need(readContainerApi({ url: URL, answer: { http: "000", rc: 28 }, expected: undefined })),
    ).toBe(`worker から ${URL} が 5 秒で答えない`);
  });

  it("宛先が合っていて時間切れなら、宛先は合っていると言い、Mac の側を指す", () => {
    const verdict = readContainerApi({
      url: URL,
      answer: { http: "000", rc: 28 },
      expected: FROM_WORKER,
    });
    expect(need(verdict)).toMatch(/worker の今の gateway と合っているが、5 秒で答えない/);
    expect(need(verdict)).toMatch(/macOS のファイアウォール/);
    expect(need(verdict)).not.toMatch(/断っている/);
  });

  it("CAPTURE_LEDGER_API_URL で上書きしているときは、gateway でなくその値と比べたと言う", () => {
    const override = { url: "http://10.0.0.9:7070", from: "override" } as const;
    expect(
      need(readContainerApi({ url: URL, answer: { http: "000", rc: 28 }, expected: override })),
    ).toMatch(/CAPTURE_LEDGER_API_URL の http:\/\/10\.0\.0\.9:7070 と違う/);
    expect(
      need(
        readContainerApi({
          url: override.url,
          answer: { http: "000", rc: 28 },
          expected: override,
        }),
      ),
    ).toMatch(/CAPTURE_LEDGER_API_URL の値と合っているが/);
  });

  it("宛先が違えば、curl の答えより先に「古い」と言う（refused でも）", () => {
    const verdict = readContainerApi({
      url: "http://192.168.65.1:7070",
      answer: { http: "000", rc: 7 },
      expected: FROM_WORKER,
    });
    expect(need(verdict)).toMatch(/と違う/);
    expect(need(verdict)).not.toMatch(/127\.0\.0\.1 で待っている/);
  });

  it("答えたが 200 でなければ、status をそのまま出す", () => {
    expect(
      need(readContainerApi({ url: URL, answer: { http: "503", rc: 0 }, expected: FROM_WORKER })),
    ).toBe(`worker から ${URL}/healthz → curl rc=0 http=503`);
  });
});

describe("2026-11-23 の実物（ネットワークの記録は 65.1・worker の実際の gateway は 64.1）", () => {
  const KEY_API_URL = "CAPTURE_LEDGER_API_URL";
  const saved = process.env[KEY_API_URL];
  beforeEach(() => {
    delete process.env[KEY_API_URL];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY_API_URL];
    else process.env[KEY_API_URL] = saved;
  });
  const WORKER_INSPECT = readFileSync(
    join(repoRoot(), "test/fixtures/container-inspect-worker.json"),
    "utf8",
  );

  it("変数がネットワークの記録の 65.1 のまま時間切れなら、worker の今の gateway と違うので宛先が古いと言う", async () => {
    const expected = await expectedApiUrl(() => Promise.resolve(WORKER_INSPECT));
    const verdict = readContainerApi({
      url: "http://192.168.65.1:7070",
      answer: { http: "000", rc: 28 },
      expected,
    });
    expect(need(verdict)).toMatch(/worker の今の gateway の http:\/\/192\.168\.64\.1:7070 と違う/);
    expect(need(verdict)).toMatch(/pnpm run windmill:capture-ledger-token/);
  });
});

describe("expectedApiUrl（doctor の比べる相手）", () => {
  const KEY_API_URL = "CAPTURE_LEDGER_API_URL";
  const saved = process.env[KEY_API_URL];
  beforeEach(() => {
    delete process.env[KEY_API_URL];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY_API_URL];
    else process.env[KEY_API_URL] = saved;
  });
  const WORKER_INSPECT = readFileSync(
    join(repoRoot(), "test/fixtures/container-inspect-worker.json"),
    "utf8",
  );

  it("worker の inspect から組み、出どころは worker", async () => {
    await expect(expectedApiUrl(() => Promise.resolve(WORKER_INSPECT))).resolves.toEqual({
      url: "http://192.168.64.1:7070",
      from: "worker",
    });
  });

  it("CAPTURE_LEDGER_API_URL を書いていれば worker を訊かず、出どころは上書き", async () => {
    process.env[KEY_API_URL] = "http://10.0.0.9:7070";
    const inspect = vi.fn(() => Promise.resolve(WORKER_INSPECT));
    await expect(expectedApiUrl(inspect)).resolves.toEqual({
      url: "http://10.0.0.9:7070",
      from: "override",
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("worker を訊けない・止まっていれば undefined（比べずに curl の答えで読む）", async () => {
    await expect(
      expectedApiUrl(() => Promise.reject(new Error("container not found"))),
    ).resolves.toBeUndefined();
    await expect(
      expectedApiUrl(() => Promise.resolve('[{"status":{"networks":[],"state":"stopped"}}]')),
    ).resolves.toBeUndefined();
  });

  it("worker への問い合わせは container inspect <worker>", () => {
    expect([...WORKER_INSPECT_ARGS]).toEqual(["inspect", WORKER_CONTAINER]);
  });
});
