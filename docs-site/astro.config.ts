import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import { satteri } from "@astrojs/markdown-satteri";
import mdastCodeRegion from "./src/plugins/mdast-code-region";
import hastRebaseLinks from "./src/plugins/hast-rebase-links";

const BASE = "/capture-scheduler";

export default defineConfig({
  site: "https://uraitakahito.github.io",
  base: BASE,
  integrations: [
    starlight({
      title: "capture-scheduler Docs",
      customCss: ["./src/styles/tables.css"],
      // 英語が root (接頭辞なし)、日本語は /ja/ 配下。訳が無いページは
      // Starlight が黙って英語に落とす —— **半分だけ訳したサイトも緑でビルドできる**
      // ので、対応の検査は scripts/check-doc-refs.ts が持つ。
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        ja: { label: "日本語", lang: "ja" },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/uraitakahito/capture-scheduler",
        },
      ],
      // 各項目に `ja` 訳を持たせる。Starlight はページを翻訳するが**ナビゲーションは
      // 翻訳しない**ので、これが無いと日本語ドキュメントは、訳されたページが英語の
      // 目次にぶら下がった状態になる。
      sidebar: [
        { label: "Overview", translations: { ja: "概要" }, slug: "index" },
        { label: "Quickstart", translations: { ja: "クイックスタート" }, slug: "quickstart" },
        { label: "Following links", translations: { ja: "リンクを辿る" }, slug: "crawl" },
        { label: "Schedule", translations: { ja: "いつ走るか" }, slug: "schedule" },
        { label: "The UI", translations: { ja: "管理画面" }, slug: "windmill-ui" },
        {
          label: "Inspecting what was dropped",
          translations: { ja: "落とした物を Windmill で調べる" },
          slug: "inspect",
        },
        {
          label: "Windmill CE",
          translations: { ja: "Windmill CE" },
          slug: "windmill-ce",
        },
        { label: "Testing", translations: { ja: "試験" }, slug: "testing" },
        { label: "Development", translations: { ja: "開発" }, slug: "development" },
      ],
    }),
  ],
  // ```ts file="windmill/…#region" を実ソースに差し替える(コード片を live 化)
  markdown: {
    // Astro 7.2 の既定プロセッサ。legacy の remarkPlugins/rehypePlugins は
    // @astrojs/markdown-remark(unified) を要求するので、そちらは使わない。
    processor: satteri({
      mdastPlugins: [mdastCodeRegion],
      hastPlugins: [hastRebaseLinks],
    }),
  },
});
