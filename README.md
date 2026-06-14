# faceit-elo-bot

Cloudflare Worker exposing FACEIT CS2 elo / peak elo as JSON endpoints for Twitch chat bots (Nightbot, StreamElements).

## Endpoints

All data routes are `GET` and respond with JSON.

`GET /` returns a small HTML guide page (usage overview); the data routes are below.

Every player-taking route accepts **either a FACEIT nickname or a player_id** (the stable UUID that never changes). Inputs matching the UUID shape are treated as a player_id; everything else as a nickname.

### `/elo` — current elo/level + rolling-window stats

| Param     | Required | Default | Description |
|-----------|----------|---------|-------------|
| `query`   | no       | —       | Raw command args. Exactly one token is used as the player (nickname or player_id); empty or 2+ tokens fall back to `default`. Case-sensitive. |
| `default` | no       | —       | Fallback player when `query` has no usable token (e.g. the streamer's nick for argument-less calls). |
| `h`       | no       | `12`    | Rolling window in hours for elo +/- and W/L. Clamped to `[1, 168]`. |
| `game`    | no       | `cs2`   | FACEIT game id. Window stats are computed only for `cs2`; other games return elo/level with the window zeroed. |

Response:
```json
{ "nickname": "...", "elo": 2450, "level": 9,
  "window": { "hours": 12, "elo": 37, "win": 4, "lose": 2, "eloStr": "+37" } }
```
`window.hours` is the window actually used, or `0` if the (undocumented) stats endpoint could not be reached.

### `/maxelo` — all-time highest elo (via Faceit Analyser)

| Param     | Required | Default | Description |
|-----------|----------|---------|-------------|
| `query`   | no       | —       | Player (nickname or player_id); empty or 2+ tokens fall back to `default`. Case-sensitive. |
| `default` | no       | —       | Fallback player when `query` has no usable token. |
| `game`    | no       | `cs2`   | Game id passed to Faceit Analyser. Supported: `cs2`, `csgo`, `dota2`, `ow2`, `deadlock`. |

Response:
```json
{ "nickname": "...", "maxelo": 2680 }
```
On failure: `{ "error": "<message>" }`.

A `player_id` is resolved to a nickname via the Data API before querying Faceit Analyser (one extra call, needs `FACEIT_KEY`).

### `/playerid` — resolve a nickname to its stable player_id

| Param     | Required | Default | Description |
|-----------|----------|---------|-------------|
| `query`   | no       | —       | Nickname (single token); empty or 2+ tokens fall back to `default`. |
| `default` | no       | —       | Fallback player for argument-less calls. |

Response: `{ "nickname": "...", "player_id": "..." }`

## Setup

```sh
npm install
wrangler secret put FACEIT_KEY   # FACEIT Data API key
wrangler secret put FA_KEY       # Faceit Analyser API key (only needed for /maxelo)
wrangler deploy
```

Local development uses [`.dev.vars`](https://developers.cloudflare.com/workers/configuration/secrets/#local-development-with-secrets) for secrets (git-ignored):

```sh
npm run dev
```

## Chat commands

Endpoints return JSON, so parse it with `$(urlfetch json ...)` + `$(eval)`. Replace
`https://<your-worker>.workers.dev` with your Worker URL and `<nickname>` with the streamer's FACEIT nick.

Nightbot:
```
!addcom !elo $(eval const a = $(urlfetch json https://<your-worker>.workers.dev/elo?query=$(querystring)&default=<nickname>&h=12); a.error ? a.error : a.nickname + ' • ELO: ' + a.elo + ' • LVL: ' + a.level + ' • ' + a.window.hours + 'h: ' + a.window.eloStr + ' [' + a.window.win + 'W/' + a.window.lose + 'L]')
!addcom !maxelo $(eval const a = $(urlfetch json https://<your-worker>.workers.dev/maxelo?query=$(querystring)&default=<nickname>); a.error ? a.error : 'Peak ELO: ' + a.maxelo)
```

Argument-less calls (`!elo`) resolve to `<nickname>`; `!elo someplayer` looks up that player instead.

## Notes / caveats

- The `/elo` rolling-window stats (`window.*`) come from an **undocumented** FACEIT endpoint. If it breaks, elo/level still return and the window degrades to zeros (`window.hours` becomes `0`).
- `/maxelo` depends on [Faceit Analyser](https://faceitanalyser.com/) (`highest_elo` field). History may be incomplete for rarely-tracked players, and the free tier is limited to ~5000 requests/month.

## License

[MIT](LICENSE)
