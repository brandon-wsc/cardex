const prompt = `幫我安裝 Cardex skill，等你查到香港信用卡嘅資料。

1. 下載 https://cardex.brandonhk.com/skill.md，存做你 skills 目錄入面嘅 cardex/SKILL.md。
2. 加 Cardex MCP server（streamable HTTP，唔使 auth）：https://cardex.brandonhk.com/mcp
3. 如果你裝唔到 skill 或者 MCP，就即刻讀嗰個 skill.md，照佢講嘅方法用普通 HTTP call 個 endpoint。

試吓得唔得：call list_tags，limit 3，俾我睇結果。

Cardex 只係俾事實。比較邊張卡由你做，邊啲條款你核實唔到，要話俾我知。`;

export const zhHK = {
  meta: {
    title: "Cardex — 碌邊張卡，問一句就知",
    description:
      "問你嘅 AI 助手碌邊張香港信用卡。裝咗 Cardex，佢會先查清楚回贈、上限同細則先答你。唔使卡號，唔排名。",
  },
  nav: {
    tagline: "碌邊張卡，問一句就知",
    how: "點用",
    faq: "常見問題",
    languageLabel: "語言",
    skip: "跳到主要內容",
  },
  notice: {
    tag: "PRE-ALPHA",
    text: "我哋仲核實緊發卡行條款，而家啲數字只係示範，暫時唔好靠佢做決定。",
  },
  hero: {
    titleLines: ["碌邊張卡，", "問一句", "就知。"],
    accentLine: 1,
    lede: "食飯、online shopping、去日本，問你嘅 AI 助手碌邊張卡。裝咗 Cardex，佢會先查清楚香港信用卡嘅回贈、上限同細則先答你。唔靠估，亦唔係照抄比較網站嘅排名。",
    trust: "唔使卡號。Cardex 唔知你有咩卡。",
  },
  prompt: {
    heading: "設定：將呢段貼落你嘅 AI 助手",
    copy: "複製",
    copied: "已複製",
    copyFailed: "請手動選取",
    text: prompt,
    foot: "設定一次就得，之後直接問。想自己手動設定？",
    footLink: "睇下面。",
  },
  demo: {
    label: "示範答案",
    by: "你嘅 AI 助手 + Cardex",
    askedLabel: "你問",
    asked: "「今晚譚仔食 $280，碌 Red Card 定 WAKUWAKU？」",
    colCard: "卡",
    colRate: "食肆",
    colBack: "$280 回贈",
    note: "Red 嘅 8% 只限指定商戶——譚仔喺示範名單上，先計到呢個率。",
    catchHeading: "碌之前確認吓",
    unknowns: {
      cap_remaining: "{card} 回贈每月有上限，你今個月賺咗幾多？",
      merchant_list: "{card} 呢個回贈只限指定商戶，呢間喺唔喺名單？",
      octopus_topup: "{card} 唔計八達通增值，食飯唔關事。",
    },
    cardNames: { card_hsbc_red: "Red Card", card_aeon: "WAKUWAKU" },
    foot: "數字同待確認項目係 Cardex 對示範數據（{date}）嘅真實回應，唔係發卡行條款；真數據會附條款連結同最後核實日期。",
    stamp: ["示範數據", "非真實條款"],
  },
  pain: {
    heading: "碌卡前最煩唔係計數，係唔知啲細則。",
    items: [
      { q: "「呢張卡食飯係咪真係 8%？」", a: "廣告寫 8%，細字話只限指定商戶。" },
      { q: "「今個月爆咗 cap 未？」", a: "回贈有上限，過咗就係 0%。" },
      { q: "「呢個優惠使唔使登記？」", a: "唔記得登記，等月結單出咗先知白碌。" },
    ],
  },
  how: {
    heading: "設定一次，之後照問。",
    steps: [
      { title: "貼段 prompt", body: "貼落 Claude、Cursor，或者其他支援 skill 或 MCP 嘅 AI 助手，佢會自己裝好 Cardex。" },
      { title: "好似問朋友咁問", quote: "「下個禮拜去日本，碌邊張好？」" },
      { title: "數同細則一次過講", body: "回贈、上限、登記限期，連佢查唔到嘅都話埋你知，唔使等月結單先發現中伏。" },
    ],
  },
  compare: {
    heading: "直接問 AI 都得，點解要 Cardex？",
    colTopic: "",
    colPlain: "直接問 AI 聊天工具",
    colCardex: "裝咗 Cardex",
    rows: [
      { topic: "數字從邊度嚟", plain: "靠記憶估，或者讀網上比較文", cardex: "查整理好嘅條款，每個數都有來源連結同核實日期" },
      { topic: "細則", plain: "上限、登記、唔計嘅簽賬好多時冇講", cardex: "逐條列出；查唔到嘅，講明要你確認" },
      { topic: "排名", plain: "網上比較文好多係聯盟推廣，排名未必中立", cardex: "Cardex 唔排名，由你嘅 AI 助手按你嘅消費比較" },
      { topic: "廣東話", plain: "「茶餐廳」「銀聯」未必知你講咩", cardex: "茶餐廳、匯豐、銀聯，你平時點講就點講" },
    ],
  },
  faq: {
    heading: "常見問題",
    items: [
      {
        q: "Cardex 會唔會直接話我知邊張卡最好？",
        a: "唔會。Cardex 只提供回贈、上限同條款呢啲事實，由你嘅 AI 助手按你嘅消費同你手上嘅卡去比較，再話你知邊啲條件查唔到。",
      },
      {
        q: "要唔要俾卡號，或者登入？",
        a: "唔使。Cardex 唔收卡號、唔存你有咩卡、唔睇交易紀錄。你有咩卡，係你同 AI 助手之間嘅事。",
      },
      {
        q: "啲數字準唔準？",
        a: "Cardex 仲係 pre-alpha，而家所有數字都係示範數據，唔係真實條款。真數據會逐張卡核實先上，每條都附發卡行條款連結同最後核實日期。大額簽賬前，記得同發卡行確認。",
      },
      {
        q: "邊啲 AI 助手用得？",
        a: "支援 skill 或者 MCP 嘅助手可以直接裝，例如 Claude、Cursor。其他助手只要識讀網址同發 HTTP request，都可以照 skill 入面寫嘅方法用。",
      },
      {
        q: "資料點樣更新？",
        a: "資料係預先整理好，唔會即時爬銀行網站。每次改動都要對住發卡行嘅頁面，經人手審批先會更新。",
      },
      {
        q: "要唔要註冊或者 API key？",
        a: "唔使。資料連線係公開嘅，唔使註冊、唔使 key。Source code 喺 GitHub，用 MIT 授權。",
      },
      {
        q: "Cardex 同發卡行有冇關係？",
        a: "冇。Cardex 係開源項目，同任何發卡行都冇隸屬、合作或者贊助關係。卡名同發卡行名只係用嚟描述事實，最終條款以發卡行為準。",
      },
    ],
  },
  manual: {
    heading: "手動設定",
    sub: "鍾意自己喐手嘅話，就喺 prompt 幫你裝嘅兩樣嘢。",
    skillTitle: "Skill",
    skillBody: "教你嘅 AI 助手答之前要查咩。存做佢 skills 目錄入面嘅 cardex/SKILL.md。",
    mcpTitle: "資料連線（MCP）",
    mcpBody: "公開，唔使 key。",
  },
  footer: {
    note: "信用卡條款成日變，大額消費前記得同發卡行確認。Cardex 同任何發卡行都冇關係，卡名只係用嚟描述事實。",
  },
  notFound: {
    title: "搵唔到呢頁",
    body: "條 link 可能打錯咗，或者頁面已經搬咗。",
    home: "返主頁",
  },
};

export type UI = typeof zhHK;
