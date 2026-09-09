import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://d4nz-jpg.github.io",
  base: "/diffowl",
  integrations: [
    starlight({
      title: "Diffowl",
      description: "Evidence-backed pull-request review for teams that keep humans in control.",
      favicon: "/favicon.svg",
      logo: {
        src: "./src/assets/diffowl-crest.svg",
      },
      head: [
        {
          // Mockup-parity fonts. TODO: self-host Satoshi + JetBrains Mono.
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://api.fontshare.com/v2/css?f[]=satoshi@500,700,900&f[]=jet-brains-mono@400,600&display=swap",
          },
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/D4NZ-jpg/diffowl",
        },
      ],
      editLink: {
        baseUrl: "https://github.com/D4NZ-jpg/diffowl/edit/main/site/",
      },
      customCss: ["./src/styles/custom.css"],
      components: {
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      sidebar: [
        {
          label: "Getting started",
          items: [
            { label: "Introduction", slug: "getting-started/introduction" },
            { label: "Quick start", slug: "getting-started/quick-start" },
            { label: "GitHub Action", slug: "getting-started/github-action" },
          ],
        },
        {
          label: "Configuration",
          items: [{ label: "Project policy", slug: "configuration/project-policy" }],
        },
        {
          label: "Guides",
          items: [
            { label: "Finding discussions", slug: "guides/finding-discussions" },
            { label: "Local CLI", slug: "guides/local-cli" },
            { label: "Durable state and self-hosting", slug: "guides/durable-state" },
            { label: "Credentials and providers", slug: "guides/credentials" },
            { label: "Debugging failed runs", slug: "guides/debugging-runs" },
          ],
        },
        {
          label: "Security",
          items: [
            { label: "Trust model", slug: "security/trust-model" },
            { label: "Security audit", slug: "security/audit" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Action inputs and outputs", slug: "reference/action" },
            { label: "CLI reference", slug: "reference/cli" },
            { label: "Review outcomes", slug: "reference/outcomes" },
            { label: "Troubleshooting", slug: "reference/troubleshooting" },
          ],
        },
        {
          label: "Integration",
          items: [{ label: "Embedding the engine", slug: "integration/library" }],
        },
        {
          label: "Project",
          items: [{ label: "Architecture", slug: "project/architecture" }],
        },
      ],
    }),
  ],
});
