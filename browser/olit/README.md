# Orbit Lite (Olit): an AI co-scientist inside Galaxy

Orbit Lite (Olit) runs the agent directly in the browser and uses Galaxy as its execution
environment. It inspects histories and datasets, plans analyses, finds and runs Galaxy tools and
workflows, follows their jobs, reads the results, and keeps a record of the analysis as a Galaxy
page. It is a Galaxy visualization plugin built on
`@galaxyproject/orbit-browser`, Orbit's browser shell.

Add it to your Galaxy's `client/visualizations.yml`, with the version on npm:

```yaml
olit:
    package: "@galaxyproject/olit"
    version: <version>
```

then rebuild the client (`make client`, or `cd client && pnpm run plugins`) and restart Galaxy.
Galaxy 26.1 or newer is required.

Source, development notes and the full guide:
https://github.com/galaxyproject/loom/tree/main/browser
