// BlazeTV server (no dependencies, Node 18+).   Start it with:  node server.js
// Videos come from folders inside ./data :  Free, VIP, DIAMOND VIP  (just drop video files in them).
// Payments are managed from a terminal in this folder:  node server.js help
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const TRUST_PROXY = process.env.TRUST_PROXY === "1";   // set only if hosted behind a proxy that sets X-Forwarded-For
const DATA = path.join(__dirname, "data"), DBF = path.join(DATA, "db.json");
const FOLDER = { free: 0, vip: 1, diamondvip: 2, diamond: 2 };          // folder name (any case/spacing) -> category
const catOf = n => FOLDER[n.toLowerCase().replace(/[^a-z]/g, "")];
const TYPES = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ogg": "video/ogg", ".mkv": "video/x-matroska" };
const DUR = { day: 864e5, week: 6048e5, month: 2592e6, lifetime: 0 };
const PLAN = { vip: 1, diamond: 2 };

fs.mkdirSync(DATA, { recursive: true });
let db = { access: {}, users: {}, requests: [] }, lastM = 0;
function load() {                                   // re-reads db.json when the terminal commands change it
  try { const m = fs.statSync(DBF).mtimeMs; if (m !== lastM) { db = Object.assign({ access: {}, users: {}, requests: [] }, JSON.parse(fs.readFileSync(DBF, "utf8"))); lastM = m; } } catch (e) {}
}
function save() { fs.writeFileSync(DBF, JSON.stringify(db, null, 1)); lastM = fs.statSync(DBF).mtimeMs; }
load();

// ---------- access (by IP) ----------
function access(ip) {                               // highest unexpired plan for this IP (Diamond includes VIP)
  const now = Date.now(); let tier = 0, exp = null;
  for (const g of db.access[ip] || []) {
    if (g.exp && g.exp < now) continue;
    if (g.tier > tier) { tier = g.tier; exp = g.exp; }
    else if (g.tier === tier && exp !== 0 && (g.exp === 0 || g.exp > exp)) exp = g.exp;
  }
  return { tier, exp };
}
function grant(ip, tier, dur) {
  const list = (db.access[ip] || []).filter(g => !g.exp || g.exp > Date.now());
  list.push({ tier, exp: DUR[dur] ? Date.now() + DUR[dur] : 0 });
  db.access[ip] = list; save();
}
const nameOf = ip => (db.users[ip] || {}).name || null;
function touch(ip) { const u = db.users[ip]; if (u && Date.now() - u.last > 6e4) { u.last = Date.now(); save(); } }

// ---------- videos (read from the folders) ----------
function ensureFolders() {
  const have = fs.readdirSync(DATA, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => catOf(d.name));
  [["Free", 0], ["VIP", 1], ["DIAMOND VIP", 2]].forEach(([n, c]) => { if (!have.includes(c)) fs.mkdirSync(path.join(DATA, n), { recursive: true }); });
}
let cache = { at: 0, list: [] };
function videos() {
  if (Date.now() - cache.at < 3000) return cache.list;
  const list = [];
  for (const d of fs.readdirSync(DATA, { withFileTypes: true })) {
    const cat = d.isDirectory() ? catOf(d.name) : undefined;
    if (cat === undefined) continue;
    for (const f of fs.readdirSync(path.join(DATA, d.name))) {
      const type = TYPES[path.extname(f).toLowerCase()];
      if (!type) continue;
      const file = path.join(DATA, d.name, f);
      list.push({ id: crypto.createHash("sha1").update(d.name + "/" + f).digest("hex").slice(0, 12), title: path.basename(f, path.extname(f)).replace(/_+/g, " "), cat, file, type, at: fs.statSync(file).mtimeMs });
    }
  }
  list.sort((a, b) => b.at - a.at);
  cache = { at: Date.now(), list }; return list;
}

// ---------- helpers ----------
const clientIp = req => {
  let a = req.socket.remoteAddress || "";
  if (TRUST_PROXY && req.headers["x-forwarded-for"]) a = String(req.headers["x-forwarded-for"]).split(",")[0].trim();
  return a.replace(/^::ffff:/, "");
};
const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const readJson = req => new Promise(r => {
  let b = ""; req.on("data", c => { b += c; if (b.length > 1e5) req.destroy(); });
  req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch (e) { r({}); } });
});
function stream(req, res, file, type) {
  const size = fs.statSync(file).size, r = req.headers.range;
  if (r) {
    const m = /bytes=(\d*)-(\d*)/.exec(r) || [];
    const s = m[1] ? +m[1] : 0, e = m[2] ? Math.min(+m[2], size - 1) : size - 1;
    res.writeHead(206, { "Content-Range": `bytes ${s}-${e}/${size}`, "Accept-Ranges": "bytes", "Content-Length": e - s + 1, "Content-Type": type });
    fs.createReadStream(file, { start: s, end: e }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Length": size, "Content-Type": type, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  }
}

// ---------- terminal commands:  node server.js <command> ----------
function cli(cmd, a, b, c) {
  const ipOf = x => { const k = Object.keys(db.users).find(k => db.users[k].name.toLowerCase() === String(x).toLowerCase()); return k || (/[.:]/.test(String(x)) ? x : null); };
  const T = ip => ip || (console.log("User not found. See: node server.js users"), null);
  switch (cmd) {
    case "requests": {
      const l = db.requests.filter(r => r.status === "pending");
      if (!l.length) return console.log("No pending requests.");
      return l.forEach(r => console.log(`${r.id}  ${r.name || "?"}  ${r.ip}  ${r.tier === 1 ? "VIP" : "DIAMOND VIP"}  ${r.dur}  "${r.note}"  ${new Date(r.at).toLocaleString()}`));
    }
    case "approve": case "reject": {
      const r = db.requests.find(x => x.id === a && x.status === "pending");
      if (!r) return console.log("Request not found. See: node server.js requests");
      if (cmd === "approve") grant(r.ip, r.tier, r.dur);
      r.status = cmd === "approve" ? "approved" : "rejected"; save(); return console.log("Done.");
    }
    case "users":
      return Object.entries(db.users).forEach(([k, u]) => { const x = access(k); console.log(`${u.name}  ${k}  ${["Free", "VIP", "DIAMOND VIP"][x.tier]}${x.tier ? (x.exp ? " until " + new Date(x.exp).toLocaleDateString() : " (lifetime)") : ""}`); });
    case "grant": {
      const ip = T(ipOf(a)); if (!ip) return;
      if (!PLAN[b] || !(c in DUR)) return console.log("Usage: node server.js grant <username|ip> <vip|diamond> <day|week|month|lifetime>");
      grant(ip, PLAN[b], c); return console.log("Done.");
    }
    case "revoke": { const ip = T(ipOf(a)); if (!ip) return; delete db.access[ip]; save(); return console.log("Done."); }
    case "remove": { const ip = T(ipOf(a)); if (!ip) return; delete db.users[ip]; save(); return console.log("Done."); }
    default:
      console.log("Commands:\n  node server.js requests                      list payment requests waiting for you\n  node server.js approve <id>                  confirm a payment (turns on that person's access)\n  node server.js reject <id>\n  node server.js users                         list usernames, IPs and plans\n  node server.js grant <username|ip> <vip|diamond> <day|week|month|lifetime>\n  node server.js revoke <username|ip>          remove someone's paid access\n  node server.js remove <username|ip>          delete a username (frees the name)");
  }
}
const [cmd, a1, a2, a3] = process.argv.slice(2);
if (cmd) { cli(cmd, a1, a2, a3); process.exit(0); }

// ---------- web server ----------
ensureFolders();
http.createServer(async (req, res) => {
  load();
  const u = new URL(req.url, "http://x"), p = u.pathname, ip = clientIp(req);
  try {
    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(path.join(__dirname, "public", "index.html")).pipe(res);
    }
    if (p === "/api/me") {
      const x = access(ip); touch(ip);
      return send(res, 200, { tier: x.tier, exp: x.exp, name: nameOf(ip), pending: db.requests.filter(r => r.ip === ip && r.status === "pending").length });
    }
    if (p === "/api/videos" && req.method === "GET") return send(res, 200, videos().map(({ id, title, cat }) => ({ id, title, cat })));

    if (p.startsWith("/video/")) {                        // the file is only sent if this IP has the plan
      const v = videos().find(x => x.id === p.slice(7));
      if (!v) return send(res, 404, { error: "not found" });
      if (access(ip).tier < v.cat) return send(res, 403, { error: "no access" });
      return stream(req, res, v.file, v.type);
    }

    if (p === "/api/login" && req.method === "POST") {    // username attached to the visitor's IP; names are unique
      const n = String((await readJson(req)).name || "").trim();
      if (!/^[A-Za-z0-9_.-]{3,20}$/.test(n)) return send(res, 400, { error: "bad name" });
      if (Object.entries(db.users).some(([k, x]) => k !== ip && x.name.toLowerCase() === n.toLowerCase())) return send(res, 409, { error: "taken" });
      db.users[ip] = { name: n, at: (db.users[ip] || {}).at || Date.now(), last: Date.now() };
      save(); return send(res, 200, { name: n });
    }

    if (p === "/api/request" && req.method === "POST") {  // buyer pressed "I've paid": you approve it from the terminal
      const b = await readJson(req);
      if (![1, 2].includes(b.tier) || !(b.dur in DUR)) return send(res, 400, { error: "bad request" });
      if (!nameOf(ip)) return send(res, 401, { error: "username required" });
      if (db.requests.filter(r => r.ip === ip && r.status === "pending").length >= 5) return send(res, 429, { error: "too many pending" });
      db.requests.unshift({ id: crypto.randomBytes(3).toString("hex"), ip, name: nameOf(ip), tier: b.tier, dur: b.dur, note: String(b.note || "").slice(0, 80), at: Date.now(), status: "pending" });
      save(); return send(res, 200, { ok: true });
    }

    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 500, { error: "server error" }); }
}).listen(PORT, () => console.log("BlazeTV running on http://localhost:" + PORT + "\nVideo folders: " + DATA));
