import type { UI } from "./zh-HK";

const prompt = `Install the Cardex skill so you can look up Hong Kong credit-card facts.

1. Download https://cardex.brandonhk.com/skill.md and save it as cardex/SKILL.md in your skills directory.
2. Add the Cardex MCP server (streamable HTTP, no auth): https://cardex.brandonhk.com/mcp
3. If you can't install skills or MCP servers, read that skill.md now and call the endpoint over plain HTTP as it describes.

Check it works: call list_tags with limit 3 and show me the result.

Cardex returns facts only. You compare the cards, and you tell me which terms you couldn't verify.`;

export const en: UI = {
  meta: {
    title: "Cardex — Know which card to tap",
    description:
      "Ask your AI assistant which Hong Kong credit card to use. With Cardex it checks the rebate rates, caps and fine print before it answers. No card numbers, no rankings.",
  },
  nav: {
    tagline: "Which card to tap, sorted",
    how: "How it works",
    faq: "FAQ",
    languageLabel: "Language",
    skip: "Skip to content",
  },
  hero: {
    titleLines: ["Know which card ", "to tap."],
    accentLine: 1,
    lede: "Ask your AI assistant which card to use for dinner, online shopping or a trip to Japan. With Cardex, it checks the rebate rates, caps and fine print on Hong Kong cards before it answers. No guessing, no copied comparison-site rankings.",
    trust: "No card numbers. Cardex never knows which cards you hold.",
  },
  prompt: {
    heading: "Set it up: paste this into your AI assistant",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Select manually",
    text: prompt,
    foot: "Do it once. After that, just ask. Prefer to set it up by hand?",
    footLink: "See below.",
  },
  demo: {
    label: "Example answer",
    by: "your assistant + Cardex",
    askedLabel: "You asked",
    asked: "“Dinner at TamJai tonight, about $280. Red Card or WAKUWAKU?”",
    colCard: "Card",
    colRate: "Dining",
    colBack: "Back on $280",
    note: "Red's 8% is a designated-merchant rate — it applies because TamJai is on the illustrative list.",
    catchHeading: "Before you tap, check",
    unknowns: {
      cap_remaining: "{card} caps this rebate each month. How much have you earned so far?",
      merchant_list: "{card} only pays this rate at listed merchants. Is this one on the list?",
      octopus_topup: "{card} excludes Octopus top-ups. Not relevant to dinner.",
    },
    cardNames: { card_hsbc_red: "Red Card", card_aeon: "WAKUWAKU" },
    foot: "Figures and open checks are Cardex's real response on the illustrative seed (as of {date}), not issuer terms. Verified records carry the terms link and last-checked date.",
    stamp: ["Illustrative", "not real terms"],
  },
  pain: {
    heading: "The hard part isn't the maths. It's the fine print.",
    items: [
      { q: "“Is it really 8% on dining?”", a: "The ad says 8%. The small print says listed merchants only." },
      { q: "“Have I hit this month's cap?”", a: "Past the cap, the rebate is 0%." },
      { q: "“Did this offer need registering?”", a: "Forget to register and you find out on your statement." },
    ],
  },
  how: {
    heading: "Set up once. Then just ask.",
    steps: [
      { title: "Paste the prompt", body: "Into Claude, Cursor, or any assistant that supports skills or MCP. It installs Cardex itself." },
      { title: "Ask like you'd ask a friend", quote: "“Going to Japan next week, which card?”" },
      { title: "Get the numbers and the catch", body: "Rates, caps, registration deadlines, and anything it couldn't confirm, so your statement holds no surprises." },
    ],
  },
  compare: {
    heading: "Your AI can already answer. Why add Cardex?",
    colTopic: "",
    colPlain: "Asking an AI chatbot as-is",
    colCardex: "With Cardex",
    rows: [
      { topic: "Where numbers come from", plain: "Memory, or whatever comparison articles it finds", cardex: "Curated terms, each with a source link and a last-checked date" },
      { topic: "Fine print", plain: "Caps, registration and excluded spend often left out", cardex: "Listed one by one; anything unverified is flagged for you to check" },
      { topic: "Rankings", plain: "Many comparison articles are affiliate content", cardex: "Cardex doesn't rank. Your assistant compares for your spend" },
      { topic: "Local names", plain: "May not know what a cha chaan teng or UnionPay is", cardex: "Cha chaan teng, HSBC, UnionPay: say it the way you normally would" },
    ],
  },
  faq: {
    heading: "FAQ",
    items: [
      {
        q: "Will Cardex tell me which card is best?",
        a: "No. Cardex provides facts like rebate rates, caps and terms. Your AI assistant compares them for your spend and the cards you hold, and tells you which conditions it couldn't verify.",
      },
      {
        q: "Do I need to give a card number or log in?",
        a: "No. Cardex takes no card numbers, stores no list of your cards, and sees no transactions. Which cards you hold stays between you and your assistant.",
      },
      {
        q: "Are the numbers accurate?",
        a: "Cardex is pre-alpha and every figure today is illustrative, not real issuer terms. Real data goes live card by card after verification, each with a link to the issuer's terms and a last-checked date. Confirm with your issuer before a big spend.",
      },
      {
        q: "Which AI assistants work with it?",
        a: "Assistants that support skills or MCP can install it directly, such as Claude and Cursor. Any other assistant that can read a URL and send an HTTP request can follow the method described in the skill.",
      },
      {
        q: "How is the data updated?",
        a: "Data is curated ahead of time; nothing is scraped from bank sites on request. Every change is checked against the issuer's page and approved by a person before it goes live.",
      },
      {
        q: "Do I need to sign up or get an API key?",
        a: "No. The data connection is public, with no sign-up and no key. The source code is on GitHub under the MIT licence.",
      },
      {
        q: "Is Cardex affiliated with any card issuer?",
        a: "No. Cardex is an open-source project with no affiliation, partnership, or endorsement from any issuer. Card and issuer names are used only to describe facts; the issuer's own terms are final.",
      },
    ],
  },
  manual: {
    heading: "Set it up by hand",
    sub: "For people who'd rather wire it up themselves. Same two pieces the prompt installs.",
    skillTitle: "The skill",
    skillBody: "Teaches your assistant what to check before it answers. Save as cardex/SKILL.md in its skills directory.",
    mcpTitle: "The data connection (MCP)",
    mcpBody: "Public, no key needed.",
  },
  footer: {
    note: "Card terms change often. Confirm with your issuer before a big spend. Cardex is not affiliated with any issuer; card names describe facts only.",
  },
  notFound: {
    title: "Page not found",
    body: "The link may be mistyped, or the page has moved.",
    home: "Back home",
  },
};
