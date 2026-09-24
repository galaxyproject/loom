# Prototype verification

Verified in Chromium through Playwright on 2026-09-24 against the public example
fixture in this PR. No brain, model, Galaxy connection or Electron restart.

- Five major stages; job completion remains distinct from verified results; all data labeled as examples.
- Stage-specific error grouping, exception expansion, evidence and next checks.
- Keyboard stage navigation and recovered upload explanation.
- Recovered-error filtering and navigation from an issue to its stage.
- Queued view excludes subsequent completion evidence and completed-report links.
- Blocked example explains the affected cohort, dependency and next action.
- Stale view retains evidence without claiming current progress.
- Empty view creates no plan or activity.
- Light theme, dark theme, and 390px layout with no horizontal overflow.
- Flow section collapse preserves access to the existing Activity sections.
- Artifact links open the labeled local fixture in a new tab without Galaxy access.
- Unavailable fixture disables stage controls and reports the load failure.

All 12 interaction checks passed. Zero page errors and zero external network
requests occurred. JavaScript syntax, focused ESLint, formatting, and diff checks
also passed. No application runtime code changed.

Screenshots generated from this public fixture: [overview](overview.png),
[stage errors](stage-errors.png), [light theme](light.png), [narrow layout](narrow.png).
These screenshots were visually inspected.
