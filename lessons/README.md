# Lessons

A lesson records one observed, scoped thing: _in this situation this goes wrong,
here is how to tell it is this one, here is what to do, and here is how to know
it worked._ It is not a skill. A skill is authored, prescriptive and broad; a
lesson is a note from a specific failure that nobody wrote down the first time.

The corpus is deliberately small. Most knowledge belongs somewhere else, and the
sorting rule below is about sending it there.

## The sorting rule

Before writing a lesson, ask what the knowledge is. Exactly one destination:

| What it is                                                                                                       | Where it goes                                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Already in a GTN FAQ, tutorial or forum thread                                                                   | Cite that. No lesson.                                                                         |
| Already a lesson here                                                                                            | Add evidence to the existing one -- counts, versions, another `sources` entry. No new lesson. |
| Something a validator, a schema or a better error message would catch                                            | An issue on galaxy-mcp, the Foundry, or Galaxy. Never the corpus.                             |
| A general how-to                                                                                                 | A GTN FAQ pull request. Regular docs are the default landing.                                 |
| Agent misbehaviour                                                                                               | The Loom prompt plus an eval. Not knowledge.                                                  |
| A silent scientific pitfall, an expectation, a choice, a source quirk, or a reproduction note, with no hit above | A lesson here.                                                                                |

The last row is the whole corpus. If a lesson would be better as an error
message, write the error message.

## Namespaces

The namespace is the first path segment and part of the lesson's id, so
`stats/na-coerced-to-zero-in-filters.md` has the id
`stats/na-coerced-to-zero-in-filters`.

- `stats` -- statistical reasoning and interpretation.
- `reproduction` -- reproducing a published analysis.
- `data` -- acquiring data and what the source actually hands back.
- `galaxy-tools` -- a tool or a server's configuration of it.
- `galaxy-api` -- lessons whose durable fix now lives somewhere else. Kept for
  the record, never surfaced: a non-empty `graduated_to` is what makes that
  true, and the validator requires one in this namespace.

## Layout

```
lessons/
  README.md  SCHEMA.md  LICENSE  log.md
  validate.mjs  build-snapshot.mjs  snapshot.json
  <namespace>/<slug>.md
```

`snapshot.json` is generated and committed. Never hand-edit it: run
`npm run build:lessons` and commit the result. `npm run check:lessons` validates
every lesson and fails if the snapshot is out of date, and runs in CI.

## Writing one

`SCHEMA.md` is the field list. The things that actually decide whether a lesson
earns its place:

- **The title is the situation, not the fix.** "Numeric filters treat NA as 0"
  rather than "Always exclude NA".
- **`Check first` and `Validate` are required, and are the point.** The first
  keeps the lesson from being applied to a situation that merely looks similar.
  The second keeps "the error went away" from passing as success.
- **Cause is optional and labelled.** Recovering from something is not proof you
  diagnosed it. Say `hypothesized` when it is a hypothesis.
- **Evidence, editorial status and applicability are three separate axes.**
  `evidence.{symptom,cause,outcome}` each carry their own label and a `method`;
  `status` is editorial; `applies_to.versions` is scope. There is no single
  confidence score and nothing is promoted automatically.
- **Triggers are machine-matchable or they are decoration.** Literal normalized
  signatures, tool ids, `galaxy_*` MCP tool names, datatypes, bare hostnames,
  dotted extensions, lowercase plan-step keywords. The prose `cues` field is for
  humans and is never matched. A lesson with every trigger list empty is
  rejected.
- **An upstream fix narrows `applies_to.versions`.** It does not retire the
  lesson -- older installs still hit it.
- **`stale_after` is required.** A lesson that nobody will re-verify should drop
  out on its own.

The body carries nothing to follow and nothing to run: no URLs, no markdown
links, images or HTML, no code blocks, printable ASCII only, each section at
most 600 characters. Those are enforced, not advisory. Provenance goes in
`sources`, and a link there must point at one of the hosts listed in
`LINK_HOSTS` in `validate.mjs`.

## Contributing

1. Fork, branch, add one `.md` file under the right namespace.
2. `npm run check:lessons` -- it prints `path:line: message` for every problem.
3. `npm run build:lessons` and commit `lessons/snapshot.json` alongside.
4. Add a line to `log.md`.
5. Open a pull request against `main`.

Your pull request needs both of these, checked by you:

```
- [ ] This lesson contains no personal data and no research data. No filesystem
      paths, dataset or history ids, URLs, private server hostnames, dataset,
      history, sample or account names, and no values copied out of anyone's
      data -- mine or anybody else's.
- [ ] Signed-off-by line present (Developer Certificate of Origin 1.1), and I
      am licensing this lesson under CC BY 4.0 as described in LICENSE.
```

Sign off with `git commit -s`, which appends
`Signed-off-by: Your Name <you@example.com>`. That line is the Developer
Certificate of Origin 1.1 assertion: you wrote the contribution, or have the
right to submit it under the licence above.

The validator is the second line of defence on the first checkbox, not the
first. It refuses the shapes of URLs, links, HTML, paths, ids, addresses and
keys and caps every field, but it cannot tell that a plausible-looking tool id
was a private server's, that a sentence describes one specific person's data,
or that a sentence is an instruction aimed at the model rather than advice. That judgement is yours, and a
published lesson cannot be unpublished from git history -- the privacy decision
happens before the pull request, which is why the checkbox is phrased the way
it is.
