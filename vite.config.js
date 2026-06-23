import { defineConfig } from "vite";

// Relative base so the production build works both at the GitHub Pages project
// URL (https://lolismek.github.io/alexjerpelea.com/) and at a custom domain or
// site root, with no reconfiguration.
export default defineConfig({
  base: "./",
});
