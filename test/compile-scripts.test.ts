import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main, readAnswer, type CrawlScript } from "../windmill/f/waggle/compile_scripts.js";

/**
 * 変換の段。**flow の中で唯一、外の service を呼ぶ段。**
 *
 * 偽の変換サービスを node:http で立て、答えごとにこの段がどう振る舞うかを見る。
 * 本物の型検査は ts-compile-service の試験に在り、ここで見るのは「答えの読み方」だけ ——
 * 200 は通す、422 は診断ごと投げる、答えなければ投げる。
 */

/** 偽の変換サービス。次に返す答えを 1 つ持つ。 */
let nextAnswer: { status: number; errorType?: string; body: unknown } = { status: 200, body: {} };
let received: unknown = undefined;
let server: Server;
let base = "";

const VARS: Record<string, string> = {};
vi.mock("windmill-client", () => ({
  getVariable: (path: string) => Promise.resolve(VARS[path]),
}));

const script = (id: string, source: string): CrawlScript => ({
  id,
  version: 1,
  phase: "behavior",
  source,
  sha256: "0".repeat(64),
  options: {},
});

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(nextAnswer.status, {
        "content-type": "application/json",
        ...(nextAnswer.errorType === undefined ? {} : { "x-amzn-errortype": nextAnswer.errorType }),
      });
      res.end(JSON.stringify(nextAnswer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  VARS["u/admin/ts_compile_url"] = base;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("compile_scripts", () => {
  it("200 なら、変換サービスの答えをそのまま次の段に渡す", async () => {
    const compiled = { typescript: "6.0.3", cached: false, scripts: [script("autoscroll", "js")] };
    nextAnswer = { status: 200, body: compiled };
    const out = await main([script("autoscroll", "ts")]);
    expect(out).toEqual(compiled);
    // 送ったのは台帳の目録そのもの
    expect(received).toEqual({ scripts: [script("autoscroll", "ts")] });
  });

  it("422 (型エラー) は診断ごと投げる —— flow は failure_module へ落ちる", async () => {
    nextAnswer = {
      status: 422,
      errorType: "CompileFailed",
      body: {
        typescript: "6.0.3",
        message: "1 件の型エラー",
        diagnostics: [
          { file: "bad.ts", line: 3, col: 9, code: "TS2322", message: "Type 'string'…" },
        ],
      },
    };
    await expect(main([script("bad", "ts")])).rejects.toThrow(
      /compile 422 CompileFailed: .*TS2322/,
    );
  });

  it("409 (hash 違い) と 400 (形の違反) も投げる", () => {
    expect(() =>
      readAnswer(409, "SourceHashMismatch", { message: "x: sha256 が台帳の約束と違う" }),
    ).toThrow(/compile 409 SourceHashMismatch/);
    expect(() =>
      readAnswer(400, "ValidationException", {
        fieldList: [{ path: "/scripts/0/id", message: "…" }],
      }),
    ).toThrow(/compile 400 ValidationException: .*\/scripts\/0\/id/);
  });

  it("変換サービスが居なければ投げる (黙って TS を先へ渡さない)", async () => {
    VARS["u/admin/ts_compile_url"] = "http://127.0.0.1:1";
    try {
      await expect(main([script("autoscroll", "ts")])).rejects.toThrow();
    } finally {
      VARS["u/admin/ts_compile_url"] = base;
    }
  });
});
