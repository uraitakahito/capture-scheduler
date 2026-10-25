/**
 * 台帳が送った TS を、ts-compile-service で型検査して JS にする。**1 段に 1 回。**
 *
 * ## なぜ flow の段なのか
 *
 * 台帳が持つのは書いたままの TS のバイト列で、BrowserHive が評価するのは JS。その間のどこかで
 * 変換しなければならず、ここがその 1 か所。`crawl_host` は運ぶだけのまま (「flow は運ぶだけで中身を
 * 見ない」は変えていない —— 変換するのはこの段で、それも中身を見ずに送るだけ)。
 *
 * ## 型が通らなければ段ごと落ちる
 *
 * 変換サービスは 1 本でも型が通らなければ 422 を返し、JS を 1 本も返さない。ここで投げるので
 * flow は failure_module (`fail_crawl`) へ落ち、台帳のクロールは failed になる。**通らない TS を
 * 黙って走らせない** —— 走らせれば「何も起きなかったのに成功したアーカイブ」が出る。
 *
 * ## hash の継ぎ目
 *
 * 台帳 → ここは TS の sha256 で、ここ → BrowserHive は JS の sha256 で継ぐ。変換サービスが
 * 送られた sha256 を source と照合し (違えば 409)、JS に打ち直す。BrowserHive はその JS の
 * sha256 を照合する。
 */
import * as wmill from "windmill-client";

/** スクリプト 1 本。`crawl_host.ts` の CrawlScript と同じ形。入力は TS、出力は JS。 */
export interface CrawlScript {
  id: string;
  version: number;
  phase: "preload" | "behavior";
  source: string;
  sha256: string;
  options: Record<string, unknown>;
}

export interface Compiled {
  scripts: CrawlScript[];
  /** 何で変換したか (typescript の版)。`report_level` が台帳に運ぶ */
  typescript: string;
  /** 何に向けて変換したか (受け皿の型の capture-scripts の tag)。同じく台帳に運ぶ */
  hostTypes: string;
  /** 同じ TS の並びを、変換サービスが前にも変換していたか */
  cached: boolean;
}

/** 変換サービスの診断 1 件 (ts-compile-service の model/main.smithy の Diagnostic)。 */
interface Diagnostic {
  file?: string;
  line?: number;
  col?: number;
  code: string;
  message: string;
}

/** 失敗の文に載せる診断の数。残りは件数だけ言う。 */
const SHOWN = 5;

/** 診断 1 件を 1 行に。file は `inline-<name>.ts` のように、どの JS かを名指す。 */
const oneLine = (d: Diagnostic): string =>
  `${d.file ?? "?"}:${String(d.line ?? "?")}:${String(d.col ?? "?")} ${d.code} ${d.message}`;

/**
 * 変換サービスの答えを読む。**ok でなければ投げる** —— 422 (型エラー) も 409 (hash 違い) も
 * 400 (形の違反) も、この段が赤くなる理由になる。診断は件数と最初の 5 件に畳んで例外の文に入れ、
 * fail_crawl が台帳に報告する reason に載せる。
 */
export const readAnswer = (status: number, errorType: string | null, body: unknown): Compiled => {
  if (status === 200) return body as Compiled;
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const diagnostics = record["diagnostics"];
  // **診断を全部は載せない。** 束ねた JS を貼ると数百件 (async.js で 708 件・9 万字) になり、
  // 台帳の /failed (reason は 2,000 字まで) が 400 で断って、クロールが running のまま残る
  const detail = Array.isArray(diagnostics)
    ? `型の誤り ${String(diagnostics.length)} 件。最初の ${String(Math.min(SHOWN, diagnostics.length))} 件: ` +
      (diagnostics as Diagnostic[]).slice(0, SHOWN).map(oneLine).join(" / ")
    : JSON.stringify(record["fieldList"] ?? body);
  throw new Error(`compile ${String(status)} ${errorType ?? ""}: ${detail}`);
};

export async function main(scripts: CrawlScript[]): Promise<Compiled> {
  // **設定は変数から読む。引数では受けない。** Windmill は schema の既定値を UI からの実行にしか
  // 埋めない —— webhook で起こすと引数は素通りになる (`crawl_host.ts` に詳しい)。
  const base = await wmill.getVariable("u/admin/ts_compile_url");
  const res = await fetch(`${base}/compile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scripts }),
    // 固まるより落ちる。初回の型検査でも 1 秒かからない (実測 608 ms)
    signal: AbortSignal.timeout(30_000),
  });
  const body: unknown = await res.json();
  return readAnswer(res.status, res.headers.get("x-amzn-errortype"), body);
}
