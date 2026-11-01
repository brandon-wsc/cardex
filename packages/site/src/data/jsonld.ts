import { type Locale, localePath, locales, t } from "../i18n";
import { links, SITE } from "./links";

export function homeJsonLd(locale: Locale): object[] {
  const ui = t(locale);
  return [
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "Cardex",
      url: `${SITE}${localePath(locale)}`,
      description: ui.meta.description,
      applicationCategory: "FinanceApplication",
      operatingSystem: "Any (AI assistant with skill or MCP support)",
      inLanguage: [...locales],
      license: "https://opensource.org/licenses/MIT",
      codeRepository: links.github,
      areaServed: { "@type": "AdministrativeArea", name: "Hong Kong" },
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      inLanguage: locale,
      mainEntity: ui.faq.items.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    },
  ];
}
