/* TKR GET Forecast — metres per rig + GET issued + stock counts in, forecast and order out.
   Works like the Daily GET Consumption Tracker: same prices, target lives and forecast method.
   Data is shared online in Firebase (admins write, managers read). */
import {
  initializeApp, getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, addDoc, setDoc, deleteDoc, getDoc, onSnapshot, query, where,
} from "../lib/firebase.js";

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
const fromStores = () => stMoves.filter(x => x.getKey && x.kind === "issue").map(x => ({ id: x.id, date: x.date, shift: x.shift || "", rig: x.machine || "", item: x.getKey, qty: num(x.qty), to: x.to || "", by: x.byName || "", src: "stores" }));
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
function showGate(msg = "") { $("gate").hidden = false; app.hidden = true; $("signBtn").hidden = true; $("who").textContent = ""; $("sErr").textContent = msg; }
function gateOrApp() {
  if (!isManager()) { showGate("This sign-in is not an admin or manager. Ask admin."); return; }
  $("gate").hidden = true; app.hidden = false; $("signBtn").hidden = false; $("who").textContent = email + (isAdmin() ? " · admin" : " · manager");
  if (subs.length === 1) {
    const live = (name, set) => subs.push(onSnapshot(collection(db, name), s => { set(s.docs.map(d => ({ id: d.id, ...d.data() }))); render(); }, e => netNote("Couldn't load. Check the signal.")));
    live("fcMetres", v => { metres = v; if (isAdmin()) setTimeout(seedOctober, 1500); }); live("fcIssues", v => issues = v); live("fcCounts", v => counts = v);
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
  try { await signInWithEmailAndPassword(auth, $("sEmail").value.trim(), $("sPass").value); $("sPass").value = ""; }
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
  ITEMS.forEach(([k, n]) => { if (c.stock[k] === null) warn.push(`No stock count for ${n.toLowerCase()} yet. Add one under Stock.`); });
  return { out, warn };
}

/* ---------- rendering ---------- */
const tabs = [["dash", "Dashboard"], ["metres", "Metres"], ["issues", "GET issued"], ["stock", "Stock"], ["settings", "Settings"], ["import", "Import"]];
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
  const empty = !metres.length && !issues.length;
  return `
  <div class="strip">
    <div><h2>${esc(dayName(c.rd))} ${fmt(c.rd)}</h2><div class="muted">This week ${short(c.weekStart)} – ${short(c.weekEnd)} · actuals up to ${fmt(c.upToCal)}</div></div>
    <div class="row"><label>Report date <input type="date" id="rd" value="${c.rd}"></label>
      <button id="msgBtn">WhatsApp message</button><button class="primary" id="xlBtn">Export to Excel</button></div>
  </div>
  ${empty ? `<div class="notice"><b class="t">No data yet</b>${isAdmin() ? "Tap Import and choose your GET tracker file to bring in October so far, or add metres, GET issued and a stock count." : "Ask admin to import the GET tracker or add the metres."}</div>` : ""}
  <div class="notice"><b class="t">Why the forecast looks like this</b><ul>${ex.out.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>
  ${ex.warn.length ? `<div class="notice warn"><b class="t">Check</b><ul>${ex.warn.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
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
function listOf(arr, line) {
  const rows = arr.slice().sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 40);
  return `<div class="list">${rows.map(x => `<div class="it"><span>${line(x)}</span>${x._c ? `<button class="danger" data-del="${esc(x._c)}|${esc(x.id)}">Delete</button>` : '<span class="muted">from Stores</span>'}</div>`).join("") || `<div class="muted">Nothing yet.</div>`}</div>`;
}
const today = () => ymd(new Date());
function metresView() {
  return `<section class="card"><h2>Add metres</h2>
    <form id="fMetres" class="grid" autocomplete="off">
      <label>Date <input type="date" name="date" value="${addDays(today(), -1)}" required></label>
      <label>Shift <select name="shift"><option>Day</option><option>Night</option></select></label>
      <label>Rig <select name="rig">${RIGS.map(r => `<option>${r}</option>`).join("")}</select></label>
      <label>Metres (fresh) <input name="metres" inputmode="decimal" required></label>
      <label>Block <input name="block"></label>
      <label>Supervisor <input name="supervisor"></label>
      <div style="display:flex;align-items:flex-end"><button class="primary" style="width:100%">Add</button></div>
    </form></section>
    <section class="card"><h2>Latest metres</h2>${listOf(metres.map(x => ({ ...x, _c: "fcMetres" })), x => `${fmt(x.date)} ${esc(x.shift)} · <b>${esc(x.rig)}</b> · ${M1(num(x.metres))} m ${x.block ? "· " + esc(x.block) : ""} ${x.supervisor ? "· " + esc(x.supervisor) : ""}`)}</section>`;
}
function issuesView() {
  const list = allIssues();
  return `<div class="info">GET issued and received at the Drill Stores (the Stores section) comes in here by itself, with the prices set in Stores. Only add GET here that was not logged in Stores, or it counts twice.</div>
    <section class="card"><h2>Add GET issued</h2>
    <form id="fIssues" class="grid" autocomplete="off">
      <label>Date <input type="date" name="date" value="${today()}" required></label>
      <label>Shift <select name="shift"><option>Day</option><option>Night</option></select></label>
      <label>Rig <select name="rig">${[...RIGS, "TDR 013 / TDR 015"].map(r => `<option>${r}</option>`).join("")}</select></label>
      <label>Item <select name="item">${ITEMS.map(([k, n, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
      <label>Qty <input name="qty" inputmode="numeric" value="1" required></label>
      <label>Issued to <input name="to"></label>
      <label>Issued by <input name="by"></label>
      <div style="display:flex;align-items:flex-end"><button class="primary" style="width:100%">Add</button></div>
    </form></section>
    <section class="card"><h2>Latest GET issued</h2>${listOf(list.map(x => ({ ...x, _c: x.src === "stores" ? "" : "fcIssues" })), x => `${x.src === "stores" ? '<span class="pill closed">Stores</span> ' : ""}${fmt(x.date)} ${esc(x.shift || "")} · <b>${esc(x.qty)} × ${esc((STOCK_ITEMS.find(i => i[0] === x.item) || [])[2] || x.item)}</b> · ${esc(x.rig || "")} ${x.to ? "· to " + esc(x.to) : ""} ${x.by ? "· by " + esc(x.by) : ""}`)}</section>`;
}
function stockView(c) {
  return `<section class="card"><h2>Stock count or GET received</h2>
    <div class="info">Stock counts and GET received at the Drill Stores (the Stores section) come in here by themselves. You only need this form for GET that was not logged in Stores.</div>
    <p class="muted" style="margin-top:0">Type the count from the closing report. If stock was received from the supplier, add it under Received.</p>
    <form id="fStock" class="grid" autocomplete="off">
      <label>Date <input type="date" name="date" value="${addDays(today(), -1)}" required></label>
      <label>Item <select name="item">${STOCK_ITEMS.map(([k, n, l]) => `<option value="${k}">${l}</option>`).join("")}</select></label>
      <label>Count in store <input name="count" inputmode="numeric"></label>
      <label>Received <input name="received" inputmode="numeric"></label>
      <label>Counted by <input name="by"></label>
      <div style="display:flex;align-items:flex-end"><button class="primary" style="width:100%">Add</button></div>
    </form>
    <p class="muted">On hand now: ${STOCK_ITEMS.map(([k, n]) => `${n.toLowerCase()} ${c.stock[k] ?? "–"}`).join(" · ")}</p></section>
    <section class="card"><h2>Latest counts</h2>${listOf(allCounts().map(x => ({ ...x, _c: x.src === "stores" ? "" : "fcCounts" })), x => `${x.src === "stores" ? '<span class="pill closed">Stores</span> ' : ""}${fmt(x.date)} · <b>${esc((STOCK_ITEMS.find(i => i[0] === x.item) || [])[2] || x.item)}</b> ${x.count !== "" && x.count != null ? "· count " + esc(x.count) : ""} ${num(x.received) ? "· received " + esc(x.received) : ""} ${x.by ? "· " + esc(x.by) : ""}`)}</section>`;
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
  if (b.id === "xlBtn") { b.disabled = true; b.textContent = "Making the Excel file…"; try { await exportExcel(calc(reportDate)); } catch (x) { console.warn(x); toast("The Excel file couldn't be made."); } render(); }
});
app.addEventListener("change", async e => {
  if (e.target.id === "rd") { reportDate = e.target.value || ymd(new Date()); render(); }
  if (e.target.id === "impFile") importFile(e.target.files[0]);
  if (e.target.id === "metFile") importMetres(e.target.files[0]);
});
app.addEventListener("submit", async e => {
  e.preventDefault(); const f = e.target, v = Object.fromEntries(new FormData(f).entries()), now = Date.now();
  try {
    if (f.id === "fMetres") { await addDoc(collection(db, "fcMetres"), { date: v.date, shift: v.shift, rig: v.rig, metres: num(v.metres), block: v.block.trim(), supervisor: v.supervisor.trim(), by: email, createdAt: now }); toast("Metres added"); }
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
async function exportExcel(c) {
  await loadLib("../lib/exceljs.min.js");
  const ExcelJS = window.ExcelJS, wb = new ExcelJS.Workbook(); wb.creator = "TKR Operations";
  let logo = null; try { logo = wb.addImage({ buffer: await (await fetch("../icons/icon-512.png")).arrayBuffer(), extension: "png" }); } catch {}
  const BLACK = "FF111111", HEAD = "FF262626", GOLD = "FFD4A12A", CREAM = "FFFFF8E6", WHITE = "FFFFFFFF", GRID = "FFD9D3C5";
  const fill = x => ({ type: "pattern", pattern: "solid", fgColor: { argb: x } }), thin = { style: "thin", color: { argb: GRID } }, box = { top: thin, left: thin, bottom: thin, right: thin };
  const sheet = (name, widths, title) => {
    const ws = wb.addWorksheet(name, { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    ws.columns = widths.map(w => ({ width: w })); const cols = Math.max(6, widths.length);
    for (let r = 1; r <= 4; r++) { ws.getRow(r).height = r === 1 ? 8 : 22; for (let k = 1; k <= cols; k++) ws.getCell(r, k).fill = fill(BLACK); }
    for (let k = 1; k <= cols; k++) ws.getCell(5, k).fill = fill(GOLD); ws.getRow(5).height = 4;
    if (logo !== null) ws.addImage(logo, { tl: { col: 0.15, row: 1.05 }, ext: { width: 62, height: 62 } });
    ws.getCell("B2").value = title; ws.getCell("B2").font = { name: "Arial", size: 18, bold: true, color: { argb: WHITE } };
    ws.getCell("B3").value = "TKR OPERATIONS  ·  GROUND ENGAGING TOOLS"; ws.getCell("B3").font = { name: "Arial", size: 9, bold: true, color: { argb: GOLD } };
    ws.getCell("B4").value = `Report date ${fmt(c.rd)} · actuals up to ${fmt(c.upToCal)}`; ws.getCell("B4").font = { name: "Arial", size: 10, color: { argb: "FFE8E2D4" } };
    ws.views = [{ showGridLines: false }]; return ws;
  };
  const table = (ws, r0, head, rows, totLast) => {
    const h = ws.getRow(r0); h.height = 28;
    head.forEach((t, i) => { const x = h.getCell(i + 1); x.value = t; x.font = { name: "Arial", size: 10, bold: true, color: { argb: WHITE } }; x.fill = fill(HEAD); x.border = box; x.alignment = { vertical: "middle", horizontal: i ? "center" : "left", wrapText: true }; });
    rows.forEach((vals, n) => { const row = ws.getRow(r0 + 1 + n); row.values = vals; row.height = 20; const tot = totLast && n === rows.length - 1;
      for (let k = 1; k <= vals.length; k++) { const x = row.getCell(k); x.border = tot ? { ...box, top: { style: "medium", color: { argb: GOLD } } } : box; x.font = { name: "Arial", size: 10, bold: tot || k === 1 }; x.alignment = { vertical: "middle", horizontal: typeof vals[k - 1] === "number" ? "center" : "left", wrapText: true }; if (n % 2 && !tot) x.fill = fill(CREAM); } });
    return r0 + rows.length + 2;
  };
  const w = c.week, ex = explain(c);
  const oc = ITEMS.reduce((n, [k]) => n + c.orderNow[k] * settings.price[k], 0), nc = ITEMS.reduce((n, [k]) => n + c.next[k].order * settings.price[k], 0);
  const ws = sheet("Forecast", [28, 15, 17, 19, 17, 16], "GET Forecast");
  let r = 7;
  [...ex.out, ...ex.warn].forEach(t => { const x = ws.getCell(r, 1); ws.mergeCells(r, 1, r, 6); x.value = t; x.font = { name: "Arial", size: 10, italic: true }; x.alignment = { wrapText: true, vertical: "top" }; ws.getRow(r).height = 30; r++; });
  r++;
  r = table(ws, r, ["This week " + short(c.weekStart) + " – " + short(c.weekEnd), "Last week", "This week to date", "Rest of week (forecast)", "This week total"], [
    ...ITEMS.map(([k, n]) => [n, w.qty[k].last, w.qty[k].toDate, w.qty[k].rest, w.qty[k].toDate + w.qty[k].rest]),
    ["Metres", r1(w.metres.last), r1(w.metres.toDate), r1(w.metres.rest), r1(w.metres.toDate + w.metres.rest)],
    ["GET cost (R)", Math.round(w.cost.last), Math.round(w.cost.toDate), Math.round(w.cost.rest), Math.round(w.cost.toDate + w.cost.rest)]], true);
  r = table(ws, r, ["Stock and orders", "Stock on hand", "Order now", "Next week need", "Spare", "Order next week"], [
    ...ITEMS.map(([k, n]) => [n, c.stock[k] ?? "", c.orderNow[k], c.next[k].need, c.next[k].spare, c.next[k].order]),
    ["Order cost (R)", "", Math.round(oc), "", "", Math.round(nc)]], true);
  const t = ws.getCell(r, 1); t.value = `Total order both weeks: ${R(oc + nc)}`; t.font = { name: "Arial", size: 12, bold: true };
  const ws2 = sheet("Metres", [12, 9, 11, 13, 11, 18], "GET Forecast – Metres");
  const mrows = metres.filter(x => x.date >= c.monthStart && x.date <= c.upToCal).sort((a, b) => a.date.localeCompare(b.date) || String(a.shift).localeCompare(String(b.shift)));
  table(ws2, 7, ["Date", "Shift", "Rig", "Block", "Metres", "Supervisor"], [...mrows.map(x => [fmt(x.date), x.shift || "", x.rig, x.block || "", num(x.metres), x.supervisor || ""]), ["Month to date", "", "", "", Math.round(c.month.metres * 10) / 10, ""]], true);
  const ws3 = sheet("GET issued", [12, 9, 18, 14, 7, 12, 40], "GET Forecast – GET issued");
  const irows = issues.filter(x => x.date >= c.monthStart && x.date <= c.upToCal).sort((a, b) => a.date.localeCompare(b.date));
  table(ws3, 7, ["Date", "Shift", "Rig", "Item", "Qty", "Cost (R)", "Note"], [...irows.map(x => [fmt(x.date), x.shift || "", x.rig || "", (ITEMS.find(i => i[0] === x.item) || [])[2] || x.item, num(x.qty), num(x.qty) * (settings.price[x.item] || 0), [x.to && "to " + x.to, x.by && "by " + x.by, x.note].filter(Boolean).join(" · ")]), ["Month to date", "", "", "", "", Math.round(c.month.cost), ""]], true);
  const out = await wb.xlsx.writeBuffer();
  const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), name = `TKR_GET_Forecast_${fmt(c.rd).replace(/\//g, "-")}.xlsx`;
  const { deliver } = await import("../lib/deliver.js");
  deliver(blob, name, { doneLabel: "Done – clear this phone's copy", onDone: async () => { const fb = await import("../lib/firebase.js"); const { clearPhoneCopy } = await import("../lib/deliver.js"); await clearPhoneCopy(fb, [db], toast); } });
}

// A new version of the app was installed: load it straight away instead of on the next open.
if("serviceWorker" in navigator&&navigator.serviceWorker.controller){let reloaded=false;navigator.serviceWorker.addEventListener("controllerchange",()=>{if(reloaded)return;reloaded=true;location.reload()})}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js", { scope: "../", updateViaCache: "none" }).then(r => r.update()).catch(() => {});
