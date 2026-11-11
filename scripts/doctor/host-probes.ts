/**
 * host から、compose が loopback に出したポートを叩いた答えの読み分け。
 *
 * capture-ledger は host で動くので、ts-compile-service には compose が `127.0.0.1` に出したポートで
 * 届く (macOS 26 では host の node がコンテナの subnet に TCP を張れない)。**200 は「何かが答えた」で
 * あって「ts-compile が答えた」ではない** —— 同じ番号を別のスタックが持っていることがある
 * (2026-09-20 に、capture-ledger の fixtures の代わりに BrowserHive の e2e の fixtures が 18080 で答えた)。
 * だから `/healthz` の形 (`typescript` と `hostTypes`) まで見る。
 */
import { HOST_TS_COMPILE } from "../env.js";
import type { Verdict } from "./run.js";
import type { Answer } from "./windmill-contents.js";

const parse = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

/** ts-compile-service の `/healthz` の形 (`{ ok, typescript, hostTypes }`) か。 */
const isTsCompileHealth = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  return (
    record["ok"] === true &&
    typeof record["typescript"] === "string" &&
    typeof record["hostTypes"] === "string"
  );
};

/** host から `127.0.0.1:28080/healthz` を叩いた答え。 */
export const readHostTsCompile = (answer: Answer): Verdict => {
  if (answer.status === undefined) {
    return {
      ok: false,
      need:
        `host から ${HOST_TS_COMPILE} に届かない —— ts-compile がポートを出していないか落ちた → ` +
        "この repo で container-compose up -d ts-compile",
    };
  }
  if (answer.status !== 200) {
    return { ok: false, need: `${HOST_TS_COMPILE}/healthz → http ${String(answer.status)}` };
  }
  if (!isTsCompileHealth(parse(answer.body))) {
    return {
      ok: false,
      need:
        `${HOST_TS_COMPILE} で答えたのは ts-compile でない (/healthz に typescript と hostTypes が無い) ` +
        "—— 同じ番号を別のスタックが持っていないかを見る",
    };
  }
  return { ok: true };
};
