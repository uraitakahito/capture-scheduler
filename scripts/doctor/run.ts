/**
 * doctor の点検を、親から子の順に走らせ、クイックスタートの節ごとの報告にする。
 *
 * ## 親が ✗ なら、子は走らせない
 *
 * doctor の前の点検 (v0.15 まで) は、全部を並べて走らせていた。Windmill が落ちていると、Windmill に
 * 訊く点検がそろって ✗ になり、直すものは 1 つなのに ✗ が並ぶ —— どれが原因かを、読む人が
 * 探すことになる。ここでは点検ごとに親 (`needs`) を書き、親が 1 つでも ✗ なら子は走らせずに
 * 「先に windmill を」と出す。名指すのは ✗ になった祖先で、途中で飛ばされた親ではない。
 *
 * 子は親が済むのを待ってから走るので、**順序も `needs` で書ける。** can_submit を jwt の後に
 * 走らせる理由 (v0.15.1: jwt の新しいトークンが API に鍵を取り直させてから、flow の古い
 * トークンで訊く) は、`needs` に jwt と書くだけで守られる。親の無い点検と、親の済んだ
 * 点検は並べて走る。
 *
 * 入出力を持たない。点検の中身は `checks.ts`、ここは順序と印字だけ。
 */
import { sectionUrl, type Section } from "./sections.js";

export type Verdict = { ok: true } | { ok: false; need: string };

/** 点検しないと決めた (TLS の口など)。✓ とも ✗ とも数えない。理由は報告に出す。 */
export interface NotChecked {
  skipped: string;
}

export type Outcome = Verdict | NotChecked;

export interface Check {
  name: string;
  /** クイックスタートのどの節の手か。報告の見出しと、✗ に添える URL になる。 */
  section: Section;
  /** 何を訊くか。報告の行に出す。 */
  where: string;
  /** これが 1 つでも ✗ なら走らせない。済むまで待ってから走る。 */
  needs?: readonly string[];
  probe: () => Promise<Outcome>;
}

export type Result = { check: Check } & (
  | { state: "ok" }
  | { state: "fail"; need: string }
  | { state: "skip"; reason: string; blockedBy: readonly string[] }
);

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const settle = (check: Check, outcome: Outcome): Result => {
  if ("skipped" in outcome) return { check, state: "skip", reason: outcome.skipped, blockedBy: [] };
  return outcome.ok ? { check, state: "ok" } : { check, state: "fail", need: outcome.need };
};

/** 子を止める祖先。✗ はそれ自身、親のせいで飛ばされたものは、その祖先。 */
const blockers = (parent: Result): readonly string[] => {
  if (parent.state === "fail") return [parent.check.name];
  if (parent.state === "skip") return parent.blockedBy;
  return [];
};

/** 結果は `checks` と同じ順に返す。`needs` の綴りが無い点検を指していれば投げる。 */
export const runChecks = async (checks: readonly Check[]): Promise<Result[]> => {
  const byName = new Map(checks.map((check) => [check.name, check]));
  const started = new Map<string, Promise<Result>>();
  const resultOf = (name: string): Promise<Result> => {
    const known = started.get(name);
    if (known !== undefined) return known;
    const check = byName.get(name);
    if (check === undefined) throw new Error(`doctor: 点検「${name}」は無い (needs の綴り)`);
    const result = Promise.all((check.needs ?? []).map(resultOf)).then(
      async (parents): Promise<Result> => {
        const blockedBy = [...new Set(parents.flatMap(blockers))];
        if (blockedBy.length > 0) {
          return { check, state: "skip", reason: `先に ${blockedBy.join("・")} を`, blockedBy };
        }
        const outcome = await check.probe().catch(
          (err: unknown): Verdict => ({
            ok: false,
            need: `点検そのものが落ちた: ${messageOf(err)}`,
          }),
        );
        return settle(check, outcome);
      },
    );
    started.set(name, result);
    return result;
  };
  return Promise.all(checks.map((check) => resultOf(check.name)));
};

/**
 * 端末で 2 桁を占める文字 (かな・漢字・全角)。`padEnd` は文字数で揃えるので、
 * 「変数」のような名前の行だけ 2 桁ずれる。
 */
const WIDE =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

const widthOf = (text: string): number =>
  [...text].reduce((sum, char) => sum + (WIDE.test(char) ? 2 : 1), 0);

/** 端末の桁で `width` まで空白を足す。smoke の見出しも同じ揃え方をする。 */
export const pad = (text: string, width: number): string =>
  text + " ".repeat(Math.max(0, width - widthOf(text)));

const MARK = { ok: "✓", fail: "✗", skip: "・" } as const;

/** 節の見出しと、点検 1 本につき 1 行。節は、結果に初めて出てきた順。 */
export const formatTable = (results: readonly Result[]): string[] => {
  const nameWidth = Math.max(...results.map((r) => widthOf(r.check.name))) + 2;
  const lines: string[] = [];
  let section: Section | undefined;
  for (const result of results) {
    if (result.check.section !== section) {
      section = result.check.section;
      lines.push(section.title);
    }
    const text = result.state === "skip" ? result.reason : result.check.where;
    lines.push(`  ${pad(MARK[result.state], 2)}${pad(result.check.name, nameWidth)}${text}`);
  }
  return lines;
};

/** ✗ ごとに、何を直すかと、その手順の節の URL。✗ が無ければ空。 */
export const formatFixes = (results: readonly Result[]): string[] => {
  const count = results.filter((r) => r.state === "fail").length;
  if (count === 0) return [];
  return [
    `直すもの (${String(count)}):`,
    ...results.flatMap((r) =>
      r.state === "fail"
        ? [`  ${r.check.name} —— ${r.need}`, `    手順: ${sectionUrl(r.check.section)}`]
        : [],
    ),
  ];
};
