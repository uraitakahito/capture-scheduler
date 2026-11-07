/**
 * 定期実行の時計を capture-ledger へ移した後に、doctor が見ること。入出力を持たない (`checks.ts` が訊いて渡す)。
 */
import type { Verdict } from "./run.js";

/** これより短ければ ✗。警告の段階が無いので、明日の回で切れる所で止める。 */
const EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000;

const FIX_TOKEN = "pnpm run windmill:capture-ledger-token";

/** JWT の exp (秒)。読めなければ undefined、exp が無ければ null。署名は見ない (見るのは台帳)。 */
const expOf = (token: string): number | null | undefined => {
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" ? claims.exp : null;
  } catch {
    return undefined;
  }
};

/**
 * flow のトークンの期限。**切れると、回が撮れても報告が 401 になり、行が running のまま残って以後を全部塞ぐ。**
 * 発行し直すのは `dev:up` のときだけなので、動かし続けた機械では期限が来る。
 */
export const readTokenExpiry = (token: string, nowMs: number): Verdict => {
  const exp = expOf(token);
  if (exp === undefined) return { ok: false, need: `変数のトークンが JWT でない → ${FIX_TOKEN}` };
  if (exp === null) return { ok: true };
  const left = exp * 1000 - nowMs;
  if (left <= 0) return { ok: false, need: `flow のトークンの期限が切れている → ${FIX_TOKEN}` };
  if (left < EXPIRY_MARGIN_MS) {
    const hours = Math.floor(left / 3_600_000);
    return { ok: false, need: `flow のトークンの期限まで ${String(hours)} 時間 → ${FIX_TOKEN}` };
  }
  return { ok: true };
};

/** 走っている行のうち定期の回を名指す。e2e の前に見る。手で始めた行は `start` の 409 の文に任せる。 */
export const readScheduledRun = ({
  status,
  body,
}: {
  status: number | undefined;
  body: string;
}): Verdict => {
  if (status !== 200) {
    return { ok: false, need: `GET /api/crawls が ${String(status)} (上の can_submit を先に)` };
  }
  const { crawls } = JSON.parse(body) as {
    crawls: { crawlId: string; schedule?: { name: string } | null }[];
  };
  const scheduled = crawls.find((crawl) => crawl.schedule !== null && crawl.schedule !== undefined);
  return scheduled === undefined
    ? { ok: true }
    : {
        ok: false,
        need:
          `定期実行「${String(scheduled.schedule?.name)}」の回が走っている (crawl ${scheduled.crawlId.slice(0, 8)})。` +
          "終わってから流す",
      };
};
