/**
 * 定期実行の時計を capture-ledger へ移した後に、doctor が見ること。入出力を持たない (`checks.ts` が訊いて渡す)。
 */
import type { Verdict } from "./run.js";

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
