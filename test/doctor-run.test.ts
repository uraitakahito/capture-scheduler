/**
 * doctor の順序と飛ばし方、報告の形。
 *
 * 要になるのは「直すものが 1 つなら ✗ も 1 本」 —— Windmill が落ちているとき、Windmill に
 * 訊く点検まで ✗ を並べない。本物の点検の並び (`CHECKS`) の親子で確かめる。
 */
import { describe, expect, it } from "vitest";

import { CHECKS } from "../scripts/doctor/checks.js";
import {
  formatFixes,
  formatTable,
  runChecks,
  type Check,
  type Outcome,
  type Result,
} from "../scripts/doctor/run.js";
import { SECTIONS } from "../scripts/doctor/sections.js";

const ok = (): Promise<Outcome> => Promise.resolve({ ok: true });
const fail = (need: string) => (): Promise<Outcome> => Promise.resolve({ ok: false, need });

const check = (name: string, needs: string[] = [], probe = ok): Check => ({
  name,
  section: SECTIONS.bringUp,
  where: `${name} を訊く`,
  needs,
  probe,
});

const stateOf = (results: Result[], name: string): Result | undefined =>
  results.find((r) => r.check.name === name);

describe("本物の点検の並び", () => {
  /** 13 本の probe を差し替える。`failing` だけ ✗ にする。 */
  const withOnlyFailing = (failing: string): Check[] =>
    CHECKS.filter((c) => c.e2eOnly !== true).map((c) => ({
      ...c,
      probe: c.name === failing ? fail(`${failing} を直す`) : ok,
    }));

  it("Windmill が落ちているとき ✗ は 1 本だけで、Windmill に訊く点検は「先に windmill を」", async () => {
    const results = await runChecks(withOnlyFailing("windmill"));
    expect(results.filter((r) => r.state === "fail").map((r) => r.check.name)).toEqual([
      "windmill",
    ]);
    const skipped = results.filter((r) => r.state === "skip");
    expect(skipped.map((r) => r.check.name).sort()).toEqual(
      [
        "can_submit",
        "container→api",
        "proto",
        "push",
        "worker→browserhive",
        "workspace",
        "変数",
      ].sort(),
    );
    for (const r of skipped) expect(r).toMatchObject({ reason: "先に windmill を" });
    // Windmill に頼らない点検は走る。
    expect(stateOf(results, "jwt")?.state).toBe("ok");
    expect(stateOf(results, "openfga")?.state).toBe("ok");
  });

  it("jwt が ✗ なら、can_submit は訊かない (flow の古いトークンで ✓ と ✗ が入れ替わるため)", async () => {
    const results = await runChecks(withOnlyFailing("jwt"));
    expect(stateOf(results, "can_submit")).toMatchObject({ state: "skip", reason: "先に jwt を" });
  });

  it("点検は 13 本で、e2e のときだけ 2 本増える", () => {
    expect(CHECKS.filter((c) => c.e2eOnly !== true)).toHaveLength(13);
    expect(CHECKS).toHaveLength(15);
  });

  it("親は必ず子より前に並ぶ (報告がクイックスタートの順に読め、循環も無い)", () => {
    const seen = new Set<string>();
    for (const c of CHECKS) {
      for (const parent of c.needs ?? []) {
        expect(seen, `${c.name} の親 ${parent}`).toContain(parent);
      }
      seen.add(c.name);
    }
  });

  it("同じ節の点検は並んでいる (見出しが 2 度出ない)", () => {
    const sections = CHECKS.map((c) => c.section);
    const firstRuns = sections.filter((s, i) => i === 0 || sections[i - 1] !== s);
    expect(new Set(firstRuns).size).toBe(firstRuns.length);
  });

  it("e2e を外しても、残る点検の親は全部残る", () => {
    const names = new Set(CHECKS.filter((c) => c.e2eOnly !== true).map((c) => c.name));
    for (const c of CHECKS.filter((c) => c.e2eOnly !== true)) {
      for (const parent of c.needs ?? []) expect(names).toContain(parent);
    }
  });
});

describe("runChecks", () => {
  it("飛ばした理由には、途中で飛ばされた親ではなく ✗ の祖先を挙げる", async () => {
    const results = await runChecks([
      check("root", [], fail("root を直す")),
      check("middle", ["root"]),
      check("leaf", ["middle"]),
    ]);
    expect(stateOf(results, "leaf")).toMatchObject({
      state: "skip",
      reason: "先に root を",
      blockedBy: ["root"],
    });
  });

  it("✗ の祖先が 2 つなら、両方を挙げる", async () => {
    const results = await runChecks([
      check("a", [], fail("a")),
      check("b", [], fail("b")),
      check("child", ["a", "b"]),
    ]);
    expect(stateOf(results, "child")).toMatchObject({ reason: "先に a・b を" });
  });

  it("子は、親の答えが出てから走る", async () => {
    const order: string[] = [];
    const slow = (): Promise<Outcome> =>
      new Promise((resolve) =>
        setTimeout(() => {
          order.push("parent done");
          resolve({ ok: true });
        }, 20),
      );
    await runChecks([
      check("parent", [], slow),
      check("child", ["parent"], () => {
        order.push("child start");
        return ok();
      }),
    ]);
    expect(order).toEqual(["parent done", "child start"]);
  });

  it("親の無い点検どうしは並べて走る", async () => {
    let running = 0;
    let peak = 0;
    const probe = async (): Promise<Outcome> => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return { ok: true };
    };
    await runChecks([check("a", [], probe), check("b", [], probe), check("c", [], probe)]);
    expect(peak).toBe(3);
  });

  it("点検が投げたら ✗ にし、ほかは止めない", async () => {
    const results = await runChecks([
      check("boom", [], () => Promise.reject(new Error("壊れた"))),
      check("other"),
    ]);
    expect(stateOf(results, "boom")).toMatchObject({
      state: "fail",
      need: "点検そのものが落ちた: 壊れた",
    });
    expect(stateOf(results, "other")?.state).toBe("ok");
  });

  it("点検しないと決めたものは ・ で、子は走らせる", async () => {
    const results = await runChecks([
      check("tls", [], () => Promise.resolve({ skipped: "TLS の口は見ない" })),
      check("child", ["tls"]),
    ]);
    expect(stateOf(results, "tls")).toMatchObject({ state: "skip", reason: "TLS の口は見ない" });
    expect(stateOf(results, "child")?.state).toBe("ok");
  });

  it("結果は渡した順に返す (答えの早い順ではない)", async () => {
    const late = (): Promise<Outcome> =>
      new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 10));
    const results = await runChecks([check("late", [], late), check("early")]);
    expect(results.map((r) => r.check.name)).toEqual(["late", "early"]);
  });

  it("needs が無い点検を指していたら投げる (綴りの誤りを黙って ✓ にしない)", async () => {
    await expect(runChecks([check("child", ["typo"])])).rejects.toThrow(/typo/);
  });
});

describe("報告", () => {
  const results: Result[] = [
    { check: { ...check("openfga"), section: SECTIONS.prerequisites }, state: "ok" },
    { check: check("windmill"), state: "fail", need: "container-compose up -d" },
    { check: check("変数"), state: "skip", reason: "先に windmill を", blockedBy: ["windmill"] },
  ];

  it("節の見出しの下に 1 本 1 行。日本語の名前でも列が揃う", () => {
    expect(formatTable(results)).toEqual([
      "前提 —— capture-ledger のスタック",
      "  ✓ openfga   openfga を訊く",
      "立ち上げる",
      "  ✗ windmill  windmill を訊く",
      "  ・変数      先に windmill を",
    ]);
  });

  it("直すものには、クイックスタートの節の URL を添える", () => {
    expect(formatFixes(results)).toEqual([
      "直すもの (1):",
      "  windmill —— container-compose up -d",
      "    手順: https://uraitakahito.github.io/capture-scheduler/ja/quickstart/#立ち上げる",
    ]);
  });

  it("✗ が無ければ、直すものは出さない", () => {
    expect(formatFixes([{ check: check("windmill"), state: "ok" }])).toEqual([]);
  });
});
