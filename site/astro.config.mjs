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
        src: "./src/assets/diffowl-logo.svg",
      },
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
          ],
        },
        {
          label: "Security",
          items: [{ label: "Trust model", slug: "security/trust-model" }],
        },
        {
          label: "Reference",
          items: [
            { label: "Action inputs and outputs", slug: "reference/action" },
            { label: "Review outcomes", slug: "reference/outcomes" },
            { label: "Troubleshooting", slug: "reference/troubleshooting" },
          ],
        },
        {
          label: "Project",
          items: [{ label: "Architecture", slug: "project/architecture" }],
        },
      ],
    }),
  ],
});
