// Clean Sweep Squad — demo mode (chores.mcdanielnet.com/demo)
//
// The demo runs the real game server (demo-engine.js, an exact copy of
// functions/api/[[path]].js) inside the visitor's browser, on a tiny in-memory
// database. Nothing is sent to the family's real database, and nothing is
// saved: closing or reloading the page starts a brand-new sample family.
//
// When the server file changes, copy it over demo-engine.js so the demo keeps
// matching the real site.

import { onRequest } from "/demo-engine.js";

export const DEMO_PINS = { parents: "1111", kids: "2222" };

// ---------- an in-memory stand-in for the Cloudflare D1 database ----------
// It understands exactly the statements the server uses, and fails loudly on
// anything new so a future server change can't silently break the demo.
const T = { kv: new Map(), sessions: new Map(), fails: new Map() };
const snap = () => JSON.stringify({ kv: [...T.kv], sessions: [...T.sessions], fails: [...T.fails] });
const restore = s => { const o = JSON.parse(s); T.kv = new Map(o.kv); T.sessions = new Map(o.sessions); T.fails = new Map(o.fails); };

function exec(sql, a) {
  const s = sql.replace(/\s+/g, " ").trim();
  let m;
  if (s.startsWith("CREATE TABLE IF NOT EXISTS")) return { changes: 0 };
  if (s === "SELECT v, rev FROM kv WHERE k = ?") { const r = T.kv.get(a[0]); return { row: r ? { v: r.v, rev: r.rev } : null }; }
  if ((m = s.match(/^INSERT INTO kv \(k, v, rev\) VALUES \('(\w+)', \?, 1\)$/))) {
    if (T.kv.has(m[1])) throw new Error("UNIQUE constraint failed: kv.k");
    T.kv.set(m[1], { v: a[0], rev: 1 }); return { changes: 1 };
  }
  if (s === "UPDATE kv SET v = ?, rev = rev + 1 WHERE k = 'state' AND rev = ?") {
    const r = T.kv.get("state"); if (!r || r.rev !== a[1]) return { changes: 0 };
    r.v = a[0]; r.rev++; return { changes: 1 };
  }
  if ((m = s.match(/^UPDATE kv SET v = \?, rev = rev \+ 1 WHERE k = '(\w+)'$/))) {
    const r = T.kv.get(m[1]); if (!r) return { changes: 0 };
    r.v = a[0]; r.rev++; return { changes: 1 };
  }
  if (s === "INSERT INTO sessions (h, user, created) VALUES (?, ?, ?)") { T.sessions.set(a[0], { user: a[1], created: a[2] }); return { changes: 1 }; }
  if (s === "SELECT user, created FROM sessions WHERE h = ?") { const r = T.sessions.get(a[0]); return { row: r ? { ...r } : null }; }
  if (s === "DELETE FROM sessions WHERE h = ?") return { changes: +T.sessions.delete(a[0]) };
  if (s === "SELECT n, until FROM fails WHERE user = ?") { const r = T.fails.get(a[0]); return { row: r ? { ...r } : null }; }
  if (s === "INSERT OR REPLACE INTO fails (user, n, until) VALUES (?, ?, ?)") { T.fails.set(a[0], { n: a[1], until: a[2] }); return { changes: 1 }; }
  if (s === "DELETE FROM fails WHERE user = ?") return { changes: +T.fails.delete(a[0]) };
  throw new Error("Demo database doesn't know this statement: " + s);
}
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  first: async () => exec(sql, args).row ?? null,
  run: async () => ({ success: true, meta: { changes: exec(sql, args).changes || 0 } }),
  all: async () => { const r = exec(sql, args).row; return { results: r ? [r] : [] }; },
  _run: () => ({ success: true, meta: { changes: exec(sql, args).changes || 0 } }),
});
const DB = {
  prepare: sql => stmt(sql),
  batch: async list => { const before = snap(); try { return list.map(st => st._run()); } catch (e) { restore(before); throw e; } },
};

// ---------- calling the real server code, in this browser ----------
async function call(path, body, token) {
  const url = new URL("/api/" + path, location.origin);
  const headers = { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) };
  const request = new Request(url.href, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
  return onRequest({ request, env: { DB }, params: { path: url.pathname.slice(5).split("/") } });
}
async function must(path, body, token) {
  const r = await call(path, body, token), j = await r.json();
  if (!r.ok) throw new Error("Demo setup failed at " + path + ": " + (j.error || r.status));
  return j;
}

// ---------- a sample family, so visitors land in a squad that's already going ----------
const DEMO_KIDS = { a: "Ava", b: "Grace", c: "Sam" };
async function seed(src) {
  const state = structuredClone(src || {});
  state.log = [];
  state.kids = (state.kids || []).map(k => ({ ...k, name: DEMO_KIDS[k.id] || k.name, xp: 0, stars: 0, missions: 0, x2: 0, bought: 0 }));
  if (!state.kids.length) state.kids = Object.entries(DEMO_KIDS).map(([id, name]) => ({ id, name }));

  const dad = (await must("setup", { pin: DEMO_PINS.parents, state })).token;
  await must("pin", { user: "mom", pin: DEMO_PINS.parents }, dad);
  for (const k of state.kids) await must("pin", { user: k.id, pin: DEMO_PINS.kids }, dad);

  // A little history: some approved missions and a bonus, so ranks and the log aren't empty.
  let S = (await must("state", null, dad)).state;
  const open = kid => S.chores.filter(c => !c.off && (!c.kid || c.kid === kid));
  const plan = { a: 4, b: 3, c: 3 };
  for (const k of S.kids) {
    const kidTok = (await must("login", { user: k.id, pin: DEMO_PINS.kids })).token;
    for (const c of open(k.id).slice(0, plan[k.id] ?? 2)) await must("act", { type: "claim", kid: k.id, chore: c.id }, kidTok);
    await must("logout", {}, kidTok);
  }
  S = (await must("state", null, dad)).state;
  for (const p of S.pending.slice(0, -1)) await must("act", { type: "approve", id: p.id }, dad); // leave one waiting for a parent
  await must("act", { type: "adjust", kid: S.kids[0].id, n: 25, mode: "give", why: "Helped without being asked" }, dad);
  if (S.kids[2]) await must("act", { type: "adjust", kid: S.kids[2].id, n: 15, mode: "give", why: "Great attitude" }, dad);
  await must("logout", {}, dad);
}

let ready = null;
export function start(src) { return (ready ??= seed(src)); }

// The page's own fetch("/api/...") is routed here in demo mode.
export async function demoFetch(url, init = {}) {
  await ready;
  const u = new URL(url, location.origin);
  const request = new Request(u.href, { method: init.method || "GET", headers: init.headers, body: init.body });
  return onRequest({ request, env: { DB }, params: { path: u.pathname.slice(5).split("/") } });
}
