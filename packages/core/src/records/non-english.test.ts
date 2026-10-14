import { describe, expect, test } from "vitest";
import { groundingCheck, textWritesDay } from "../firecrawl/extract.ts";
import { groundQuotedPage, QuotedPage } from "../firecrawl/reader.ts";
import { assertedRoundCertainty } from "./certainty.ts";
import { normalizeCompanyKey } from "./keys.ts";
import { classifyStage, isDataPointQuote, namesCompany, parseAmount } from "./normalize.ts";
import { amountInEvidence, resolveRounds } from "./resolve.ts";
import { notARound } from "./routing.ts";
import type { ExtractedRound } from "./schema.ts";
import { textNamesSubject } from "./source-fit.ts";

// Every case is a page a history read refused although it states the round: 01.AI on ifeng, ByteDance
// (今日头条) on Yicai, MiniMax on Sina and Sohu, Musinsa on Investnews, Unitree on iyiou, and Back Market,
// BlaBlaCar, Contentsquare, Doctolib and Pennylane in the French press.

const IFENG =
  "# 消息称李开复创办的AI公司零一万物完成数亿美元融资\n\n李开复创办的 AI 大模型独角兽公司零一万物已经完成新一轮融资，金额达数亿美元。融资参与方包括某国际战投、东南亚财团等。";

describe("pages in Chinese, Japanese and Korean", () => {
  test("a quote is grounded on the page that writes it, and not on a page that does not", () => {
    const quote = "零一万物已经完成新一轮融资，金额达数亿美元。";
    expect(groundingCheck({ evidence_quote: quote }, IFENG)).toBe(true);
    expect(groundingCheck({ evidence_quote: quote }, "# 小红书\n\n小红书已经完成新一轮融资，金额达5亿美元。其他内容。")).toBe(false);
    expect(
      groundingCheck(
        { evidence_quote: "무신사가 400억 원 규모의 시리즈C 추가 투자 유치를 완료했다." },
        "무신사가 400억 원 규모의 시리즈C 추가 투자 유치를 완료했다. 이번 투자에는 산업은행과 IMM인베스트먼트가 참여했다.",
      ),
    ).toBe(true);
  });

  test("a quote translated out of the page's language is not grounded", () => {
    expect(
      groundingCheck(
        { evidence_quote: "The investment amount is 1 billion yen, with a shareholding ratio of 3%." },
        "出資額は10億円で、出資比率は3%。",
      ),
    ).toBe(false);
  });

  test("the reader keeps a round whose quotes are Chinese", () => {
    const sentence = "零一万物已经完成新一轮融资，金额达数亿美元。";
    const page = QuotedPage.parse({
      page_kind: "article",
      page_date: "2024-08-07",
      rounds: [
        {
          company_name: "零一万物",
          company_website: null,
          company_description: null,
          round_type_as_written: "新一轮融资",
          amount_as_written: "数亿美元",
          amount_kind: "round",
          amount_scope: null,
          financing_total_as_written: null,
          financing_total_quote: null,
          valuation_as_written: null,
          valuation_quote: null,
          debt_quote: null,
          lead_investors: [],
          other_investors: [],
          announced_date: null,
          headquarters: null,
          sector: null,
          evidence_quote: sentence,
          source_url: null,
          is_background: false,
          is_rumor: false,
          field_quotes: {
            company: "零一万物",
            website: null,
            description: null,
            stage: "新一轮融资",
            amount: "数亿美元",
            financing_total: null,
            valuation: null,
            date: null,
            headquarters: null,
            sector: null,
            lead_investors: [],
            other_investors: [],
          },
        },
      ],
    });
    expect(groundQuotedPage(page, IFENG).rounds.map((r) => r.company_name)).toEqual(["零一万物"]);
  });

  test("a name in Chinese, Japanese or Korean has a key, and Latin names inside Chinese text stay words", () => {
    expect(normalizeCompanyKey("零一万物")).toBe("零一万物");
    expect(normalizeCompanyKey("무신사")).toBe("무신사");
    expect(normalizeCompanyKey("プリファードネットワークス")).toBe("プリファードネットワークス");
    expect(normalizeCompanyKey("国内头部大模型企业MiniMax已基本完成新一轮融资交割")).toBe(
      "国内头部大模型企业 minimax 已基本完成新一轮融资交割",
    );
    expect(normalizeCompanyKey("Ørsted A/S")).toBe("rsted a s");
  });

  test("a text names a company written without spaces or with a particle attached", () => {
    expect(namesCompany(IFENG, "零一万物")).toBe(true);
    expect(namesCompany("무신사가 400억 원 규모의 시리즈C 추가 투자 유치를 완료했다.", "무신사")).toBe(true);
    expect(namesCompany("国内头部大模型企业MiniMax已基本完成新一轮融资交割", "MiniMax")).toBe(true);
    expect(namesCompany(IFENG, "小红书")).toBe(false);
    expect(textNamesSubject("独角兽融资抢手 大疆刚刚敲定10亿美元融资竞价有3轮", { name: "大疆" })).toBe(true);
    expect(textNamesSubject("首发丨宇树科技获数千万元Pre-A轮融资，红杉中国种子基金领投", { name: "宇树科技" })).toBe(true);
  });

  test.each([
    ["10亿美元", 1000, "USD"],
    ["4000 万美元", 40, "USD"],
    ["近 3 亿美元", 300, "USD"],
    ["不到20亿美元", 2000, "USD"],
    ["1亿美元 (US$100 million)", 100, "USD"],
    ["人民币1012.86万元", 10.129, "CNY"],
    ["2億円", 200, "JPY"],
    ["1000억원", 100000, "KRW"],
    ["400억 원", 40000, "KRW"],
  ])("%s is %s million %s", (written, value, currency) => {
    expect(parseAmount(written)).toEqual({ value, currency });
  });

  test("a figure that names no number stays unread", () => {
    expect(parseAmount("数亿美元").value).toBeNull();
    expect(parseAmount("数千万元").value).toBeNull();
  });

  test("the amount is found in its own sentence", () => {
    expect(amountInEvidence("10亿美元", "大疆新一轮10亿美元股权融资曝光。")).toBe(true);
    expect(amountInEvidence("400억 원", "무신사가 400억 원 규모의 시리즈C 추가 투자 유치를 완료했다.")).toBe(true);
    expect(amountInEvidence("5亿美元", "小红书已完成新一轮3亿美元融资。")).toBe(false);
  });

  test.each([
    ["C轮融资", "series_c"],
    ["B2轮融资", "series_b"],
    ["Pre-A轮融资", "pre_a"],
    ["시리즈C 추가 투자", "series_c"],
    ["シリーズA", "series_a"],
    ["天使轮", "pre_seed"],
    ["种子轮", "seed"],
    ["新一轮融资", "other"],
  ])("%s is %s", (label, stage) => {
    expect(classifyStage(label).stage).toBe(stage);
  });

  test("a sentence that states the raise is a round, and a Japanese loan is not a raise", () => {
    expect(notARound("融资", "今日头条已经完成了新一轮的融资，融资金额不到20亿美元。", "不到20亿美元", "今日头条")).toBeNull();
    expect(notARound("新融资", "大疆新一轮10亿美元股权融资曝光。", "10亿美元", "大疆")).toBeNull();
    expect(notARound("funding round", "무신사가 400억 원 규모의 투자 유치를 완료했다.", "400억 원", "무신사")).toBeNull();
    expect(notARound("funding round", "みずほ銀行から10億円の融資を受けた。", "10億円", "Acme")).toBe("no raise stated");
  });

  test("a close in progress and unnamed sources are not an announcement", () => {
    expect(assertedRoundCertainty("大模型公司 MiniMax 近 3 亿美元的新一轮融资已接近完成，投后估值超过 40 亿美元")).toBe("expected");
    expect(assertedRoundCertainty("11月8日，消息称，小红书已完成新一轮5亿美元融资，投后估值超过200亿美元。")).toBe("reported");
    expect(assertedRoundCertainty("今日头条已经完成了新一轮的融资，融资金额不到20亿美元。")).toBeNull();
  });

  test("a page writes its day in Chinese, Korean, or inside emphasis", () => {
    expect(textWritesDay("PingWest品玩4月7日报道，2017年4月7日", new Date("2017-04-07"))).toBe(true);
    expect(textWritesDay("기사입력 2023년 11월 2일", new Date("2023-11-02"))).toBe(true);
    expect(textWritesDay("第一财经APP _2017-08-12 07:31_", new Date("2017-08-12"))).toBe(true);
    expect(textWritesDay("第一财经APP _2017-08-12 07:31_", new Date("2017-08-11"))).toBe(false);
  });
});

function resolveFrench(evidence: string, amount: string, label = "levée de fonds") {
  const round: ExtractedRound = {
    company_name: "Back Market",
    company_website: null,
    company_description: null,
    round_type_as_written: label,
    amount_as_written: amount,
    amount_kind: "round",
    valuation_as_written: null,
    lead_investors: [],
    other_investors: [],
    announced_date: null,
    headquarters: null,
    sector: null,
    evidence_quote: evidence,
    source_url: null,
    is_background: false,
    is_rumor: false,
  };
  return resolveRounds(
    [
      {
        round,
        source: {
          url: "https://alliancy.fr/back-market-leve-300-000-euros-pour-ses-produits-electroniques-reconditionnes",
          host: "alliancy.fr",
          title: "Back Market lève 300 000 euros pour ses produits électroniques reconditionnés",
          published: "2015-05-29",
        },
        page_kind: "article",
        page_date: "2015-05-29",
      },
    ],
    {
      stages: ["seed", "series_a"],
      stagelessBands: ["early", "mid"],
      windowStart: new Date("2015-01-01"),
      now: new Date("2015-06-30"),
      rates: { date: "2015-05-29", perUsd: { EUR: 0.91 } },
    },
  );
}

describe("pages in French", () => {
  test("a French round sentence is a sentence, not a data point", () => {
    for (const quote of [
      "Six mois seulement après sa création, la start-up réalise une levée de fonds de 300 000 euros auprès d’investisseurs privés.",
      "Le géant français du covoiturage BlaBlaCar a annoncé jeudi avoir bouclé une levée de fonds de 21 millions d'euros auprès d'une société russe.",
      "Doctolib vient d'annoncer avoir bouclé un tour de table d'un million d'euros auprès de plusieurs business angels.",
      "Pennylane vient de boucler une levée de fonds de 29,5 millions d’euros.",
    ])
      expect(isDataPointQuote(quote)).toBe(false);
    expect(isDataPointQuote("Back Market : 300 000 euros")).toBe(true);
  });

  test("injecting, gathering, and joining the capital are raises", () => {
    expect(
      notARound(
        "tour de table",
        "Le fonds de pré-amorçage des entrepreneurs Internet français va injecter 1,25 millions d’euros dans la société éditrice (Comuto).",
        "1,25 millions d’euros",
        "Covoiturage.fr",
      ),
    ).toBeNull();
    expect(
      notARound(
        "funding round",
        "ContentSquare a réuni 20 millions de dollars, auprès de Highland Europe.",
        "$20 million",
        "ContentSquare",
      ),
    ).toBeNull();
    expect(
      notARound("capitalisation", "Sequoia entre au capital de Pennylane à hauteur de 15 millions €.", "15 millions €", "Pennylane"),
    ).toBeNull();
  });

  test("a figure with spaces between its thousands is read", () => {
    expect(parseAmount("300 000 euros")).toEqual({ value: 0.3, currency: "EUR" });
    expect(parseAmount("2015 300 000 euros").value).toBeNull();
  });

  test("Back Market's 2015 round on alliancy.fr is kept", () => {
    const result = resolveFrench(
      "Six mois seulement après sa création, la start-up réalise une levée de fonds de 300 000 euros auprès d’investisseurs privés dont Thierry Petit.",
      "300 000 euros",
    );
    expect(result.kept.map((r) => [r.company_name, r.amount?.value, r.amount?.currency])).toEqual([["Back Market", 0.3, "EUR"]]);
  });
});
