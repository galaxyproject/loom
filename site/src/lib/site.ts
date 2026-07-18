// Shared site constants + base-path-aware URL helper.
// import.meta.env.BASE_URL is "/loom/" in production, "/" in some dev setups.

const raw = import.meta.env.BASE_URL;
export const BASE = raw.replace(/\/$/, '');

/** Build an absolute-within-site path that respects the deploy base. */
export function url(path = '/'): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${BASE}${p}` || '/';
}

export const links = {
  loom: 'https://github.com/galaxyproject/loom',
  mcp: 'https://github.com/galaxyproject/galaxy-mcp',
  releases: 'https://github.com/galaxyproject/loom/releases',
  npm: 'https://www.npmjs.com/package/@galaxyproject/loom',
  skills: 'https://github.com/galaxyproject/galaxy-skills',
  galaxy: 'https://galaxyproject.org',
  iwc: 'https://iwc.galaxyproject.org',
};

export const SITE_TITLE = 'Agentic Science with Galaxy';
export const SITE_DESC =
  'Point an AI agent at your data. It plans, runs real bioinformatics on Galaxy, and keeps the whole analysis fully reproducible and transparent. Meet Orbit, Loom, and Galaxy MCP.';
