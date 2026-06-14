/**
 * FACEIT elo worker for Nightbot/StreamElements chat commands.
 *
 * Author: redins1de — https://www.twitch.tv/redins1de | https://t.me/redinside
 *
 * Routes (GET):
 *   /                   HTML guide page (usage overview).
 *   /elo                Current elo/level + rolling-window stats.
 *   /maxelo             All-time highest elo (via Faceit Analyser API).
 *   /playerid           Resolve a nickname to its stable FACEIT player_id.
 *
 * Player identifier: every route that takes a player accepts EITHER a FACEIT
 * nickname OR a player_id (the stable UUID that never changes). Inputs matching
 * the UUID shape are treated as a player_id; everything else as a nickname.
 *
 * All routes respond with JSON.
 *
 * Shared query params (/elo, /maxelo, /playerid):
 *   query   (optional) Raw command args. Exactly one token is used as the
 *                      player (nickname or player_id). Case-sensitive. Empty or
 *                      2+ tokens -> fall back to `default`.
 *   default (optional) Fallback player when `query` has no usable token
 *                      (e.g. streamer's nick for argument-less command calls).
 *
 * /elo extra params:
 *   h       (optional) Rolling window in hours for elo +/- and W/L.
 *                      Default 12, clamped to [1, 168].
 *   game    (optional) FACEIT game id (e.g. "cs2", "csgo"). Default "cs2".
 *                      Rolling-window stats (window.*) only computed for cs2;
 *                      other games return elo/level with window.* zeroed.
 *
 * /elo success:
 *   { nickname, elo, level, window: { hours, elo, win, lose, eloStr } }
 *   window.hours is the window actually used, or 0 if it could not be computed.
 *
 * /maxelo: uses the shared query/default params (nickname or player_id).
 *
 * /maxelo extra params:
 *   game    (optional) Game id passed to Faceit Analyser. Default "cs2".
 *                      Supported: cs2, csgo, dota2, ow2, deadlock.
 *
 * /maxelo response: one of:
 *   { nickname, maxelo }  all-time highest elo (Faceit Analyser highest_elo)
 *   { error: "<msg>" }    on any failure
 *
 * /playerid response: { nickname, player_id }
 *
 * Error (any route): { error: "<human-readable message>" }.
 *
 * Notes:
 *   - /elo window stats come from an UNDOCUMENTED FACEIT endpoint; if it
 *     breaks, elo/level still return and window.* degrade to zeros.
 *   - /maxelo uses Faceit Analyser (highest_elo field); its history may be
 *     incomplete for rarely-tracked players. Free tier: 5000 req/month.
 *     Faceit Analyser keys on nickname, so a player_id is resolved to a
 *     nickname first (one extra Data API call, needs FACEIT_KEY).
 *   - Requires secret FACEIT_KEY. /maxelo additionally requires secret FA_KEY
 *     (Settings -> Variables and Secrets).
 *   - Successful data responses are edge-cached per route (see CACHE_TTL) to
 *     spare the upstream APIs / rate limits. Cache is per-colo; errors are not
 *     cached. Expect data to lag by up to the route's TTL.
 */
const DEFAULT_HOURS = 12;

// Edge-cache TTL per route (seconds). Spares the upstream APIs / rate limits.
// Cache is per-colo; errors are never cached (they set Cache-Control: no-store).
const CACHE_TTL = { "/elo": 30, "/maxelo": 3600, "/playerid": 86400 };

// FACEIT player_id is a UUID; nicknames never match this shape.
const PLAYER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isPlayerId = (s) => PLAYER_ID_RE.test(s);

// Resolve player token: exactly one query token, else `default`. null if neither.
function resolveNick(url) {
  const tokens = (url.searchParams.get("query") || "").trim().split(/\s+/).filter(Boolean);
  const fallback = (url.searchParams.get("default") || "").trim();
  return (tokens.length === 1 ? tokens[0] : fallback) || null;
}

// Look up a player by nickname OR player_id via the official Data API.
// Returns { player } on success, or { error: Response } to short-circuit.
async function lookupPlayer(id, env, err) {
  const apiUrl = isPlayerId(id)
    ? `https://open.faceit.com/data/v4/players/${id}`
    : `https://open.faceit.com/data/v4/players?nickname=${encodeURIComponent(id)}`;
  const pr = await fetch(apiUrl, { headers: { Authorization: `Bearer ${env.FACEIT_KEY}` } });
  if (pr.status === 404) return { error: err(`Player "${id}" not found`) };
  if (!pr.ok) return { error: err(`FACEIT API error: ${pr.status}`) };
  return { player: await pr.json() };
}

// ---- /elo : current elo/level + rolling-window stats ----------------------
async function handleElo(url, env, err) {
  const nick = resolveNick(url);
  if (!nick) return err("No nickname provided and no default set");

  // explicit h clamps to [1,168] (h=0 / h=-5 -> 1); missing/blank -> default
  const hRaw = url.searchParams.get("h");
  const hours = hRaw ? Math.min(168, Math.max(1, Number(hRaw) || 1)) : DEFAULT_HOURS;
  const game = (url.searchParams.get("game") || "cs2").trim().toLowerCase() || "cs2";

  const { player: p, error } = await lookupPlayer(nick, env, err);
  if (error) return error;

  const g = p.games?.[game];
  if (!g) return err(`${p.nickname}: no ${game.toUpperCase()} profile`);

  const out = {
    nickname: p.nickname,
    elo: g.faceit_elo,
    level: g.skill_level,
    window: { hours: 0, elo: 0, win: 0, lose: 0, eloStr: "0" },
  };

  // Rolling-window stats from undocumented endpoint; best-effort.
  // window.hours stays 0 unless the window was actually computed.
  if (game === "cs2") {
    try {
      const sr = await fetch(
        `https://api.faceit.com/stats/v1/stats/time/users/${p.player_id}/games/cs2?page=0&size=100`,
        { headers: { "User-Agent": "Mozilla/5.0" } }
      );
      if (sr.ok) {
        const matches = await sr.json();          // newest first
        const start = Date.now() - hours * 3600_000;
        const recent = matches.filter(m => m.date >= start);

        out.window.win = recent.filter(m => m.i10 === "1").length;
        out.window.lose = recent.length - out.window.win;

        if (recent.length) {
          // baseline = elo after the last match BEFORE the window
          const prev = matches.find(m => m.date < start && m.elo);
          const baseline = prev?.elo ?? recent[recent.length - 1]?.elo;
          if (baseline) out.window.elo = out.elo - Number(baseline);
        }
        out.window.eloStr = out.window.elo > 0 ? `+${out.window.elo}` : String(out.window.elo);
        out.window.hours = hours;
      }
    } catch (e) { /* leave window.* zeroed (hours stays 0) */ }
  }

  return Response.json(out);
}

// ---- /maxelo : all-time highest elo (Faceit Analyser) ---------------------
// Takes query/default like /elo (nickname or player_id). JSON: { maxelo } or
// { error }. Faceit Analyser keys on nickname, so a player_id is resolved to a
// nickname via the Data API first.
async function handlePeak(url, env, err) {
  let nick = resolveNick(url);
  if (!nick) return err("No nickname provided and no default set");
  if (!env.FA_KEY) return err("Peak lookup not configured (missing FA_KEY)");

  const game = (url.searchParams.get("game") || "cs2").trim().toLowerCase() || "cs2";

  // Faceit Analyser needs a nickname; turn a player_id into one first.
  if (isPlayerId(nick)) {
    const { player, error } = await lookupPlayer(nick, env, err);
    if (error) return error;
    nick = player.nickname;
  }

  const sr = await fetch(
    `https://faceitanalyser.com/api/stats/${encodeURIComponent(nick)}/${encodeURIComponent(game)}?key=${env.FA_KEY}`,
    { headers: { "User-Agent": "Mozilla/5.0" } }
  );
  if (sr.status === 401) return err("Faceit Analyser: invalid API key");
  if (sr.status === 404) return err(`Player "${nick}" not found`);
  if (!sr.ok) return err(`Faceit Analyser error: ${sr.status}`);

  const s = await sr.json();          // global segment object (flat)
  const maxelo = Number(s.highest_elo);
  if (!maxelo) return err(`${nick}: no peak elo data`);

  return Response.json({ nickname: nick, maxelo });
}

// ---- /playerid : resolve nickname (or player_id) to the stable player_id ---
async function handlePlayerId(url, env, err) {
  const id = resolveNick(url);
  if (!id) return err("No nickname provided and no default set");

  const { player: p, error } = await lookupPlayer(id, env, err);
  if (error) return error;

  return Response.json({ nickname: p.nickname, player_id: p.player_id });
}

// ---- / : human-readable guide page ----------------------------------------
function handleHome(url) {
  const b = url.origin;
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>faceit-elo-bot</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 680px; margin: 2rem auto; padding: 0 1rem; }
  h1 { margin-bottom: .2rem; }
  p.sub { margin-top: 0; opacity: .7; }
  code { background: rgba(127,127,127,.18); padding: .1em .35em; border-radius: 4px; }
  .ep { margin: 1.4rem 0; padding-left: 1rem; border-left: 3px solid rgba(127,127,127,.35); }
  .ep h2 { margin: 0 0 .3rem; font-size: 1.05rem; }
  table { border-collapse: collapse; margin: .4rem 0; font-size: .92em; }
  td, th { text-align: left; padding: .15rem .8rem .15rem 0; vertical-align: top; }
  a { color: inherit; }
  pre { background: rgba(127,127,127,.14); padding: .7rem .8rem; border-radius: 6px; white-space: pre-wrap; word-break: break-all; font-size: .82em; }
  pre code { background: none; padding: 0; }
  footer { margin-top: 2rem; opacity: .75; font-size: .85em; }
  footer a { text-decoration: none; white-space: nowrap; }
  footer a:hover { text-decoration: underline; }
  footer svg { width: 14px; height: 14px; vertical-align: -2px; margin-right: 3px; }
  .sep { opacity: .4; margin: 0 .5rem; }
</style>
<h1>faceit-elo-bot</h1>
<p class="sub">FACEIT CS2 elo / peak elo as JSON endpoints for Twitch chat bots.</p>
<p>All routes respond with JSON. Every route accepts a FACEIT <strong>nickname</strong> or a <strong>player_id</strong> (the stable UUID that never changes).</p>

<div class="ep">
  <h2>GET /elo</h2>
  <p>Current elo/level + rolling-window stats.</p>
  <table>
    <tr><th>query</th><td>nickname or player_id (single token); falls back to <code>default</code></td></tr>
    <tr><th>default</th><td>fallback player for argument-less calls</td></tr>
    <tr><th>h</th><td>window in hours, 1–168 (default 12)</td></tr>
    <tr><th>game</th><td>FACEIT game id (default cs2)</td></tr>
  </table>
  <p>Example: <a href="${b}/elo?query=redins1de">/elo?query=redins1de</a></p>
</div>

<div class="ep">
  <h2>GET /maxelo</h2>
  <p>All-time highest elo (via Faceit Analyser).</p>
  <table>
    <tr><th>query</th><td>nickname or player_id (single token); falls back to <code>default</code></td></tr>
    <tr><th>default</th><td>fallback player for argument-less calls</td></tr>
    <tr><th>game</th><td>game id (default cs2): cs2, csgo, dota2, ow2, deadlock</td></tr>
  </table>
  <p>Example: <a href="${b}/maxelo?query=redins1de">/maxelo?query=redins1de</a></p>
</div>

<div class="ep">
  <h2>GET /playerid</h2>
  <p>Resolve a nickname to its stable FACEIT player_id.</p>
  <table>
    <tr><th>query</th><td>nickname (single token); falls back to <code>default</code></td></tr>
    <tr><th>default</th><td>fallback player for argument-less calls</td></tr>
  </table>
  <p>Example: <a href="${b}/playerid?query=redins1de">/playerid?query=redins1de</a></p>
</div>

<h2>Nightbot — ready-to-use commands</h2>
<p>Paste into chat, then replace <code>YOUR_NICK</code> with your FACEIT nickname.
Bare <code>!elo</code> shows your stats; <code>!elo someone</code> looks up another player.</p>
<p style="opacity:.7">Tip: drop your <code>player_id</code> in place of the nickname so the command survives a rename — grab it from <a href="${b}/playerid?query=YOUR_NICK">/playerid</a>.</p>
<pre><code>!addcom !elo $(eval const a = $(urlfetch json ${b}/elo?query=$(querystring)&amp;default=YOUR_NICK&amp;h=12); a.error ? a.error : a.nickname + ' • ELO: ' + a.elo + ' • LVL: ' + a.level + ' • ' + a.window.hours + 'h: ' + a.window.eloStr + ' [' + a.window.win + 'W/' + a.window.lose + 'L]')</code></pre>
<pre><code>!addcom !maxelo $(eval const a = $(urlfetch json ${b}/maxelo?query=$(querystring)&amp;default=YOUR_NICK); a.error ? a.error : a.nickname + ' • Peak ELO: ' + a.maxelo)</code></pre>

<h2>Caching</h2>
<p>Successful responses are cached at the edge to spare the upstream APIs:
<code>/elo</code> 30s <span class="sep">·</span> <code>/maxelo</code> 1h <span class="sep">·</span> <code>/playerid</code> 24h.
Errors are never cached. The <code>X-Cache</code> response header shows <code>HIT</code> or <code>MISS</code>.</p>

<footer>
  Made by <strong>redins1de</strong>
  <span class="sep">·</span>
  <a href="https://www.twitch.tv/redins1de"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg>twitch.tv/redins1de</a>
  <span class="sep">·</span>
  <a href="https://t.me/redinside"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.139-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>t.me/redinside</a>
</footer>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const err = (message) => Response.json({ error: message }, { headers: { "Cache-Control": "no-store" } });

    // Read-only API: only GET (and HEAD, which the runtime derives from GET).
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json(
        { error: "Method not allowed. Use GET." },
        { status: 405, headers: { "Allow": "GET", "Access-Control-Allow-Origin": "*" } }
      );
    }

    const path = url.pathname.replace(/\/+$/, ""); // strip trailing slash ("/" -> "")

    // No favicon to serve; answer 204 so browsers stop asking (no 404 noise).
    if (path === "/favicon.ico") return new Response(null, { status: 204 });

    // Serve a fresh copy from the edge cache when we have one.
    const ttl = CACHE_TTL[path];
    const cache = caches.default;
    if (ttl) {
      const hit = await cache.match(request);
      if (hit) {
        // Cached responses have immutable headers; re-wrap to tag the hit.
        const tagged = new Response(hit.body, hit);
        tagged.headers.set("X-Cache", "HIT");
        return tagged;
      }
    }

    try {
      let res;
      if (path === "") res = handleHome(url);
      else if (path === "/elo") res = await handleElo(url, env, err);
      else if (path === "/maxelo") res = await handlePeak(url, env, err);
      else if (path === "/playerid") res = await handlePlayerId(url, env, err);
      else res = Response.json({ error: "Not found. See / for usage." }, { status: 404 });

      // Allow browser-side use (StreamElements widgets, OBS browser source, overlays).
      res.headers.set("Access-Control-Allow-Origin", "*");

      // Cache successful data responses; errors opt out via Cache-Control: no-store.
      if (ttl && res.headers.get("Cache-Control") !== "no-store") {
        res.headers.set("Cache-Control", `public, max-age=${ttl}`);
        ctx.waitUntil(cache.put(request, res.clone())); // store before tagging so the copy stays clean
        res.headers.set("X-Cache", "MISS");
      }
      return res;
    } catch (e) {
      // Keep the "always JSON" contract even on unexpected failures
      // (upstream network error, malformed response, etc.).
      return Response.json(
        { error: `Internal error: ${e.message}` },
        { status: 500, headers: { "Access-Control-Allow-Origin": "*" } }
      );
    }
  }
};
