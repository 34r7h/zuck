# Zuck — the meta model manager

Bring a job. Zuck asks what it does not know yet (who, platform,
must-haves, look, limits, what done looks like — answer, skip, or say
"just plan it") until nothing is unknown. Then it plans goals, tasks,
and subtasks, with gates (a task waits until its dependencies are done)
and parallel groups (independent tasks run together), each task assigned
a Meta model at a level of effort — Spark for text at light, standard,
or deep, Wonder for the hardest planning and review, Image for pictures,
SAM 3.1 for vision, and you for the calls only a human makes. Then it
runs the plan until it is done.

Runs are asynchronous: model calls take longer than a request handler
should block, so a run starts in the background and the page watches
tasks land. A run never pretends a model ran.

## The honest parts

- Model tasks need the visitor's own Meta Model API key, sent with the
  run call only. Zuck never stores it, logs it, or puts it in a process
  argument list (it travels in a 0600 temp curl config file, deleted
  after the call). No key means tasks wait with their briefs ready.
  A bad key surfaces Meta's own error.
- Image and SAM have no verified endpoint in v1, so with a key they
  produce the exact prompt / segmentation spec via Spark, labeled SPEC.
  The artifact itself still needs its own Image / SAM run.
- Only Wonder's model id (`muse-wonder-1.0`) is verified against
  Meta's API; the Spark / Image / SAM ids follow the same naming
  pattern and are shown on every task card.
- Sign in with handoff to save projects to your account and pick up
  where you left off. Project links (`?pid=...`) also reopen a project
  directly. Note: handoff's authorize step currently refuses this
  client's redirects platform-wide (proven live on Cricket's own
  sign-in button too), so sign-in lights up again when the platform
  allows it; the save/exit machinery is otherwise complete.

## Layout

- `app/index.html` — the miniapp bundle (published to handoff.lol).
- `server/zuck-server.mjs` — the backend, served through the handoff
  universal app server as app `zuck`. State: `zuck_state.json`,
  sessions: `zuck_sessions.json` (server-side only, never in the repo).
- `tests/zuck-audit.mjs` — interaction audit against a throwaway
  test server (`ZUCK_TEST=1 ZUCK_PORT=8105 node server/zuck-server.mjs`)
  and a test page built from `app/index.html` with `callU` rewritten
  to call the test server directly.

Live (interim, published as amuse until the zuck agent's key exists):
https://handoff.lol/app/amuse/zuck
