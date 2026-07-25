# faceit-elo-bot

Cloudflare Worker exposing FACEIT CS2 elo / peak elo as JSON endpoints for Twitch chat bots (Nightbot, StreamElements).

## Endpoints

All data routes are `GET` and respond with JSON.

`GET /` returns a small HTML guide page (usage overview); the data routes are below.

Every player-taking route accepts **either a FACEIT nickname or a player_id** (the stable UUID that never changes). Inputs matching the UUID shape are treated as a player_id; everything else as a nickname.

### `/elo` — current elo/level + rolling-window stats

| Param     | Required | Default | Description |
|-----------|----------|---------|-------------|
| `query`   | no       | —       | Raw command args. Exactly one token is used as the player (nickname or player_id); empty or 2+ tokens fall back to `default`. Case-sensitive. Supports an inline window — see below. |
| `default` | no       | —       | Fallback player when `query` has no usable token (e.g. the streamer's nick for argument-less calls). |
| `h`       | no       | `12`    | Rolling window in hours for elo +/- and W/L. Clamped to `[1, 720]`. An inline `nick:h` in `query` takes precedence. |

The `query` token may carry an inline hours override, `<nick>:<h>`. Inline parts win over the `default` / `h` params; empty parts fall back to them:

| `query` | Resolves to |
|---------|-------------|
| `nick:24` | nick, 24h |
| `nick` or `nick:` | nick, `h` param (or 12) |
| `:24` | `default` nick, 24h |
| `:` or empty | `default` nick, `h` param (or 12) |
| `game`    | no       | `cs2`   | FACEIT game id. Window stats are computed only for `cs2`; other games return elo/level with the window zeroed. |

Response:
```json
{ "nickname": "...", "elo": 2450, "level": 9,
  "window": { "hours": 12, "elo": 37, "win": 4, "lose": 2, "eloStr": "+37", "kd": 1.08 } }
```
`window.hours` is the window actually **covered**, or `0` if the (undocumented) stats endpoint could not be reached. It can be smaller than the requested `h`: match history is paged in 100 at a time and capped at 5 pages, so a very wide window on a very active account may be truncated — in that case `window.hours` reports the real span instead of the requested one. `window.kd` is the combined kills/deaths across the window's matches.

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
npx wrangler secret put FACEIT_KEY   # FACEIT Data API key
npx wrangler secret put FA_KEY       # Faceit Analyser API key (only needed for /maxelo)
npx wrangler deploy
```

For local development, copy the secrets template and fill it in. [`.dev.vars`](https://developers.cloudflare.com/workers/configuration/secrets/#local-development-with-secrets) is git-ignored:

```sh
cp .dev.vars.example .dev.vars   # then edit the values
npm run dev
```

## Chat commands

Endpoints return JSON, so parse it with `$(urlfetch json ...)` + `$(eval)`. Replace
`https://<your-worker>.workers.dev` with your Worker URL and `<nickname>` with the streamer's FACEIT nick.

Nightbot:
```
!addcom !elo $(eval const a = $(urlfetch json https://<your-worker>.workers.dev/elo?query=$(querystring)&default=<nickname>&h=12); a.error ? a.error : a.nickname + ' • ELO: ' + a.elo + ' • LVL: ' + a.level + ' • ' + a.window.hours + 'h: ' + a.window.eloStr + ' [' + a.window.win + 'W/' + a.window.lose + 'L] • K/D ' + a.window.kd)
!addcom !maxelo $(eval const a = $(urlfetch json https://<your-worker>.workers.dev/maxelo?query=$(querystring)&default=<nickname>); a.error ? a.error : a.nickname + ' • Peak ELO: ' + a.maxelo)
```

Argument-less calls (`!elo`) resolve to `<nickname>`; `!elo someplayer` looks up that player instead.

## Notes / caveats

- The `/elo` rolling-window stats (`window.*`) come from an **undocumented** FACEIT endpoint. If it breaks, elo/level still return and the window degrades to zeros (`window.hours` becomes `0`). It serves at most 100 matches per page (a larger `size` is ignored), so wide windows are paged in — up to 5 pages, which bounds the response time.
- `/maxelo` depends on [Faceit Analyser](https://faceitanalyser.com/) (`highest_elo` field). History may be incomplete for rarely-tracked players, and the free tier is limited to ~5000 requests/month.
- Successful responses are edge-cached (`/elo` 30s, `/maxelo` 1h, `/playerid` 10m) to spare the upstream APIs. The cache is per-datacenter and errors are never cached, so data can lag by up to the route's TTL.

## Author

redins1de — [twitch.tv/redins1de](https://www.twitch.tv/redins1de) · [t.me/redinside](https://t.me/redinside)

## License

[MIT](LICENSE)
