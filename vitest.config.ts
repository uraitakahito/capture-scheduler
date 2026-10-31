import { defineConfig } from "vitest/config";

/**
 * project は 2 つ。**設定ファイルは 1 つ。**
 *
 *   unit —— 既定。スタックを一切要らない。`pnpm test` はこれだけを走らせる。
 *   e2e  —— 動いているスタックに対して 1 本だけ。`pnpm run test:e2e` で opt-in。
 *
 * 分ける理由は、e2e が **単体では定義上見えないもの**を見ているから ——
 * flow が script に引数を渡す経路は TypeScript の外に在り、型でも単体でも触れない。
 * 実際、`host_parallelism` を camelCase で書いて null が届いた事故も、schema の
 * 既定値が webhook 実行では埋まらない事故も、単体では 1 つも赤くならなかった。
 *
 * e2e を CI に載せないのは、Windmill・capture-ledger・browserhive・capture-fixtures・OpenSearch が
 * 揃って動いている必要があるから。手で `pnpm run test:e2e`。
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/e2e/**"],
          environment: "node",
          setupFiles: ["./test/no-dns.ts"],
          clearMocks: true,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.e2e.test.ts"],
          // クロール 1 本ぶん。本物のブラウザが動くので緩く取る。
          testTimeout: 300_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
