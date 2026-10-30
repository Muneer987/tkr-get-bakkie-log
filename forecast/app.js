/* TKR GET Forecast — metres per rig + GET issued + stock counts in, forecast and order out.
   Works like the Daily GET Consumption Tracker: same prices, target lives and forecast method.
   Data is shared online in Firebase (admins write, managers read). */
import {
  initializeApp, getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, addDoc, setDoc, deleteDoc, getDoc, onSnapshot, query, where,
} from "../lib/firebase.js";
const showName = e => /@mgr\.tkroperations\.app$/.test(e || "") ? (e[0].toUpperCase() + e.slice(1, e.indexOf("@"))) : e;
const toLogin = v => { v = String(v || "").trim(); return v.includes("@") ? v : v.toLowerCase().replace(/[^a-z0-9]/g, "") + "@mgr.tkroperations.app"; };  // managers can sign in with a username

const firebaseConfig = {
  apiKey: "AIzaSyALzOBLObrONGVD1bS0Tz02aNKhQ40TRoI", authDomain: "tkr-operations-app.firebaseapp.com", projectId: "tkr-operations-app",
  storageBucket: "tkr-operations-app.firebasestorage.app", messagingSenderId: "158080247079", appId: "1:158080247079:web:7cb7786d2b7f9ee172b502",
};
const ADMINS = ["muneer@tkroperations.com", "amogelang@tkroperations.com"];
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
let db; try { db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); } catch { db = initializeFirestore(fbApp, {}); }

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const fmt = s => s ? s.split("-").reverse().join("/") : "";
const dayName = s => parse(s).toLocaleDateString("en-ZA", { weekday: "long" });
const short = s => parse(s).toLocaleDateString("en-ZA", { day: "2-digit", month: "short" });
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const R = v => "R" + String(Math.round(v || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const R2 = v => "R" + (v || 0).toFixed(2);
const r1 = v => Math.round((v || 0) * 10) / 10;
const M1 = v => { const [i, d] = r1(v).toFixed(1).split("."); return i.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + "." + d; };
const num = v => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isNaN(n) ? 0 : n; };
function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3000); }
function fail(e) { console.warn(e); toast(e?.code === "permission-denied" ? "Only an admin can change this." : "That didn't save. Try again."); }
const loadLib = src => new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)?.dataset.ok) return res(); const s = document.createElement("script"); s.src = src; s.onload = () => { s.dataset.ok = 1; res(); }; s.onerror = rej; document.head.appendChild(s); });

const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ITEMS = [["BIT", "Bits", "140 mm bits"], ["ROD", "Rods", "Rods"], ["SHANK", "Shanks", "Shanks"]];
const STOCK_ITEMS = [...ITEMS, ["HAMMER", "Hammers", "Hammers"]];
const ONE = { BIT: "bit", ROD: "rod", SHANK: "shank", HAMMER: "hammer" };
const qn = (k, q) => `${q} ${ONE[k]}${q === 1 ? "" : "s"}`;
const RIGS = ["TDR 013", "TDR 015", "TDR 014"];
const DEFAULTS = { price: { BIT: 9000, ROD: 8621, SHANK: 6200, HAMMER: 48000 }, life: { BIT: 600, ROD: 700, SHANK: 500 }, spare: { BIT: 2, ROD: 2, SHANK: 2 }, nextBits: 5, avgDays: 7 };

/* ---------- state ---------- */
let user = null, email = "", managers = [], metres = [], issues = [], counts = [], settings = structuredClone(DEFAULTS);
// GET issued and received at the Drill Stores (Stores section) come in by themselves, with the prices set there
let stMoves = [], stCounts = [], stPrice = {};
const rigName = m => (m || "").replace(/TDR(\d{3})/g, "TDR $1");
const fromStores = () => stMoves.filter(x => x.getKey && x.kind === "issue").map(x => { const n = x.note || "", rg = n.match(/TDR \d{3}( \/ TDR \d{3})*/), bl = n.match(/block ([^·]+)/);
  return { id: x.id, date: x.date, shift: x.shift || "", rig: rigName(x.machine) || (rg ? rg[0] : ""), block: bl ? bl[1].trim() : "", item: x.getKey, qty: num(x.qty), to: x.to || "", by: x.byName || "", note: rg || bl ? "" : n, src: "stores" }; });
const allIssues = () => issues.concat(fromStores());
const allCounts = () => counts.concat(stCounts.filter(x => x.getKey).map(x => ({ id: x.id, date: x.date, item: x.getKey, count: num(x.count), received: 0, by: x.byName || "", src: "stores" })),
  stMoves.filter(x => x.getKey && x.kind === "receive").map(x => ({ id: x.id, date: x.date, item: x.getKey, count: "", received: num(x.qty), by: (x.from ? x.from + " · " : "") + (x.byName || ""), src: "stores" })));
let reportDate = ymd(new Date()), tab = "dash", subs = [], impStatus = "", metStatus = "";
const isAdmin = () => ADMINS.includes(email);
const isManager = () => isAdmin() || (email && managers.includes(email));
const app = $("app");

/* ---------- sign in ---------- */
onAuthStateChanged(auth, u => {
  user = u; email = (u?.email || "").toLowerCase();
  subs.forEach(f => f()); subs = [];
  if (!u || u.isAnonymous || email.endsWith("@staff.tkroperations.app")) { showGate(); return; }
  subs.push(onSnapshot(doc(db, "config", "roles"), s => { managers = ((s.exists() && s.data().managers) || []).map(x => String(x).toLowerCase()); gateOrApp(); }, () => gateOrApp()));
});
function showGate(msg = "", html = false) { $("gate").hidden = false; app.hidden = true; $("signBtn").hidden = true; $("who").textContent = ""; if (html) $("sErr").innerHTML = msg; else $("sErr").textContent = msg; $("signForm").querySelectorAll("label, button, p.muted").forEach(el => el.hidden = html); }
function gateOrApp() {
  if (!isManager()) { showGate(`<span style="color:var(--fg);font-weight:500">Sorry ${esc(showName(email))}, you don't have access here. Please ask admin.</span>`, true); return; }
  $("gate").hidden = true; app.hidden = false; $("signBtn").hidden = false; $("who").textContent = showName(email) + (isAdmin() ? " · admin" : " · manager");
  if (subs.length === 1) {
    const live = (name, set) => subs.push(onSnapshot(collection(db, name), s => { set(s.docs.map(d => ({ id: d.id, ...d.data() }))); render(); }, e => netNote("Couldn't load. Check the signal.")));
    live("fcMetres", v => { metres = v; if (isAdmin()) setTimeout(async () => { await seedOctober(); await seedLate(); await seedSite5200(); }, 1500); }); live("fcIssues", v => issues = v); live("fcCounts", v => counts = v);
    const liveQ = (name, set) => subs.push(onSnapshot(query(collection(db, name), where("store", "==", "drill")), s => { set(s.docs.map(d => ({ id: d.id, ...d.data() }))); render(); }, e => console.warn(e)));
    liveQ("stMoves", v => stMoves = v); liveQ("stCounts", v => stCounts = v);
    subs.push(onSnapshot(doc(db, "stConfig", "items"), s => { stPrice = {}; (s.exists() ? s.data().list || [] : []).forEach(i => { if (i.getKey && num(i.price) > 0) stPrice[i.getKey] = num(i.price); }); settings = mergeSettings(rawSettings); render(); }, () => {}));
    subs.push(onSnapshot(doc(db, "fcSettings", "main"), s => { rawSettings = s.exists() ? s.data() : {}; settings = mergeSettings(rawSettings); render(); }, () => {}));
  }
  render();
}
let rawSettings = {};
function mergeSettings(x) { const s = structuredClone(DEFAULTS); for (const k of ["price", "life", "spare"]) Object.assign(s[k], x[k] || {}); Object.assign(s.price, stPrice); if (x.nextBits !== undefined) s.nextBits = x.nextBits; return s; }
$("signForm").onsubmit = async e => {
  e.preventDefault(); $("sErr").textContent = "Signing in…";
  try { await signInWithEmailAndPassword(auth, toLogin($("sEmail").value), $("sPass").value); $("sPass").value = ""; }
  catch (err) { $("sErr").textContent = String(err?.code || "").includes("network") ? "No signal. Signing in needs signal." : "Email or password is wrong."; }
};
$("signBtn").onclick = () => signOut(auth);
$("forgotBtn").onclick = async () => {
  const em = $("sEmail").value.trim(); if (!em) { $("sErr").textContent = "Type your email first, then tap Forgot your password."; return; }
  try { await sendPasswordResetEmail(auth, em); $("sErr").textContent = `A link to set a new password was sent to ${em}. Check the inbox and spam folder.`; }
  catch (x) { $("sErr").textContent = String(x?.code || "").includes("network") ? "No signal. Try again with signal." : "That email is not set up in the app. Ask admin."; }
};
function netNote(m) { $("net").textContent = m; $("net").hidden = !m; }
addEventListener("offline", () => netNote("No signal. You see the last saved figures; changes send when the signal is back."));
addEventListener("online", () => netNote(""));

/* ---------- the forecast (same method as the tracker) ---------- */
function calc(rd) {
  const issues = allIssues(), counts = allCounts();
  const upToCal = addDays(rd, -1);                                    // actuals up to yesterday
  const lastProd = metres.reduce((m, x) => x.date > m ? x.date : m, "");
  const upTo = lastProd && lastProd < upToCal ? lastProd : upToCal;  // average taken up to the last day captured
  const d = parse(rd), wd = (d.getDay() + 6) % 7;                     // Monday = 0
  const weekStart = addDays(rd, -wd), weekEnd = addDays(weekStart, 6), lastStart = addDays(weekStart, -7), lastEnd = addDays(weekStart, -1);
  const monthStart = upToCal.slice(0, 8) + "01";
  const inR = (x, a, b) => x.date >= a && x.date <= b;
  const mSum = (a, b, rig) => metres.filter(x => inR(x, a, b) && (!rig || x.rig === rig)).reduce((n, x) => n + num(x.metres), 0);
  const iSum = (item, a, b) => issues.filter(x => x.item === item && inR(x, a, b)).reduce((n, x) => n + num(x.qty), 0);
  const cost = (a, b) => ITEMS.reduce((n, [k]) => n + iSum(k, a, b) * (settings.price[k] || 0), 0);
  const avgFrom = addDays(upTo, -(settings.avgDays - 1));
  const rigsSeen = RIGS.filter(r => metres.some(x => x.rig === r));
  const avg = {}; rigsSeen.forEach(r => avg[r] = mSum(avgFrom, upTo, r) / settings.avgDays);
  const avgAll = Object.values(avg).reduce((a, b) => a + b, 0);
  const monthM = mSum(monthStart, upToCal);
  const lifeUsed = {}; ITEMS.forEach(([k]) => { const q = iSum(k, monthStart, upToCal); lifeUsed[k] = q > 0 ? monthM / q : settings.life[k]; });
  const actualDays = Math.max(0, Math.min(7, (parse(upToCal) - parse(weekStart)) / 864e5 + 1));
  const projDays = 7 - actualDays;
  const projM = projDays * avgAll;
  const rest = {}; ITEMS.forEach(([k]) => rest[k] = lifeUsed[k] ? Math.round(projM / lifeUsed[k]) : 0);
  // stock on hand: latest count, then received and issued after that day
  const stock = {}, stockDate = {};
  STOCK_ITEMS.forEach(([k]) => {
    const c = counts.filter(x => x.item === k && x.date <= upToCal && x.count !== "" && x.count != null).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    if (!c) { stock[k] = null; return; }
    const after = (arr, f) => arr.filter(x => x.item === k && x.date > c.date && x.date <= upToCal).reduce((n, x) => n + num(f(x)), 0);
    stock[k] = num(c.count) + after(counts, x => x.received) - after(issues, x => x.qty); stockDate[k] = c.date;
  });
  const week = {
    metres: { last: mSum(lastStart, lastEnd), toDate: actualDays ? mSum(weekStart, upToCal) : 0, rest: projM },
    qty: {}, cost: { last: cost(lastStart, lastEnd), toDate: actualDays ? cost(weekStart, upToCal) : 0, rest: ITEMS.reduce((n, [k]) => n + rest[k] * settings.price[k], 0) },
  };
  ITEMS.forEach(([k]) => week.qty[k] = { last: iSum(k, lastStart, lastEnd), toDate: actualDays ? iSum(k, weekStart, upToCal) : 0, rest: rest[k] });
  const orderNow = {}; ITEMS.forEach(([k]) => orderNow[k] = Math.max(0, rest[k] - (stock[k] || 0)));
  const nextM = 7 * avgAll;
  const next = {}; ITEMS.forEach(([k]) => {
    const need = k === "BIT" && settings.nextBits !== "" && settings.nextBits != null ? num(settings.nextBits) : (lifeUsed[k] ? Math.round(nextM / lifeUsed[k]) : 0);
    const left = Math.max(0, (stock[k] || 0) - rest[k]), total = need + num(settings.spare[k]);
    next[k] = { need, spare: num(settings.spare[k]), total, left, order: Math.max(0, total - left) };
  });
  const std = ITEMS.reduce((n, [k]) => n + settings.price[k] / settings.life[k], 0);
  const yest = upToCal;
  return { rd, upTo, upToCal, lastProd, weekStart, weekEnd, lastStart, lastEnd, monthStart, actualDays, projDays, avg, avgAll, avgFrom, lifeUsed, stock, stockDate, week, orderNow, nextM, next, std,
    day: { metres: mSum(yest, yest), cost: cost(yest, yest) }, month: { metres: monthM, cost: cost(monthStart, upToCal) },
    monthRig: Object.fromEntries(RIGS.map(r => [r, mSum(monthStart, upToCal, r)])), monthNA: monthM - RIGS.reduce((n, r) => n + mSum(monthStart, upToCal, r), 0),
    weekRig: Object.fromEntries(RIGS.map(r => [r, actualDays ? mSum(weekStart, upToCal, r) : 0])),
    recentIssues: issues.filter(x => inR(x, addDays(upToCal, -1), upToCal)) };
}

/* ---------- why the numbers look the way they do ---------- */
function explain(c) {
  const out = [], warn = [];
  const nextMon = fmt(addDays(c.weekStart, 7));
  const wtdM = c.week.metres.toDate, wtdC = c.week.cost.toDate, wtdRm = wtdM ? wtdC / wtdM : 0;
  if (c.actualDays === 0) out.push(`The week started today (${fmt(c.weekStart)}). Everything for this week is forecast from the last ${settings.avgDays} days.`);
  else if (c.actualDays < 7) out.push(`It is ${dayName(c.rd)}: ${c.actualDays} of 7 days of this week are actual (${short(c.weekStart)} to ${short(c.upToCal)}) and ${c.projDays} are forecast.`);
  else out.push(`This week (${short(c.weekStart)} to ${short(c.weekEnd)}) is complete. All figures are actual.`);
  if (c.actualDays > 0 && c.actualDays < 7 && wtdRm > c.std * 1.5 && c.recentIssues.length) {
    const tot = {}; c.recentIssues.forEach(x => tot[x.item] = (tot[x.item] || 0) + num(x.qty));
    const it = ITEMS.filter(([k]) => tot[k]).map(([k]) => qn(k, tot[k])).join(", ");
    out.push(`Cost per metre this week looks high (${R2(wtdRm)}/m against the ${R2(c.std)}/m standard) because GET was issued on ${[...new Set(c.recentIssues.map(x => fmt(x.date)))].join(" and ")} (${it}). That GET is used over the next days, so the metres for it are still to come.`);
  }
  if (c.actualDays < 7) out.push(`The figures settle as the week is completed. From Monday ${nextMon} this week's figures will all be actual.`);
  if (c.lastProd && c.lastProd < c.upToCal) warn.push(`Metres are captured up to ${fmt(c.lastProd)}. ${fmt(addDays(c.lastProd, 1))} to ${fmt(c.upToCal)} still need to be added.`);
  if (c.actualDays === 7 && wtdRm > c.std * 1.5) warn.push(`The week is complete and cost per metre is ${R2(wtdRm)}/m, above the ${R2(c.std)}/m standard. This is not because the week is unfinished.`);
  ITEMS.forEach(([k, n]) => { if (c.stock[k] === null) warn.push(`No ${n.toLowerCase()} in stock yet. Log what was received in Stores → Drill Stores.`); });
  return { out, warn };
}

/* ---------- rendering ---------- */
const tabs = [["dash", "Dashboard"], ["metres", "Metres"], ["issues", "GET issued"], ["stock", "GET stock"], ["settings", "Settings"], ["import", "Import"]];
function render() {
  if (app.hidden) return;
  const c = calc(reportDate);
  const head = `<div class="tabs" role="tablist">${tabs.filter(([k]) => isAdmin() || ["dash"].includes(k)).map(([k, t]) => `<button role="tab" aria-selected="${tab === k}" data-tab="${k}">${t}</button>`).join("")}</div>`;
  let body = "";
  if (tab === "dash") body = dash(c);
  if (tab === "metres") body = metresView();
  if (tab === "issues") body = issuesView();
  if (tab === "stock") body = stockView(c);
  if (tab === "settings") body = settingsView();
  if (tab === "import") body = importView();
  app.innerHTML = head + body;
}
function tile(l, n, s, cls = "") { return `<div class="tile ${cls}"><div class="l">${l}</div><div class="n">${n}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`; }
function dash(c) {
  const ex = explain(c), w = c.week, wtdRm = w.metres.toDate ? w.cost.toDate / w.metres.toDate : 0, mRm = c.month.metres ? c.month.cost / c.month.metres : 0;
  const orderNowCost = ITEMS.reduce((n, [k]) => n + c.orderNow[k] * settings.price[k], 0);
  const nextCost = ITEMS.reduce((n, [k]) => n + c.next[k].order * settings.price[k], 0);
  const empty = !metres.length && !allIssues().length;
  return `
  <div class="strip">
    <div><h2>${esc(dayName(c.rd))} ${fmt(c.rd)}</h2><div class="muted">This week ${short(c.weekStart)} – ${short(c.weekEnd)} · actuals up to ${fmt(c.upToCal)}</div>${lastUpdate()}</div>
    <div class="row"><label>Report date <input type="date" id="rd" value="${c.rd}"></label>
      <button id="msgBtn">WhatsApp message</button><button class="primary" id="xlBtn">Export GET tracker (Excel)</button></div>
  </div>
  ${empty ? `<div class="notice"><b class="t">No data yet</b>${isAdmin() ? "Tap Import and choose your GET tracker file to bring in October so far, or add the metres." : "Ask admin to import the GET tracker or add the metres."}</div>` : ""}
  <div class="notice"><b class="t">Why the forecast looks like this</b><ul>${ex.out.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>
  ${ex.warn.length ? `<div class="notice warn"><b class="t">Check</b><ul>${ex.warn.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
  <section class="card" style="background:#111;color:#f2efe8;border-color:#d4a12a">
    <h2 style="color:#d4a12a">GET cost per metre</h2>
    <div class="tiles" style="margin-bottom:0">
      ${tile("Month to date", R2(mRm), `${R(c.month.cost)} ÷ ${M1(c.month.metres)} m · 1 to ${short(c.upToCal)}`, "dark")}
      ${tile("This week to date", R2(wtdRm), w.metres.toDate ? `${R(w.cost.toDate)} ÷ ${M1(w.metres.toDate)} m` : "no metres yet this week", "dark")}
      ${tile("Last week", R2(w.metres.last ? w.cost.last / w.metres.last : 0), `${short(c.lastStart)} – ${short(c.lastEnd)}`, "dark")}
      ${tile("Standard", R2(c.std), "if every item reaches its target life", "dark")}
    </div></section>
  <section class="card"><h2>Metres to date · ${MONTHS_FULL[+c.monthStart.slice(5, 7) - 1]} ${c.monthStart.slice(0, 4)}</h2>
    <div class="tiles" style="margin-bottom:0">
      ${tile("All rigs combined", M1(c.month.metres) + " m", `1 to ${short(c.upToCal)} · this week ${M1(w.metres.toDate)} m`, "dark")}
      ${RIGS.map(r => tile(r, M1(c.monthRig[r]) + " m", `this week ${M1(c.weekRig[r])} m · ${M1(c.avg[r] || 0)} m/day avg`)).join("")}
      ${Math.abs(c.monthNA) >= 0.05 ? tile("Not allocated to a rig", M1(c.monthNA) + " m", "site total not split by rig") : ""}
    </div></section>
  <div class="tiles">
    ${tile("Metres " + fmt(c.upToCal), M1(c.day.metres) + " m", "")}
    ${tile("Metres this week to date", M1(w.metres.toDate) + " m", "last week " + M1(w.metres.last) + " m")}
    ${tile("Metres month to date", M1(c.month.metres) + " m", "")}
    ${tile("GET cost/m this week", R2(wtdRm), `standard ${R2(c.std)}/m`, wtdRm > c.std ? "" : "")}
    ${tile("GET cost/m month to date", R2(mRm), `GET cost ${R(c.month.cost)}`)}
    ${tile("Order now (this week)", R(orderNowCost), ITEMS.filter(([k]) => c.orderNow[k]).map(([k]) => qn(k, c.orderNow[k])).join(", ") || "nothing to order", "dark")}
    ${tile("Order for next week", R(nextCost), ITEMS.filter(([k]) => c.next[k].order).map(([k]) => qn(k, c.next[k].order)).join(", ") || "nothing to order", "dark")}
  </div>
  <div class="grid2c">
    <section class="card"><h2>This week – GET used</h2><div class="tbl"><table>
      <tr><th>Item</th><th class="num">Last week</th><th class="num">This week to date</th><th class="num">Rest of week (forecast)</th><th class="num">This week total</th></tr>
      ${ITEMS.map(([k, n]) => `<tr><td>${n}</td><td class="num">${w.qty[k].last}</td><td class="num">${w.qty[k].toDate}</td><td class="num">${w.qty[k].rest}</td><td class="num">${w.qty[k].toDate + w.qty[k].rest}</td></tr>`).join("")}
      <tr><td>Metres</td><td class="num">${M1(w.metres.last)}</td><td class="num">${M1(w.metres.toDate)}</td><td class="num">${M1(w.metres.rest)}</td><td class="num">${M1(w.metres.toDate + w.metres.rest)}</td></tr>
      <tr class="tot"><td>GET cost</td><td class="num">${R(w.cost.last)}</td><td class="num">${R(w.cost.toDate)}</td><td class="num">${R(w.cost.rest)}</td><td class="num">${R(w.cost.toDate + w.cost.rest)}</td></tr>
    </table></div></section>
    <section class="card"><h2>Stock and orders</h2><div class="tbl"><table>
      <tr><th>Item</th><th class="num">Stock on hand</th><th class="num">Order now</th><th class="num">Next week need + spare</th><th class="num">Order next week</th></tr>
      ${ITEMS.map(([k, n]) => `<tr><td>${n}</td><td class="num">${c.stock[k] ?? "–"}${c.stockDate[k] ? ` <span class="muted">(${short(c.stockDate[k])})</span>` : ""}</td><td class="num">${c.orderNow[k]}</td><td class="num">${c.next[k].need} + ${c.next[k].spare}</td><td class="num">${c.next[k].order}</td></tr>`).join("")}
      <tr class="tot"><td>Cost</td><td></td><td class="num">${R(orderNowCost)}</td><td></td><td class="num">${R(nextCost)}</td></tr>
    </table></div>
    <p class="muted" style="margin:8px 0 0">Total order both weeks: <b>${R(orderNowCost + nextCost)}</b></p></section>
  </div>
  <div class="grid2c">
    <section class="card chart"><h2>Metres per day – last 14 days</h2>${metresChart(c)}</section>
    <section class="card"><h2>Forecast basis</h2><div class="tbl"><table>
      <tr><th>Rig</th><th class="num">Average m/day</th></tr>
      ${Object.entries(c.avg).map(([r, v]) => `<tr><td>${r}</td><td class="num">${M1(v)}</td></tr>`).join("") || `<tr><td colspan="2" class="muted">No metres yet</td></tr>`}
      <tr class="tot"><td>All rigs</td><td class="num">${M1(c.avgAll)}</td></tr></table></div>
      <p class="muted">Average over ${settings.avgDays} days (${fmt(c.avgFrom)} to ${fmt(c.upTo)}). Life used this month: ${ITEMS.map(([k, n]) => `${n.toLowerCase()} ${Math.round(c.lifeUsed[k])} m`).join(", ")}. Next week bits: ${settings.nextBits !== "" && settings.nextBits != null ? settings.nextBits + " (set in Settings)" : "from the forecast"}.</p>
    </section>
  </div>`;
}
function metresChart(c) {
  const days = []; for (let i = 13; i >= 0; i--) days.push(addDays(c.upToCal, -i));
  const col = { "TDR 013": "#d4a12a", "TDR 015": "#2e7d4f", "TDR 014": "#2f6fb8" };
  const data = days.map(d => RIGS.map(r => metres.filter(x => x.date === d && x.rig === r).reduce((n, x) => n + num(x.metres), 0)));
  const max = Math.max(50, ...data.map(v => v.reduce((a, b) => a + b, 0)));
  const W = 560, H = 190, bot = 30, top = 14, bw = 28, gap = (W - bw * 14) / 14, sc = v => v / max * (H - top - bot);
  let g = `<line x1="0" x2="${W}" y1="${H - bot}" y2="${H - bot}" stroke="var(--line)"/>`;
  data.forEach((v, i) => {
    const x = gap / 2 + i * (bw + gap); let y = H - bot;
    v.forEach((m, j) => { if (!m) return; const h = sc(m); y -= h; g += `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${col[RIGS[j]]}"><title>${RIGS[j]} ${M1(m)} m</title></rect>`; });
    const tot = v.reduce((a, b) => a + b, 0);
    g += `<text x="${x + bw / 2}" y="${y - 4}" text-anchor="middle">${tot ? Math.round(tot) : ""}</text><text x="${x + bw / 2}" y="${H - 14}" text-anchor="middle">${parse(days[i]).getDate()}</text>`;
    if (days[i] === c.weekStart) g += `<line x1="${x - gap / 2}" x2="${x - gap / 2}" y1="${top}" y2="${H - bot}" stroke="var(--gold)" stroke-dasharray="3 3"/>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Metres per day per rig">${g}</svg><div class="legend">${RIGS.map(r => `<span><i style="background:${col[r]}"></i>${r}</span>`).join("")}<span>dashed line = start of this week</span></div>`;
}
function lastUpdate() {
  const sk = x => (x.date || "") + (x.shift === "Night" ? "2" : "1");
  const lm = metres.slice().sort((a, b) => sk(b).localeCompare(sk(a)))[0];
  const ls = stMoves.filter(x => x.getKey).map(x => x.date).sort().at(-1);
  const t = Math.max(0, ...metres.map(x => x.createdAt || 0), ...stMoves.map(x => x.createdAt || 0), ...issues.map(x => x.createdAt || 0));
  if (!lm && !ls) return "";
  const when = t ? (d => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} at ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`)(new Date(t)) : "";
  return `<div class="muted" style="margin-top:2px"><b>Last update:</b> metres up to ${lm ? fmt(lm.date) + (lm.shift ? " " + esc(lm.shift.toLowerCase()) + " shift" : "") : "–"} · GET from Drill Stores up to ${ls ? fmt(ls) : "–"}${when ? " · last saved " + esc(when) : ""}</div>`;
}
function listOf(arr, line) {
  const rows = arr.slice().sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 40);
  return `<div class="list">${rows.map(x => `<div class="it"><span>${line(x)}</span>${x._c ? `<button class="danger" data-del="${esc(x._c)}|${esc(x.id)}">Delete</button>` : '<span class="muted">from Stores</span>'}</div>`).join("") || `<div class="muted">Nothing yet.</div>`}</div>`;
}
const today = () => ymd(new Date());
function metresView() {
  const first = metres.map(x => x.date).sort()[0] || today().slice(0, 8) + "01";
  mxFrom = mxFrom || first; mxTo = mxTo || addDays(today(), -1);
  return `<section class="card" style="border:2px solid #d4a12a"><h2>Machines and metres (Excel)</h2>
    <p class="muted" style="margin-top:0">Every rig's metres per day for the dates you choose, with the status and delays from the shift reports, totals per machine and a chart.</p>
    <div class="row" style="align-items:flex-end"><label style="flex:1 1 150px">From <input type="date" id="mxFrom" value="${mxFrom}" min="${first}" max="${today()}"></label>
      <label style="flex:1 1 150px">To <input type="date" id="mxTo" value="${mxTo}" min="${first}" max="${today()}"></label>
      <button class="primary" id="mxGo" style="flex:1 1 220px;min-height:48px">Download machines and metres</button></div>
    <p style="margin:10px 0 0;font-size:18px"><b>${fmt(mxFrom)}</b> to <b>${fmt(mxTo)}</b></p></section>
    <section class="card"><h2>Add metres</h2>
    <form id="fMetres" class="grid" autocomplete="off">
      <label>Date <input type="date" name="date" value="${addDays(today(), -1)}" required></label>
      <label>Shift <select name="shift"><option>Day</option><option>Night</option></select></label>
      <label>Rig <select name="rig">${RIGS.map(r => `<option>${r}</option>`).join("")}</select></label>
      <label>Metres (fresh) <input name="metres" inputmode="decimal" required></label>
      <label>Block <input name="block"></label>
      <label>Supervisor <input name="supervisor"></label>
      <label style="grid-column:1/-1">Status / delays <input name="note" placeholder="For example Drifter out for service, No drill bit, Waiting for engine"></label>
      <div style="display:flex;align-items:flex-end"><button class="primary" style="width:100%">Add</button></div>
    </form></section>
    <section class="card"><h2>Latest metres</h2>${listOf(metres.map(x => ({ ...x, _c: "fcMetres" })), x => `${fmt(x.date)} ${esc(x.shift)} · <b>${esc(x.rig)}</b> · ${M1(num(x.metres))} m ${x.block ? "· " + esc(x.block) : ""} ${x.supervisor ? "· " + esc(x.supervisor) : ""}${x.note ? ` <span class="muted">· ${esc(x.note)}</span>` : ""}`)}</section>`;
}
function issuesView() {
  const list = allIssues();
  return `<div class="info">GET issued comes from the Drill Stores by itself. The store controllers log it in <a href="../stores/">Stores</a> → Drill Stores → Issue, and it shows here and in the forecast straight away.</div>
    <section class="card"><h2>GET issued</h2>${listOf(list.map(x => ({ ...x, _c: x.src === "stores" ? "" : "fcIssues" })), x => `${x.src === "stores" ? '<span class="pill closed">Drill Stores</span> ' : '<span class="pill">Earlier import</span> '}${fmt(x.date)} ${esc(x.shift || "")} · <b>${esc(x.qty)} × ${esc((STOCK_ITEMS.find(i => i[0] === x.item) || [])[2] || x.item)}</b> · ${esc(x.rig || "")} ${x.to ? "· to " + esc(x.to) : ""} ${x.by ? "· by " + esc(x.by) : ""}`)}</section>`;
}
function stockView(c) {
  const nm = k => (STOCK_ITEMS.find(i => i[0] === k) || [])[2] || k;
  return `<div class="info">GET stock comes from the Drill Stores by itself: what was received, less what was issued. Issues and deliveries are logged in <a href="../stores/">Stores</a> → Drill Stores.</div>
    <section class="card"><h2>GET stock now</h2><div class="tiles" style="margin-bottom:0">${STOCK_ITEMS.map(([k, n]) => tile(n, c.stock[k] ?? "–", "")).join("")}</div></section>
    <section class="card"><h2>GET issued and received</h2>${listOf(stMoves.filter(x => x.getKey && (x.kind === "issue" || x.kind === "receive")), x => `${x.kind === "issue" ? '<span class="pill">Issued</span>' : '<span class="pill closed">Received</span>'} ${fmt(x.date)} · <b>${esc(nm(x.getKey))}</b> · ${esc(num(x.qty))}${x.machine ? " · " + esc(x.machine) : ""}${x.kind === "issue" ? (x.to ? " · to " + esc(x.to) : "") : (x.from ? " · from " + esc(x.from) : "")}${x.byName ? " · " + esc(x.byName) : ""}`)}</section>`;
}
function settingsView() {
  const f = (k, i) => `<input name="${k}.${i}" inputmode="decimal" value="${esc(settings[k][i])}">`;
  return `<section class="card"><h2>Prices, target lives and spares</h2>
    <form id="fSettings" autocomplete="off"><div class="tbl"><table>
      <tr><th>Item</th><th>Unit price (R)</th><th>Target life (m)</th><th>Spare next week</th></tr>
      ${ITEMS.map(([k, n]) => `<tr><td>${n}</td><td>${f("price", k)}</td><td>${f("life", k)}</td><td>${f("spare", k)}</td></tr>`).join("")}
      <tr><td>Hammers</td><td>${f("price", "HAMMER")}</td><td class="muted">stock only</td><td></td></tr>
    </table></div>
    <div class="grid" style="margin-top:12px"><label>Next week bits (your estimate, empty = from the forecast) <input name="nextBits" inputmode="numeric" value="${esc(settings.nextBits ?? "")}"></label></div>
    <button class="primary" style="margin-top:12px">Save settings</button></form>
    <p class="muted">When a GET price is set in Stores → Items & prices, that price is used here. Hammers: R48 000 each; hammers count in the stock but not in cost per metre, like the tracker.</p>
    <p class="muted">These start with the values in your GET tracker: bits R9 000 / 600 m, rods R8 621 / 700 m, shanks R6 200 / 500 m, next week bits 5, 2 spare each.</p></section>`;
}
function importView() {
  return `<section class="card"><h2>Import from the GET tracker</h2>
    <p style="margin-top:0">Choose your Daily GET Consumption Tracker file (.xlsb or .xlsx). The app reads the Production, Consumption and Stock tabs and brings in every line. Importing again replaces the earlier import, so you can import the newest file any time.</p>
    <p class="muted">Lines you typed in this app are kept. Don't type a day here that is also in the file, or it counts twice.</p>
    <input type="file" id="impFile" accept=".xlsb,.xlsx,.xls">
    <p id="impMsg" class="muted">${esc(impStatus)}</p></section>
    <section class="card"><h2>Import a metres summary</h2>
    <p style="margin-top:0">Choose an Excel with one row per date: <b>Date</b>, <b>TDR 013</b>, <b>TDR 015</b>, <b>TDR 014</b>, and if you have it <b>Month to date</b>. The metres for those dates replace whatever the app had for them, so nothing counts twice.</p>
    <p class="muted">With a Month to date column, any site metres not split by rig are added per day as "Not allocated", so the month to date matches the site total. They count in month to date and cost per metre, not in a rig's average.</p>
    <input type="file" id="metFile" accept=".xlsx,.xls,.xlsb,.csv">
    <p id="metMsg" class="muted">${esc(metStatus)}</p></section>`;
}

/* ---------- events ---------- */
app.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.tab) { tab = b.dataset.tab; render(); return; }
  if (b.dataset.del) { const [c, id] = b.dataset.del.split("|"); if (confirm("Delete this line?")) deleteDoc(doc(db, c, id)).catch(fail); return; }
  if (b.id === "msgBtn") { const t = message(calc(reportDate)); try { await navigator.clipboard.writeText(t); toast("Message copied. Paste it into WhatsApp."); } catch { prompt("Copy the message:", t); } return; }
  if (b.id === "mxGo") { const f = $("mxFrom").value || mxFrom, t = $("mxTo").value || mxTo; if (f > t) { toast("Choose a From date before the To date."); return; }
    b.disabled = true; b.textContent = "Making the Excel file…"; try { await exportMetres(f, t); } catch (x) { console.warn(x); toast("The Excel file couldn't be made."); } render(); return; }
  if (b.id === "xlBtn") { b.disabled = true; b.textContent = "Making the Excel file…"; try { await exportExcel(calc(reportDate)); } catch (x) { console.warn(x); toast("The Excel file couldn't be made."); } render(); }
});
app.addEventListener("change", async e => {
  if (e.target.id === "mxFrom" || e.target.id === "mxTo") { if (e.target.id === "mxFrom") mxFrom = e.target.value || mxFrom; else mxTo = e.target.value || mxTo; render(); return; }
  if (e.target.id === "rd") { reportDate = e.target.value || ymd(new Date()); render(); }
  if (e.target.id === "impFile") importFile(e.target.files[0]);
  if (e.target.id === "metFile") importMetres(e.target.files[0]);
});
app.addEventListener("submit", async e => {
  e.preventDefault(); const f = e.target, v = Object.fromEntries(new FormData(f).entries()), now = Date.now();
  try {
    if (f.id === "fMetres") { await addDoc(collection(db, "fcMetres"), { date: v.date, shift: v.shift, rig: v.rig, metres: num(v.metres), block: v.block.trim(), supervisor: v.supervisor.trim(), note: (v.note || "").trim(), by: email, createdAt: now }); toast("Metres added"); }
    if (f.id === "fIssues") { await addDoc(collection(db, "fcIssues"), { date: v.date, shift: v.shift, rig: v.rig, item: v.item, qty: num(v.qty), to: v.to.trim(), by: v.by.trim(), createdAt: now }); toast("GET issued added"); }
    if (f.id === "fStock") {
      if (v.count === "" && v.received === "") { toast("Type a count or a received qty."); return; }
      await addDoc(collection(db, "fcCounts"), { date: v.date, item: v.item, count: v.count === "" ? null : num(v.count), received: num(v.received), by: v.by.trim(), createdAt: now }); toast("Stock added");
    }
    if (f.id === "fSettings") {
      const s = { price: {}, life: {}, spare: {} };
      ITEMS.forEach(([k]) => { s.price[k] = num(v["price." + k]); s.life[k] = num(v["life." + k]) || DEFAULTS.life[k]; s.spare[k] = num(v["spare." + k]); });
      s.price.HAMMER = num(v["price.HAMMER"]) || DEFAULTS.price.HAMMER;
      s.nextBits = v.nextBits === "" ? null : num(v.nextBits);
      await setDoc(doc(db, "fcSettings", "main"), s); toast("Settings saved");
    }
    f.reset?.();
  } catch (x) { fail(x); }
});

/* ---------- import the tracker file ---------- */
async function importFile(file) {
  if (!file) return; const msg = { set textContent(t) { impStatus = t; const el = $("impMsg"); if (el) el.textContent = t; } }; msg.textContent = "Reading the file…";
  try {
    await loadLib("../lib/xlsx.full.min.js");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const rows = n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null });
    const dateOf = v => { if (typeof v === "number") { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5); return d.toISOString().slice(0, 10); } if (v instanceof Date) return ymd(v); return null; };
    const code = s => String(s || "").toUpperCase().split("-")[0];
    if (!wb.Sheets.Production || !wb.Sheets.Consumption || !wb.Sheets.Stock) { msg.textContent = "This file doesn't have the Production, Consumption and Stock tabs."; return; }
    const summaryDays = new Set(metres.filter(x => x.src === "summary").map(x => x.date));   // a metres summary wins over the tracker for its dates
    const P = rows("Production").slice(6).map((r, i) => ({ i: i + 7, date: dateOf(r[0]), shift: r[1], rig: r[2], block: r[3], metres: num(r[4]), supervisor: r[5] })).filter(x => x.date && x.rig && !summaryDays.has(x.date));
    // GET already in the Stores section wins for its dates, so the same issue or count never counts twice
    const stDays = new Set(stMoves.filter(x => x.getKey).map(x => x.date).concat(stCounts.filter(x => x.getKey).map(x => x.date)));
    const stFrom = [...stDays].sort()[0] || "9999";
    const C = rows("Consumption").slice(6).map((r, i) => ({ i: i + 7, date: dateOf(r[0]), shift: r[1], rig: r[2], item: code(r[4]), qty: num(r[6]), note: r[11] })).filter(x => x.date && ["BIT", "ROD", "SHANK"].includes(x.item) && x.qty && x.date < stFrom);
    const S = rows("Stock").slice(6).map((r, i) => ({ i: i + 7, date: dateOf(r[0]), item: code(r[1]), received: num(r[3]), count: r[8] === null || r[8] === "" ? null : num(r[8]), by: r[11] })).filter(x => x.date && STOCK_ITEMS.some(s => s[0] === x.item) && x.date < stFrom);
    msg.textContent = `Found ${P.length} metre lines, ${C.length} GET issues and ${S.length} stock lines. Sending…`;
    // remove the earlier import, then write the new one
    for (const [col, arr] of [["fcMetres", metres], ["fcIssues", issues], ["fcCounts", counts]]) for (const x of arr) if (x.imported) await deleteDoc(doc(db, col, x.id));
    const now = Date.now(); let n = 0;
    for (const x of P) { await setDoc(doc(db, "fcMetres", "imp-p" + x.i), { date: x.date, shift: x.shift || "", rig: x.rig, block: String(x.block ?? ""), metres: x.metres, supervisor: x.supervisor || "", imported: true, createdAt: now + x.i }); n++; }
    for (const x of C) { await setDoc(doc(db, "fcIssues", "imp-c" + x.i), { date: x.date, shift: x.shift || "", rig: x.rig || "", item: x.item, qty: x.qty, to: "", by: "", note: x.note || "", imported: true, createdAt: now + x.i }); n++; }
    for (const x of S) { await setDoc(doc(db, "fcCounts", "imp-s" + x.i), { date: x.date, item: x.item, count: x.count, received: x.received, by: x.by || "", imported: true, createdAt: now + x.i }); n++; }
    msg.textContent = `Imported ${n} lines from ${file.name}.`; toast("Import done");
  } catch (x) { console.warn(x); msg.textContent = x?.code === "permission-denied" ? "Only an admin can import." : "The file couldn't be read. Save it again in Excel and try once more."; }
}

const normK = v => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function summaryLines(data) {
  const lines = []; let prevMtd = null, prevMonth = "";
  for (const d of data) {
    const rigSum = Object.values(d.rigs).reduce((a, b) => a + b, 0);
    Object.entries(d.rigs).forEach(([rig, m]) => { if (m) lines.push({ date: d.date, rig, metres: r1(m) }); });
    if (d.mtd !== null) { const mo = d.date.slice(0, 7); const site = mo !== prevMonth || prevMtd === null ? d.mtd : d.mtd - prevMtd; const diff = r1(site - rigSum);
      if (Math.abs(diff) >= 0.05) lines.push({ date: d.date, rig: "Not allocated", metres: diff }); prevMtd = d.mtd; prevMonth = mo; }
  }
  return lines;
}
async function writeSummary(data, lines) {
  const days = new Set(data.map(d => d.date));
  for (const x of metres.filter(x => days.has(x.date))) await deleteDoc(doc(db, "fcMetres", x.id));
  const now = Date.now(); let n = 0;
  for (const x of lines) { await setDoc(doc(db, "fcMetres", `sum-${x.date}-${normK(x.rig)}`), { date: x.date, shift: "", rig: x.rig, block: "", metres: x.metres, supervisor: "", src: "summary", note: x.rig === "Not allocated" ? "Site total not split by rig" : "", createdAt: now + n }); n++; }
  return n;
}
/* October 2026 metres (TKR October 2026 Drilling Metres Summary, 01/10 to 23/10): machine metres from the daily shift reports, month to date as per site totals.
   Loaded into the app once, the first time an admin opens the GET Forecast with signal. */
const OCT_2026 = [["01", 170.0, 70.0, 240.0], ["02", 170.0, 80.4, 483.0], ["03", 135.0, 207.1, 825.1], ["04", 166.9, 93.6, 1249.2], ["05", 142.5, 192.7, 1584.4], ["06", 180.1, 228.0, 1992.5],
  ["07", 80.0, 10.8, 2083.3], ["08", 96.7, 65.3, 2245.3], ["09", 157.1, 126.6, 2529.0], ["10", 0.0, 144.0, 2673.0], ["11", 50.4, 137.4, 2860.8], ["12", 0.0, 49.5, 2910.3],
  ["13", 69.5, 99.5, 3079.3], ["14", 164.4, 218.1, 3461.8], ["15", 147.1, 221.1, 3830.0], ["16", 33.7, 16.9, 3880.6], ["17", 0.0, 99.5, 4006.3], ["18", 132.1, 104.7, 4243.1],
  ["19", 71.8, 24.9, 4426.5], ["20", 59.4, 76.2, 4562.1], ["21", 34.8, 83.7, 4680.6], ["22", 0.0, 208.3, 4888.9], ["23", 0.0, 32.6, 4921.5]]
  .map(([d, a, b, mtd]) => ({ date: "2026-10-" + d, rigs: { "TDR 013": a, "TDR 015": b, "TDR 014": 0 }, mtd }));
let seeding = false;
async function seedOctober() {
  if (seeding || !isAdmin() || !navigator.onLine) return; seeding = true;
  try {
    const flag = doc(db, "fcSettings", "seed-2026-10-metres"); const f = await getDoc(flag);
    if (f.exists()) return;
    const n = await writeSummary(OCT_2026, summaryLines(OCT_2026));
    await setDoc(flag, { done: Date.now(), by: email, lines: n });
    toast("October metres (1–23 Oct) loaded: 4 921.5 m month to date");
  } catch (e) { console.warn(e); } finally { seeding = false; }
}
/* 24/10 and 25/10 shift reports (Soosans drilling group): no drilling on Saturday 24/10 day shift; night shifts 24/10 and 25/10 drilled 0 m
   (TDR013 drifter out for service, TDR015 no drill bit fit to use, TDR014 waiting for an engine). Loaded once, like the October metres. */
const LATE_2026_10 = [["2026-10-24", "Day", "", "", "No drilling on Saturday"],
  ["2026-10-24", "Night", "0423", "Katlego", "TDR013 drifter out for service · TDR015 no drill bit · TDR014 waiting for engine"],
  ["2026-10-25", "Night", "0423 / 0424", "Katlego", "TDR013 drifter out for service · TDR015 no drill bit fit to use · TDR014 waiting for engine"]];
let seedingLate = false;
/* Site month to date to 25/10 is 5 200 m (as given by Muneer); the 278.5 m above the rig figures is not split by rig or day, so it is booked on 25/10 as unassigned. */
let seedingSite = false;
async function seedSite5200() {
  if (seedingSite || !isAdmin() || !navigator.onLine) return; seedingSite = true;
  try {
  if (!(await getDoc(doc(db, "fcSettings", "seed-2026-10-24-25-metres"))).exists()) return;
  const flag = doc(db, "fcSettings", "adj-2026-10-25-5200"); if ((await getDoc(flag)).exists()) return;
  await setDoc(doc(db, "fcMetres", "adj-2026-10-25-NA"), { date: "2026-10-25", shift: "", rig: "Not allocated", block: "", metres: 278.5, supervisor: "", src: "summary", note: "Site total 5 200 m up to 25/10, not split by rig", createdAt: Date.now() });
  await setDoc(flag, { done: Date.now(), by: email });
  toast("Month to date set to 5 200 m (278.5 m unassigned on 25/10)");
  } catch (e) { console.warn(e); } finally { seedingSite = false; }
}
async function seedLate() {
  if (seedingLate || !isAdmin() || !navigator.onLine) return; seedingLate = true;
  try {
    const flag = doc(db, "fcSettings", "seed-2026-10-24-25-metres"); if ((await getDoc(flag)).exists()) return;
    if (!(await getDoc(doc(db, "fcSettings", "seed-2026-10-metres"))).exists()) return;
    const now = Date.now(); let n = 0;
    for (const [date, shift, block, sup, note] of LATE_2026_10) for (const rig of ["TDR 013", "TDR 015"]) {
      await setDoc(doc(db, "fcMetres", `rep-${date}-${shift}-${normK(rig)}`), { date, shift, rig, block, metres: 0, supervisor: sup, src: "report", note, createdAt: now + n }); n++; }
    await setDoc(flag, { done: now, by: email, lines: n });
    toast("Shift reports 24/10 and 25/10 loaded: 0 m");
  } catch (e) { console.warn(e); } finally { seedingLate = false; }
}
/* ---------- metres summary: Date | TDR 013 | TDR 015 | TDR 014 | (Month to date) ---------- */
async function importMetres(file) {
  if (!file) return; const say = t => { metStatus = t; const el = $("metMsg"); if (el) el.textContent = t; }; say("Reading the file…");
  try {
    await loadLib("../lib/xlsx.full.min.js");
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null });
    const norm = v => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const hi = rows.findIndex(r => r.some(v => norm(v) === "DATE") && r.some(v => norm(v).startsWith("TDR")));
    if (hi < 0) { say("No header row with Date and TDR columns was found."); return; }
    const H = rows[hi].map(norm), cDate = H.indexOf("DATE"), cMtd = H.findIndex(h => h.startsWith("MONTHTODATE"));
    const rigCols = RIGS.map(r => [r, H.findIndex(h => h.startsWith(norm(r)))]).filter(([, i]) => i >= 0);
    const dateOf = v => { if (typeof v === "number") return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5).toISOString().slice(0, 10);
      if (v instanceof Date) return ymd(v); const m = String(v || "").match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/); return m ? `${m[3]}-${pad(+m[2])}-${pad(+m[1])}` : null; };
    const data = rows.slice(hi + 1).map(r => ({ date: dateOf(r[cDate]), rigs: Object.fromEntries(rigCols.map(([rig, i]) => [rig, num(r[i])])), mtd: cMtd >= 0 && r[cMtd] !== null && r[cMtd] !== "" ? num(r[cMtd]) : null })).filter(x => x.date).sort((a, b) => a.date.localeCompare(b.date));
    if (!data.length) { say("No dated rows were found under the header."); return; }
    const lines = summaryLines(data);
    const total = r1(lines.reduce((a, x) => a + x.metres, 0));
    if (!confirm(`Import ${data.length} days (${fmt(data[0].date)} to ${fmt(data.at(-1).date)}), ${M1(total)} m in total?\nThe app's metres for these days are replaced.`)) { say("Nothing changed."); return; }
    say("Sending…"); const n = await writeSummary(data, lines);
    say(`Imported ${n} metre lines for ${data.length} days from ${file.name}. Month to date in the file: ${data.at(-1).mtd !== null ? M1(data.at(-1).mtd) + " m" : "not given"}.`); toast("Metres imported");
  } catch (x) { console.warn(x); say(x?.code === "permission-denied" ? "Only an admin can import." : "The file couldn't be read. Save it again in Excel and try once more."); }
}

/* ---------- WhatsApp message ---------- */
function message(c) {
  const w = c.week, oc = ITEMS.reduce((n, [k]) => n + c.orderNow[k] * settings.price[k], 0), nc = ITEMS.reduce((n, [k]) => n + c.next[k].order * settings.price[k], 0);
  const list = o => ITEMS.filter(([k]) => o[k]).map(([k]) => qn(k, o[k])).join(", ") || "nothing";
  return [`GET update ${fmt(c.rd)}`, "",
    `Metres: ${fmt(c.upToCal)} ${M1(c.day.metres)} m, this week to date ${M1(w.metres.toDate)} m, month to date ${M1(c.month.metres)} m.`,
    `GET this week to date: ${ITEMS.map(([k]) => qn(k, w.qty[k].toDate)).join(", ")}, ${R(w.cost.toDate)}${w.metres.toDate ? ` (${R2(w.cost.toDate / w.metres.toDate)}/m)` : ""}.`,
    `Stock in store (${fmt(c.upToCal)}): ${ITEMS.map(([k, n]) => `${n.toLowerCase()} ${c.stock[k] ?? "–"}`).join(", ")}.`,
    `Order this week: ${list(c.orderNow)} – ${R(oc)}.`,
    `Order next week: ${list(Object.fromEntries(ITEMS.map(([k]) => [k, c.next[k].order])))} – ${R(nc)}.`, "",
    `Total order both weeks: ${R(oc + nc)}`].join("\n");
}

/* ---------- branded Excel ---------- */
/* ---------- Excel export in the layout of the Daily GET Consumption Tracker ----------
   Same tabs as the tracker (Daily report, Prices, Consumption, Production, Stock, This week, Next week), TKR-branded, values worked out by the app. */
/* ---------- machines and metres Excel (Metres tab): chosen dates, every rig, statuses from the shift reports ---------- */
let mxFrom = "", mxTo = "";
function stackPng(days, rigs, colors, val) {
  const w = 1100, h = 430, k = 2, c = document.createElement("canvas"); c.width = w * k; c.height = h * k; const g = c.getContext("2d"); g.scale(k, k);
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.fillStyle = "#111"; g.fillRect(0, 0, w, 44); g.fillStyle = "#d4a12a"; g.fillRect(0, 44, w, 3);
  g.font = "bold 19px Arial"; g.fillStyle = "#fff"; g.textBaseline = "middle"; g.fillText("Metres drilled per day, by machine", 18, 23);
  let x0 = 18; g.font = "13px Arial"; rigs.forEach((r, i) => { g.fillStyle = colors[i]; g.fillRect(x0, 60, 14, 14); g.fillStyle = "#1a1a1a"; g.fillText(r, x0 + 20, 67); x0 += g.measureText(r).width + 46; });
  const left = 60, right = w - 16, top = 92, bottom = h - 40, tot = days.map(d => rigs.reduce((n, r) => n + Math.max(0, val(d, r)), 0)), max = Math.max(1, ...tot), cw = (right - left) / Math.max(1, days.length);
  g.strokeStyle = "#e6e0d2"; g.textAlign = "right"; for (let t = 0; t <= 4; t++) { const y = bottom - (bottom - top) * t / 4; g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke(); g.fillStyle = "#6b6558"; g.font = "11px Arial"; g.fillText(Math.round(max * t / 4), left - 6, y); }
  g.textAlign = "center";
  days.forEach((d, i) => { let y = bottom; const x = left + cw * i + cw * 0.15, bw = cw * 0.7;
    rigs.forEach((r, ri) => { const v = Math.max(0, val(d, r)); if (!v) return; const bh = (bottom - top) * v / max; g.fillStyle = colors[ri]; g.fillRect(x, y - bh, bw, bh); y -= bh; });
    if (tot[i] && days.length <= 31) { g.fillStyle = "#1a1a1a"; g.font = "bold 10px Arial"; g.fillText(Math.round(tot[i]), x + bw / 2, y - 8); }
    if (days.length <= 16 || i % Math.ceil(days.length / 16) === 0) { g.fillStyle = "#1a1a1a"; g.font = "11px Arial"; g.fillText(d.slice(8, 10) + "/" + d.slice(5, 7), x + bw / 2, bottom + 15); } });
  return c.toDataURL("image/png");
}
async function exportMetres(from, to) {
  toast("Making the machines and metres report…");
  try { await loadLib("../lib/exceljs.min.js"); } catch { toast("Open the app once with signal, then try again."); return; }
  const wb = new ExcelJS.Workbook(); wb.creator = "TKR Operations"; wb.created = new Date();
  let logo = null; try { logo = wb.addImage({ buffer: await (await fetch("../icons/icon-512.png")).arrayBuffer(), extension: "png" }); } catch {}
  const X = { BLACK: "FF111111", HEAD: "FF262626", GOLD: "FFD4A12A", CREAM: "FFFFF8E6", TOT: "FFFFF2CC", WHITE: "FFFFFFFF", GRID: "FFD9D3C5", MUTED: "FF6B6558", RED: "FFB3261E" };
  const fill = x => ({ type: "pattern", pattern: "solid", fgColor: { argb: x } }), thin = { style: "thin", color: { argb: X.GRID } }, box = { top: thin, left: thin, bottom: thin, right: thin };
  const F = (o = {}) => Object.assign({ name: "Arial", size: 10, color: { argb: X.BLACK } }, o);
  const D = s => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }, DEC1 = "#,##0.0";
  const period = from === to ? fmt(from) : `${fmt(from)}  to  ${fmt(to)}`;
  function sheet(name, widths, sub) {
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }], pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    ws.columns = widths.map(w => ({ width: w })); const n = widths.length, H = [8, 22, 30, 18];
    for (let r = 1; r <= 4; r++) { ws.getRow(r).height = H[r - 1]; for (let k = 1; k <= n; k++) ws.getCell(r, k).fill = fill(X.BLACK); }
    ws.getRow(5).height = 4; for (let k = 1; k <= n; k++) ws.getCell(5, k).fill = fill(X.GOLD);
    if (logo !== null) ws.addImage(logo, { tl: { col: 0.08, row: 1.12 }, ext: { width: 62, height: 62 } });
    const put = (r, v, f) => { const x = ws.getCell(r, 2); x.value = v; x.font = f; x.alignment = { vertical: "middle" }; };
    put(2, "TKR OPERATIONS – DRILLING: MACHINES AND METRES", F({ size: 13, bold: true, color: { argb: X.WHITE } }));
    put(3, "DATES:  " + period, F({ size: 20, bold: true, color: { argb: X.GOLD } }));
    put(4, sub, F({ size: 10, bold: true, color: { argb: X.WHITE } }));
    ws.views = [{ state: "frozen", ySplit: 5, showGridLines: false }]; return ws;
  }
  const head = (ws, r, labels) => { const row = ws.getRow(r); row.height = 30; labels.forEach((l, i) => { const x = row.getCell(i + 1); x.value = l; x.font = F({ bold: true, color: { argb: X.WHITE } }); x.fill = fill(X.HEAD); x.border = box; x.alignment = { vertical: "middle", horizontal: i ? "center" : "left", wrapText: true }; }); return r + 1; };
  const line = (ws, r, vals, i, o = {}) => { const row = ws.getRow(r); row.height = o.h || 18;
    vals.forEach((v, k) => { const x = row.getCell(k + 1); x.value = v === "" || v == null ? null : v; x.border = box; x.font = F({ bold: !!o.bold || k === 0 });
      x.alignment = { vertical: "middle", horizontal: typeof v === "number" || v instanceof Date ? "center" : "left", wrapText: true };
      if (typeof v === "number") x.numFmt = DEC1; if (v instanceof Date) x.numFmt = "dd/mm/yyyy";
      if (o.tot) { x.fill = fill(X.TOT); x.border = { ...box, top: { style: "medium", color: { argb: X.GOLD } } }; x.font = F({ bold: true }); } else if (i % 2) x.fill = fill(X.CREAM); });
    return r + 1; };
  const NA = "Not allocated", inR = x => x.date >= from && x.date <= to, list = metres.filter(inR);
  const rigs = [...RIGS, ...(list.some(x => x.rig === NA) ? [NA] : [])], label = r => r === NA ? "Unassigned" : r;
  const days = []; for (let d = parse(from); ymd(d) <= to; d.setDate(d.getDate() + 1)) days.push(ymd(d));
  const m = (d, r, sh) => list.filter(x => x.date === d && x.rig === r && (!sh || x.shift === sh)).reduce((n, x) => n + num(x.metres), 0);
  const notes = d => { const g = new Map(); list.filter(x => x.date === d && x.note).forEach(x => { const k = x.note.trim(); if (!g.has(k)) g.set(k, new Set()); if (x.rig !== NA) g.get(k).add(x.rig.replace(" ", "") + (x.shift ? " " + x.shift.toLowerCase() : "")); });
    return [...g.entries()].map(([t, rs]) => /TDR/i.test(t) || !rs.size ? t : [...rs].join(", ") + ": " + t).join(" | "); };
  // 1. per day
  let ws = sheet("Metres per day", [13, 13, 13, 13, ...(rigs.includes(NA) ? [14] : []), 13, 15, 60], "Metres per machine per day, with the status from the shift reports"), r = 7;
  r = head(ws, r, ["Date", ...rigs.map(label), "Day total", "Running total", "Status / delays"]);
  let run = 0;
  days.forEach((d, i) => { const v = rigs.map(rg => r1(m(d, rg))), t = r1(v.reduce((a, b) => a + b, 0)); run = r1(run + t);
    const nt = notes(d);
    r = line(ws, r, [D(d), ...v, t, run, nt], i, { h: nt.length > 70 ? 32 : 18 }); });
  const tots = rigs.map(rg => r1(list.filter(x => x.rig === rg).reduce((n, x) => n + num(x.metres), 0)));
  r = line(ws, r, ["Total", ...tots, r1(tots.reduce((a, b) => a + b, 0)), "", ""], 0, { tot: true });
  // chart
  const colors = ["#d4a12a", "#111111", "#2e7d4f", "#8a8378"];
  const png = stackPng(days, rigs.map(label), colors, (d, rg) => m(d, rigs[rigs.map(label).indexOf(rg)]));
  const im = await new Promise(res => { const x = new Image(); x.onload = () => res(x); x.src = png; });
  const id = wb.addImage({ base64: png, extension: "png" }); ws.addImage(id, { tl: { col: 0, row: r + 1 }, ext: { width: 980, height: Math.round(980 * im.height / im.width) } });
  // 2. per machine
  ws = sheet("Per machine", [18, 14, 16, 16, 18, 14], "Totals per machine for the dates chosen"); r = 7;
  r = head(ws, r, ["Machine", "Total (m)", "Days with metres", "Days on 0 m", "Average m per drilling day", "Share of total"]);
  const grand = tots.reduce((a, b) => a + b, 0) || 1;
  rigs.forEach((rg, i) => { const dd = days.map(d => m(d, rg)), drilled = dd.filter(v => v > 0).length, zero = days.filter(d => list.some(x => x.date === d && x.rig === rg) && m(d, rg) <= 0).length;
    const t = tots[i]; r = line(ws, r, [label(rg), t, drilled, rg === NA ? "" : zero, drilled ? r1(t / drilled) : 0, Math.round(t / grand * 1000) / 10 + "%"], i); });
  r = line(ws, r, ["All machines", r1(grand), "", "", "", "100%"], 0, { tot: true });
  // 3. every shift line
  ws = sheet("Shift detail", [13, 10, 14, 16, 12, 18, 70], "Every metres line captured"); r = 7;
  r = head(ws, r, ["Date", "Shift", "Machine", "Block", "Metres", "Supervisor", "Status / delays"]);
  list.slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.shift).localeCompare(String(b.shift)) || String(a.rig).localeCompare(String(b.rig)))
    .forEach((x, i) => { r = line(ws, r, [D(x.date), x.shift || "", label(x.rig), x.block || "", r1(num(x.metres)), x.supervisor || "", x.note || ""], i); });
  const buf = await wb.xlsx.writeBuffer(), blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const name = `TKR_Drilling_Machines_and_Metres_${fmt(from).replace(/\//g, "-")}${from === to ? "" : "_to_" + fmt(to).replace(/\//g, "-")}.xlsx`;
  const { deliver } = await import("../lib/deliver.js"); deliver(blob, name);
}

async function exportExcel(c) {
  await loadLib("../lib/exceljs.min.js");
  const ExcelJS = window.ExcelJS, wb = new ExcelJS.Workbook(); wb.creator = "TKR Operations"; wb.created = new Date();
  let logo = null; try { logo = wb.addImage({ buffer: await (await fetch("../icons/icon-512.png")).arrayBuffer(), extension: "png" }); } catch {}
  const X = { BLACK: "FF111111", HEAD: "FF262626", GOLD: "FFD4A12A", CREAM: "FFFFF8E6", TOT: "FFFFF2CC", WHITE: "FFFFFFFF", GRID: "FFD9D3C5", MUTED: "FF6B6558", RED: "FFB3261E", GREEN: "FF2E7D4F", YEL: "FFFFF2B3" };
  const fill = x => ({ type: "pattern", pattern: "solid", fgColor: { argb: x } }), thin = { style: "thin", color: { argb: X.GRID } }, box = { top: thin, left: thin, bottom: thin, right: thin };
  const F = (o = {}) => Object.assign({ name: "Arial", size: 10, color: { argb: X.BLACK } }, o);
  const D = s => { if (!s) return null; const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const MONEY = '"R" #,##0', MONEY2 = '"R" #,##0.00', DEC1 = "#,##0.0", DATE = "dd/mm/yyyy";
  function sheet(name, widths, title, sub) {
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }], pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    ws.columns = widths.map(w => ({ width: w })); const n = Math.max(6, widths.length);
    for (let r = 1; r <= 4; r++) { ws.getRow(r).height = r === 1 ? 8 : 20; for (let k = 1; k <= n; k++) ws.getCell(r, k).fill = fill(X.BLACK); }
    ws.getRow(5).height = 4; for (let k = 1; k <= n; k++) ws.getCell(5, k).fill = fill(X.GOLD);
    if (logo !== null) ws.addImage(logo, { tl: { col: 0.08, row: 1.08 }, ext: { width: 56, height: 56 } });
    const put = (r, v, f) => { const x = ws.getCell(r, 2); x.value = v; x.font = f; x.alignment = { vertical: "middle" }; };
    put(2, title, F({ size: 15, bold: true, color: { argb: X.WHITE } }));
    put(3, "TKR OPERATIONS  |  GROUND ENGAGING TOOLS", F({ size: 9, bold: true, color: { argb: X.GOLD } }));
    put(4, sub || `Report date ${fmt(c.upToCal)} · month ${fmt(c.monthStart)} to ${fmt(c.upToCal)}`, F({ size: 9, color: { argb: "FFCFC8B8" } }));
    ws.views = [{ state: "frozen", ySplit: 5, showGridLines: false }]; return ws;
  }
  function heading(ws, r, t) { const x = ws.getCell(r, 1); x.value = t; x.font = F({ size: 12, bold: true }); ws.getRow(r).height = 22; return r + 1; }
  function head(ws, r, labels) { const row = ws.getRow(r); row.height = 30; labels.forEach((l, i) => { const x = row.getCell(i + 1); x.value = l; x.font = F({ bold: true, color: { argb: X.WHITE } }); x.fill = fill(X.HEAD); x.border = box; x.alignment = { vertical: "middle", horizontal: i ? "center" : "left", wrapText: true }; }); return r + 1; }
  function line(ws, r, vals, i, o = {}) {
    const row = ws.getRow(r); row.height = o.h || 18;
    vals.forEach((v, k) => { const x = row.getCell(k + 1); x.value = v === "" || v === undefined ? null : v; x.border = box; x.font = F({ bold: !!o.bold || (o.boldFirst && k === 0) });
      x.alignment = { vertical: "middle", horizontal: typeof v === "number" || v instanceof Date ? "center" : "left", wrapText: true };
      const f = (o.fmt || {})[k]; if (f) x.numFmt = f; if (v instanceof Date) x.numFmt = DATE;
      if ((o.red || []).includes(k) && typeof v === "number" && v > 0) x.font = F({ bold: true, color: { argb: X.RED } });
      if (o.tot) { x.fill = fill(X.TOT); x.border = { ...box, top: { style: "medium", color: { argb: X.GOLD } } }; x.font = F({ bold: true }); } else if (i % 2) x.fill = fill(X.CREAM); });
    return r + 1;
  }
  function note(ws, r, t, n = 8) { ws.mergeCells(r, 1, r, n); const x = ws.getCell(r, 1); x.value = t; x.font = F({ size: 9, italic: true, color: { argb: X.MUTED } }); x.alignment = { wrapText: true, vertical: "top" }; ws.getRow(r).height = 26; return r + 1; }
  const freezeAt = (ws, row) => { ws.views = [{ state: "frozen", ySplit: row, showGridLines: false }]; };

  const NAME = { BIT: "Bit", ROD: "Rod", SHANK: "Shank", HAMMER: "Hammer" }, CODE = k => k + "-01";
  const price = k => num(settings.price[k]), life = k => num(settings.life[k]);
  const ms = c.monthStart, upTo = c.upToCal, inM = x => x.date >= ms && x.date <= upTo;
  const iss = allIssues().filter(inM).sort((a, b) => a.date.localeCompare(b.date) || String(a.shift).localeCompare(String(b.shift)));
  const cnts = allCounts().filter(x => x.date <= upTo);
  const mtdQty = k => iss.filter(x => x.item === k).reduce((n, x) => n + num(x.qty), 0);
  const mM = c.month.metres, mCost = c.month.cost, dM = c.day.metres, dCost = c.day.cost;

  // 1. Daily report
  let ws = sheet("Daily report", [30, 16, 16, 16, 16, 14, 14, 16, 16, 30], "TKR daily GET report");
  let r = 7;
  r = line(ws, r, ["Report date", D(upTo), "", "Month start", D(ms)], 0, { boldFirst: true }); r++;
  r = head(ws, r, ["Metric", "Daily", "Month to date"]);
  r = line(ws, r, ["Metres drilled", r1(dM), r1(mM)], 0, { fmt: { 1: DEC1, 2: DEC1 }, boldFirst: true });
  r = line(ws, r, ["GET consumption cost (R)", Math.round(dCost), Math.round(mCost)], 1, { fmt: { 1: MONEY, 2: MONEY }, boldFirst: true });
  r = line(ws, r, ["GET cost per metre (R/m)", dM ? dCost / dM : 0, mM ? mCost / mM : 0], 0, { fmt: { 1: MONEY2, 2: MONEY2 }, boldFirst: true }); r++;
  r = heading(ws, r, "GET usage by item (month to date)");
  r = head(ws, r, ["GET item", "MTD consumed qty", "Target life m/unit", "Expected MTD qty", "Expected cost (R)", "Stock on hand", "Excess qty (+)", "MTD cost (R)", "Variance (R)", "Comments"]);
  let tExp = 0, tCost = 0;
  ITEMS.forEach(([k], i) => { const q = mtdQty(k), exq = life(k) ? mM / life(k) : 0, exc = exq * price(k), cost = q * price(k); tExp += exc; tCost += cost;
    r = line(ws, r, [NAME[k], q, life(k), Math.round(exq * 10) / 10, Math.round(exc), c.stock[k] ?? "", Math.round((q - exq) * 10) / 10, cost, Math.round(exc - cost), ""], i, { fmt: { 4: MONEY, 7: MONEY, 8: MONEY }, red: [6], boldFirst: true }); });
  r = line(ws, r, [NAME.HAMMER, mtdQty("HAMMER"), "", "", "", c.stock.HAMMER ?? "", "", mtdQty("HAMMER") * price("HAMMER"), "", "Hammers are not in cost per metre"], 1, { fmt: { 7: MONEY }, boldFirst: true });
  r = line(ws, r, ["Total: bit, rod and shank", "", "", "", Math.round(tExp), "", "", tCost, Math.round(tExp - tCost), ""], 0, { tot: true, fmt: { 4: MONEY, 7: MONEY, 8: MONEY } });
  r = note(ws, r, "Expected qty = month-to-date metres ÷ target life. Positive excess = more used than expected. Negative variance = cost above what the metres allow.", 10); r++;
  r = heading(ws, r, "Variance against standard (month to date)");
  r = head(ws, r, ["GET item", "Standard price (R)", "Life (m/unit)", "Standard R/m", "Allowed MTD cost (R)", "Consumption variance (R)", "Price variance (R)", "Total variance (R)"]);
  let tAll = 0, tVar = 0;
  ITEMS.forEach(([k], i) => { const allowed = life(k) ? mM / life(k) * price(k) : 0, v = mtdQty(k) * price(k) - allowed; tAll += allowed; tVar += v;
    r = line(ws, r, [NAME[k], price(k), life(k), life(k) ? price(k) / life(k) : 0, Math.round(allowed), Math.round(v), 0, Math.round(v)], i, { fmt: { 1: MONEY, 3: MONEY2, 4: MONEY, 5: MONEY, 6: MONEY, 7: MONEY }, red: [5, 7], boldFirst: true }); });
  r = line(ws, r, ["Total: bit, rod and shank", "", "", c.std, Math.round(tAll), Math.round(tVar), 0, Math.round(tVar)], 0, { tot: true, fmt: { 3: MONEY2, 4: MONEY, 5: MONEY, 6: MONEY, 7: MONEY } });
  r = note(ws, r, "Positive variance = higher cost than standard. Negative variance = saving. Price variance = quantity × (actual price − standard price).", 8);

  // 2. Prices
  ws = sheet("Prices", [14, 14, 26, 16, 18, 26, 20], "GET price register", "Unit prices and target lives used in every tab");
  r = head(ws, 7, ["Price code", "GET item", "Specification / size", "Unit price (R)", "Target life (m/unit)", "Supplier / effective date", "Standard unit price (R)"]);
  STOCK_ITEMS.forEach(([k, n, l], i) => { r = line(ws, r, [CODE(k), NAME[k], l, price(k) || "", k === "HAMMER" ? "" : life(k), "", price(k) || ""], i, { fmt: { 3: MONEY, 6: MONEY } }); });
  freezeAt(ws, 7);

  // 3. Consumption
  ws = sheet("Consumption", [12, 9, 18, 12, 12, 16, 9, 13, 13, 9, 22, 40, 14], "Daily GET consumption");
  r = head(ws, 7, ["Date", "Shift", "Drill", "Block", "Price code", "Reason", "Qty consumed", "Unit price (R)", "Cost (R)", "Item", "Notes", "Reference / serial", "Approved by"]);
  const blockOf = x => metres.find(m => m.date === x.date && (!x.shift || m.shift === x.shift) && m.block)?.block || "";
  iss.forEach((x, i) => { r = line(ws, r, [D(x.date), x.shift || "", x.rig || "", x.block || blockOf(x), CODE(x.item), "Issued from store", num(x.qty), price(x.item), num(x.qty) * price(x.item), NAME[x.item] || x.item, x.note || "",
    [x.to && "to " + x.to, x.by && "by " + x.by].filter(Boolean).join(" · "), ""], i, { fmt: { 7: MONEY, 8: MONEY } }); });
  r = line(ws, r, ["Total", "", "", "", "", "", iss.reduce((n, x) => n + num(x.qty), 0), "", iss.reduce((n, x) => n + num(x.qty) * price(x.item), 0), "", "", "", ""], 0, { tot: true, fmt: { 8: MONEY } });
  freezeAt(ws, 7);

  // 4. Production
  ws = sheet("Production", [12, 10, 16, 14, 15, 30, 18], "Daily drilling metres");
  r = head(ws, 7, ["Date", "Shift", "Drill", "Block", "Metres drilled", "Supervisor", "Unassigned metres (not split by rig)"]);
  const prod = metres.filter(inM).sort((a, b) => a.date.localeCompare(b.date) || String(a.shift).localeCompare(String(b.shift)) || String(a.rig).localeCompare(String(b.rig)));
  const isNA = x => x.rig === "Not allocated";
  prod.forEach((x, i) => { r = line(ws, r, [D(x.date), x.shift || "", isNA(x) ? "Unassigned" : x.rig, x.block || "", isNA(x) ? "" : num(x.metres), x.supervisor || x.note || "", isNA(x) ? num(x.metres) : ""], i, { fmt: { 4: DEC1, 6: DEC1 } }); });
  const naM = prod.filter(isNA).reduce((n, x) => n + num(x.metres), 0);
  r = line(ws, r, ["Month to date", "", "", "", r1(mM - naM), `All rigs and unassigned: ${M1(mM)} m`, r1(naM)], 0, { tot: true, fmt: { 4: DEC1, 6: DEC1 } });
  freezeAt(ws, 7);

  // 5. Stock (daily reconciliation, worked out from counts, receipts and issues)
  ws = sheet("Stock", [12, 13, 12, 11, 12, 12, 14, 14, 14, 12, 16, 14, 34], "Daily GET stock reconciliation");
  r = head(ws, 7, ["Date", "Price code", "Opening store qty", "Receipts", "Issued to drills", "Returns to store", "Other out / write-off", "Expected closing", "Actual closing qty", "Variance qty", "Variance value (R)", "Checked by", "Action / explanation"]);
  const days = []; for (let d = ms; d <= upTo; d = addDays(d, 1)) days.push(d);
  let k2 = 0;
  for (const d of days) for (const [k] of STOCK_ITEMS) {
    const recv = cnts.filter(x => x.item === k && x.date === d).reduce((n, x) => n + num(x.received), 0);
    const out = iss.filter(x => x.item === k && x.date === d).reduce((n, x) => n + num(x.qty), 0);
    const cnt = cnts.filter(x => x.item === k && x.date === d && x.count !== "" && x.count != null).at(-1);
    if (!cnt && !recv && !out) continue;
    const prev = cnts.filter(x => x.item === k && x.date < d && x.count !== "" && x.count != null).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
    const open = prev ? num(prev.count) + cnts.filter(x => x.item === k && x.date > prev.date && x.date < d).reduce((n, x) => n + num(x.received), 0) - iss.filter(x => x.item === k && x.date > prev.date && x.date < d).reduce((n, x) => n + num(x.qty), 0) : "";
    const exp = open === "" ? "" : open + recv - out, act = cnt ? num(cnt.count) : "", vq = act !== "" && exp !== "" ? act - exp : "";
    r = line(ws, r, [D(d), CODE(k), open, recv, out, 0, 0, exp, act, vq, vq === "" ? "" : vq * price(k), cnt?.by || "", ""], k2++, { fmt: { 10: MONEY } });
    if (typeof vq === "number" && vq < 0) [10, 11].forEach(col => ws.getRow(r - 1).getCell(col).font = F({ bold: true, color: { argb: X.RED } }));
  }
  freezeAt(ws, 7);

  // 6. This week
  const w = c.week, wk = `${short(c.weekStart)} – ${short(c.weekEnd)}`, lw = `${short(c.lastStart)} – ${short(c.lastEnd)}`;
  ws = sheet("This week", [30, 17, 17, 19, 17, 14, 40], "This week – GET used and stock");
  r = heading(ws, 7, "Dates");
  r = line(ws, r, ["Report date", D(c.rd), ""], 0, { boldFirst: true });
  r = line(ws, r, ["Actuals up to (yesterday)", D(upTo), ""], 1, { boldFirst: true });
  r = line(ws, r, ["This week (Mon – Sun)", D(c.weekStart), wk], 0, { boldFirst: true });
  r = line(ws, r, ["Last week (Mon – Sun)", D(c.lastStart), lw], 1, { boldFirst: true });
  r = line(ws, r, ["Production captured up to", D(c.lastProd || upTo), c.lastProd && c.lastProd < upTo ? "Metres still to be added" : "Up to date"], 0, { boldFirst: true }); r++;
  r = heading(ws, r, "1. GET used – last week against this week");
  r = head(ws, r, ["Item", "Last week (actual)", "This week to date", "Rest of this week (forecast)", "This week total", "Difference", "Comments"]);
  r = line(ws, r, ["Dates", lw, c.actualDays ? `${short(c.weekStart)} – ${short(upTo)}` : "–", c.projDays ? `${short(addDays(c.weekStart, c.actualDays))} – ${short(c.weekEnd)}` : "–", wk, "", ""], 1, { boldFirst: true });
  ITEMS.forEach(([k, n], i) => { const q = w.qty[k], tot = q.toDate + q.rest; r = line(ws, r, [n + " used", q.last, q.toDate, q.rest, tot, tot - q.last, ""], i, { red: [5], boldFirst: true }); });
  const wTot = w.cost.toDate + w.cost.rest, mTot = w.metres.toDate + w.metres.rest;
  r = line(ws, r, ["GET cost (R)", Math.round(w.cost.last), Math.round(w.cost.toDate), Math.round(w.cost.rest), Math.round(wTot), Math.round(wTot - w.cost.last), `Rest of this week forecast at the average of the last ${settings.avgDays} days (${short(c.avgFrom)} – ${short(c.upTo)})`], 0, { fmt: { 1: MONEY, 2: MONEY, 3: MONEY, 4: MONEY, 5: MONEY }, red: [5], boldFirst: true });
  r = line(ws, r, ["Metres drilled", r1(w.metres.last), r1(w.metres.toDate), r1(w.metres.rest), r1(mTot), r1(mTot - w.metres.last), ""], 1, { fmt: { 1: DEC1, 2: DEC1, 3: DEC1, 4: DEC1, 5: DEC1 }, boldFirst: true });
  const rm = (cst, m) => m ? cst / m : 0;
  r = line(ws, r, ["GET cost per metre (R/m)", rm(w.cost.last, w.metres.last), rm(w.cost.toDate, w.metres.toDate), rm(w.cost.rest, w.metres.rest), rm(wTot, mTot), rm(wTot, mTot) - rm(w.cost.last, w.metres.last), `Last week ${R2(rm(w.cost.last, w.metres.last))}/m against ${R2(c.std)}/m standard`], 0, { fmt: { 1: MONEY2, 2: MONEY2, 3: MONEY2, 4: MONEY2, 5: MONEY2 }, red: [5], boldFirst: true });
  r = line(ws, r, ["Standard GET cost per metre (R/m)", c.std, "", "", "", "", ""], 1, { fmt: { 1: MONEY2 }, boldFirst: true }); r++;
  r = heading(ws, r, "2. GET stock and order for the rest of this week");
  r = head(ws, r, ["Item", "Stock on hand", "Stock count date", "Needed rest of this week", "Order now", "Order cost (R)", "Comments"]);
  let oc = 0;
  ITEMS.forEach(([k, n], i) => { const cost = c.orderNow[k] * price(k); oc += cost;
    r = line(ws, r, [n, c.stock[k] ?? "", c.stockDate[k] ? D(c.stockDate[k]) : "", w.qty[k].rest, c.orderNow[k], cost, c.stock[k] === null ? "No stock count yet" : `${c.stock[k]} in store, need ${w.qty[k].rest} up to Sunday ${fmt(c.weekEnd).slice(0, 5)}`], i, { fmt: { 5: MONEY }, red: [4], boldFirst: true }); });
  r = line(ws, r, ["Total", "", "", "", "", oc, ""], 0, { tot: true, fmt: { 5: MONEY } }); r++;
  r = heading(ws, r, "3. Metres by machine (actual up to yesterday)");
  r = head(ws, r, ["Machine", "Day shift (month)", "Night shift (month)", "Month to date", "This week to date", "Last week", "Comments"]);
  const ms_ = (rig, sh, a, b) => metres.filter(x => x.rig === rig && x.date >= a && x.date <= b && (!sh || x.shift === sh)).reduce((n, x) => n + num(x.metres), 0);
  const rigsAll = [...RIGS, ...(metres.some(x => x.rig === "Not allocated" && inM(x)) ? ["Not allocated"] : [])];
  rigsAll.forEach((g, i) => { const other = ms_(g, null, ms, upTo) - ms_(g, "Day", ms, upTo) - ms_(g, "Night", ms, upTo);
    r = line(ws, r, [g === "Not allocated" ? "Unassigned" : g, r1(ms_(g, "Day", ms, upTo)), r1(ms_(g, "Night", ms, upTo)), r1(ms_(g, null, ms, upTo)), r1(c.actualDays ? ms_(g, null, c.weekStart, upTo) : 0), r1(ms_(g, null, c.lastStart, c.lastEnd)), other > 0.05 ? `${M1(other)} m not split by shift` : (g === "Not allocated" ? "Site total not split by rig" : "")], i, { fmt: { 1: DEC1, 2: DEC1, 3: DEC1, 4: DEC1, 5: DEC1 }, boldFirst: true }); });
  r = line(ws, r, ["Total", "", "", r1(mM), r1(w.metres.toDate), r1(w.metres.last), ""], 0, { tot: true, fmt: { 3: DEC1, 4: DEC1, 5: DEC1 } }); r++;
  const ex = explain(c); [...ex.out, ...ex.warn].forEach(t => { r = note(ws, r, t, 7); });

  // 7. Next week
  const nStart = addDays(c.weekStart, 7), nEnd = addDays(c.weekStart, 13);
  ws = sheet("Next week", [24, 15, 16, 16, 18, 12, 14, 16, 40], "Next week – GET forecast and order");
  r = heading(ws, 7, "Dates");
  r = line(ws, r, ["Next week (Mon – Sun)", D(nStart), `${short(nStart)} – ${short(nEnd)}`], 0, { boldFirst: true });
  r = line(ws, r, ["Production captured up to", D(c.lastProd || upTo), c.lastProd && c.lastProd < upTo ? "Metres still to be added" : "Up to date"], 1, { boldFirst: true }); r++;
  r = heading(ws, r, "1. GET forecast and order for next week");
  r = head(ws, r, ["Item", "Forecast need", "Extra (spare)", "Total needed", "Stock left after this week", "Order", "Unit price (R)", "Order cost (R)", "Comments"]);
  let nc = 0;
  ITEMS.forEach(([k, n], i) => { const x = c.next[k], cost = x.order * price(k); nc += cost;
    r = line(ws, r, [n, x.need, x.spare, x.total, x.left, x.order, price(k), cost, `Forecast ${x.need} + ${x.spare} spare. ${x.left} left after this week, order ${x.order}`], i, { fmt: { 6: MONEY, 7: MONEY }, red: [5], boldFirst: true }); });
  r = line(ws, r, ["Total", "", "", "", "", "", "", nc, ""], 0, { tot: true, fmt: { 7: MONEY } });
  r = line(ws, r, ["Order both weeks", "", "", "", "", "", "", oc + nc, `This week ${R(oc)} + next week ${R(nc)}`], 0, { tot: true, fmt: { 7: MONEY } }); r++;
  r = heading(ws, r, "2. This week against next week");
  r = head(ws, r, ["Item", "This week total", "Next week (forecast)", "Difference", "Comments"]);
  const nCost = ITEMS.reduce((n, [k]) => n + c.next[k].need * price(k), 0);
  r = line(ws, r, ["Metres drilled", r1(mTot), r1(c.nextM), r1(c.nextM - mTot), `Same m/day as the last ${settings.avgDays} days (${short(c.avgFrom)} – ${short(c.upTo)})`], 0, { fmt: { 1: DEC1, 2: DEC1, 3: DEC1 }, boldFirst: true });
  r = line(ws, r, ["GET cost (R), excluding spare", Math.round(wTot), Math.round(nCost), Math.round(nCost - wTot), ""], 1, { fmt: { 1: MONEY, 2: MONEY, 3: MONEY }, boldFirst: true }); r++;
  r = heading(ws, r, "3. Daily plan next week");
  const rigsOn = RIGS.filter(g => (c.avg[g] || 0) > 0);
  r = head(ws, r, ["Date", "Day", ...rigsOn.map(g => g + " metres"), "Total metres"]);
  for (let i = 0; i < 7; i++) { const d = addDays(nStart, i), vals = rigsOn.map(g => r1(c.avg[g])); r = line(ws, r, [D(d), dayName(d), ...vals, r1(vals.reduce((a, b) => a + b, 0))], i, { fmt: Object.fromEntries([...rigsOn.map((_, j) => [j + 2, DEC1]), [rigsOn.length + 2, DEC1]]) }); }
  r = line(ws, r, ["Week total", "", ...rigsOn.map(g => r1(c.avg[g] * 7)), r1(c.nextM)], 0, { tot: true, fmt: Object.fromEntries([...rigsOn.map((_, j) => [j + 2, DEC1]), [rigsOn.length + 2, DEC1]]) }); r++;
  r = note(ws, r, `Bits forecast need = ${settings.nextBits ?? "next week metres ÷ bit life"} (stores estimate). Rods and shanks = next week metres ÷ life per unit this month, rounded. Extra (spare) covers losses in the hole.`, 9);
  r = note(ws, r, "Stock left after this week = stock on hand less what is still needed this week. Order = total needed less stock left. Red = items to order.", 9);

  const out = await wb.xlsx.writeBuffer();
  const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), name = `TKR_GET_Tracker_${fmt(upTo).replace(/\//g, "-")}.xlsx`;
  const { deliver } = await import("../lib/deliver.js");
  deliver(blob, name, { doneLabel: "Done – clear this phone's copy", onDone: async () => { const fb = await import("../lib/firebase.js"); const { clearPhoneCopy } = await import("../lib/deliver.js"); await clearPhoneCopy(fb, [db], toast); } });
}

// A new version of the app was installed: load it straight away instead of on the next open.
if("serviceWorker" in navigator&&navigator.serviceWorker.controller){let reloaded=false;navigator.serviceWorker.addEventListener("controllerchange",()=>{if(reloaded)return;reloaded=true;location.reload()})}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js", { scope: "../", updateViaCache: "none" }).then(r => r.update()).catch(() => {});
