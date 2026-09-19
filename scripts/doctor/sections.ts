/**
 * doctor の報告の見出しと、✗ に添える手順の URL。**docs の見出しそのもの。**
 *
 * 報告を節で分けるのは、✗ から「クイックスタートのどこをやり直すか」へ 1 歩で行けるように
 * するため。点検の名前 (jwt・can_submit) だけでは、読む人は docs を頭から探すことになる。
 *
 * anchor は公開されるページの id (Starlight が見出しから作る) と一字一句同じでなければ
 * ならない。見出しを書き換えると id も変わり、doctor が指す URL は黙ってページの先頭に
 * 落ちる —— `check-doc-refs.ts` が build 後の HTML と突き合わせて止める。
 */
export interface Section {
  /** 報告の見出し。 */
  title: string;
  /** docs-site の ja のページ。`quickstart` なら `ja/quickstart/`。 */
  page: string;
  anchor: string;
}

const DOCS = "https://uraitakahito.github.io/capture-scheduler/ja/";

export const SECTIONS = {
  prerequisites: {
    title: "前提 —— capture-ledger のスタック",
    page: "quickstart",
    anchor: "前提--capture-ledger-のスタックが動いていること",
  },
  bringUp: { title: "立ち上げる", page: "quickstart", anchor: "立ち上げる" },
  handOver: { title: "鍵を渡す", page: "quickstart", anchor: "鍵を渡す" },
  grant: {
    title: "windmill にクロールを許可する",
    page: "quickstart",
    anchor: "windmill-にクロールを許可する",
  },
  e2e: {
    title: "e2e",
    page: "testing",
    anchor: "e2e-は本物のクロールを-1-本起こす",
  },
  /** smoke が、知らない失敗のときに開かせる節。 */
  digFailures: {
    title: "失敗を掘る",
    page: "windmill-ui",
    anchor: "失敗を掘る--実例-2-つ",
  },
} as const satisfies Record<string, Section>;

export const sectionUrl = ({ page, anchor }: Section): string => `${DOCS}${page}/#${anchor}`;
