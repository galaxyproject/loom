# Agentic Science with Galaxy — site

The public marketing + docs site for Orbit, Loom, and Galaxy MCP. Astro 5 +
Tailwind v4, deployed to GitHub Pages at **https://galaxyproject.github.io/loom/**.

## Design

Styling is the canonical Galaxy design system — it consumes
[`@galaxyproject/brand-tokens`](https://github.com/galaxyproject/galaxy-brand-tokens)
(`theme.css`) directly rather than hand-copying colors, and follows the component
patterns in the Hub's `DESIGN.md`. Atkinson Hyperlegible + JetBrains Mono. The
"cosmic web / observatory" hero treatment leans on the project's own cosmology
(the cosmic web weaving galaxies; Orbit as the electron shell).

## Develop

```bash
cd site
npm install
npm run dev        # http://localhost:4321/loom/
npm run build      # static output in dist/
npm run preview    # serve the built site
npm run typecheck  # astro check
```

Node 18.20.8+, 20.3+, or 22+.

## Structure

```
site/
  src/
    layouts/       Base.astro, DocsLayout.astro
    components/    Header, Footer, CosmicWeb, OrbitMock
    pages/         index.astro, docs/index.astro, docs/[...slug].astro
    content/docs/  markdown docs (getting-started, concepts, galaxy-mcp, architecture)
    styles/        global.css (brand tokens + site component layer)
    lib/           site.ts (base-path helper + links)
  public/          brand marks (galaxy-logo, orbit-icon, favicon)
```

Docs are markdown in `src/content/docs/` (a content collection). Add a `.md` with
`title` / `description` / `group` / `order` frontmatter and it appears in the docs
nav automatically.

## Deploy

`.github/workflows/site.yml` builds `site/` and publishes to Pages on push to
`main`. Requires **Settings → Pages → Source = GitHub Actions** to be enabled on
the repository.
