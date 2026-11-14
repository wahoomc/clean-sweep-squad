// Clean Sweep Squad — family sync server (Cloudflare Pages Function + D1)
// Every device reads and writes the same scoreboard through these routes:
//   GET  /api/roster        who can log in (names, colors, emblems)
//   POST /api/setup         first run only: Dad picks a PIN, squad is created
//   POST /api/login         name + 4-digit PIN -> device token
//   POST /api/logout
//   GET  /api/state         the shared game (needs a token)
//   POST /api/act           one game action (claim, buy, approve, adjust, config, ...)
//   POST /api/pin           a parent sets anyone's PIN
// Needs a D1 database bound to the project with the variable name DB.

const TZ = "America/Indiana/Indianapolis";
const PARENTS = [
  { id: "dad", name: "Dad", color: "#1d2a4a", emblem: "shield" },
  { id: "mom", name: "Mom", color: "#f5487f", emblem: "heart" },
];
const AREAS = ["Upstairs", "Downstairs", "Outside"];
const LOCK_AFTER = 5, LOCK_MS = 10 * 60 * 1000;
const SESSION_DAYS = 365;
const LOG_MAX = 300;

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (msg, status = 400) => json({ error: msg }, status);
class Oops extends Error { constructor(m, s = 400) { super(m); this.status = s; } }

function today() {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return g("year") + "-" + g("month") + "-" + g("day");
}
function motd(S) {
  const on = S.chores.filter(c => !c.off);
  let h = 0; for (const ch of today()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return on.length ? on[h % on.length] : null;
}
const doneKey = (kid, ch) => today() + "|" + kid + "|" + ch;

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function pinHash(salt, pin) { let h = salt + ":" + pin; for (let i = 0; i < 300; i++) h = await sha(h); return h; }
const randHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(x => x.toString(16).padStart(2, "0")).join("");

let ready = false;
async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1)"),
    db.prepare("CREATE TABLE IF NOT EXISTS sessions (h TEXT PRIMARY KEY, user TEXT NOT NULL, created INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS fails (user TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)"),
  ]);
  ready = true;
}
async function getKV(db, k) {
  const r = await db.prepare("SELECT v, rev FROM kv WHERE k = ?").bind(k).first();
  return r ? { v: JSON.parse(r.v), rev: r.rev } : null;
}

// ---------- one-time chore update: the family whiteboard list (Nov 2026) ----------
// Adds these missions (switched on, assigned by kid name), updates any with the same name,
// and switches off the older missions they replace. Runs once per squad, then never again.
const WHITEBOARD = [
  ["Dry mop downstairs", 15, "Downstairs", "William"],
  ["Wet mop downstairs", 20, "Downstairs", "Isabella"],
  ["Sweep kitchen, bathroom & back room", 15, "Downstairs", "Margaret"],
  ["Wet mop kitchen, bathroom & back room", 20, "Downstairs", "Isabella"],
  ["Dust living room", 10, "Downstairs", "Margaret"],
  ["Dust dining room", 10, "Downstairs", "Margaret"],
  ["Wash front door & fridge", 15, "Downstairs", "William"],
  ["Wash light switches", 10, "Downstairs", "William"],
  ["Wash doorknobs", 10, "Downstairs", "Isabella"],
  ["Upstairs bathroom sink", 10, "Upstairs", "Margaret"],
  ["Downstairs bathroom sink & outside of toilet", 15, "Downstairs", "William"],
  ["Clean inside both toilets", 20, "Downstairs", "Isabella"],
  ["Change sheets", 15, "Upstairs", "Isabella"],
  ["Fold clothes", 10, "Upstairs", "Isabella"],
  ["Homework", 10, "Downstairs", "Margaret"],
  ["Change sheets", 15, "Upstairs", "William"],
];
const WHITEBOARD_REPLACES = ["Clean the door knobs", "Clean the downstairs toilet", "Clean the upstairs toilet", "Clean the bathroom sink", "Fold a load of laundry"];
let whiteboardDone = false;
async function addWhiteboard(db) {
  if (whiteboardDone) return;
  const st = await getKV(db, "state");
  if (!st) return; // squad not set up yet; try again on a later request
  const S = st.v;
  if (S.whiteboard1) { whiteboardDone = true; return; }
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const kidId = n => (S.kids.find(k => norm(k.name) === norm(n)) || {}).id || null;
  const ids = new Set(S.chores.map(c => c.id));
  WHITEBOARD.forEach(([name, xp, area, who], i) => {
    const kid = kidId(who);
    const same = S.chores.find(c => norm(c.name) === norm(name) && (!c.kid || c.kid === kid));
    if (same) { same.kid = kid; same.area = area; same.off = false; return; }
    let id = "wb" + (i + 1); while (ids.has(id)) id += "x"; ids.add(id);
    S.chores.push({ id, name, xp, area, kid, off: false });
  });
  for (const c of S.chores) if (WHITEBOARD_REPLACES.some(n => norm(n) === norm(c.name))) c.off = true;
  S.whiteboard1 = true;
  const r = await db.prepare("UPDATE kv SET v = ?, rev = rev + 1 WHERE k = 'state' AND rev = ?").bind(JSON.stringify(S), st.rev).run();
  if (r.meta.changes === 1) whiteboardDone = true; // otherwise someone saved at the same moment; retry next request
}

// ---------- cleaning what browsers send ----------
const str = (s, max) => String(s ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, max);
const int = (n, lo, hi, d) => { n = Math.round(+n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const color = c => /^#[0-9a-f]{6}$/i.test(c) ? c : "#3b82f6";
const emblem = e => /^[a-z]{1,20}$/.test(e) ? e : "star";
const idOf = s => str(s, 40).replace(/[^\w-]/g, "") || "x" + randHex(4);

function cleanChores(list, kidIds) {
  return (Array.isArray(list) ? list : []).slice(0, 120).map(c => ({
    id: idOf(c.id), name: str(c.name, 60) || "Mission", xp: int(c.xp, 1, 200, 10),
    area: AREAS.includes(c.area) ? c.area : "Downstairs", kid: kidIds.includes(c.kid) ? c.kid : null, off: !!c.off,
  }));
}
function cleanRewards(list) {
  return (Array.isArray(list) ? list : []).slice(0, 80).map(r => ({ id: idOf(r.id), name: str(r.name, 60) || "Reward", cost: int(r.cost, 1, 999, 50) }));
}
function cleanKidLooks(k, src) {
  k.name = str(src.name, 30) || k.name; k.color = color(src.color); k.emblem = emblem(src.emblem);
}
function freshState(src) {
  const kids = (Array.isArray(src?.kids) ? src.kids : []).slice(0, 8).map((k, i) => ({
    id: idOf(k.id || "k" + i), name: str(k.name, 30) || "Cadet " + (i + 1), color: color(k.color), emblem: emblem(k.emblem),
    xp: int(k.xp, 0, 1e6, 0), stars: int(k.stars, -1e6, 1e6, 0), missions: int(k.missions, 0, 1e6, 0),
    x2: int(k.x2, 0, 1e6, 0), bought: int(k.bought, 0, 1e6, 0),
  }));
  if (!kids.length) throw new Oops("No cadets found");
  const ids = kids.map(k => k.id);
  let seq = 0;
  const log = (Array.isArray(src?.log) ? src.log : []).slice(0, LOG_MAX).reverse().map(l => ({
    id: ++seq, kid: ids.includes(l.kid) ? l.kid : null, text: str(l.text, 120), d: int(l.d, -1e5, 1e5, 0),
    xp: int(l.xp, 0, 1e5, 0), x2: !!l.x2, buy: !!l.buy,
  })).reverse();
  return { kids, chores: cleanChores(src?.chores, ids), rewards: cleanRewards(src?.rewards), log, done: {}, pending: [], settings: { approve: true }, seq };
}

// ---------- the game rules, enforced here so every device agrees ----------
function grantChore(S, k, name, pts, x2, key, by) {
  k.xp += pts; k.stars += pts; k.missions++; if (x2) k.x2++; S.done[key] = 1;
  S.log.unshift({ id: ++S.seq, kid: k.id, text: `${k.name}: ${name}`, d: pts, xp: pts, key, x2: !!x2, by, at: Date.now() });
}
function grantBuy(S, k, name, cost, by) {
  k.stars -= cost; k.bought++;
  S.log.unshift({ id: ++S.seq, kid: k.id, text: `${k.name} got: ${name}`, d: -cost, xp: 0, buy: true, by, at: Date.now() });
}
const pendingCost = (S, kid) => S.pending.filter(p => p.kid === kid && p.type === "buy").reduce((a, p) => a + p.cost, 0);

// ---------- Chore Day games: a parent picks the chores and the game, kids win the chores ----------
// Draft: snake order, random first pick. Auction: lowest bid wins, floor is half price.
// Rising bounty: first come, first served, and untaken chores gain 2 stars every 10 minutes.
// Every chore won goes into that kid's required list ("orders") at the stars they won it for ("deals").
const OPEN_MS = 30000, BID_MS = 15000, BOUNTY_EVERY = 10 * 60 * 1000;
const kidName = (S, id) => (S.kids.find(k => k.id === id) || {}).name || "someone";
const snakeKid = g => { const n = g.order.length, r = Math.floor(g.turn / n), i = g.turn % n; return r % 2 ? g.order[n - 1 - i] : g.order[i]; };
const bountyPrice = (g, c, now) => Math.min(c.xp * 2, c.xp + 2 * Math.floor(Math.max(0, now - g.started) / BOUNTY_EVERY));
function finishGame(g, now) { g.status = "done"; g.lot = null; g.ended = now; }
function winChore(S, g, choreId, kid, stars, now) {
  g.pool = g.pool.filter(id => id !== choreId);
  S.orders = S.orders || {}; S.deals = S.deals || {};
  const l = S.orders[kid] || []; if (!l.includes(choreId)) l.push(choreId); S.orders[kid] = l;
  S.deals[kid + "|" + choreId] = stars;
  const c = S.chores.find(c => c.id === choreId); if (c) c.off = false;
  g.results.push({ chore: choreId, kid, stars, at: now });
  if (!g.pool.length && g.mode !== "auction") finishGame(g, now);
}
function nextLot(S, g, now) {
  while (g.pool.length && !S.chores.some(c => c.id === g.pool[0])) g.pool.shift();
  if (!g.pool.length) { finishGame(g, now); return; }
  const c = S.chores.find(c => c.id === g.pool[0]);
  g.lot = { chore: c.id, start: c.xp, price: c.xp, leader: null, ends: now + OPEN_MS, bids: 0 };
}
// Auctions run on a clock, so every request first settles any lot whose time ran out.
function gameTick(S, now) {
  const g = S.game; if (!g || g.status !== "live" || g.mode !== "auction") return false;
  let changed = false, guard = 0;
  while (g.lot && now >= g.lot.ends && guard++ < 200) {
    const lot = g.lot, at = lot.ends;
    if (lot.leader) winChore(S, g, lot.chore, lot.leader, lot.price, at);
    else { g.pool = g.pool.filter(id => id !== lot.chore); g.unsold.push(lot.chore); }
    g.lot = null; nextLot(S, g, at); changed = true;
  }
  return changed;
}

function apply(S, me, a) {
  const isParent = me.role === "parent";
  const needParent = () => { if (!isParent) throw new Oops("Only Mom or Dad can do that", 403); };
  const kidFor = id => {
    const kid = isParent ? id : me.id;
    if (!isParent && id && id !== me.id) throw new Oops("You can only claim your own missions", 403);
    const k = S.kids.find(k => k.id === kid); if (!k) throw new Oops("Pick a cadet");
    return k;
  };
  switch (a.type) {
    case "claim": {
      const k = kidFor(a.kid), c = S.chores.find(c => c.id === a.chore);
      if (!c || c.off) throw new Oops("That mission isn't available right now");
      if (c.kid && c.kid !== k.id && !((S.orders || {})[k.id] || []).includes(c.id)) throw new Oops("That mission belongs to someone else");
      const key = doneKey(k.id, c.id);
      if (S.done[key]) throw new Oops(S.done[key] === "p" ? "Already waiting for approval" : "Already done today. Try again tomorrow!");
      const deal = (S.deals || {})[k.id + "|" + c.id], m = motd(S), x2 = deal == null && !!a.x2 && m && m.id === c.id, pts = deal != null ? deal : c.xp * (x2 ? 2 : 1);
      if (!isParent && S.settings.approve) {
        S.pending.push({ id: "p" + (++S.seq), type: "chore", kid: k.id, chore: c.id, name: c.name, pts, x2, key, at: Date.now() });
        S.done[key] = "p";
        return { status: "pending", pts, x2 };
      }
      grantChore(S, k, c.name, pts, x2, key, isParent ? me.name : null);
      return { status: "awarded", pts, x2 };
    }
    case "buy": {
      const k = kidFor(a.kid), r = S.rewards.find(r => r.id === a.reward);
      if (!r) throw new Oops("That reward isn't in the store anymore");
      if (k.stars - pendingCost(S, k.id) < r.cost) throw new Oops("Not enough stars yet. Keep going!");
      if (!isParent && S.settings.approve) {
        S.pending.push({ id: "p" + (++S.seq), type: "buy", kid: k.id, reward: r.id, name: r.name, cost: r.cost, at: Date.now() });
        return { status: "pending", cost: r.cost };
      }
      grantBuy(S, k, r.name, r.cost, isParent ? me.name : null);
      return { status: "awarded", cost: r.cost };
    }
    case "approve": case "deny": {
      needParent();
      const i = S.pending.findIndex(p => p.id === a.id); if (i < 0) throw new Oops("Someone already handled that one");
      const [p] = S.pending.splice(i, 1), k = S.kids.find(k => k.id === p.kid);
      if (!k) return { status: "gone" };
      if (a.type === "deny") {
        if (p.key) delete S.done[p.key];
        S.log.unshift({ id: ++S.seq, kid: k.id, text: `${k.name}: ${p.name} (not yet)`, d: 0, xp: 0, no: true, by: me.name, at: Date.now() });
        return { status: "denied" };
      }
      if (p.type === "chore") grantChore(S, k, p.name, p.pts, p.x2, p.key, me.name);
      else { if (k.stars < p.cost) throw new Oops(`${k.name} doesn't have enough stars anymore`); grantBuy(S, k, p.name, p.cost, me.name); }
      return { status: "approved" };
    }
    case "config": {
      needParent();
      const c = a.config || {}, ids = S.kids.map(k => k.id);
      if (Array.isArray(c.kids)) c.kids.forEach(src => { const k = S.kids.find(k => k.id === src.id); if (k) cleanKidLooks(k, src); });
      if (Array.isArray(c.chores)) S.chores = cleanChores(c.chores, ids);
      if (Array.isArray(c.rewards)) S.rewards = cleanRewards(c.rewards);
      return { status: "saved" };
    }
    case "game_start": {
      needParent();
      const mode = ["draft", "auction", "bounty"].includes(a.mode) ? a.mode : null; if (!mode) throw new Oops("Pick a game");
      const kids = S.kids.filter(k => (a.kids || []).includes(k.id)).map(k => k.id);
      if (!kids.length) throw new Oops("Pick at least one cadet to play");
      const pool = S.chores.filter(c => (a.chores || []).includes(c.id)).sort((x, y) => y.xp - x.xp || x.name.localeCompare(y.name)).map(c => c.id);
      if (!pool.length) throw new Oops("Pick at least one chore");
      if (a.replace) { S.orders = {}; S.deals = {}; }
      for (const id of pool) S.chores.find(c => c.id === id).off = false;
      const now = Date.now(), order = [...kids];
      for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
      S.game = { id: "g" + (++S.seq), mode, status: "live", by: me.name, started: now, kids, pool, results: [], unsold: [], order, turn: 0, lot: null };
      if (mode === "auction") nextLot(S, S.game, now);
      return { status: "started" };
    }
    case "game_pick": {
      const g = S.game, now = Date.now();
      if (!g || g.status !== "live" || g.mode === "auction") throw new Oops("There's no pick right now");
      const c = S.chores.find(c => c.id === a.chore);
      if (!c || !g.pool.includes(c.id)) throw new Oops("Someone already took that one", 409);
      if (g.mode === "draft") {
        const turnKid = snakeKid(g);
        if (!isParent && me.id !== turnKid) throw new Oops(`It's ${kidName(S, turnKid)}'s pick`, 409);
        winChore(S, g, c.id, turnKid, c.xp, now); g.turn++;
        return { status: "picked", kid: turnKid, stars: c.xp };
      }
      const k = kidFor(a.kid); if (!g.kids.includes(k.id)) throw new Oops(`${k.name} isn't playing this round`);
      const stars = bountyPrice(g, c, now); winChore(S, g, c.id, k.id, stars, now);
      return { status: "grabbed", kid: k.id, stars };
    }
    case "game_bid": {
      const g = S.game, now = Date.now();
      if (!g || g.status !== "live" || g.mode !== "auction" || !g.lot) throw new Oops("Nothing is up for bid right now", 409);
      const k = kidFor(a.kid); if (!g.kids.includes(k.id)) throw new Oops(`${k.name} isn't playing this round`);
      const lot = g.lot, floor = Math.ceil(lot.start / 2), price = int(a.price, 0, 1000, -1);
      if (lot.leader === k.id) throw new Oops(`${k.name} is already winning this one`, 409);
      const max = lot.leader ? lot.price - 1 : lot.start;
      if (max < floor) throw new Oops(`Nobody can go lower than ${floor} stars. ${kidName(S, lot.leader)} has it.`, 409);
      if (price < floor) throw new Oops(`Bids can't go below ${floor} stars`);
      if (price > max) throw new Oops(lot.leader ? `Bid ${max} or less to beat ${kidName(S, lot.leader)}` : `Bid ${max} or less`, 409);
      Object.assign(lot, { price, leader: k.id, ends: now + BID_MS, bids: lot.bids + 1 });
      return { status: "bid", price };
    }
    case "game_skip": {
      needParent();
      const g = S.game, now = Date.now();
      if (!g || g.status !== "live") throw new Oops("No game is running");
      if (g.mode === "draft") { g.turn++; return { status: "skipped" }; }
      if (g.mode === "auction" && g.lot) { g.lot.ends = now; gameTick(S, now); return { status: "closed" }; }
      throw new Oops("Nothing to skip in this game");
    }
    case "game_end": { needParent(); if (S.game && S.game.status === "live") finishGame(S.game, Date.now()); return { status: "ended" }; }
    case "game_close": { needParent(); delete S.game; return { status: "closed" }; }
    case "orders": {
      needParent();
      S.orders = S.orders || {};
      S.deals = S.deals || {};
      if (a.clear) {
        if (a.kid) { delete S.orders[a.kid]; for (const d of Object.keys(S.deals)) if (d.startsWith(a.kid + "|")) delete S.deals[d]; }
        else { S.orders = {}; S.deals = {}; }
        return { status: "cleared" };
      }
      const k = S.kids.find(k => k.id === a.kid); if (!k) throw new Oops("Pick a cadet");
      const c = S.chores.find(c => c.id === a.chore); if (!c) throw new Oops("That mission isn't on the list anymore");
      const list = (S.orders[k.id] || []).filter(id => id !== c.id);
      if (a.on) { list.push(c.id); c.off = false; } else delete S.deals[k.id + "|" + c.id]; // requiring a mission switches it on
      if (list.length) S.orders[k.id] = list; else delete S.orders[k.id];
      return { status: a.on ? "required" : "removed" };
    }
    case "settings": {
      needParent();
      if ("approve" in a) S.settings.approve = !!a.approve;
      return { status: "saved" };
    }
    case "adjust": {
      needParent();
      const k = S.kids.find(k => k.id === a.kid); if (!k) throw new Oops("Pick a cadet");
      let n = int(a.n, 0, 999, 0); if (n < 1) throw new Oops("Type how many stars first");
      const why = str(a.why, 60), note = why ? ` (${why})` : "";
      if (a.mode === "take") {
        n = Math.min(n, k.stars); if (n < 1) throw new Oops(`${k.name} has no stars to take`);
        k.stars -= n;
        S.log.unshift({ id: ++S.seq, kid: k.id, text: `${k.name}: ${me.name} took stars${note}`, d: -n, xp: 0, adj: true, by: me.name, at: Date.now() });
        return { status: "taken", n };
      }
      k.stars += n; k.xp += n;
      S.log.unshift({ id: ++S.seq, kid: k.id, text: `${k.name}: bonus from ${me.name}${note}`, d: n, xp: n, adj: true, by: me.name, at: Date.now() });
      return { status: "given", n };
    }
    case "undo": {
      needParent();
      const l = S.log.shift(); if (!l) throw new Oops("Nothing to undo");
      const k = S.kids.find(k => k.id === l.kid);
      if (k && !l.no) { k.stars -= l.d; k.xp -= l.xp || 0; if (l.xp && !l.adj) k.missions--; if (l.x2) k.x2--; if (l.buy) k.bought--; }
      if (l.key) delete S.done[l.key];
      return { status: "undone", text: l.text };
    }
    case "reset": {
      needParent();
      S.kids.forEach(k => Object.assign(k, { xp: 0, stars: 0, missions: 0, x2: 0, bought: 0 }));
      S.log = []; S.done = {}; S.pending = [];
      return { status: "reset" };
    }
  }
  throw new Oops("Unknown action");
}

// ---------- logins ----------
async function session(db, user) {
  const token = randHex(32);
  await db.prepare("INSERT INTO sessions (h, user, created) VALUES (?, ?, ?)").bind(await sha(token), user, Date.now()).run();
  return token;
}
function whoIs(user, S) {
  const p = PARENTS.find(p => p.id === user); if (p) return { id: p.id, name: p.name, role: "parent" };
  const k = S?.kids.find(k => k.id === user); return k ? { id: k.id, name: k.name, role: "kid" } : null;
}
async function auth(db, request) {
  const t = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!/^[0-9a-f]{64}$/.test(t)) throw new Oops("Please log in", 401);
  const row = await db.prepare("SELECT user, created FROM sessions WHERE h = ?").bind(await sha(t)).first();
  if (!row || Date.now() - row.created > SESSION_DAYS * 864e5) throw new Oops("Please log in", 401);
  const st = await getKV(db, "state"), me = whoIs(row.user, st?.v);
  if (!st || !me) throw new Oops("Please log in", 401);
  return { me, st, hash: await sha(t) };
}
async function stateReply(db, me, st, extra) {
  const out = { rev: st.rev, state: st.v, me, now: Date.now(), ...extra };
  if (me.role === "parent") { const u = await getKV(db, "users"); out.pins = Object.fromEntries(Object.keys(u?.v || {}).map(k => [k, true])); }
  return json(out);
}
async function readBody(request) {
  const t = await request.text(); if (t.length > 200000) throw new Oops("That's too much at once");
  try { return t ? JSON.parse(t) : {}; } catch { throw new Oops("Bad request"); }
}

export async function onRequest({ request, env, params }) {
  const db = env.DB;
  if (!db) return fail("The Squad's database isn't connected yet. A parent needs to add the D1 binding named DB in Cloudflare.", 503);
  const route = (params.path || []).join("/"), method = request.method;
  try {
    await init(db);
    try { await addWhiteboard(db); } catch (e) { console.error("whiteboard update", e); }
    if (route === "roster" && method === "GET") {
      const [st, users] = [await getKV(db, "state"), await getKV(db, "users")];
      if (!st || !users) return json({ setup: false });
      const pins = users.v;
      return json({
        setup: true,
        people: [
          ...st.v.kids.map(k => ({ id: k.id, name: k.name, color: k.color, emblem: k.emblem, role: "kid", hasPin: !!pins[k.id] })),
          ...PARENTS.map(p => ({ ...p, role: "parent", hasPin: !!pins[p.id] })),
        ],
      });
    }
    if (route === "setup" && method === "POST") {
      const b = await readBody(request);
      if (!/^\d{4}$/.test(b.pin || "")) throw new Oops("PIN must be 4 digits");
      if (await getKV(db, "users")) throw new Oops("The Squad is already set up. Log in instead.", 409);
      // A squad that already has progress keeps it (this is how a PIN reset works); otherwise start from this device
      const existing = await getKV(db, "state"), S = existing ? existing.v : freshState(b.state), salt = randHex(16);
      const users = { dad: { salt, hash: await pinHash(salt, b.pin) } };
      try {
        await db.batch([
          db.prepare("INSERT INTO kv (k, v, rev) VALUES ('users', ?, 1)").bind(JSON.stringify(users)),
          ...(existing ? [] : [db.prepare("INSERT INTO kv (k, v, rev) VALUES ('state', ?, 1)").bind(JSON.stringify(S))]),
        ]);
      } catch { throw new Oops("The Squad is already set up. Log in instead.", 409); }
      const token = await session(db, "dad");
      return stateReply(db, whoIs("dad", S), existing || { v: S, rev: 1 }, { token });
    }
    if (route === "login" && method === "POST") {
      const b = await readBody(request), user = idOf(b.user);
      const users = await getKV(db, "users"), st = await getKV(db, "state");
      const u = users?.v[user], me = whoIs(user, st?.v);
      if (!u || !me) throw new Oops("That person doesn't have a PIN yet. Ask Mom or Dad.", 404);
      const f = await db.prepare("SELECT n, until FROM fails WHERE user = ?").bind(user).first();
      if (f && f.until > Date.now()) throw new Oops(`Too many tries. Wait ${Math.ceil((f.until - Date.now()) / 60000)} minutes and try again.`, 429);
      if (!/^\d{4}$/.test(b.pin || "") || (await pinHash(u.salt, b.pin)) !== u.hash) {
        const n = (f && f.until <= Date.now() && f.until > 0 ? 0 : f?.n || 0) + 1;
        await db.prepare("INSERT OR REPLACE INTO fails (user, n, until) VALUES (?, ?, ?)").bind(user, n >= LOCK_AFTER ? 0 : n, n >= LOCK_AFTER ? Date.now() + LOCK_MS : 0).run();
        throw new Oops(n >= LOCK_AFTER ? "Too many tries. Wait 10 minutes and try again." : `Wrong PIN. ${LOCK_AFTER - n} tries left.`, 401);
      }
      await db.prepare("DELETE FROM fails WHERE user = ?").bind(user).run();
      const token = await session(db, user);
      return stateReply(db, me, st, { token });
    }
    const { me, st, hash } = await auth(db, request);
    if (route === "logout" && method === "POST") {
      await db.prepare("DELETE FROM sessions WHERE h = ?").bind(hash).run();
      return json({ ok: true });
    }
    if (route === "state" && method === "GET") {
      let cur = st;
      if (gameTick(cur.v, Date.now())) {
        const r = await db.prepare("UPDATE kv SET v = ?, rev = rev + 1 WHERE k = 'state' AND rev = ?").bind(JSON.stringify(cur.v), cur.rev).run();
        cur = r.meta.changes === 1 ? { v: cur.v, rev: cur.rev + 1 } : await getKV(db, "state");
      }
      const since = +new URL(request.url).searchParams.get("since");
      if (since && since === cur.rev) return json({ same: true, rev: cur.rev });
      return stateReply(db, me, cur);
    }
    if (route === "act" && method === "POST") {
      const a = await readBody(request);
      for (let tries = 0; tries < 4; tries++) {
        const cur = tries ? await getKV(db, "state") : st;
        const S = cur.v, t = today();
        gameTick(S, Date.now());
        const result = apply(S, me, a);
        for (const k of Object.keys(S.done)) if (!k.startsWith(t + "|")) delete S.done[k];
        if (S.orders) for (const kid of Object.keys(S.orders)) {
          S.orders[kid] = S.orders[kid].filter(id => S.chores.some(c => c.id === id));
          if (!S.orders[kid].length || !S.kids.some(k => k.id === kid)) delete S.orders[kid];
        }
        S.log = S.log.slice(0, LOG_MAX);
        const r = await db.prepare("UPDATE kv SET v = ?, rev = rev + 1 WHERE k = 'state' AND rev = ?").bind(JSON.stringify(S), cur.rev).run();
        if (r.meta.changes === 1) return stateReply(db, whoIs(me.id, S), { v: S, rev: cur.rev + 1 }, { result });
      }
      throw new Oops("Lots going on at once. Try again.", 409);
    }
    if (route === "pin" && method === "POST") {
      if (me.role !== "parent") throw new Oops("Only Mom or Dad can set PINs", 403);
      const b = await readBody(request), user = idOf(b.user);
      if (!whoIs(user, st.v)) throw new Oops("Who is this PIN for?");
      if (!/^\d{4}$/.test(b.pin || "")) throw new Oops("PIN must be 4 digits");
      const users = await getKV(db, "users"), salt = randHex(16);
      users.v[user] = { salt, hash: await pinHash(salt, b.pin) };
      await db.prepare("UPDATE kv SET v = ?, rev = rev + 1 WHERE k = 'users'").bind(JSON.stringify(users.v)).run();
      await db.prepare("DELETE FROM fails WHERE user = ?").bind(user).run();
      return stateReply(db, me, st, { ok: true });
    }
    return fail("Not found", 404);
  } catch (e) {
    if (e instanceof Oops) return fail(e.message, e.status);
    console.error(e);
    return fail("Something went wrong on the server. Try again in a minute.", 500);
  }
}
