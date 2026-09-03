# @antseed/router-levanto

The `routing-client` half of Levanto's model-routing subscription (public side —
see `docs/model-routing-*.md` at the repo root for the full design; the
routing-server's actual ranking/pricing logic lives in the separate, private
`levanto-routing-server` repo, not here).

Implements `Router.selectRoute` — declines immediately for any concretely-chosen
model, and for the `levanto-auto` sentinel, calls out to the configured routing
peer's `/_antseed/route` endpoint and returns its ranked candidates.

## Config

- `LEVANTO_ROUTING_PEER_URL` — base URL of the routing peer, e.g.
  `http://127.0.0.1:8787`.

## Status

Thin slice: routing call + candidate mapping only. Payment signing, the
new-user-message gate, the local ledger, and the catch-up burst land in later
passes — see the repo's task list / `docs/model-routing-runlog.md`.
