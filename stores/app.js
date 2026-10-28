/* TKR Stores — Drill Stores and Rompad Stores: items issued (out) and received (in), stock, PPE, dashboards
   and the branded consumption report. Store controllers sign in with their name and PIN; admins approve them.
   GET issued and received at the Drill Stores feeds the GET Forecast (stock and cost) automatically. */
import {
  initializeApp, getAuth, signInAnonymously, sendPasswordResetEmail, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, addDoc, setDoc, deleteDoc, getDoc, getDocs, onSnapshot, query, where,
} from "../lib/firebase.js";
const showName = e => /@mgr\.tkroperations\.app$/.test(e || "") ? (e[0].toUpperCase() + e.slice(1, e.indexOf("@"))) : e;
const toLogin = v => { v = String(v || "").trim(); return v.includes("@") ? v : v.toLowerCase().replace(/[^a-z0-9]/g, "") + "@mgr.tkroperations.app"; };  // managers can sign in with a username

const firebaseConfig = {
  apiKey: "AIzaSyALzOBLObrONGVD1bS0Tz02aNKhQ40TRoI", authDomain: "tkr-operations-app.firebaseapp.com", projectId: "tkr-operations-app",
  storageBucket: "tkr-operations-app.firebasestorage.app", messagingSenderId: "158080247079", appId: "1:158080247079:web:7cb7786d2b7f9ee172b502",
};
const ADMINS = ["muneer@tkroperations.com", "amogelang@tkroperations.com"];
// Admins and managers use the one TKR sign-in shared by every section (signed in once = signed in everywhere).
// Store controllers sign in here with name + PIN on a separate sign-in, so a Task Board PIN on the same phone is not touched.
const mainApp = initializeApp(firebaseConfig), mainAuth = getAuth(mainApp);
const fbApp = initializeApp(firebaseConfig, "stores"), stAuth = getAuth(fbApp);
const mkDb = a => { try { return initializeFirestore(a, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); } catch { return initializeFirestore(a, {}); } };
const stDb = mkDb(fbApp); let mainDb = null;
let auth = stAuth, db = stDb, boss = false;

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => ymd(new Date());
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmt = s => s ? s.split("-").reverse().join("/") : "";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = m => MONTHS[+m.slice(5, 7) - 1] + " " + m.slice(0, 4);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const R = v => "R" + String(Math.round(v || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const num = v => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isNaN(n) ? 0 : n; };
const nq = v => { const n = Math.round(num(v) * 100) / 100; return String(n); };
function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3200); }
function fail(e) { console.warn(e); toast(e?.code === "permission-denied" ? "Not allowed. Ask admin." : "That didn't save. Check the signal and try again."); }
const loadLib = src => new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)?.dataset.ok) return res(); const s = document.createElement("script"); s.src = src; s.onload = () => { s.dataset.ok = 1; res(); }; s.onerror = rej; document.head.appendChild(s); });
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

/* ---------- what the stores hold ---------- */
const STORES = { drill: { name: "Drill Stores", sheet: "TDR Drill Rigs", sub: "Drill rigs (TDR)", machines: ["TDR013", "TDR014", "TDR015"] },
  rompad: { name: "Rompad Stores", sheet: "Rompad Rockbreakers", sub: "Rockbreakers (TKRH) – Rompad", machines: ["TKRH011", "TKRH012", "TKRH015", "TKRH016", "TKRH017", "TKRH019", "TKRH020", "TKRH021"] } };
const OILS = ["Hydraulic oil", "Engine oil", "Grease", "Rockdrill / compressor oil", "Other oils & lubricants"];
const OIL20 = o => o !== "Grease" && o !== "Other oils & lubricants";
const CATS = { drill: ["GET", ...OILS, "Spares", "Fasteners", "PPE"], rompad: [...OILS, "Moil locks", "Spares", "Fasteners", "PPE"] };
const GET_KEYS = [["BIT", "Bits"], ["ROD", "Rods"], ["SHANK", "Shanks"], ["HAMMER", "Hammers"]];
const PPE_ICON = { helmet: "⛑️", glasses: "🥽", gloves: "🧤", boots: "🥾", vest: "🦺", respirator: "😷", ear: "🎧", harness: "🪢", other: "📦" };
const DEFAULT_ITEMS = [
  { id: "get-bit", store: "drill", cat: "GET", name: "Button bit 140 mm", unit: "ea", price: 9000, min: 2, getKey: "BIT" },
  { id: "get-rod", store: "drill", cat: "GET", name: "Rod", unit: "ea", price: 8621, min: 2, getKey: "ROD" },
  { id: "get-shank", store: "drill", cat: "GET", name: "Shank", unit: "ea", price: 6200, min: 2, getKey: "SHANK" },
  { id: "get-hammer", store: "drill", cat: "GET", name: "DTH hammer", unit: "ea", price: 48000, min: 1, getKey: "HAMMER" },
  { id: "oil-hyd", store: "both", cat: "Hydraulic oil", name: "Hydraulic Oil 68", unit: "20L" },
  { id: "oil-eng", store: "both", cat: "Engine oil", name: "Diesel engine oil 15W40", unit: "20L" },
  { id: "oil-comp", store: "both", cat: "Rockdrill / compressor oil", name: "Compressor oil 46", unit: "20L" },
  { id: "grease", store: "both", cat: "Grease", name: "Grease", unit: "kg" },
  { id: "grease-cu", store: "both", cat: "Grease", name: "Copper grease", unit: "ea" },
  { id: "moil-lock", store: "rompad", cat: "Moil locks", name: "EDT 3000 moil lock", unit: "ea" },
  { id: "moil-pin", store: "rompad", cat: "Moil locks", name: "Moil lock pin", unit: "ea" },
  { id: "ppe-helmet", store: "both", cat: "PPE", name: "Hard hat", unit: "ea", ppe: "helmet" },
  { id: "ppe-glasses", store: "both", cat: "PPE", name: "Safety glasses", unit: "ea", ppe: "glasses" },
  { id: "ppe-gloves", store: "both", cat: "PPE", name: "Gloves", unit: "pr", ppe: "gloves" },
  { id: "ppe-boots", store: "both", cat: "PPE", name: "Safety boots", unit: "pr", ppe: "boots" },
  { id: "ppe-vest", store: "both", cat: "PPE", name: "Reflector vest", unit: "ea", ppe: "vest" },
  { id: "ppe-resp", store: "both", cat: "PPE", name: "Respirator / dust mask", unit: "ea", ppe: "respirator" },
  { id: "ppe-ear", store: "both", cat: "PPE", name: "Ear plugs", unit: "pr", ppe: "ear" },
  { id: "ppe-harness", store: "both", cat: "PPE", name: "Safety harness", unit: "ea", ppe: "harness" },
];

/* ---------- state ---------- */
let user = null, email = "", me = null, managers = [], supers = [], staff = [], items = DEFAULT_ITEMS.slice(), itemsSaved = false, moves = [], counts = [], status = {}, settings = { supervisor: "Edwin Khonkhobe" };
let registering = false, fcMetres = null, reports = [], renderLater = false;
let store = lsGet("tkr-st-store") || "drill", tab = lsGet("tkr-st-tab") || "log", month = today().slice(0, 7), ppeStore = "all", subs = [], picked = null, gateMode = "pick", gateMsg = "", form = { out: {}, in: {} };
const isAdmin = () => ADMINS.includes(email);
const isSup = () => !!email && supers.includes(email);            // supervisor (Edwin): everything in Stores, like an admin
const isBoss = () => isAdmin() || isSup();
const isManager = () => isBoss() || (!!email && managers.includes(email));
const isStaff = () => !!me && me.approved;
const canLog = () => isStaff() || isBoss();
const myName = () => me?.name || email;
const app = $("app"), gate = $("gate");

/* ---------- sign in: store controllers with name + PIN, admins and managers with email ---------- */
const randKey = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");
const stEmail = key => `st.${key}@staff.tkroperations.app`;
const stPass = (pin, key) => `tkr-st-${pin}-${key}`;
async function loadStaff() { try { const s = await getDocs(collection(db, "stUsers")); staff = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name)); } catch (e) { console.warn(e); } }
async function bossCheck(u) {
  if (!u || u.isAnonymous || !u.email || u.email.endsWith("@staff.tkroperations.app")) return false;
  const em = u.email.toLowerCase(); if (ADMINS.includes(em)) return true;
  mainDb = mainDb || mkDb(mainApp);
  try { const r = await getDoc(doc(mainDb, "config", "roles")); const d = r.exists() ? r.data() : {}; return [...(d.managers || []), ...(d.supervisors || [])].map(x => String(x).toLowerCase()).includes(em); } catch { return false; }
}
async function useBoss(u) {
  boss = true; auth = mainAuth; db = mainDb = mainDb || mkDb(mainApp); user = u; email = u.email.toLowerCase(); me = null;
  try { const r = await getDoc(doc(db, "config", "roles")); managers = ((r.exists() && r.data().managers) || []).map(x => String(x).toLowerCase()); supers = ((r.exists() && r.data().supervisors) || []).map(x => String(x).toLowerCase()); } catch {}
  subs.forEach(f => f()); subs = []; startApp();
}
(async () => {
  try { await mainAuth.authStateReady(); } catch {}
  const u = mainAuth.currentUser;
  if (await bossCheck(u)) { await useBoss(u); onAuthStateChanged(mainAuth, x => { if (boss && !x) location.reload(); }); return; }
  watchStores();
})();
// a manager on this phone switches to the store controller sign-in (their TKR sign-in in other sections stays)
function staffSignIn() { subs.forEach(f => f()); subs = []; boss = false; auth = stAuth; db = stDb; user = null; email = ""; me = null; managers = []; supers = []; gateMode = "pick"; watchStores(); }
function watchStores() { onAuthStateChanged(stAuth, async u => {
  user = u; email = (u?.email || "").toLowerCase(); me = null;
  subs.forEach(f => f()); subs = [];
  if (!u) { try { await signInAnonymously(auth); } catch { showGate("pick", "No signal. Opening Stores the first time needs signal."); } return; }
  if (u.isAnonymous) { await loadStaff(); showGate(gateMode === "wait" ? "wait" : "pick"); return; }
  if (email.startsWith("st.")) {
    if (registering) return;
    try { const d = await getDoc(doc(db, "stUsers", u.uid)); me = d.exists() ? { id: d.id, ...d.data() } : null; } catch {}
    if (!me) { await signOut(auth); showGate("pick", "Your sign-in was removed. Register again."); return; }
    if (!me.approved) { picked = me; showGate("wait"); return; }
  }
  if (!email.startsWith("st.")) {
    try { const r = await getDoc(doc(db, "config", "roles")); managers = ((r.exists() && r.data().managers) || []).map(x => String(x).toLowerCase()); supers = ((r.exists() && r.data().supervisors) || []).map(x => String(x).toLowerCase()); } catch {}
    if (!isManager()) { await signOut(auth); showGate("pick", "This email is not an admin or manager. Ask admin."); return; }
  }
  startApp();
}); }
function showGate(mode, msg = "") {
  gateMode = mode; gateMsg = msg; app.hidden = true; gate.hidden = false; $("outBtn").hidden = true; $("who").textContent = "";
  const err = `<p class="flag" id="gErr" style="margin:0">${esc(msg)}</p>`;
  const pinIn = (id, l) => `<label>${l} <input id="${id}" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off"></label>`;
  let h = "";
  if (mode === "pick") {
    const list = staff.filter(s => s.approved !== undefined);
    h = `<h2>Who is working in the store?</h2><p class="muted" style="margin:0 0 10px">Store controllers: choose your name and type your PIN.</p>
      <div class="list" style="display:flex;flex-direction:column;gap:8px">${list.length ? list.map(s => `<button class="pick" data-st="${esc(s.id)}">${esc(s.name)}${s.approved ? "" : ' <span class="muted">· waiting for approval</span>'}</button>`).join("") : '<div class="muted">No store controllers yet.</div>'}</div>
      ${err}<div class="row" style="margin-top:12px"><button class="primary" id="gNew">New store controller? Register</button><button class="ghost" id="gAdmin">Admin or manager sign in</button></div>`;
  } else if (mode === "pin") {
    h = `<form id="gForm" style="display:flex;flex-direction:column;gap:12px"><h2>Hello ${esc(picked.name)}</h2><p class="muted" style="margin:0">Type your 4-digit PIN.</p>${pinIn("gPin", "PIN")}${err}
      <button class="primary">Sign in</button><button type="button" class="ghost" id="gBack">Not you?</button></form>`;
  } else if (mode === "register") {
    h = `<form id="gForm" style="display:flex;flex-direction:column;gap:12px"><h2>Register as a store controller</h2><p class="muted" style="margin:0">Type your full name and make a 4-digit PIN. Then ask admin to approve you.</p>
      <label>Full name <input id="gName" maxlength="60" autocomplete="off"></label>${pinIn("gPin", "PIN")}${pinIn("gPin2", "Type the PIN again")}${err}
      <button class="primary">Register</button><button type="button" class="ghost" id="gBack">Back</button></form>`;
  } else if (mode === "wait") {
    h = `<h2>Waiting for approval</h2><p>${esc(picked?.name || "")}, you are registered. Ask admin to approve you, then tap Check again.</p>${err}
      <div class="row"><button class="primary" id="gCheck">Check again</button><button class="ghost" id="gBack">Back</button></div>`;
  } else if (mode === "admin") {
    h = `<form id="gForm" style="display:flex;flex-direction:column;gap:12px" autocomplete="on"><h2>Admin or manager sign in</h2>
      <label>Username or email <input id="gEmail" type="text" autocapitalize="none" autocomplete="username" required></label><label>Password <input id="gPass" type="password" autocomplete="current-password" required></label>${err}
      <button class="primary">Sign in</button><button type="button" class="ghost" id="gForgot">Forgot your password?</button><button type="button" class="ghost" id="gBack">Back</button></form>`;
  }
  gate.innerHTML = h; setTimeout(() => gate.querySelector("input")?.focus(), 50);
}
gate.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b || b.type === "submit" && b.closest("form")) return;
  if (b.dataset.st) { picked = staff.find(s => s.id === b.dataset.st); showGate(picked.approved ? "pin" : "wait"); }
  if (b.id === "gNew") showGate("register");
  if (b.id === "gAdmin") showGate("admin");
  if (b.id === "gForgot") { const em = $("gEmail").value.trim(), er = $("gErr"); if (!em) { er.textContent = "Type your email first."; return; }
    try { await sendPasswordResetEmail(mainAuth, em); er.textContent = `A link to set a new password was sent to ${em}. Check the inbox and spam folder.`; } catch (x) { er.textContent = String(x?.code || "").includes("network") ? "No signal." : "That email is not set up in the app."; } }
  if (b.id === "gBack") { if (user && !user.isAnonymous) { await signOut(auth); } await loadStaff(); showGate("pick"); }
  if (b.id === "gCheck") { await loadStaff(); const s = staff.find(x => x.id === picked?.id); if (s?.approved && user && user.uid === s.id) { me = s; startApp(); } else if (s?.approved) { picked = s; showGate("pin", "You are approved. Type your PIN."); } else $("gErr").textContent = "Not approved yet."; }
});
gate.addEventListener("submit", async e => {
  e.preventDefault(); const err = t => { const el = $("gErr"); if (el) el.textContent = t; };
  if (gateMode === "admin") {
    err("Signing in…");
    try { const cred = await signInWithEmailAndPassword(mainAuth, toLogin($("gEmail").value), $("gPass").value);
      if (await bossCheck(cred.user)) { if (!stAuth.currentUser?.isAnonymous && stAuth.currentUser) await signOut(stAuth); await useBoss(cred.user); onAuthStateChanged(mainAuth, x => { if (boss && !x) location.reload(); }); }
      else { await signOut(mainAuth); err("This email is not an admin or manager. Ask admin."); } }
    catch (x) { err(String(x?.code || "").includes("network") ? "No signal. Signing in needs signal." : "Email or password is wrong."); }
    return;
  }
  const pin = $("gPin").value.trim();
  if (!/^\d{4}$/.test(pin)) { err("The PIN must be 4 numbers."); return; }
  if (gateMode === "register") {
    const name = $("gName").value.trim().replace(/\s+/g, " ");
    if (name.length < 3) { err("Type your full name."); return; }
    if (pin !== $("gPin2").value.trim()) { err("The two PINs are not the same."); return; }
    err("Registering…");
    try {
      const key = randKey(), em = stEmail(key);
      registering = true; const cred = await createUserWithEmailAndPassword(auth, em, stPass(pin, key));
      const rec = { name, authEmail: em, key, approved: false, createdAt: Date.now() };
      await setDoc(doc(db, "stUsers", cred.user.uid), rec); picked = { id: cred.user.uid, ...rec }; registering = false; showGate("wait");
    } catch (x) { console.warn(x); registering = false; err("Registering didn't work. Check the signal and try again."); }
    return;
  }
  if (gateMode === "pin") {
    err("Signing in…");
    try { await signInWithEmailAndPassword(auth, picked.authEmail, stPass(pin, picked.key)); }
    catch (x) { const c = String(x?.code || ""); $("gPin").value = ""; err(c.includes("too-many") ? "Too many tries. Wait a few minutes." : c.includes("network") ? "No signal. Try again with signal." : "Wrong PIN."); }
  }
});
$("outBtn").onclick = async () => { if (boss && !confirm("Sign out of the TKR app? You will be signed out of every section on this phone.")) return; await signOut(auth); if (boss) location.reload(); };
function netNote(m) { $("net").textContent = m; $("net").hidden = !m; }
addEventListener("offline", () => netNote("No signal. You can keep logging; it sends when the signal is back."));
addEventListener("online", () => netNote(""));

/* ---------- October 2026 GET records from the Daily GET Consumption Tracker (Consumption and Stock tabs, 01/10 to 20/10).
   Loaded into the Drill Stores once, the first time an admin opens Stores with signal. The GET Forecast then takes them from here,
   so the earlier tracker import in the Forecast is taken out for these dates to stop them counting twice. ---------- */
const OCT_TRACKER = {"issues":[["2026-10-01","Day","BIT",2.0,"","TDR 013 / TDR 015","0822","Muneer","Bongani"],["2026-10-02","Day","BIT",1.0,"TDR015","","0822","Olebogeng","Andrew"],["2026-10-02","Day","SHANK",1.0,"TDR015","","0822","Olebogeng","Sawara"],["2026-10-03","Night","ROD",4.0,"","TDR 013 / TDR 015","0223","Muneer","Zandile"],["2026-10-04","Day","SHANK",1.0,"TDR013","","1025","Olebogeng","Katlego"],["2026-10-04","Night","BIT",2.0,"","TDR 013 / TDR 015","1025","Muneer","Bongani"],["2026-10-05","Day","ROD",1.0,"TDR015","","1025","Phumzile","Yvonne"],["2026-10-05","Day","BIT",1.0,"TDR015","","1025","Phumzile","Yvonne"],["2026-10-07","Day","BIT",2.0,"","TDR 013 / TDR 015","1025","Phumzile","Thomas"],["2026-10-08","Day","BIT",2.0,"","TDR 013 / TDR 015","1025","Refilwe","Thomas"],["2026-10-09","Day","ROD",2.0,"","TDR 013 / TDR 015","0822","Refilwe","Thomas"],["2026-10-09","Day","BIT",1.0,"TDR013","","0822","Refilwe","Thomas"],["2026-10-11","Day","ROD",2.0,"TDR013","","0822","Olebogeng","Andrew"],["2026-10-11","Day","BIT",1.0,"TDR015","","0822 / 2016","Olebogeng","Andrew"],["2026-10-12","Day","SHANK",1.0,"TDR013","","0822","Olebogeng","Martin"],["2026-10-12","Day","BIT",2.0,"","TDR 013 / TDR 015","2016","Olebogeng","Andrew"],["2026-10-13","Day","BIT",1.0,"TDR015","","2016","Olebogeng","Thomas"],["2026-10-13","Day","SHANK",1.0,"TDR015","","2016","Olebogeng","Thomas"],["2026-10-13","Day","ROD",2.0,"TDR015","","2016","Olebogeng","Thomas"],["2026-10-14","Day","ROD",2.0,"TDR013","","0622 / 2016","Phumzile","Katlego"],["2026-10-14","Day","BIT",1.0,"TDR013","","0622 / 2016","Phumzile","Katlego"],["2026-10-16","Day","ROD",2.0,"TDR013","","0622","Edwin","Tshepang"],["2026-10-16","Day","BIT",1.0,"TDR013","","0622","Edwin","Tshepang"],["2026-10-17","Day","BIT",2.0,"","TDR 013 / TDR 015","2016","Phumzile","Tshepang"],["2026-10-19","Night","ROD",1.0,"TDR013","","0525","Boitumelo","Tshepang"],["2026-10-19","Night","SHANK",1.0,"TDR015","","5208","Boitumelo","Tshepang"],["2026-10-20","Day","BIT",2.0,"","TDR 013 / TDR 015","0525","Olebogeng","Fourie"],["2026-10-20","Day","ROD",2.0,"","TDR 013 / TDR 015","0525","Olebogeng","Fourie"]],"recs":[["2026-10-07","BIT",6.0,"","Phumzile"],["2026-10-07","ROD",10.0,"","Phumzile"],["2026-10-07","SHANK",3.0,"","Phumzile"],["2026-10-12","BIT",5.0,"Khaya","Olebogeng"],["2026-10-17","BIT",6.0,"Wolf Corp","Phumzile"],["2026-10-17","ROD",6.0,"Wolf Corp","Phumzile"],["2026-10-17","SHANK",2.0,"Wolf Corp","Phumzile"]],"cnts":[["2026-10-04","BIT",6.0,"Muneer"],["2026-10-04","ROD",1.0,"Muneer"],["2026-10-04","SHANK",2.0,"Muneer"],["2026-10-04","HAMMER",2.0,"Muneer"],["2026-10-05","BIT",3.0,"Phumzile"],["2026-10-05","ROD",0.0,"Phumzile"],["2026-10-05","SHANK",1.0,"Phumzile"],["2026-10-05","HAMMER",2.0,"Phumzile"],["2026-10-06","BIT",3.0,"Phumzile"],["2026-10-06","ROD",0.0,"Phumzile"],["2026-10-06","SHANK",1.0,"Phumzile"],["2026-10-06","HAMMER",2.0,"Phumzile"],["2026-10-07","BIT",5.0,"Phumzile"],["2026-10-07","ROD",10.0,"Phumzile"],["2026-10-07","SHANK",4.0,"Phumzile"],["2026-10-07","HAMMER",2.0,"Phumzile"],["2026-10-08","BIT",3.0,"Phumzile"],["2026-10-08","ROD",10.0,"Phumzile"],["2026-10-08","SHANK",4.0,"Phumzile"],["2026-10-08","HAMMER",2.0,"Phumzile"],["2026-10-09","BIT",3.0,"Phumzile"],["2026-10-09","ROD",10.0,"Phumzile"],["2026-10-09","SHANK",4.0,"Phumzile"],["2026-10-09","HAMMER",2.0,"Phumzile"],["2026-10-10","BIT",2.0,"Refilwe"],["2026-10-10","ROD",8.0,"Refilwe"],["2026-10-10","SHANK",4.0,"Refilwe"],["2026-10-10","HAMMER",2.0,"Refilwe"],["2026-10-11","BIT",1.0,"Refilwe"],["2026-10-11","ROD",6.0,"Refilwe"],["2026-10-11","SHANK",4.0,"Refilwe"],["2026-10-11","HAMMER",2.0,"Refilwe"],["2026-10-12","BIT",3.0,"Olebogeng"],["2026-10-12","ROD",6.0,"Olebogeng"],["2026-10-12","SHANK",3.0,"Olebogeng"],["2026-10-13","BIT",2.0,"Olebogeng"],["2026-10-13","ROD",4.0,"Olebogeng"],["2026-10-13","SHANK",2.0,"Olebogeng"],["2026-10-14","BIT",1.0,"Phumzile"],["2026-10-14","ROD",2.0,"Phumzile"],["2026-10-14","SHANK",2.0,"Phumzile"],["2026-10-14","HAMMER",2.0,"Phumzile"],["2026-10-15","BIT",1.0,"Olebogeng"],["2026-10-15","ROD",2.0,"Olebogeng"],["2026-10-15","SHANK",2.0,"Olebogeng"],["2026-10-15","HAMMER",2.0,"Olebogeng"],["2026-10-16","BIT",0.0,"Phumzile"],["2026-10-16","ROD",0.0,"Phumzile"],["2026-10-16","SHANK",2.0,"Phumzile"],["2026-10-16","HAMMER",2.0,"Phumzile"],["2026-10-17","BIT",4.0,"Phumzile"],["2026-10-17","ROD",6.0,"Phumzile"],["2026-10-17","SHANK",4.0,"Phumzile"],["2026-10-17","HAMMER",2.0,"Phumzile"],["2026-10-18","BIT",4.0,"Olebogeng"],["2026-10-18","ROD",6.0,"Olebogeng"],["2026-10-18","SHANK",4.0,"Olebogeng"],["2026-10-18","HAMMER",2.0,"Olebogeng"],["2026-10-19","ROD",5.0,"Boitumelo"],["2026-10-19","BIT",4.0,"Olebogeng"],["2026-10-19","HAMMER",2.0,"Olebogeng"],["2026-10-19","SHANK",4.0,"Boitumelo"],["2026-10-20","BIT",2.0,"Olebogeng"],["2026-10-20","ROD",3.0,"Olebogeng"],["2026-10-20","SHANK",3.0,"Olebogeng"],["2026-10-20","HAMMER",2.0,"Olebogeng"]]};
let seedingGet = false;
async function seedOctoberGet() {
  if (seedingGet || !boss || !isAdmin() || !navigator.onLine) return; seedingGet = true;
  try {
    const flag = doc(db, "stConfig", "seed-2026-10-get"); const f = await getDoc(flag); if (f.exists()) return;
    const it = k => items.find(i => i.getKey === k) || DEFAULT_ITEMS.find(i => i.getKey === k);
    const at = (d, h, i = 0) => Date.parse(d + "T00:00:00+02:00") + h * 3600e3 + i * 1000;
    let n = 0;
    for (const [i, [date, shift, k, qty, machine, rigs, block, by, to]] of OCT_TRACKER.issues.entries()) {
      const x = it(k); await setDoc(doc(db, "stMoves", `trk-i-${date}-${i}`), { kind: "issue", store: "drill", cat: "GET", itemId: x.id, item: x.name, getKey: k, unit: x.unit || "ea", price: num(x.price),
        qty, date, shift, machine: machine || rigs.replace(/TDR (\d{3})/g, "TDR$1"), to, note: [rigs, block ? "block " + block : ""].filter(Boolean).join(" · "), byName: by || "GET tracker", byUid: user.uid, src: "tracker", createdAt: at(date, shift === "Night" ? 20 : 9, i) }); n++;
    }
    for (const [i, [date, k, qty, from, by]] of OCT_TRACKER.recs.entries()) {
      const x = it(k); await setDoc(doc(db, "stMoves", `trk-r-${date}-${i}`), { kind: "receive", store: "drill", cat: "GET", itemId: x.id, item: x.name, getKey: k, unit: x.unit || "ea", price: num(x.price),
        qty, date, from, ref: "", note: "", byName: by || "GET tracker", byUid: user.uid, src: "tracker", createdAt: at(date, 8, i) }); n++;
    }
    for (const [i, [date, k, count, by]] of OCT_TRACKER.cnts.entries()) {
      const x = it(k); await setDoc(doc(db, "stCounts", `trk-c-${date}-${k}`), { store: "drill", itemId: x.id, item: x.name, getKey: k, date, count, byName: by || "GET tracker", byUid: user.uid, src: "tracker", createdAt: at(date, 23, i) }); n++;
    }
    // the Forecast's own import of the same tracker lines would now count twice: take those out for 01/10 to 20/10
    for (const col of ["fcIssues", "fcCounts"]) { const s = await getDocs(collection(db, col)); for (const d of s.docs) { const v = d.data(); if (v.imported && v.date >= "2026-10-01" && v.date <= "2026-10-20") await deleteDoc(d.ref); } }
    await setDoc(flag, { done: Date.now(), by: email, lines: n });
    toast("October GET from the tracker loaded into Drill Stores (01/10 to 20/10)");
  } catch (e) { console.warn(e); } finally { seedingGet = false; }
}

/* Later reports (Drill Stores closing 21/10, Rompad reports 22–24/10), loaded the same way, once each.
   m = [date, kind, store, cat, itemId or "", item name, unit, qty, machine, to/from, by, note]   c = [date, store, itemId, count, by] */
const REPORT_SEEDS = [
  { id: "seed-2026-10-21-drill", msg: "Drill Stores closing 21/10 loaded", m: [
    ["2026-10-21", "issue", "drill", "GET", "get-bit", "", "", 1, "TDR015", "Thomas", "Olebogeng", "Drill Stores closing 21/10"]],
    c: [["2026-10-21", "drill", "get-bit", 1, "Olebogeng"], ["2026-10-21", "drill", "get-rod", 3, "Olebogeng"], ["2026-10-21", "drill", "get-shank", 3, "Olebogeng"]] },
  { id: "seed-2026-10-drill-spares", msg: "October Drill Stores spares loaded", m: [
    ["2026-10-03", "issue", "drill", "Engine oil", "oil-eng", "", "", 2, "TDR013", "", "Muneer", "Site office 21:00"],
    ["2026-10-08", "issue", "drill", "PPE", "ppe-helmet", "", "", 1, "", "Hannes", "Refilwe", ""],
    ["2026-10-08", "issue", "drill", "Spares", "", "Pine gel 5 kg", "ea", 1, "ROMPAD STORE", "Refilwe", "Refilwe", "Moved to Rompad Stores"],
    ["2026-10-08", "issue", "drill", "Spares", "", "Service kit TKRH011", "kit", 1, "ROMPAD STORE", "Refilwe", "Refilwe", "Moved to Rompad Stores"],
    ["2026-10-08", "issue", "drill", "Spares", "", "Tissue", "ea", 2, "", "Valeka", "Refilwe", ""],
    ["2026-10-08", "issue", "drill", "Spares", "", "Service kit TKRH015", "kit", 1, "ROMPAD STORE", "Refilwe", "Edwin", "Moved to Rompad Stores"],
    ["2026-10-09", "issue", "drill", "PPE", "", "PPE top", "ea", 40, "", "Simon (drilling)", "Edwin", ""],
    ["2026-10-09", "issue", "drill", "PPE", "", "PPE trouser", "ea", 36, "", "Simon (drilling)", "Edwin", ""],
    ["2026-10-09", "issue", "drill", "PPE", "ppe-gloves", "", "", 1, "", "Titus", "Edwin", ""],
    ["2026-10-09", "issue", "drill", "PPE", "ppe-gloves", "", "", 1, "", "Andries", "Edwin", ""],
    ["2026-10-10", "issue", "drill", "PPE", "ppe-gloves", "", "", 2, "", "Martin", "Refilwe", ""],
    ["2026-10-10", "issue", "drill", "PPE", "ppe-ear", "", "", 2, "", "Martin", "Refilwe", ""],
    ["2026-10-10", "issue", "drill", "Spares", "", "Coogar gas", "ea", 1, "ROMPAD STORE", "", "Refilwe", "Moved to Rompad Stores"],
    ["2026-10-10", "issue", "drill", "Spares", "", "Oxygen gas", "ea", 1, "ROMPAD STORE", "", "Refilwe", "Moved to Rompad Stores"],
    ["2026-10-10", "issue", "drill", "Hydraulic oil", "oil-hyd", "", "", 1, "ROMPAD STORE", "", "Refilwe", "Moved to Rompad Stores"],
    ["2026-10-10", "issue", "drill", "Engine oil", "oil-eng", "", "", 1, "TDR013", "", "Refilwe", ""],
    ["2026-10-15", "receive", "drill", "Spares", "", "Hydraulic grease fitting (110 piece)", "ea", 1, "", "Khaya", "Phumzile", ""],
    ["2026-10-15", "receive", "drill", "Spares", "", "Injector pump", "ea", 1, "", "Khaya", "Phumzile", ""],
    ...[["250 hr service kit TDR015", "Spares", "kit", 1], ["500 hr service kit TDR013", "Spares", "kit", 1], ["Hydraulic Oil 68", "Hydraulic oil", "20L", 10, "oil-hyd"], ["Diesel engine oil 15W40", "Engine oil", "20L", 5, "oil-eng"],
      ["Degreaser", "Spares", "ea", 2], ["Antifreeze", "Spares", "ea", 2], ["Compressor oil 46", "Rockdrill / compressor oil", "20L", 5, "oil-comp"], ["Lithium grease", "Grease", "ea", 1], ["Injector pump", "Spares", "ea", 1]]
      .map(([n, cat, u, q, id]) => ["2026-10-16", "receive", "drill", cat, id || "", n, u, q, "", "Khaya", "Edwin", ""]),
    ["2026-10-19", "receive", "drill", "Spares", "", "Tyre (TLDV012)", "ea", 4, "", "Tynash", "Edwin", ""],
    ["2026-10-20", "issue", "drill", "Spares", "", "Tyre", "ea", 4, "TLDV012", "Sawara", "Olebogeng", "Drill Stores closing 20/10"],
    ...[["M10 x 80 bolts, nuts & washers", 8], ["Hammer 1.8 kg (hand tool)", 1], ["M12 x 40 bolts, nuts & washers", 8], ["M14 x 40 bolts, nuts & washers", 8], ["Lock rubber", 1], ["Rod catcher", 4], ["Hydraulic return filter", 1],
      ["Dust collector filter", 5], ["Pito clamp", 2], ["Stoppers", 4], ["M10 x 130 bolt & nuts", 4], ["M10 x 110 bolt & nuts", 4], ["Soft grippers", 4]]
      .map(([n, q]) => ["2026-10-21", "receive", "drill", "Spares", "", n, "ea", q, "", "Sawara", "Olebogeng", "Drill Stores closing 21/10"]),
    ["2026-10-21", "issue", "drill", "Engine oil", "oil-eng", "", "", 2, "ROMPAD STORE", "Jeff", "Olebogeng", "Moved to Rompad Stores"],
    ["2026-10-21", "issue", "drill", "Spares", "", "Antifreeze", "ea", 1, "ROMPAD STORE", "Jeff", "Olebogeng", "Moved to Rompad Stores"],
    ...[["Hammer 1.8 kg (hand tool)", 1], ["Stoppers", 2], ["Rod catcher", 1], ["M10 x 130 bolt & nuts", 4], ["M14 x 40 bolts, nuts & washers", 8], ["M12 x 40 bolts, nuts & washers", 8], ["Lock rubber", 1]]
      .map(([n, q]) => ["2026-10-21", "issue", "drill", "Spares", "", n, "ea", q, "TDR013", "Sawara", "Olebogeng", "Drill Stores closing 21/10"]),
    ["2026-10-24", "issue", "drill", "Spares", "", "Service kit TDR015", "kit", 1, "TDR015", "Tshepang Nyoni", "Phumzile", "Site office 24/10"],
    ["2026-10-24", "issue", "drill", "Spares", "", "Service kit TDR013", "kit", 1, "TDR013", "Tshepang Nyoni", "Phumzile", "Site office 24/10"]], c: [] },
  { id: "seed-2026-10-22-24-rompad", msg: "Rompad reports 22–24/10 loaded", m: [
    ...[["Degreaser", "Spares", "ea", 2], ["Diesel engine oil 15W40", "Engine oil", "20L", 3, "oil-eng"], ["Compressor oil 68", "Rockdrill / compressor oil", "20L", 5], ["Antifreeze", "Spares", "ea", 1],
      ["Compressor oil 46", "Rockdrill / compressor oil", "20L", 2, "oil-comp"], ["Rockdrill oil 220", "Rockdrill / compressor oil", "20L", 2], ["Engine gearlube 80W-90", "Spares", "ea", 3],
      ["Lithium complex EP2 grease", "Grease", "ea", 1], ["Transmission fluid", "Spares", "ea", 1], ["Spirax axle oil", "Spares", "ea", 2], ["Rod catcher", "Spares", "ea", 3]]
      .map(([n, cat, u, q, id]) => ["2026-10-22", "receive", "rompad", cat, id || "", n, u, q, "", "Drill Stores (site office)", "Phumzile", "Moved from the site office store to Rompad 22/10"]),
    ["2026-10-23", "receive", "rompad", "Moil locks", "moil-lock", "", "", 4, "", "", "Phumzile", "Rompad day shift 23/10"],
    ["2026-10-23", "receive", "rompad", "Moil locks", "", "Moil / rubber stopper", "ea", 2, "", "", "Phumzile", "Rompad day shift 23/10"],
    ["2026-10-23", "issue", "rompad", "PPE", "ppe-gloves", "", "", 5, "", "", "Phumzile", "Rompad day shift 23/10"],
    ["2026-10-23", "issue", "rompad", "PPE", "ppe-ear", "", "", 2, "", "", "Phumzile", "Rompad day shift 23/10"],
    ["2026-10-23", "issue", "rompad", "Moil locks", "moil-lock", "", "", 2, "", "", "Phumzile", "Rompad day shift 23/10"],
    ["2026-10-23", "issue", "rompad", "Moil locks", "moil-pin", "", "", 2, "", "", "Phumzile", "Rompad day shift 23/10"],
    ["2026-10-23", "issue", "rompad", "Moil locks", "", "Moil / rubber stopper", "ea", 1, "", "", "Phumzile", "Rompad day shift 23/10"],
    ["2026-10-23", "issue", "rompad", "Spares", "", "Circlip 30", "ea", 1, "", "", "Phumzile", "Rompad day shift 23/10"],
    ["2026-10-23", "issue", "rompad", "Spares", "", "Rubber plug 30", "ea", 1, "", "", "Phumzile", "Rompad day shift 23/10"],
    ["2026-10-23", "issue", "rompad", "Engine oil", "", "Engine oil 15W40 (litres)", "L", 35, "", "", "Phumzile", "Rompad day shift 23/10"],
    ["2026-10-24", "receive", "rompad", "Spares", "", "Service kit TDR015", "kit", 1, "", "", "Phumzile", "Rompad day shift 24/10"],
    ["2026-10-24", "issue", "rompad", "PPE", "ppe-gloves", "", "", 9, "", "", "Phumzile", "Rompad day shift 24/10"],
    ["2026-10-24", "issue", "rompad", "PPE", "ppe-resp", "", "", 5, "", "", "Phumzile", "Rompad day shift 24/10 (dust masks)"],
    ["2026-10-24", "issue", "rompad", "PPE", "ppe-glasses", "", "", 4, "", "", "Phumzile", "Rompad day shift 24/10 (safety goggles)"],
    ["2026-10-24", "issue", "rompad", "Grease", "grease", "", "", 9, "", "", "Phumzile", "Rompad day shift 24/10"],
    ["2026-10-24", "issue", "rompad", "Engine oil", "oil-eng", "", "", 1, "TDR013", "Simon", "Phumzile", "To Simon for TDR013"],
    ["2026-10-24", "issue", "rompad", "Spares", "", "Antifreeze", "ea", 1, "TDR013", "Simon", "Phumzile", "To Simon for TDR013"],
    ["2026-10-24", "issue", "rompad", "Spares", "", "Degreaser", "L", 5, "TDR013", "Simon", "Phumzile", "To Simon for TDR013"],
    ["2026-10-24", "issue", "rompad", "Hydraulic oil", "oil-hyd", "", "", 1, "", "", "Phumzile", "Rompad day shift 24/10"]],
    c: [["2026-10-24", "rompad", "oil-hyd", 0, "Phumzile"], ["2026-10-24", "rompad", "ppe-gloves", 0, "Phumzile"], ["2026-10-24", "rompad", "ppe-glasses", 1, "Phumzile"],
      ["2026-10-24", "rompad", "ppe-resp", 35, "Phumzile"], ["2026-10-24", "rompad", "oil-eng", 2, "Phumzile"], ["2026-10-24", "rompad", "oil-comp", 1, "Phumzile"], ["2026-10-24", "rompad", "moil-lock", 2, "Phumzile"]] },
];
let seedingRep = false;
async function seedReports() {
  if (seedingRep || !boss || !isAdmin() || !navigator.onLine) return; seedingRep = true;
  try {
    for (const S of REPORT_SEEDS) {
      const flag = doc(db, "stConfig", S.id); if ((await getDoc(flag)).exists()) continue;
      const at = (d, h, i) => Date.parse(d + "T00:00:00+02:00") + h * 3600e3 + i * 1000;
      let n = 0;
      for (const [i, [date, kind, st, cat, itemId, name, unit, qty, machine, who, by, note]] of S.m.entries()) {
        const it = items.find(x => x.id === itemId) || DEFAULT_ITEMS.find(x => x.id === itemId);
        await setDoc(doc(db, "stMoves", `${S.id}-m${i}`), { kind, store: st, cat, itemId: it?.id || "", item: it?.name || name, getKey: it?.getKey || "", unit: it ? (it.unit || "") : unit, price: it?.price ? num(it.price) : 0,
          qty, date, shift: "Day", machine, ...(kind === "issue" ? { to: who } : { from: who, ref: "" }), note, byName: by, byUid: user.uid, src: "report", createdAt: at(date, kind === "receive" ? 8 : 12, i) }); n++;
      }
      for (const [i, [date, st, itemId, count, by]] of S.c.entries()) {
        const it = items.find(x => x.id === itemId) || DEFAULT_ITEMS.find(x => x.id === itemId);
        await setDoc(doc(db, "stCounts", `${S.id}-c${i}`), { store: st, itemId, item: it?.name || itemId, getKey: it?.getKey || "", date, count, byName: by, byUid: user.uid, src: "report", createdAt: at(date, 23, i) }); n++;
      }
      await setDoc(flag, { done: Date.now(), by: email, lines: n }); toast(S.msg);
    }
    // 28/10 09:23: 33 dust masks in stock at Rompad Stores, as given by Muneer
    const dm = doc(db, "stConfig", "fix-2026-10-28-dustmasks");
    if (!(await getDoc(dm)).exists()) {
      await setDoc(doc(db, "stCounts", "fix-2026-10-28-dustmasks"), { store: "rompad", itemId: "ppe-resp", item: "Respirator / dust mask", getKey: "", date: "2026-10-28", count: 33, byName: "Muneer", byUid: user.uid, src: "admin", createdAt: Date.parse("2026-10-28T09:23:00+02:00") });
      await setDoc(dm, { done: Date.now(), by: email }); toast("Dust masks set to 33 in stock at Rompad Stores");
    }
    // 24/10: oil, antifreeze and degreaser to Simon were for TDR013; book them to that machine where they were loaded before
    const fix = doc(db, "stConfig", "fix-2026-10-24-tdr013");
    if (!(await getDoc(fix)).exists()) {
      const S = REPORT_SEEDS.find(x => x.id === "seed-2026-10-22-24-rompad");
      for (const [i, r] of S.m.entries()) if (r[11] === "To Simon for TDR013") await setDoc(doc(db, "stMoves", `${S.id}-m${i}`), { machine: "TDR013" }, { merge: true });
      await setDoc(fix, { done: Date.now(), by: email });
    }
  } catch (e) { console.warn(e); } finally { seedingRep = false; }
}

/* ---------- set lists of what is in the stores (as given by Muneer, 28/10) ----------
   Drill Stores: 28/10 handover closing report (titled Rompad, but it is Drill Stores stock) for oils, PPE, GET and
   fasteners (half-thread and M16 lines are Rompad, so they go to Rompad Stores); the rest from the 20/10 Drill Stores opening list.
   [id (existing or new), store, cat, name, unit, qty, date, note] */
const L28 = "2026-10-28", L20 = "2026-10-20", OO = "Other oils & lubricants", RC = "Rockdrill / compressor oil";
const SET_LIST = [
  ["oil-hyd", "drill", "", "", "", 3, L28, "reorder"], ["dr-lith", "drill", "Grease", "Lithium complex EP2 grease", "ea", 0, L28, "out of stock"],
  ["dr-degr", "drill", OO, "Degreaser", "5L", 2, L28, ""], ["oil-eng", "drill", "", "", "", 2, L28, "5 L x2 left"], ["dr-comp68", "drill", RC, "Compressor oil 68", "20L", 5, L28, ""],
  ["oil-comp", "drill", "", "", "", 1, L28, "10 L left"], ["dr-anti", "drill", OO, "Antifreeze", "5L", 1, L28, ""], ["dr-rd220", "drill", RC, "Rockdrill oil 220", "20L", 2, L28, ""],
  ["dr-gear", "drill", OO, "Engine gearlube 80W-90", "ea", 4, L28, ""], ["dr-getran", "drill", OO, "Getran gear oil 80W-90", "ea", 3, L28, ""],
  ["dr-trans", "drill", OO, "Transmission fluid", "ea", 1, L28, ""], ["dr-axle", "drill", OO, "Spirax axle oil", "ea", 2, L28, ""],
  ["ppe-gloves", "drill", "", "", "", 0, L28, ""], ["ppe-glasses", "drill", "", "", "", 2, L28, ""], ["ppe-resp", "drill", "", "", "", 33, L28, ""], ["dr-earbox", "drill", "PPE", "Ear plugs (box)", "box", 1.5, L28, ""],
  ["get-bit", "drill", "", "", "", 2, L28, ""], ["get-rod", "drill", "", "", "", 1, L28, ""], ["dr-rodcatch", "drill", "Spares", "Rod catcher", "ea", 3, L28, ""],
  ["dr-m36x100", "drill", "Fasteners", "M36 x 100 bolts", "ea", 3, L28, ""], ["dr-m20b", "drill", "Fasteners", "M20 bolts", "ea", 4, L28, ""], ["dr-m27n", "drill", "Fasteners", "M27 nuts", "ea", 8, L28, ""],
  ["rp-m16n", "rompad", "Fasteners", "M16 nuts", "ea", 0, L28, "critical, reorder"], ["rp-m16x200", "rompad", "Fasteners", "M16 x 200 bolts (full thread)", "ea", 6, L28, ""],
  ["rp-m20x150", "rompad", "Fasteners", "M20 x 150 bolts (half thread)", "ea", 1, L28, ""], ["rp-m24x120", "rompad", "Fasteners", "M24 x 120 bolts (half thread)", "ea", 4, L28, ""],
  ["rp-m20x140", "rompad", "Fasteners", "M20 x 140 bolts (half thread)", "ea", 4, L28, ""], ["rp-m24x140", "rompad", "Fasteners", "M24 x 140 bolts (half thread)", "ea", 5, L28, ""],
  ["rp-m20x100", "rompad", "Fasteners", "M20 x 100 bolts (half thread)", "ea", 8, L28, ""],
  ["ppe-helmet", "drill", "", "", "", 0, L20, ""], ["dr-face", "drill", "PPE", "Face shields", "ea", 2, L20, ""], ["dr-shirt", "drill", "PPE", "Shirts – small", "ea", 12, L20, ""],
  ["dr-wapron", "drill", "PPE", "Welding apron", "ea", 1, L20, ""], ["dr-wgloves", "drill", "PPE", "Welding gloves", "pr", 1, L20, ""], ["dr-rain", "drill", "PPE", "Rain jackets", "ea", 36, L20, ""],
  ["dr-127", "drill", "GET", "127 mm bits", "ea", 0, L20, ""], ["dr-102", "drill", "GET", "102 mm bits", "ea", 0, L20, ""],
  ...[["Clamping collars", 2], ["PTO clamps", 0], ["Gasket seal covers", 2], ["Desikhan packet", 1], ["Soft grippers", 0], ["Threaded pins", 6], ["Companion flanges", 2], ["T-head pin", 3],
    ["Rod cylinder (0.5 m circ / 2 cm)", 2], ["Roller chains", 3], ["Master-link full link", 9], ["Master-link half link", 9], ["Hydraulic hose", 1], ["Industrial hose", 1], ["Accelerator cable", 1],
    ["Dust collector tire", 1], ["Hose section SL 90", 1], ["Filters", 13], ["Gasket maker", 2], ["Pin cushion", 4], ["Automotive water pump", 1], ["Pressure gauge", 1], ["EGD controller button", 1],
    ["Wheel nut indicators", 108], ["Wheel chock set", 1], ["Measuring tape", 7], ["First aid kit", 1], ["Stickers – TKRH022, TKRH023, TKR09", 1, "set"], ["Cord 20 m", 1], ["Fire extinguisher", 4],
    ["Emergency stop button", 6], ["Rotating light", 2], ["Microphone – DM1 range", 1], ["Solenoid cartridges", 0], ["Moil (rockbreaker tool)", 2], ["500 hr service kit", 1, "kit"], ["250 hr service kit", 1, "kit"], ["Injector", 1]]
    .map(([n, q, u], i) => ["dr-sp" + i, "drill", "Spares", n, u || "ea", q, L20, ""]),
  ...[["M16 x 80 bolt", 16], ["M14 nuts & flat washers", 16], ["MIG tip con", 11], ["M10 x 130 bolts", 6], ["Nut hex 10 mm", 50], ["M10 x 70 bolt", 13], ["M8 nuts", 14], ["M16 x 100 bolt", 7],
    ["M20 nuts & washers", 8], ["M18 x 40 bolt", 10], ["M18 nuts", 10], ["M8 washers", 10], ["Split ring washer", 16], ["Cotter pins", 40], ["M12 x 80 bolt", 3], ["M14 nuts", 26], ["Cotter pins – extra", 39],
    ["M20 x 150 hex bolt", 10], ["M24 bolt", 3], ["Saddle M24 bolts", 4], ["M16 x 35", 4], ["M14 x 50", 4], ["14 mm grinding cup", 6], ["Cutting disc set (10)", 1, "set"]]
    .map(([n, q, u], i) => ["dr-fa" + i, "drill", "Fasteners", n, u || "ea", q, L20, ""]),
];
async function seedSetList() {
  const flag = doc(db, "stConfig", "seed-2026-10-28-setlist"); if ((await getDoc(flag)).exists()) return;
  const cur = (await getDoc(doc(db, "stConfig", "items"))); const list = cur.exists() ? (cur.data().list || []).slice() : DEFAULT_ITEMS.slice();
  for (const [id, st, cat, name, unit] of SET_LIST) if (cat && !list.some(i => i.id === id)) list.push({ id, store: st, cat, name, unit, ...(cat === "PPE" ? { ppe: "other" } : {}) });
  await setDoc(doc(db, "stConfig", "items"), { list }, { merge: true });
  let n = 0;
  for (const [i, [id, st, , , , qty, date]] of SET_LIST.entries()) { const it = list.find(x => x.id === id);
    await setDoc(doc(db, "stCounts", `setlist-${st}-${id}`), { store: st, itemId: id, item: it?.name || id, getKey: it?.getKey || "", date, count: qty, byName: "Muneer", byUid: user.uid, src: "setlist", createdAt: Date.parse(date + "T06:00:00+02:00") + i }); n++; }
  // the 33 dust masks set on Rompad earlier are Drill Stores stock
  await deleteDoc(doc(db, "stCounts", "fix-2026-10-28-dustmasks")).catch(() => {});
  // 22/10 "site office to Rompad" lines and 24/10 oils to Simon for TDR013 were Drill Stores moving to the Rompad, so they belong to Drill Stores
  const S = REPORT_SEEDS.find(x => x.id === "seed-2026-10-22-24-rompad");
  for (const [i, r] of S.m.entries()) if (r[11].startsWith("Moved from the site office") || r[11] === "To Simon for TDR013") await setDoc(doc(db, "stMoves", `${S.id}-m${i}`), { store: "drill" }, { merge: true });
  await setDoc(flag, { done: Date.now(), by: email, lines: n }); toast("Store lists loaded: Drill Stores and Rompad Stores");
}

/* ---------- live data ---------- */
function startApp() {
  gate.hidden = true; app.hidden = false; $("outBtn").hidden = false;
  $("who").textContent = (me ? me.name + " · store controller" : showName(email) + (isAdmin() ? " · admin" : isSup() ? " · supervisor" : " · manager"));
  const live = (name, set) => subs.push(onSnapshot(collection(db, name), s => { set(s.docs.map(d => ({ id: d.id, ...d.data() }))); render(); }, e => { console.warn(e); netNote("Couldn't load everything. Check the signal."); }));
  live("stMoves", v => moves = v); live("stCounts", v => counts = v); live("stReports", v => reports = v);
  if (boss && isAdmin()) setTimeout(async () => { await seedOctoberGet(); await seedReports(); try { await seedSetList(); } catch (e) { console.warn(e); } }, 1500);
  subs.push(onSnapshot(doc(db, "stConfig", "items"), s => { itemsSaved = s.exists(); items = itemsSaved ? (s.data().list || []) : DEFAULT_ITEMS.slice(); render(); }, () => {}));
  subs.push(onSnapshot(doc(db, "stConfig", "status"), s => { status = s.exists() ? (s.data().machines || {}) : {}; render(); }, () => {}));
  subs.push(onSnapshot(doc(db, "stConfig", "settings"), s => { if (s.exists()) settings = Object.assign({ supervisor: "" }, s.data()); render(); }, () => {}));
  if (boss) subs.push(onSnapshot(collection(db, "fcMetres"), s => { fcMetres = s.docs.map(d => d.data()); render(); }, () => {}));
  if (isBoss()) subs.push(onSnapshot(collection(db, "stUsers"), s => { staff = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name)); render(); }, () => {}));
  render();
}

/* ---------- duplicates: same store, issue/receive, day, item, quantity, machine and person ---------- */
const dupKey = x => [x.store, x.kind, x.date, (x.itemId || String(x.item || "").trim().toLowerCase()), num(x.qty), String(x.machine || "").toUpperCase(), String(x.kind === "issue" ? x.to || "" : x.from || "").trim().toLowerCase()].join("|");
function duplicates() {   // later lines that repeat an earlier one; the first line is kept as the real one
  const seen = new Map(), dups = new Map();
  moves.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).forEach(x => { const k = dupKey(x); if (seen.has(k)) dups.set(x.id, seen.get(k)); else seen.set(k, x); });
  return dups;
}

/* ---------- numbers ---------- */
const storeItems = st => items.filter(i => i.store === st || i.store === "both");
const itemOf = id => items.find(i => i.id === id);
const inMonth = (x, m) => (x.date || "").slice(0, 7) === m;
const val = x => num(x.qty) * num(x.price);
const issuesOf = (st, m) => moves.filter(x => x.kind === "issue" && (!st || x.store === st) && (!m || inMonth(x, m)));
const receiptsOf = (st, m) => moves.filter(x => x.kind === "receive" && (!st || x.store === st) && (!m || inMonth(x, m)));
function stockOf(st, it) {
  const c = counts.filter(x => x.store === st && x.itemId === it.id).sort((a, b) => (a.date + (a.createdAt || 0)).localeCompare(b.date + (b.createdAt || 0))).at(-1);
  const from = c ? c.date : "";
  const after = kind => moves.filter(x => x.store === st && x.kind === kind && (x.itemId === it.id || (!x.itemId && x.item === it.name)) && (!c || x.date > from || (x.date === from && (x.createdAt || 0) > (c.createdAt || 0)))).reduce((n, x) => n + num(x.qty), 0);
  const recv = after("receive"), iss = after("issue");
  return { count: c ? num(c.count) : null, countDate: from, recv, iss, onHand: (c ? num(c.count) : 0) + recv - iss, net: recv - iss };
}
function machineTotals(st, m) {
  // every machine in the store's list, plus any other machine items went to, plus a line for items not booked to a machine
  const used = [...new Set(issuesOf(st, m).map(x => x.machine).filter(Boolean))].filter(x => !STORES[st].machines.includes(x)).sort();
  const NA = "Not booked to a machine";
  const rows = [...STORES[st].machines, ...used, NA].map(mc => {
    const l = issuesOf(st, m).filter(x => mc === NA ? !x.machine : x.machine === mc);
    const o = {}; OILS.forEach(k => o[k] = l.filter(x => x.cat === k).reduce((n, x) => n + num(x.qty), 0));
    return { mc, oils: o, spares: l.filter(x => !OILS.includes(x.cat) && x.cat !== "PPE").length, value: l.reduce((n, x) => n + val(x), 0), get: l.filter(x => x.cat === "GET").reduce((n, x) => n + val(x), 0), lines: l.length };
  });
  return rows.filter(r => r.mc !== NA || r.lines);
}

/* ---------- rendering ---------- */
const TABS = [["log", "Issue / Receive"], ["count", "Stock count"], ["dash", "Dashboard"], ["ppe", "PPE"], ["stock", "Stock"], ["report", "Consumption report"], ["items", "Items & prices"], ["users", "Store controllers"]];
function render(force) {
  if (app.hidden) return;
  // don't redraw the stock count while someone is typing in it; it redraws when they leave the box
  if (!force && tab === "count" && document.activeElement?.closest?.("#countView") && document.activeElement.matches("input:not([type=file]), textarea, select")) { renderLater = true; return; }
  const tabs = TABS.filter(([k]) => (k !== "items" && k !== "users") || isBoss());
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  const keep = {}; app.querySelectorAll("form [id]").forEach(el => { if ("value" in el && el.type !== "submit") keep[el.id] = el.value; });
  let h = `<div class="storesw" role="group" aria-label="Store">${Object.entries(STORES).map(([k, s]) => `<button data-store="${k}" aria-pressed="${store === k}">${s.name}</button>`).join("")}</div>
    <div class="tabs" role="tablist">${tabs.map(([k, t]) => `<button role="tab" aria-selected="${tab === k}" data-tab="${k}">${t}</button>`).join("")}</div>`;
  h += ({ log: logView, count: countView, dash: dashView, ppe: ppeView, stock: stockView, report: reportView, items: itemsView, users: usersView }[tab])();
  app.innerHTML = h;
  Object.entries(keep).forEach(([id, v]) => { const el = document.getElementById(id); if (el && !el.dataset.fresh) el.value = v; });
  syncForms();
}
const opt = (v, l, sel) => `<option value="${esc(v)}" ${sel ? "selected" : ""}>${esc(l)}</option>`;
function moveForm(kind) {
  const isOut = kind === "out", f = form[kind], cats = CATS[store], cat = f.cat || cats[0], its = storeItems(store).filter(i => i.cat === cat);
  const getTiles = cat === "GET" ? `<div class="gets">${its.map(i => `<button type="button" data-pickitem="${kind}:${esc(i.id)}" aria-pressed="${f.itemId === i.id}"><b>${esc(GET_KEYS.find(g => g[0] === i.getKey)?.[1] || i.name)}</b><span>${esc(i.name)}</span><span>${i.price ? R(i.price) + " each" : "no price yet"}</span></button>`).join("")}</div>` : "";
  const P = isOut ? "o" : "i";
  return `<section class="card ${isOut ? "out" : "in"}">
    <h2><span class="badge">${isOut ? "↑" : "↓"}</span>${isOut ? "ISSUE – items going out of the store" : "RECEIVE – items coming into the store"}</h2>
    <p class="muted" style="margin-top:0">${isOut ? "Someone takes items: log what, how many, for which machine and who took it." : "A delivery or return comes in: log what came in and the delivery note number."}</p>
    <form id="f-${kind}" class="grid" autocomplete="off" data-kind="${kind}">
      <label>Date <input type="date" id="${P}Date" value="${today()}" max="${today()}"></label>
      ${isOut ? `<label>Shift <select id="${P}Shift">${opt("Day", "Day")}${opt("Night", "Night")}</select></label>` : ""}
      <label style="grid-column:1/-1">Category <select id="${P}Cat" data-fresh="1">${cats.map(c => opt(c, c === "GET" ? "GET (bits, rods, shanks, hammers)" : c, c === cat)).join("")}${opt("Anything", "Anything – type any item", cat === "Anything")}</select></label>
      <div style="grid-column:1/-1">${getTiles}</div>
      <label style="grid-column:1/-1" ${cat === "GET" ? "hidden" : ""}>Item <select id="${P}Item" data-fresh="1">${its.map(i => opt(i.id, i.name + (i.unit ? " (" + i.unit + ")" : ""), f.itemId === i.id)).join("")}${opt("__other", "Other item – type it", f.itemId === "__other" || (!its.length && cat !== "GET"))}</select></label>
      <label style="grid-column:1/-1" id="${P}OtherWrap" hidden>Item name <input id="${P}Other" placeholder="For example M16 bolt"></label>
      <label id="${P}UnitWrap" hidden>Unit <input id="${P}Unit" placeholder="ea, 20L, kg, pr"></label>
      <label id="${P}PriceEachWrap" hidden>Price each in R (optional) <input id="${P}PriceEach" inputmode="decimal" placeholder="Leave empty if not known"></label>
      <label>Qty <input id="${P}Qty" inputmode="decimal" value="1"></label>
      ${isOut ? `<label>Machine <select id="${P}Mach">${opt("", "Store / no machine")}${STORES[store].machines.map(m => opt(m, m)).join("")}${opt("__other", "Other machine – type it")}</select></label>
        <label id="${P}MachOtherWrap" hidden>Machine name <input id="${P}MachOther" placeholder="For example TLDV012"></label>
        <label>Issued to <input id="${P}To" list="names" placeholder="Name of the person"></label>`
      : `<label>Received from <input id="${P}From" placeholder="Supplier or main store"></label><label>Delivery note / GRN no. <input id="${P}Ref"></label>`}
      <label style="grid-column:1/-1">Note (optional) <input id="${P}Note"></label>
      <div style="grid-column:1/-1" class="price" id="${P}Price"></div>
      <div style="grid-column:1/-1"><button class="${isOut ? "out" : "in"}" style="width:100%;min-height:52px;font-size:18px">${isOut ? "Issue" : "Receive"}</button></div>
      <p class="flag" id="${P}Err" style="grid-column:1/-1;margin:0"></p>
    </form></section>`;
}
function syncForms() {
  ["out", "in"].forEach(kind => {
    const P = kind === "out" ? "o" : "i", sel = $(P + "Item"); if (!$(P + "Cat")) return;
    const cat = $(P + "Cat").value, f = form[kind];
    const id = cat === "GET" ? f.itemId : sel.value, it = itemOf(id), other = id === "__other" || (!it && cat !== "GET");
    $(P + "OtherWrap").hidden = !other; $(P + "UnitWrap").hidden = !other; $(P + "PriceEachWrap").hidden = !other;
    if ($(P + "Mach")) $(P + "MachOtherWrap").hidden = $(P + "Mach").value !== "__other";
    const q = num($(P + "Qty").value);
    $(P + "Price").innerHTML = it ? `${esc(it.name)} · ${it.price ? R(it.price) + " per " + esc(it.unit || "unit") + (q ? " · value <b>" + R(it.price * q) + "</b>" : "") : "no price set (admin adds it under Items & prices)"}${kind === "out" && !other ? " · in store: " + stockText(it) : ""}` : (cat === "GET" ? "Tap Bits, Rods, Shanks or Hammers." : "");
  });
  const dl = document.getElementById("names"); if (!dl) app.insertAdjacentHTML("beforeend", `<datalist id="names">${[...new Set(moves.map(x => x.to).filter(Boolean))].sort().map(n => `<option value="${esc(n)}">`).join("")}</datalist>`);
}
const stockText = it => { const s = stockOf(store, it); return `<b class="${s.onHand <= num(it.min) ? "low" : ""}">${nq(s.onHand)}</b> ${esc(it.unit || "")}`; };
function lineHtml(x, canDel, dup) {
  const out = x.kind === "issue";
  return `<div class="line"><span class="pill ${out ? "out" : "in"}">${out ? "Issued" : "Received"}</span>
    <div><b>${esc(nq(x.qty))} ${esc(x.unit || "")} × ${esc(x.item)}</b>${x.price ? ` · ${R(val(x))}` : ""}${dup ? ` <span class="pill out" title="Same store, day, item, quantity, machine and person as a line logged earlier">Possible duplicate</span>` : ""}
      <div class="meta">${fmt(x.date)}${x.shift ? " " + esc(x.shift) : ""} · ${esc(x.cat)}${x.machine ? " · " + esc(x.machine) : ""}${x.to ? " · to " + esc(x.to) : ""}${x.from ? " · from " + esc(x.from) : ""}${x.ref ? " · " + esc(x.ref) : ""}${x.note ? " · " + esc(x.note) : ""} · logged by ${esc(x.byName || "")}</div></div>
    ${canDel ? `<button class="ghost" data-del="${esc(x.id)}">Remove</button>` : "<span></span>"}</div>`;
}
const mayDel = x => isBoss() || (me && x.byUid === user?.uid && x.date >= ymd(new Date(Date.now() - 2 * 864e5)));
function logView() {
  const recent = moves.filter(x => x.store === store).sort((a, b) => (b.date + pad(b.createdAt || 0)).localeCompare(a.date + pad(a.createdAt || 0))).slice(0, 40);
  const dups = duplicates(), mine = [...dups.keys()].map(id => moves.find(x => x.id === id)).filter(x => x && x.store === store);
  const dupCard = mine.length ? `<section class="card" style="border:2px solid var(--bad)"><h2>Possible duplicates (${mine.length})</h2>
    <p class="muted" style="margin-top:0">These lines repeat a line logged earlier: same day, item, quantity, machine and person. If it is the same issue or delivery logged twice, remove it so stock and cost are not counted twice. If it really happened twice, keep it.</p>
    ${mine.map(x => { const o = dups.get(x.id); return lineHtml(x, mayDel(x), true) + `<div class="meta" style="margin:-4px 0 8px 0">First logged by ${esc(o.byName || "")}${o.createdAt ? " at " + new Date(o.createdAt).toLocaleString("en-ZA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : ""}</div>`; }).join("")}</section>` : "";
  return `${dupCard}<div class="pair">${moveForm("out")}${moveForm("in")}</div>
    <section class="card"><h2>Latest at ${STORES[store].name}</h2>${recent.length ? recent.map(x => lineHtml(x, mayDel(x), dups.has(x.id))).join("") : '<div class="empty"><b>Nothing logged yet</b>Every item issued or received shows here.</div>'}
    <p class="muted">A line can be removed by the person who logged it for 2 days. After that ask admin.</p></section>`;
}
function monthPick(id = "month") { return `<label>Month <input type="month" id="${id}" value="${month}" max="${today().slice(0, 7)}"></label>`; }
function tile(l, n, s, cls = "") { return `<div class="tile ${cls}"><div class="l">${l}</div><div class="n">${n}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`; }
function dashView() {
  const iss = issuesOf(store, month), rec = receiptsOf(store, month), mt = machineTotals(store, month);
  const value = iss.reduce((n, x) => n + val(x), 0), getV = iss.filter(x => x.cat === "GET").reduce((n, x) => n + val(x), 0);
  const low = storeItems(store).filter(i => { const s = stockOf(store, i); return s.onHand !== null && s.onHand <= num(i.min) && num(i.min) > 0; });
  const byItem = {}; iss.forEach(x => { const k = x.item + "|" + (x.unit || ""); byItem[k] = byItem[k] || { item: x.item, unit: x.unit, qty: 0, value: 0 }; byItem[k].qty += num(x.qty); byItem[k].value += val(x); });
  const top = Object.values(byItem).sort((a, b) => b.value - a.value || b.qty - a.qty).slice(0, 10);
  const days = []; const d0 = parse(month + "-01"); const dn = new Date(d0.getFullYear(), d0.getMonth() + 1, 0).getDate();
  for (let i = 1; i <= dn; i++) { const ds = month + "-" + pad(i); days.push({ ds, lines: iss.filter(x => x.date === ds).length, value: iss.filter(x => x.date === ds).reduce((n, x) => n + val(x), 0) }); }
  return `<div class="strip"><div><h2>${STORES[store].name} · ${monthName(month)}</h2><div class="muted">${STORES[store].sub}</div>${lastLogged()}</div><div class="row">${monthPick()}<button class="primary" data-report="1">Download consumption report</button></div></div>
  ${store === "drill" && fcMetres ? (() => { const end = month === today().slice(0, 7) ? today() : month + "-31";
      const mm = fcMetres.filter(x => (x.date || "").slice(0, 7) === month && x.date < end).reduce((n, x) => n + num(x.metres), 0);
      const lastM = fcMetres.filter(x => (x.date || "").slice(0, 7) === month).reduce((d, x) => x.date > d ? x.date : d, "");
      const getC = iss.filter(x => ["BIT", "ROD", "SHANK"].includes(x.getKey) && x.date <= lastM).reduce((n, x) => n + val(x), 0);   // same days as the metres
      return `<div class="tiles">${tile("GET cost per metre", mm ? "R" + (getC / mm).toFixed(2) : "–", mm ? `1 to ${fmt(lastM).slice(0, 5)}: ${R(getC)} bits, rods and shanks ÷ ${String(Math.round(mm * 10) / 10).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} m · standard R39.72/m` : "no metres yet", "dark")}${tile("Metres month to date", mm ? (Math.round(mm * 10) / 10).toFixed(1) + " m" : "–", lastM ? "captured up to " + fmt(lastM) : "add metres in GET Forecast")}</div>`; })() : ""}
  <div class="tiles">${tile("Items issued", iss.length, "lines this month", "dark")}${tile("Value issued", R(value), "items with a price")}${store === "drill" ? tile("GET issued", R(getV), GET_KEYS.map(([k, n]) => { const q = iss.filter(x => x.getKey === k).reduce((a, x) => a + num(x.qty), 0); return q ? q + " " + (q === 1 ? n.slice(0, -1) : n).toLowerCase() : ""; }).filter(Boolean).join(" · ") || "none") : ""}${tile("Received", rec.length, "lines this month")}${tile("Low stock", low.length, low.map(i => esc(i.name)).slice(0, 3).join(", ") || "none")}${(() => { const d = [...duplicates().keys()].map(id => moves.find(x => x.id === id)).filter(x => x && x.store === store && inMonth(x, month)).length; return d ? tile("Possible duplicates", d, "check them on Issue / Receive", "") : ""; })()}</div>
  <section class="card"><h2>Totals per machine</h2><div class="tbl"><table><thead><tr><th>Machine</th>${OILS.map(o => `<th class="r">${o}${OIL20(o) ? " (20 L)" : ""}</th>`).join("")}<th class="r">Spares items issued</th><th class="r">Value</th><th>Status</th></tr></thead><tbody>
    ${mt.map(r => `<tr><td><b>${r.mc}</b></td>${OILS.map(o => `<td class="num">${nq(r.oils[o]) || ""}</td>`).join("")}<td class="num">${r.spares || ""}</td><td class="num">${r.value ? R(r.value) : ""}</td>
      <td>${canLog() ? `<input data-status="${r.mc}" value="${esc(status[r.mc] || "")}" placeholder="Working" style="min-width:160px">` : esc(status[r.mc] || "")}</td></tr>`).join("")}
    <tr style="font-weight:700"><td>Total</td>${OILS.map(o => `<td class="num">${nq(mt.reduce((n, r) => n + r.oils[o], 0))}</td>`).join("")}<td class="num">${mt.reduce((n, r) => n + r.spares, 0)}</td><td class="num">${R(mt.reduce((n, r) => n + r.value, 0))}</td><td></td></tr>
  </tbody></table></div></section>
  <div class="pair"><section class="card"><h2>Lines issued per day</h2>${barChart(days)}</section>
  <section class="card"><h2>Top items issued</h2>${top.length ? `<div class="tbl"><table><thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Value</th></tr></thead><tbody>${top.map(t => `<tr><td>${esc(t.item)}</td><td class="num">${nq(t.qty)} ${esc(t.unit || "")}</td><td class="num">${t.value ? R(t.value) : ""}</td></tr>`).join("")}</tbody></table></div>` : '<div class="muted">Nothing issued this month yet.</div>'}</section></div>`;
}
function barChart(days) {
  const W = 620, H = 180, pl = 28, pb = 22, max = Math.max(1, ...days.map(d => d.lines)), bw = (W - pl) / days.length;
  const bars = days.map((d, i) => { const h = (H - pb - 10) * d.lines / max; return `<rect x="${pl + i * bw + 1}" y="${H - pb - h}" width="${Math.max(1, bw - 2)}" height="${h}" fill="#d4a12a" rx="2"><title>${fmt(d.ds)}: ${d.lines} lines${d.value ? ", " + R(d.value) : ""}</title></rect>${i % 5 === 0 ? `<text x="${pl + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${+d.ds.slice(8)}</text>` : ""}`; }).join("");
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Lines issued per day"><line x1="${pl}" y1="${H - pb}" x2="${W}" y2="${H - pb}" stroke="currentColor" opacity=".25"/><text x="0" y="14">${max}</text><text x="0" y="${H - pb}">0</text>${bars}</svg></div>`;
}
function ppeView() {
  const sts = ppeStore === "all" ? ["drill", "rompad"] : [ppeStore];
  const ppeItems = items.filter(i => i.cat === "PPE");
  const iss = moves.filter(x => x.kind === "issue" && x.cat === "PPE" && sts.includes(x.store) && inMonth(x, month));
  const people = [...new Set(iss.map(x => (x.to || "").trim()).filter(Boolean))].sort();
  const qtyOf = (name, list = iss) => list.filter(x => x.item === name).reduce((n, x) => n + num(x.qty), 0);
  const stockAll = it => { let any = false, t = 0; sts.forEach(s => { if (it.store === "both" || it.store === s) { const k = stockOf(s, it); if (k.onHand !== null) { any = true; t += k.onHand; } } }); return any ? t : null; };
  const low = ppeItems.filter(i => { const s = stockAll(i); return s !== null && num(i.min) > 0 && s <= num(i.min); });
  const value = iss.reduce((n, x) => n + val(x), 0);
  return `<div class="strip"><div><h2>PPE consumption · ${monthName(month)}</h2><div class="muted">Personal protective equipment issued from the stores</div></div>
    <div class="row"><label>Store <select id="ppeStore">${opt("all", "Both stores", ppeStore === "all")}${opt("drill", "Drill Stores", ppeStore === "drill")}${opt("rompad", "Rompad Stores", ppeStore === "rompad")}</select></label>${monthPick()}<button class="primary" data-report="1">Download consumption report</button></div></div>
  <div class="tiles">${tile("Employees issued PPE", people.length, "this month", "dark")}${tile("Items issued", nq(iss.reduce((n, x) => n + num(x.qty), 0)), iss.length + (iss.length === 1 ? " line" : " lines"))}${tile("PPE value", value ? R(value) : "–", value ? "items with a price" : "add prices under Items & prices")}${tile("Low stock items", low.length, low.map(i => esc(i.name)).join(", ") || "none")}</div>
  <div class="ppe">${ppeItems.map(i => { const s = stockAll(i), q = qtyOf(i.name), mn = num(i.min); const pc = s === null ? 0 : Math.min(100, mn ? 100 * s / (mn * 3) : 100);
    return `<div class="it"><div class="em" aria-hidden="true">${PPE_ICON[i.ppe] || PPE_ICON.other}</div><div style="flex:1;min-width:0"><b>${esc(i.name)}</b><span class="muted">${nq(q)} ${esc(i.unit || "")} issued · ${nq(s || 0)} in store</span>
      ${s === null ? "" : `<div class="bar"><i class="${mn && s <= mn ? "low" : ""}" style="width:${pc}%"></i></div>`}</div></div>`; }).join("")}</div>
  <div class="pair"><section class="card"><h2>PPE issuance register</h2>${people.length ? `<div class="tbl"><table><thead><tr><th>Employee</th>${ppeItems.map(i => `<th class="r">${esc(i.name)}</th>`).join("")}</tr></thead><tbody>
    ${people.map(p => `<tr><td>${esc(p)}</td>${ppeItems.map(i => { const q = iss.filter(x => x.to?.trim() === p && x.item === i.name).reduce((n, x) => n + num(x.qty), 0); return `<td class="r">${q ? `<span class="chk">✓</span>${q > 1 ? " " + nq(q) : ""}` : '<span class="nochk">–</span>'}</td>`; }).join("")}</tr>`).join("")}
    </tbody></table></div>` : '<div class="muted">No PPE issued to a named person this month. Type the name in "Issued to" when PPE goes out.</div>'}</section>
  <section class="card"><h2>Stock alerts</h2>${low.length ? low.map(i => `<div class="line"><span class="pill out">Low stock</span><div><b>${esc(i.name)}</b><div class="meta">${nq(stockAll(i))} ${esc(i.unit || "")} left · minimum ${nq(i.min)}</div></div><span></span></div>`).join("") : '<div class="muted">No PPE below its minimum. Admin sets the minimum per item under Items & prices.</div>'}</section></div>`;
}
function lastLogged() {
  const l = moves.filter(x => x.store === store).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0]; if (!l) return "";
  const lastDay = moves.filter(x => x.store === store).map(x => x.date).sort().at(-1);
  const when = l.createdAt ? (d => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} at ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`)(new Date(l.createdAt)) : "";
  return `<div class="muted" style="margin-top:2px"><b>Last update:</b> lines up to ${fmt(lastDay)}${when ? " · last saved " + esc(when) + (l.byName ? " by " + esc(l.byName) : "") : ""}</div>`;
}
function stockView() {
  const its = storeItems(store);
  return `<section class="card"><h2>Stock at ${STORES[store].name}</h2>
    <p class="muted" style="margin-top:0">On hand = stock from the last closing report + received − issued since then.${store === "drill" ? " GET stock and GET issued go to the GET Forecast by themselves." : ""}</p>
    <div class="tbl"><table><thead><tr><th>Item</th><th>Category</th><th class="r">Received since</th><th class="r">Issued since</th><th class="r">On hand</th><th class="r">Minimum</th></tr></thead><tbody>
    ${its.map(i => { const s = stockOf(store, i); const low = num(i.min) > 0 && s.onHand <= num(i.min);
      return `<tr><td><b>${esc(i.name)}</b> <span class="muted">${esc(i.unit || "")}</span></td><td>${esc(i.cat)}</td><td class="num">${nq(s.recv) || ""}</td><td class="num">${nq(s.iss) || ""}</td>
        <td class="num ${low ? "low" : ""}">${nq(s.onHand)}</td><td class="num">${i.min ? nq(i.min) : ""}</td></tr>`; }).join("")}
    </tbody></table></div><p class="muted">Items typed as "Other item" are not in this list; admin adds them under Items & prices to track their stock.</p></section>`;
}
function reportView() {
  return `<section class="card" style="max-width:640px"><h2>Consumption report</h2>
    <p style="margin-top:0">A TKR-branded Excel for the month, set out like the stores consumption report: totals per machine and everything issued for the Drill rigs and the Rompad rockbreakers, every issue, PPE, and everything received.</p>
    <div class="grid">${monthPick()}<label>Stores controller <input id="repCtl" value="${esc(myName())}"></label><label>Supervisor <input id="repSup" value="${esc(settings.supervisor || "")}"></label></div>
    <button class="primary" data-report="1" style="margin-top:12px">Download consumption report</button></section>`;
}
function itemsView() {
  const its = items.slice().sort((a, b) => (a.store + a.cat + a.name).localeCompare(b.store + b.cat + b.name));
  const allCats = [...new Set([...CATS.drill, ...CATS.rompad])];
  return `<section class="card"><h2>Items & prices</h2><p class="muted" style="margin-top:0">These are the items the store controllers choose from. A price here shows when an item is issued and gives the value in the dashboards and the report. Minimum = the stock level that raises a low-stock alert.${itemsSaved ? "" : " <b>The list below is the starting list. Save once to keep it.</b>"}</p>
    <div class="tbl"><table><thead><tr><th>Store</th><th>Category</th><th>Item</th><th>Unit</th><th class="r">Price (R)</th><th class="r">Minimum</th><th>PPE icon</th><th></th></tr></thead><tbody>
    ${its.map(i => `<tr data-iid="${esc(i.id)}"><td><select data-f="store">${opt("drill", "Drill", i.store === "drill")}${opt("rompad", "Rompad", i.store === "rompad")}${opt("both", "Both", i.store === "both")}</select></td>
      <td><select data-f="cat">${allCats.map(c => opt(c, c, i.cat === c)).join("")}</select></td><td><input data-f="name" value="${esc(i.name)}"></td><td><input data-f="unit" value="${esc(i.unit || "")}" style="width:70px"></td>
      <td><input data-f="price" inputmode="decimal" value="${esc(i.price ?? "")}" style="width:100px"></td><td><input data-f="min" inputmode="decimal" value="${esc(i.min ?? "")}" style="width:70px"></td>
      <td>${i.cat === "PPE" ? `<select data-f="ppe">${Object.keys(PPE_ICON).map(k => opt(k, PPE_ICON[k] + " " + k, i.ppe === k)).join("")}</select>` : (i.getKey ? `<span class="muted">GET: ${esc(i.getKey)}</span>` : "")}</td>
      <td>${i.getKey ? "" : `<button class="ghost" data-idel="${esc(i.id)}">Remove</button>`}</td></tr>`).join("")}
    </tbody></table></div>
    <div class="row" style="margin-top:12px"><button id="iAdd">Add an item</button><button class="primary" id="iSave">Save items & prices</button></div>
    <p class="muted">GET items (bits, rods, shanks, hammers) are linked to the GET Forecast and can't be removed. Their prices here are also the prices in the GET Forecast.</p></section>
    <section class="card" style="max-width:520px"><h2>Report details</h2><div class="grid"><label>Supervisor on the report <input id="setSup" value="${esc(settings.supervisor || "")}"></label></div><button id="setSave" style="margin-top:10px">Save</button></section>`;
}
function usersView() {
  return `<section class="card"><h2>Store controllers</h2><p class="muted" style="margin-top:0">Approve people after they register on the Stores sign-in screen. Remove someone who leaves; they can register again with a new PIN.</p>
    ${staff.length ? staff.map(s => `<div class="line"><span class="pill ${s.approved ? "in" : "out"}">${s.approved ? "Approved" : "Waiting"}</span><div><b>${esc(s.name)}</b><div class="meta">Registered ${s.createdAt ? fmt(ymd(new Date(s.createdAt))) : ""}</div></div>
      <div class="row">${s.approved ? "" : `<button class="primary" data-uok="${esc(s.id)}">Approve</button>`}<button class="danger" data-udel="${esc(s.id)}">Remove</button></div></div>`).join("") : '<div class="muted">Nobody has registered yet.</div>'}</section>`;
}

/* ---------- actions ---------- */
app.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.store) { store = b.dataset.store; lsSet("tkr-st-store", store); form = { out: {}, in: {} }; render(); return; }
  if (b.dataset.tab) { tab = b.dataset.tab; lsSet("tkr-st-tab", tab); render(); return; }
  if (b.dataset.pickitem) { const [kind, id] = b.dataset.pickitem.split(":"); form[kind].itemId = id; render(); return; }
  if (b.dataset.report) { const ctl = $("repCtl")?.value || myName(), sup = $("repSup")?.value ?? settings.supervisor; exportReport(month, ctl, sup); return; }
  if (b.dataset.del) { const x = moves.find(m => m.id === b.dataset.del); if (x && confirm(`Remove this line?\n${x.qty} × ${x.item}`)) deleteDoc(doc(db, "stMoves", x.id)).then(() => toast("Removed")).catch(fail); return; }
  if (b.dataset.count) {
    const it = itemOf(b.dataset.count), v = app.querySelector(`[data-countval="${CSS.escape(b.dataset.count)}"]`).value.trim();
    if (v === "" || isNaN(num(v))) { toast("Type the number counted."); return; }
    addDoc(collection(db, "stCounts"), { store, itemId: it.id, item: it.name, getKey: it.getKey || "", date: today(), count: num(v), byName: myName(), byUid: user.uid, createdAt: Date.now() }).then(() => toast(`Count saved: ${v} ${it.name}`)).catch(fail); return;
  }
  if (b.id === "iAdd") { items = items.concat([{ id: "it-" + Date.now().toString(36), store, cat: CATS[store].includes("Spares") ? "Spares" : CATS[store][0], name: "New item", unit: "ea" }]); render(); return; }
  if (b.dataset.idel) { items = items.filter(i => i.id !== b.dataset.idel); render(); toast("Removed from the list. Tap Save to keep the change."); return; }
  if (b.id === "iSave") { readItemRows(); setDoc(doc(db, "stConfig", "items"), { list: items, updatedBy: email, updatedAt: Date.now() }).then(() => toast("Items and prices saved")).catch(fail); return; }
  if (b.id === "setSave") { setDoc(doc(db, "stConfig", "settings"), { supervisor: $("setSup").value.trim() }, { merge: true }).then(() => toast("Saved")).catch(fail); return; }
  if (b.dataset.uok) { setDoc(doc(db, "stUsers", b.dataset.uok), { approved: true, approvedBy: email, approvedAt: Date.now() }, { merge: true }).then(() => toast("Approved")).catch(fail); return; }
  if (b.dataset.udel) { const s = staff.find(x => x.id === b.dataset.udel); if (s && confirm(`Remove ${s.name}? Their logged lines stay.`)) deleteDoc(doc(db, "stUsers", s.id)).then(() => toast("Removed")).catch(fail); return; }
});
function readItemRows() {
  app.querySelectorAll("tr[data-iid]").forEach(tr => {
    const it = items.find(i => i.id === tr.dataset.iid); if (!it) return;
    tr.querySelectorAll("[data-f]").forEach(el => { const k = el.dataset.f; let v = el.value.trim(); if (k === "price" || k === "min") v = v === "" ? "" : num(v); it[k] = v; });
    if (it.cat === "PPE" && !it.ppe) it.ppe = "other";
  });
}
app.addEventListener("change", e => {
  const t = e.target;
  if (t.id === "month") { month = t.value || month; render(); return; }
  if (t.id === "ppeStore") { ppeStore = t.value; render(); return; }
  if (t.id === "oCat" || t.id === "iCat") { const k = t.id === "oCat" ? "out" : "in"; form[k] = { cat: t.value }; render(); return; }
  if (t.id === "oMach") { syncForms(); return; }
  if (t.id === "oItem" || t.id === "iItem") { form[t.id === "oItem" ? "out" : "in"].itemId = t.value; syncForms(); return; }
  if (t.dataset.status !== undefined) { setDoc(doc(db, "stConfig", "status"), { machines: { [t.dataset.status]: t.value.trim() } }, { merge: true }).then(() => toast("Status saved")).catch(fail); return; }
  if (tab === "items" && t.dataset.f) readItemRows();
});
app.addEventListener("input", e => { if (e.target.id === "oQty" || e.target.id === "iQty") syncForms(); });
app.addEventListener("submit", async e => {
  e.preventDefault(); const kind = e.target.dataset.kind; if (!kind) return;
  if (!canLog()) { if (confirm("Only a store controller can issue or receive.\n\nTap OK to sign in as a store controller with your name and PIN.")) staffSignIn(); return; }
  const P = kind === "out" ? "o" : "i", err = t => { $(P + "Err").textContent = t; };
  const cat = $(P + "Cat").value;
  const id = cat === "GET" ? form[kind].itemId : $(P + "Item").value, it = itemOf(id);
  const other = !it, name = other ? $(P + "Other").value.trim() : it.name;
  if (cat === "GET" && !it) { err("Tap Bits, Rods, Shanks or Hammers."); return; }
  if (!name) { err("Type the item name."); return; }
  const qty = num($(P + "Qty").value); if (!(qty > 0)) { err("Type how many, for example 1."); return; }
  const rec = { kind: kind === "out" ? "issue" : "receive", store, cat, itemId: it?.id || "", item: name, getKey: it?.getKey || "", unit: other ? $(P + "Unit").value.trim() : (it.unit || ""), price: it?.price ? num(it.price) : (it ? 0 : num($(P + "PriceEach").value) || 0),
    qty, date: $(P + "Date").value || today(), note: $(P + "Note").value.trim(), byName: myName(), byUid: user.uid, createdAt: Date.now() };
  if (kind === "out") { const mach = $("oMach").value === "__other" ? $("oMachOther").value.trim().toUpperCase() : $("oMach").value;
    if ($("oMach").value === "__other" && !mach) { err("Type the machine name."); return; }
    Object.assign(rec, { shift: $("oShift").value, machine: mach, to: $("oTo").value.trim() }); }
  else Object.assign(rec, { from: $("iFrom").value.trim(), ref: $("iRef").value.trim() });
  const twin = moves.find(x => dupKey(x) === dupKey(rec));
  if (twin && !confirm(`This looks like a line already logged:\n${twin.kind === "issue" ? "Issued" : "Received"} ${nq(twin.qty)} ${twin.unit || ""} × ${twin.item} on ${fmt(twin.date)}${twin.machine ? " for " + twin.machine : ""}${twin.to ? " to " + twin.to : ""}${twin.from ? " from " + twin.from : ""}, logged by ${twin.byName || "someone"}${twin.createdAt ? " at " + new Date(twin.createdAt).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }) : ""}.\n\nIs this a second, separate ${twin.kind === "issue" ? "issue" : "delivery"}? Tap OK to log it, or Cancel if it's the same one.`)) { err("Not logged: it was the same as a line already there."); return; }
  if (kind === "out" && cat === "PPE" && !rec.to) { err("Type who the PPE is for, so it shows on the PPE register."); return; }
  if (kind === "out" && it) { const s = stockOf(store, it); if (s.onHand !== null && qty > s.onHand && !confirm(`The app shows ${nq(s.onHand)} ${it.unit || ""} ${it.name} in the store. Issue ${qty} anyway?`)) return; }
  err("");
  addDoc(collection(db, "stMoves"), rec).catch(fail);   // saved on the phone at once, sent when there is signal
  toast(`${rec.kind === "issue" ? "Issued" : "Received"}: ${nq(qty)} ${rec.unit} × ${name}${rec.price ? " (" + R(qty * rec.price) + ")" : ""}`);
  ["Qty", "Note", "Other", "Unit", "PriceEach", "To", "From", "Ref", "MachOther"].forEach(k => { const el = $(P + k); if (el) el.value = k === "Qty" ? "1" : ""; });
  if (cat === "GET") form[kind].itemId = ""; render();
});

/* ---------- stock count (opening / closing handover report), with photos, branded PDF ---------- */
const FOR_OPTS = { drill: ["Soosan drill rigs", "All machines", "General / store"], rompad: ["Rockbreakers (TKRH)", "All machines", "General / store"] };
const SECTIONS = [["PPE", "PPE stock"], ["OILS", "Oils & lubricants"], ["GET", "GET spares"], ["Spares", "Spares"], ["Fasteners", "Fasteners, bolts, nuts & washers"], ["Moil locks", "Moil locks"], ["Anything", "Other items"]];
const secOf = cat => OILS.includes(cat) ? "OILS" : SECTIONS.some(([k]) => k === cat) ? cat : "Anything";
const defFor = (st, cat) => OILS.includes(cat) ? "All machines" : cat === "PPE" ? "General / store" : FOR_OPTS[st][0];
const lineStatus = (l, it) => { if (l.qty === "" || l.qty == null) return ""; const q = num(l.qty); if (q <= 0) return "Out of stock"; if (it && num(it.min) > 0 && q <= num(it.min)) return "Low"; return "OK"; };
let sc = null, scPhotos = [], scBusy = false;
const draftKey = st => "tkr-st-count-" + st;
// the store's set list: items kept only in this store, plus shared items this store has counted or moved
const setItems = st => storeItems(st).filter(i => i.store === st || counts.some(c => c.store === st && c.itemId === i.id) || moves.some(m => m.store === st && m.itemId === i.id));
function newDraft(st) {
  const last = reports.filter(r => r.store === st).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
  const lastBy = new Map((last?.lines || []).map(l => [l.itemId || "t:" + l.item.toLowerCase(), l]));
  const lines = setItems(st).map(i => ({ key: i.id, itemId: i.id, cat: i.cat, item: i.name, unit: i.unit || "", for: lastBy.get(i.id)?.for || defFor(st, i.cat), qty: "", note: "" }));
  (last?.lines || []).filter(l => !l.itemId).forEach(l => lines.push({ key: "t" + Math.random().toString(36).slice(2, 8), itemId: "", cat: l.cat, item: l.item, unit: l.unit || "", for: l.for || defFor(st, l.cat), qty: "", note: "" }));
  const h = new Date().getHours();
  return { store: st, date: today(), shift: h >= 6 && h < 18 ? "Day" : "Night", type: "Closing", supervisor: settings.supervisor || "", reorder: "", notes: "", lines };
}
function loadDraft() {
  if (sc && sc.store === store) return;
  try { const d = JSON.parse(lsGet(draftKey(store)) || "null"); sc = d && d.store === store ? d : newDraft(store); } catch { sc = newDraft(store); }
  scPhotos = [];
}
const saveDraft = () => { if (sc) lsSet(draftKey(sc.store), JSON.stringify(sc)); };
function countView() {
  loadDraft();
  const forOpts = [...FOR_OPTS[store], ...STORES[store].machines];
  const its = new Map(items.map(i => [i.id, i]));
  const sec = k => sc.lines.filter(l => secOf(l.cat) === k);
  setItems(store).forEach(i => { if (!sc.lines.some(l => l.itemId === i.id)) sc.lines.push({ key: i.id, itemId: i.id, cat: i.cat, item: i.name, unit: i.unit || "", for: defFor(store, i.cat), qty: "", note: "" }); });
  sc.lines.forEach(l => { const it = its.get(l.itemId); if (it && !l.edited) { const oh = stockOf(store, it).onHand; l.qty = oh > 0 ? String(nq(oh)) : "0"; } });
  const lineRow = l => { const it = its.get(l.itemId), st = lineStatus(l, it), app = it ? stockOf(store, it).onHand : null;
    return `<div class="scline" data-key="${esc(l.key)}">
      <div class="nm"><b>${esc(l.item)}</b>${l.unit ? ` <span class="muted">${esc(l.unit)}</span>` : ""}${app !== null && it ? `<span class="muted"> · app shows ${esc(nq(app))}</span>` : ""}${st ? ` <span class="stpill ${st === "OK" ? "ok" : st === "Low" ? "low" : "out"}">${st}</span>` : ""}</div>
      <label>Counted <input data-sc="qty" inputmode="decimal" value="${esc(l.qty)}" placeholder="Qty"></label>
      <label>For machine <select data-sc="for">${[...new Set([l.for, ...forOpts])].map(o => opt(o, o, o === l.for)).join("")}</select></label>
      <label class="wide">Note <input data-sc="note" value="${esc(l.note)}" placeholder="For example 5 L left, reorder"></label>
      ${l.itemId ? "" : `<button type="button" class="ghost" data-scdel="${esc(l.key)}" aria-label="Remove line">✕</button>`}</div>`; };
  const issuedToday = moves.filter(x => x.store === store && x.kind === "issue" && x.date === sc.date).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const autoRe = sc.lines.filter(l => { const st = lineStatus(l, its.get(l.itemId)); return st === "Out of stock" || st === "Low"; });
  const mine = reports.filter(r => r.store === store).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 15);
  return `<div id="countView">
  <section class="card" style="border:2px solid var(--gold)">
    <h2>Stock count – ${STORES[store].name}</h2>
    <p class="muted" style="margin-top:0">The numbers fill in by themselves from Issue / Receive. Check them against the shelf, change any that are wrong, add photos, then tap <b>Save and download PDF</b>.</p>
    <div class="grid">
      <label>Date <input type="date" data-scf="date" value="${esc(sc.date)}" max="${today()}"></label>
      <label>Shift <select data-scf="shift">${["Day", "Night"].map(x => opt(x, x, sc.shift === x)).join("")}</select></label>
      <label>Report <select data-scf="type">${["Opening", "Closing"].map(x => opt(x, x + " stock count", sc.type === x)).join("")}</select></label>
      <label>Supervisor <input data-scf="supervisor" value="${esc(sc.supervisor)}"></label>
    </div>
    <p class="muted" style="margin:10px 0 0">Store controller: <b>${esc(showName(myName()))}</b></p>
  </section>
  ${SECTIONS.map(([k, t]) => { const l = sec(k); return `<section class="card"><h2>${esc(t)}</h2>${l.length ? l.map(lineRow).join("") : '<div class="muted">No items here yet. Add one below.</div>'}</section>`; }).join("")}
  <section class="card">
    <h2>Add a line</h2>
    <div class="grid">
      <label>Section <select id="scNewCat">${SECTIONS.map(([k, t]) => opt(k === "OILS" ? OILS[0] : k, t)).join("")}</select></label>
      <label>Item <input id="scNewItem" placeholder="For example M16 x 200 bolts"></label>
      <label>Unit <input id="scNewUnit" placeholder="ea, 20L, box"></label>
      <div style="display:flex;align-items:flex-end"><button type="button" class="primary" id="scAdd" style="width:100%">Add line</button></div>
    </div>
  </section>
  <section class="card">
    <h2>Items issued during the shift</h2>
    ${issuedToday.length ? issuedToday.map(x => `<div class="line"><span class="pill out">Issued</span><div><b>${esc(nq(x.qty))} ${esc(x.unit || "")} × ${esc(x.item)}</b><div class="meta">${[x.machine, x.to && "to " + x.to, x.byName].filter(Boolean).map(esc).join(" · ")}</div></div><span></span></div>`).join("") : `<div class="muted">Nothing issued at ${STORES[store].name} on ${fmt(sc.date)}.</div>`}
    <p class="muted" style="margin-bottom:0">This comes from Issue / Receive by itself.</p>
  </section>
  <section class="card">
    <h2>Reorder required / stock needed</h2>
    ${autoRe.length ? `<p style="margin-top:0">${autoRe.map(l => `<span class="stpill ${lineStatus(l, its.get(l.itemId)) === "Low" ? "low" : "out"}">${esc(l.item)}</span>`).join(" ")}</p>` : '<p class="muted" style="margin-top:0">Items counted at 0 or at their minimum show here by themselves.</p>'}
    <label>Anything else needed <textarea data-scf="reorder" rows="2" placeholder="For example permanent marker, lockout tags">${esc(sc.reorder)}</textarea></label>
    <label style="margin-top:10px">Stock notes <textarea data-scf="notes" rows="3" placeholder="For example dust masks reduced to 33">${esc(sc.notes)}</textarea></label>
  </section>
  <section class="card">
    <h2>Photos</h2>
    <p class="muted" style="margin-top:0">Take a photo or upload one, and type a note for each.</p>
    <div class="row"><label class="primary filebtn">📷 Take photo<input type="file" accept="image/*" capture="environment" data-scphoto="1" hidden></label>
      <label class="filebtn">🖼️ Upload photo<input type="file" accept="image/*" multiple data-scphoto="1" hidden></label></div>
    <div class="scphotos">${scPhotos.map((ph, i) => `<div class="scph"><img src="${ph.data}" alt="Photo ${i + 1}"><input data-scpn="${i}" value="${esc(ph.note)}" placeholder="Note for this photo"><button type="button" class="ghost" data-scpdel="${i}">Remove</button></div>`).join("")}</div>
  </section>
  <section class="card">
    <div class="row" style="justify-content:space-between">
      <button type="button" class="ghost" id="scReset">Start again</button>
      <button type="button" class="primary" id="scSave" style="flex:1 1 240px;min-height:56px;font-size:18px" ${scBusy ? "disabled" : ""}>${scBusy ? "Saving…" : "Save and download PDF"}</button>
    </div>
    <p class="flag" id="scErr" style="margin:8px 0 0"></p>
  </section>
  <section class="card">
    <h2>Saved stock counts</h2>
    ${mine.length ? mine.map(r => `<div class="line"><span class="pill in">${esc(r.type || "")}</span><div><b>${fmt(r.date)} · ${esc(r.shift || "")} shift</b><div class="meta">${esc(r.byName || "")} · ${(r.lines || []).length} items counted${r.photoCount ? ` · ${r.photoCount} photo${r.photoCount === 1 ? "" : "s"}` : ""}</div></div>
      <span class="row" style="gap:6px"><button data-scpdf="${esc(r.id)}">PDF</button>${isBoss() ? `<button class="danger" data-scrm="${esc(r.id)}">Remove</button>` : ""}</span></div>`).join("") : '<div class="muted">No stock counts saved yet.</div>'}
  </section></div>`;
}
const scLine = el => sc.lines.find(l => l.key === el.closest("[data-key]")?.dataset.key);
app.addEventListener("input", e => {
  const t = e.target; if (!sc || !t.closest?.("#countView")) return;
  if (t.dataset.sc) { const l = scLine(t); if (l) { l[t.dataset.sc] = t.value; if (t.dataset.sc === "qty") l.edited = true; saveDraft();
    if (t.dataset.sc === "qty") { const nm = t.closest("[data-key]").querySelector(".nm"), st = lineStatus(l, items.find(i => i.id === l.itemId)); let pl = nm.querySelector(".stpill");
      if (!st) pl?.remove(); else { if (!pl) { pl = document.createElement("span"); nm.append(" ", pl); } pl.className = "stpill " + (st === "OK" ? "ok" : st === "Low" ? "low" : "out"); pl.textContent = st; } } } return; }
  if (t.dataset.scf) { sc[t.dataset.scf] = t.value; saveDraft(); return; }
  if (t.dataset.scpn) { const ph = scPhotos[+t.dataset.scpn]; if (ph) ph.note = t.value; }
});
app.addEventListener("focusout", () => { if (renderLater) setTimeout(() => { if (!document.activeElement?.closest?.("#countView") || !document.activeElement.matches("input:not([type=file]), textarea, select")) { renderLater = false; render(); } }, 0); });
app.addEventListener("change", async e => {
  const t = e.target; if (!sc || !t.closest?.("#countView")) return;
  if (t.dataset.scf === "date") render(true);
  if (t.dataset.scphoto) {
    for (const f of [...t.files]) { try { scPhotos.push({ data: await shrinkPhoto(f), note: "" }); } catch { toast("That photo couldn't be read."); } }
    t.value = ""; render(true);
  }
});
function shrinkPhoto(file) {
  return new Promise((res, rej) => { const u = URL.createObjectURL(file), img = new Image();
    img.onload = () => { const k = Math.min(1, 1280 / Math.max(img.width, img.height)), c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u); let q = 0.72, d = c.toDataURL("image/jpeg", q); while (d.length > 700000 && q > 0.35) { q -= 0.1; d = c.toDataURL("image/jpeg", q); } res(d); };
    img.onerror = () => { URL.revokeObjectURL(u); rej(); }; img.src = u; });
}
app.addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b || !b.closest("#countView")) return;
  if (b.dataset.scdel) { sc.lines = sc.lines.filter(l => l.key !== b.dataset.scdel); saveDraft(); render(true); return; }
  if (b.dataset.scpdel) { scPhotos.splice(+b.dataset.scpdel, 1); render(true); return; }
  if (b.id === "scAdd") {
    const cat = $("scNewCat").value, item = $("scNewItem").value.trim(); if (!item) { toast("Type the item name."); return; }
    sc.lines.push({ key: "t" + Math.random().toString(36).slice(2, 8), itemId: "", cat, item, unit: $("scNewUnit").value.trim(), for: defFor(store, cat), qty: "", note: "" }); saveDraft(); render(); return;
  }
  if (b.id === "scReset") { if (confirm("Clear this stock count and start again?")) { sc = newDraft(store); scPhotos = []; saveDraft(); render(true); } return; }
  if (b.id === "scSave") { await saveCount(); return; }
  if (b.dataset.scpdf) { const r = reports.find(x => x.id === b.dataset.scpdf); if (r) countPdf(r); return; }
  if (b.dataset.scrm) { const r = reports.find(x => x.id === b.dataset.scrm); if (r && confirm(`Remove the ${r.type.toLowerCase()} stock count of ${fmt(r.date)}? The stock numbers it set stay.`)) deleteDoc(doc(db, "stReports", r.id)).then(() => toast("Removed")).catch(fail); }
});
async function saveCount() {
  const err = t => { const el = $("scErr"); if (el) el.textContent = t; };
  if (!canLog()) { if (confirm("Only a store controller can save a stock count.\n\nTap OK to sign in as a store controller with your name and PIN.")) staffSignIn(); return; }
  const lines = sc.lines.filter(l => String(l.qty).trim() !== "" || l.note.trim());
  if (!lines.filter(l => String(l.qty).trim() !== "").length) { err("Type the count for at least one item."); return; }
  if (lines.some(l => String(l.qty).trim() !== "" && isNaN(num(l.qty)))) { err("Counts must be numbers."); return; }
  const its = new Map(items.map(i => [i.id, i]));
  scBusy = true; render(true);
  try {
    const now = Date.now(), ref = doc(collection(db, "stReports"));
    const issued = moves.filter(x => x.store === store && x.kind === "issue" && x.date === sc.date).map(x => ({ item: x.item, qty: num(x.qty), unit: x.unit || "", machine: x.machine || "", to: x.to || "" }));
    const rec = { store, date: sc.date, shift: sc.shift, type: sc.type, supervisor: sc.supervisor.trim(), byName: showName(myName()), byUid: user.uid, createdAt: now, reorder: sc.reorder.trim(), notes: sc.notes.trim(), issued, photoCount: scPhotos.length,
      lines: lines.map(l => ({ itemId: l.itemId, cat: l.cat, item: l.item, unit: l.unit, for: l.for, qty: String(l.qty).trim() === "" ? "" : num(l.qty), note: l.note.trim(), status: lineStatus(l, its.get(l.itemId)) })) };
    await Promise.race([setDoc(ref, rec), new Promise(r => setTimeout(r, 4000))]);   // offline: saved on the phone, sent later
    let i = 0;
    for (const l of rec.lines) if (l.itemId && l.qty !== "") { const it = its.get(l.itemId);
      setDoc(doc(db, "stCounts", `${ref.id}-${l.itemId}`), { store, itemId: l.itemId, item: l.item, getKey: it?.getKey || "", date: sc.date, count: l.qty, byName: myName(), byUid: user.uid, src: "stockcount", reportId: ref.id, createdAt: now + i++ }).catch(fail); }
    scPhotos.forEach((ph, k) => setDoc(doc(db, "stReportPhotos", `${ref.id}-${k}`), { reportId: ref.id, store, n: k, data: ph.data, note: ph.note.trim(), byUid: user.uid, createdAt: now + k }).catch(fail));
    const keepPh = scPhotos.slice(); sc = newDraft(store); scPhotos = []; saveDraft(); scBusy = false; render(true);
    toast("Stock count saved. Making the PDF…"); countPdf({ id: ref.id, ...rec }, keepPh);
  } catch (x) { scBusy = false; render(true); fail(x); }
}
async function countPdf(r, photos) {
  try { await loadLib("../lib/jspdf.umd.min.js"); await loadLib("../lib/jspdf.plugin.autotable.min.js"); } catch { toast("Open the app once with signal, then try again."); return; }
  if (!photos) { photos = []; try { const s = await getDocs(query(collection(db, "stReportPhotos"), where("reportId", "==", r.id))); photos = s.docs.map(d => d.data()).sort((a, b) => a.n - b.n); } catch (x) { console.warn(x); } }
  const { jsPDF } = window.jspdf, P = new jsPDF({ unit: "mm", format: "a4" }), W = 210, M = 12;
  const GOLD = [212, 161, 42], BLACK = [17, 17, 17], MUTED = [107, 101, 88];
  let logo = null; try { const bl = await (await fetch("../icons/icon-192.png")).blob(); logo = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(bl); }); } catch {}
  const title = `${STORES[r.store].name.toUpperCase()}`, sub = `${(r.shift || "").toUpperCase()} SHIFT ${String(r.type || "").toUpperCase()} STOCK COUNT`;
  const band = () => { P.setFillColor(...BLACK); P.rect(0, 0, W, 30, "F"); P.setFillColor(...GOLD); P.rect(0, 30, W, 1.6, "F");
    if (logo) P.addImage(logo, "PNG", M, 5, 20, 20);
    P.setTextColor(255, 255, 255); P.setFont("helvetica", "bold"); P.setFontSize(16); P.text("TKR OPERATIONS · " + title, M + 25, 14);
    P.setTextColor(...GOLD); P.setFontSize(9.5); P.text(sub, M + 25, 21);
    P.setDrawColor(...GOLD); P.setLineWidth(0.5); P.roundedRect(W - M - 38, 10, 38, 10, 2, 2); P.setFontSize(8.5); P.text((r.type || "").toUpperCase() + " REPORT", W - M - 19, 16.3, { align: "center" }); };
  band();
  let y = 38;
  const info = [["DATE", fmt(r.date)], ["SHIFT", r.shift || ""], ["STORES CONTROLLER", r.byName || ""], ["SUPERVISOR", r.supervisor || ""]];
  P.setDrawColor(217, 211, 197); P.setFillColor(247, 244, 236); P.roundedRect(M, y, W - 2 * M, 16, 2, 2, "FD");
  info.forEach(([l, v], i) => { const x = M + 5 + i * ((W - 2 * M) / 4); P.setTextColor(...MUTED); P.setFont("helvetica", "bold"); P.setFontSize(7); P.text(l, x, y + 6); P.setTextColor(...BLACK); P.setFontSize(10.5); P.text(P.splitTextToSize(String(v), (W - 2 * M) / 4 - 7)[0] || "", x, y + 12); });
  y += 22;
  const re = (r.lines || []).filter(l => l.status === "Out of stock" || l.status === "Low").map(l => l.item + (l.status === "Out of stock" ? " (out of stock)" : " (low)"));
  if (r.reorder) re.push(...r.reorder.split(/\n|,/).map(x => x.trim()).filter(Boolean));
  if (re.length) { const txt = P.splitTextToSize(re.join(" • "), W - 2 * M - 10), h = 10 + txt.length * 4.6;
    P.setFillColor(253, 236, 234); P.setDrawColor(179, 64, 47); P.roundedRect(M, y, W - 2 * M, h, 2, 2, "FD");
    P.setTextColor(179, 64, 47); P.setFont("helvetica", "bold"); P.setFontSize(9.5); P.text("REORDER REQUIRED / STOCK NEEDED", M + 5, y + 6);
    P.setFont("helvetica", "normal"); P.setFontSize(9); P.setTextColor(...BLACK); P.text(txt, M + 5, y + 11.5); y += h + 6; }
  const stCol = s => s === "Out of stock" ? [179, 64, 47] : s === "Low" ? [184, 134, 11] : s === "OK" ? [46, 125, 79] : MUTED;
  for (const [k, t] of SECTIONS) {
    const l = (r.lines || []).filter(x => secOf(x.cat) === k); if (!l.length) continue;
    if (y > 260) { P.addPage(); band(); y = 38; }
    P.setTextColor(...BLACK); P.setFont("helvetica", "bold"); P.setFontSize(11); P.text(t.toUpperCase(), M, y); y += 2;
    P.autoTable({ startY: y, margin: { left: M, right: M, top: 38 }, theme: "grid",
      head: [["Item", "For machine", "Qty", "Unit", "Status", "Note"]],
      body: l.map(x => [x.item, x.for || "", x.qty === "" ? "" : nq(x.qty), x.unit || "", x.status || "", x.note || ""]),
      styles: { font: "helvetica", fontSize: 8.6, cellPadding: 2, lineColor: [217, 211, 197], lineWidth: 0.2, textColor: BLACK },
      headStyles: { fillColor: BLACK, textColor: GOLD, fontStyle: "bold" }, alternateRowStyles: { fillColor: [255, 255, 255] },
      columnStyles: { 0: { cellWidth: 50, fontStyle: "bold" }, 1: { cellWidth: 36 }, 2: { cellWidth: 14, halign: "center" }, 3: { cellWidth: 14 }, 4: { cellWidth: 24 } },
      didParseCell: d => { if (d.section === "body" && d.column.index === 4) { d.cell.styles.textColor = stCol(d.cell.raw); d.cell.styles.fontStyle = "bold"; } },
      didDrawPage: () => band() });
    y = P.lastAutoTable.finalY + 8;
  }
  if (y > 250) { P.addPage(); band(); y = 38; }
  P.setTextColor(...BLACK); P.setFont("helvetica", "bold"); P.setFontSize(11); P.text("ITEMS ISSUED DURING THE SHIFT", M, y); y += 2;
  P.autoTable({ startY: y, margin: { left: M, right: M, top: 38 }, theme: "grid", head: [["Item", "Qty", "Unit", "Machine", "Issued to"]],
    body: (r.issued || []).length ? r.issued.map(x => [x.item, nq(x.qty), x.unit, x.machine, x.to]) : [["Nothing issued on " + fmt(r.date), "", "", "", ""]],
    styles: { font: "helvetica", fontSize: 8.6, cellPadding: 2, lineColor: [217, 211, 197], lineWidth: 0.2, textColor: BLACK }, headStyles: { fillColor: BLACK, textColor: GOLD }, didDrawPage: () => band() });
  y = P.lastAutoTable.finalY + 8;
  if (r.notes) { const txt = P.splitTextToSize(r.notes, W - 2 * M - 10), h = 10 + txt.length * 4.6; if (y + h > 280) { P.addPage(); band(); y = 38; }
    P.setFillColor(247, 244, 236); P.setDrawColor(...GOLD); P.roundedRect(M, y, W - 2 * M, h, 2, 2, "FD"); P.setFont("helvetica", "bold"); P.setFontSize(9.5); P.setTextColor(...BLACK); P.text("STOCK NOTES", M + 5, y + 6);
    P.setFont("helvetica", "normal"); P.setFontSize(9); P.text(txt, M + 5, y + 11.5); y += h + 6; }
  if (photos.length) {
    if (y > 200) { P.addPage(); band(); y = 38; }
    P.setFont("helvetica", "bold"); P.setFontSize(11); P.setTextColor(...BLACK); P.text("PHOTOS", M, y); y += 4;
    const cw = (W - 2 * M - 6) / 2; let col = 0;
    for (const ph of photos) {
      const img = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = ph.data; }); if (!img) continue;
      const h = Math.min(70, cw * img.height / img.width), w = h * img.width / img.height, note = P.splitTextToSize(ph.note || "", cw), boxH = h + 4 + note.length * 4.2;
      if (y + boxH > 284) { P.addPage(); band(); y = 38; col = 0; }
      const x = M + col * (cw + 6); P.addImage(ph.data, "JPEG", x + (cw - w) / 2, y, w, h);
      P.setFont("helvetica", "normal"); P.setFontSize(8.5); P.setTextColor(...MUTED); if (note.length) P.text(note, x, y + h + 4);
      if (col === 1) { y += boxH + 6; col = 0; } else { col = 1; P.__rowH = boxH; }
    }
    if (col === 1) y += (P.__rowH || 80) + 6;
  }
  if (y > 250) { P.addPage(); band(); y = 38; }
  P.setFont("helvetica", "bold"); P.setFontSize(11); P.setTextColor(...BLACK); P.text("HANDOVER SIGN-OFF", M, y); y += 8;
  [["Stores controller", r.byName || ""], ["Supervisor", r.supervisor || ""]].forEach(([l, v], i) => { const x = M + i * ((W - 2 * M) / 2);
    P.setFont("helvetica", "bold"); P.setFontSize(9); P.setTextColor(...MUTED); P.text(l.toUpperCase(), x, y); P.setTextColor(...BLACK); P.setFont("helvetica", "normal"); P.setFontSize(10);
    P.text("Name: " + v, x, y + 7); P.text("Signature: ______________________", x, y + 15); });
  const n = P.getNumberOfPages();
  for (let i = 1; i <= n; i++) { P.setPage(i); P.setFont("helvetica", "normal"); P.setFontSize(8); P.setTextColor(...MUTED);
    P.text(`TKR Operations · ${STORES[r.store].name} ${String(r.type || "").toLowerCase()} stock count · ${fmt(r.date)} ${r.shift || ""} shift`, M, 292); P.text(`Page ${i} of ${n}`, W - M, 292, { align: "right" }); }
  const name = `TKR_${STORES[r.store].name.replace(/ /g, "_")}_${r.type}_Stock_Count_${fmt(r.date).replace(/\//g, "-")}_${r.shift || ""}.pdf`;
  const { deliver } = await import("../lib/deliver.js"); deliver(P.output("blob"), name);
}

/* ---------- branded consumption report (ExcelJS, TKR logo, black and gold) ---------- */
async function exportReport(m, ctl, sup) {
  toast("Making the consumption report…");
  try { await loadLib("../lib/exceljs.min.js"); } catch { toast("Open the app once with signal, then try again."); return; }
  const X = new ExcelJS.Workbook(); X.creator = "TKR Operations"; X.created = new Date();
  let logo = null; try { logo = X.addImage({ buffer: await (await fetch("../icons/icon-512.png")).arrayBuffer(), extension: "png" }); } catch {}
  const C = { BLACK: "FF111111", HEAD: "FF262626", GOLD: "FFD4A12A", CREAM: "FFFFF8E6", TOT: "FFFFF2CC", WHITE: "FFFFFFFF", GRID: "FFD9D3C5", MUTED: "FF6B6558", OUT: "FFC2410C", IN: "FF2E7D4F" };
  const thin = { style: "thin", color: { argb: C.GRID } }, box = { top: thin, left: thin, bottom: thin, right: thin }, fill = c => ({ type: "pattern", pattern: "solid", fgColor: { argb: c } });
  // one colour per machine (same colour on every sheet), and a colour of its own for each oil
  const MC_FILLS = ["FFDCEAF8", "FFDDF0E1", "FFFFEDC7", "FFEADDF5", "FFF9DCDC", "FFD5F0EC", "FFF0E6D2", "FFE3F4D6", "FFFCE2CF", "FFE2E6F0", "FFF7DDEE", "FFD8EEF7", "FFEFF0CF", "FFE8E0D8", "FFDDE3F8", "FFF3E3E3", "FFD9F2E4", "FFF4EBD9", "FFE6DCEF", "FFDFEFEF"];
  const mcList = [...new Set([...STORES.drill.machines, ...STORES.rompad.machines, ...issuesOf(null, m).map(x => x.machine).filter(Boolean).sort()])];
  const mcFill = mc => { const i = mcList.indexOf(mc); return i < 0 ? "FFF2F2F2" : MC_FILLS[i % MC_FILLS.length]; };
  const OIL_C = { "Hydraulic oil": "FF1F5FA8", "Engine oil": "FF8A4B08", "Grease": "FF5B5B5B", "Rockdrill / compressor oil": "FF2E7D4F", "Other oils & lubricants": "FF6B3FA0" };
  const title = `TKR OPERATIONS – STORES CONSUMPTION REPORT, ${monthName(m).toUpperCase()}`;
  const people = `Stores Controller: ${ctl || ""}   |   Supervisor: ${sup || ""}`;
  function sheet(name, sub, widths) {
    const ws = X.addWorksheet(name, { views: [{ showGridLines: false }], pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    ws.columns = widths.map(w => ({ width: w })); const n = widths.length;
    for (let r = 1; r <= 4; r++) { ws.getRow(r).height = r === 1 ? 8 : 20; for (let c = 1; c <= n; c++) ws.getCell(r, c).fill = fill(C.BLACK); }
    ws.getRow(5).height = 4; for (let c = 1; c <= n; c++) ws.getCell(5, c).fill = fill(C.GOLD);
    if (logo !== null) ws.addImage(logo, { tl: { col: 0.08, row: 1.08 }, ext: { width: 56, height: 56 } });
    const put = (r, v, font) => { const c = ws.getCell(r, 2); c.value = v; c.font = font; c.alignment = { vertical: "middle" }; };
    put(2, title, { name: "Arial", size: 14, bold: true, color: { argb: C.WHITE } });
    put(3, sub, { name: "Arial", size: 10, bold: true, color: { argb: C.GOLD } });
    put(4, people, { name: "Arial", size: 9, color: { argb: "FFCFC8B8" } });
    ws.views = [{ state: "frozen", ySplit: 5, showGridLines: false }];
    return { ws, n, r: 7 };
  }
  function heading(S, text) { const c = S.ws.getCell(S.r, 1); c.value = text; c.font = { name: "Arial", size: 12, bold: true, color: { argb: C.BLACK } }; S.ws.getRow(S.r).height = 20; S.r++; }
  function head(S, labels, fills = {}) { const row = S.ws.getRow(S.r); row.height = labels.some(l => l.length > 22) ? 44 : 30; labels.forEach((l, i) => { const c = row.getCell(i + 1); c.value = l; c.font = { name: "Arial", size: 10, bold: true, color: { argb: C.WHITE } }; c.fill = fill(fills[i] || C.HEAD); c.border = box; c.alignment = { vertical: "middle", horizontal: i ? "center" : "left", wrapText: true }; }); S.r++; }
  function line(S, vals, i, o = {}) {
    const row = S.ws.getRow(S.r); row.height = 18;
    vals.forEach((v, k) => { const c = row.getCell(k + 1); c.value = v === "" || v == null ? null : v; c.border = box; c.font = { name: "Arial", size: 10, bold: !!o.bold || !!o.color?.[k], color: { argb: o.color?.[k] || C.BLACK } };
      c.alignment = { vertical: "middle", horizontal: typeof v === "number" ? "center" : "left", wrapText: true };
      if (o.money?.includes(k) && typeof v === "number") c.numFmt = '"R" #,##0';
      if (o.date?.includes(k) && v instanceof Date) c.numFmt = "dd/mm/yyyy";
      if (o.tot) { c.fill = fill(C.TOT); c.border = { top: { style: "medium", color: { argb: C.GOLD } }, left: thin, bottom: thin, right: thin }; } else if (o.mc !== undefined) c.fill = fill(mcFill(o.mc)); });
    S.r++;
  }
  const dt = s => { if (!s) return ""; const [y, mo, d] = s.split("-").map(Number); return new Date(Date.UTC(y, mo - 1, d)); };
  const sortD = l => l.slice().sort((a, b) => (a.machine || "").localeCompare(b.machine || "") || a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
  // one sheet per store, set out like the template
  for (const st of ["drill", "rompad"]) {
    const S = sheet(STORES[st].sheet, STORES[st].sub, [16, 20, 15, 34, 17, 15, 18, 20, 14]);
    heading(S, "Totals per machine");
    head(S, ["Machine", ...OILS.map(o => o + (OIL20(o) ? " (20 L)" : "")), "Spares items issued", "Value (R)", "Status"], Object.fromEntries(OILS.map((o, k) => [k + 1, OIL_C[o]])));
    const mt = machineTotals(st, m);
    const oilFont = Object.fromEntries(OILS.map((o, k) => [k + 1, OIL_C[o]]));
    mt.forEach((r, i) => line(S, [r.mc, ...OILS.map(o => r.oils[o]), r.spares, r.value, status[r.mc] || ""], i, { money: [OILS.length + 2], mc: r.mc, color: oilFont }));
    line(S, ["Total", ...OILS.map(o => mt.reduce((n, r) => n + r.oils[o], 0)), mt.reduce((n, r) => n + r.spares, 0), mt.reduce((n, r) => n + r.value, 0), ""], 0, { tot: true, bold: true, money: [OILS.length + 2] });
    S.r++; heading(S, "Everything issued");
    head(S, ["Machine", "Category", "Date", "Item issued", "Qty", "Unit", "Issued to", "Logged by", "Value (R)"]);
    const l = sortD(issuesOf(st, m));
    if (!l.length) line(S, ["Nothing issued this month.", "", "", "", "", "", "", "", ""], 0);
    l.forEach((x, i) => line(S, [x.machine || "Store", x.cat, dt(x.date), x.item, num(x.qty), x.unit || "", x.to || "", x.byName || "", x.price ? val(x) : ""], i, { money: [8], date: [2], mc: x.machine || "", bold: false, color: OIL_C[x.cat] ? { 1: OIL_C[x.cat], 3: OIL_C[x.cat] } : undefined }));
    if (l.length) line(S, ["Total", "", "", "", "", "", "", "", l.reduce((n, x) => n + val(x), 0)], 0, { tot: true, bold: true, money: [8] });
  }
  // every issue, both stores
  let S = sheet("All Issues", "All machines and spares issued", [12, 10, 16, 38, 8, 8, 12, 13, 20, 16, 30]);
  head(S, ["Date", "Store", "Machine", "Item issued", "Qty", "Unit", "Price (R)", "Value (R)", "Issued to", "Logged by", "Note"]);
  const all = issuesOf(null, m).sort((a, b) => a.date.localeCompare(b.date) || a.store.localeCompare(b.store) || (a.createdAt || 0) - (b.createdAt || 0));
  all.forEach((x, i) => line(S, [dt(x.date), x.store === "drill" ? "Drill" : "Rompad", x.machine || "", x.item, num(x.qty), x.unit || "", x.price || "", x.price ? val(x) : "", x.to || "", x.byName || "", x.note || ""], i, { money: [6, 7], date: [0], mc: x.machine || "", color: OIL_C[x.cat] ? { 3: OIL_C[x.cat] } : undefined }));
  if (all.length) line(S, ["Total", "", "", "", "", "", "", all.reduce((n, x) => n + val(x), 0), "", "", ""], 0, { tot: true, bold: true, money: [7] });
  // PPE
  S = sheet("PPE", "Personal protective equipment issued", [26, 10, 22, 26, 8, 8, 13, 18, 24]);
  heading(S, "PPE per item");
  head(S, ["Item", "Qty", "Unit", "Value (R)"]);
  const ppe = all.filter(x => x.cat === "PPE"); const per = {};
  ppe.forEach(x => { const k = x.item + "|" + (x.unit || ""); per[k] = per[k] || { item: x.item, unit: x.unit || "", q: 0, v: 0 }; per[k].q += num(x.qty); per[k].v += val(x); });
  Object.values(per).forEach((p, i) => line(S, [p.item, p.q, p.unit, p.v || ""], i, { money: [3] }));
  if (!ppe.length) line(S, ["No PPE issued this month.", "", "", ""], 0);
  S.r++; heading(S, "PPE issued");
  head(S, ["Date", "Store", "Issued to", "Item", "Qty", "Unit", "Value (R)", "Logged by", "Note"]);
  ppe.forEach((x, i) => line(S, [dt(x.date), x.store === "drill" ? "Drill" : "Rompad", x.to || "", x.item, num(x.qty), x.unit || "", x.price ? val(x) : "", x.byName || "", x.note || ""], i, { money: [6], date: [0] }));
  // received
  S = sheet("Received", "Everything received into the stores", [12, 10, 16, 38, 8, 8, 22, 18, 16, 26]);
  head(S, ["Date", "Store", "Category", "Item received", "Qty", "Unit", "Received from", "Delivery note / GRN", "Logged by", "Note"]);
  const rec = receiptsOf(null, m).sort((a, b) => a.date.localeCompare(b.date));
  if (!rec.length) line(S, ["", "", "", "Nothing received this month.", "", "", "", "", "", ""], 0);
  rec.forEach((x, i) => line(S, [dt(x.date), x.store === "drill" ? "Drill" : "Rompad", x.cat, x.item, num(x.qty), x.unit || "", x.from || "", x.ref || "", x.byName || "", x.note || ""], i, { date: [0] }));
  const buf = await X.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const name = `TKR_Stores_Consumption_${MONTHS[+m.slice(5, 7) - 1]}_${m.slice(0, 4)}.xlsx`;
  const { deliver } = await import("../lib/deliver.js");
  deliver(blob, name, { doneLabel: "Done – clear this phone's copy", onDone: async () => { const fb = await import("../lib/firebase.js"); const { clearPhoneCopy } = await import("../lib/deliver.js"); await clearPhoneCopy(fb, [db], toast); } });
}

if ("serviceWorker" in navigator && navigator.serviceWorker.controller) { let r = false; navigator.serviceWorker.addEventListener("controllerchange", () => { if (r) return; r = true; location.reload(); }); }
if ("serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js", { scope: "../", updateViaCache: "none" }).then(r => r.update()).catch(() => {});
