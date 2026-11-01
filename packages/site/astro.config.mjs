import preact from "@astrojs/preact";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://cardex.brandonhk.com",
  output: "static",
  trailingSlash: "never",
  build: { format: "file" },
  integrations: [preact()],
});
