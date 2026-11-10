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
  value: {
    type: string;
    path?: string;
    modules?: Module[];
    input_transforms?: Record<string, { type: string; expr: string }>;
  };
}

const waggle = join(repoRoot(), "windmill", "f", "waggle");
const flow = parse(readFileSync(join(waggle, "crawl_level.flow", "flow.yaml"), "utf8")) as {
  value: { modules: Module[] };
  schema: { properties: Record<string, unknown> };
};
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
