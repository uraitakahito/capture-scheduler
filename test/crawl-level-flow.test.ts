/**
 * flow (`crawl_level.flow/flow.yaml`) が crawl_host の引数を運ぶ形。
 *
 * 引数を渡すのは flow の `input_transforms` で、書き忘れた引数は Windmill が `null` で届ける —— 黙って「無い」に
 * 倒れる。`secret_archive` なら、keep と宣言した値が隠れる側に倒れ、取り込みは成功するので気づけない。本物の
 * 往復は e2e (`script-values.e2e.test.ts` の keep の試験) が見る。ここは、スタックが無くても見られる形だけを見る。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { repoRoot } from "../scripts/env.js";

interface Module {
  id: string;
  retry?: { constant?: { attempts: number; seconds: number } };
  value: {
    type: string;
    path?: string;
    modules?: Module[];
    input_transforms?: Record<string, { type: string; expr: string }>;
  };
}

const waggle = join(repoRoot(), "windmill", "f", "waggle");
const flow = parse(readFileSync(join(waggle, "crawl_level.flow", "flow.yaml"), "utf8")) as {
  value: { modules: Module[]; failure_module: Module };
  schema: { properties: Record<string, unknown>; required: string[] };
};
const schemaOf = (name: string) =>
  (
    parse(readFileSync(join(waggle, `${name}.script.yaml`), "utf8")) as {
      schema: { properties: Record<string, unknown> };
    }
  ).schema.properties;
const script = parse(readFileSync(join(waggle, "crawl_host.script.yaml"), "utf8")) as {
  schema: { properties: Record<string, unknown> };
};

/** for-loop の中の crawl_host の段。 */
const crawlHostStep = (): Module | undefined =>
  flow.value.modules
    .flatMap((module) => module.value.modules ?? [])
    .find((module) => module.value.path === "f/waggle/crawl_host");

describe("flow が crawl_host の引数を運ぶ", () => {
  it("crawl_host の引数 (script.yaml の schema) は全部、for-loop の段が input_transforms で渡す", () => {
    const step = crawlHostStep();
    expect(step, "flow に crawl_host の段が無い").toBeDefined();
    const carried = Object.keys(step?.value.input_transforms ?? {}).sort();
    expect(carried).toEqual(Object.keys(script.schema.properties).sort());
  });

  it("secret_archive は flow の入力をそのまま運び、flow の schema に在る", () => {
    expect(crawlHostStep()?.value.input_transforms?.["secret_archive"]).toEqual({
      type: "javascript",
      expr: "flow_input.secret_archive",
    });
    expect(flow.schema.properties).toHaveProperty("secret_archive");
  });
});

/**
 * 段の鍵 (CAPTURE-180)。capture-ledger が flow の引数 `level_key` で渡し、段の報告の `Idempotency-Key` と fail_crawl の
 * 本文に返す。書き忘れると Windmill は null で届け、capture-ledger は段の報告を 400 で断る。
 */
describe("flow が段の鍵を運ぶ", () => {
  const report = flow.value.modules.find((module) => module.id === "report");

  it("level_key は flow の入力で、必須", () => {
    expect(flow.schema.properties).toHaveProperty("level_key");
    expect(flow.schema.required).toContain("level_key");
  });

  it("report の段は report_level の引数を全部運び、level_key は flow の入力そのまま", () => {
    expect(Object.keys(report?.value.input_transforms ?? {}).sort()).toEqual(
      Object.keys(schemaOf("report_level")).sort(),
    );
    expect(report?.value.input_transforms?.["level_key"]).toEqual({
      type: "javascript",
      expr: "flow_input.level_key",
    });
  });

  it("report の段は 30 秒の間隔で 5 回再試行する（報告中の期限 2 分より長く）", () => {
    expect(report?.retry).toEqual({ constant: { attempts: 5, seconds: 30 } });
  });

  it("failure_module は fail_crawl の引数を全部運び、落ちた段の深さと鍵を渡す", () => {
    const failure = flow.value.failure_module;
    expect(Object.keys(failure.value.input_transforms ?? {}).sort()).toEqual(
      Object.keys(schemaOf("fail_crawl")).sort(),
    );
    expect(failure.value.input_transforms?.["depth"]?.expr).toBe("flow_input.depth");
    expect(failure.value.input_transforms?.["level_key"]?.expr).toBe("flow_input.level_key");
  });
});
