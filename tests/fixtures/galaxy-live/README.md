# Recorded Galaxy responses for the live history panel

Real responses, fetched anonymously from public Galaxy servers on 2026-09-18 and
reformatted by prettier. Nothing here is hand-written, and nothing here belongs
to a Loom user: every history is one its owner published.

Each pair is exactly the two requests `galaxy-live-source.ts` makes:

```
GET /api/histories/{id}?keys=name,update_time,state,contents_active
GET /api/histories/{id}/contents?v=dev&q=deleted&qv=False&q=visible&qv=True&order=hid-dsc&limit=201
```

| pair          | server                                           | what it is                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `midrun`      | usegalaxy.org.au `6f608228bd012a10`              | genuinely mid-run: 2 running, 1 failed, 18 finished. Also the shortest id we have, 16 hex characters                                                                                                                                                                                                        |
| `collections` | usegalaxy.org `bbd44e69cb8906b5988ab58ce61eee92` | 67 rows, 23 of them collections. The reason the header counts rows instead of Galaxy's histogram: the same history's `contents_states` says `{error: 10, ok: 57}` while the rows say `{error: 19, ok: 48}`, because a collection is scored by its own state and the row under it by the worst job inside it |
| `paused`      | usegalaxy.org.au `8a5202cb1d990bf9`              | a paused dataset, which is a state neither success nor failure                                                                                                                                                                                                                                              |
| `empty`       | usegalaxy.org `bbd44e69cb8906b52c9873e5f915df9f` | no datasets at all, and a non-ASCII history name                                                                                                                                                                                                                                                            |

Two cases are built in the tests rather than recorded, because they cannot be
recorded honestly: a history large enough to truncate (committing a 5,000-row
response to make one assertion is not worth the megabytes) and hostile dataset
names (no public server is serving `<img src=x onerror=...>` as a dataset name,
and we are not going to upload one to make a point). Both are constructed from
the recorded rows so the shape around them stays real.

Error statuses are asserted against `GalaxyApiError`, not recorded bodies. As
measured against usegalaxy.org on the same day: a bogus `x-api-key` on a
published history is `401 {"err_msg":"Provided API key is not valid."}`, a
well-formed but unknown hex id is `400 "Wrong id ... unable to decode"`, and a
`.` id is the interesting one -- see the id-guard test.
