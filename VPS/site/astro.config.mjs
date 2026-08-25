import { defineConfig } from "astro/config";

export default defineConfig({
  trailingSlash: "always",
  output: "static",
  devToolbar: { enabled: false },
});
