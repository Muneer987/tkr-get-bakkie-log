/* TKR Daily Task Board — shared online through Firebase. Changes made with no signal are kept on the
   device and sent when the signal comes back. Employees: no sign-in (anonymous). Admins and managers: email + password. */
import {
  initializeApp, deleteApp, getAuth, signInAnonymously, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDocs,
  onSnapshot, query, where, arrayUnion, arrayRemove,
} from "../lib/firebase.js";
const showName = e => /@mgr\.tkroperations\.app$/.test(e || "") ? (e[0].toUpperCase() + e.slice(1, e.indexOf("@"))) : e;
const toLogin = v => { v = String(v || "").trim(); return v.includes("@") ? v : v.toLowerCase().replace(/[^a-z0-9]/g, "") + "@mgr.tkroperations.app"; };  // managers can sign in with a username

const firebaseConfig = {
  apiKey: "AIzaSyALzOBLObrONGVD1bS0Tz02aNKhQ40TRoI",
  authDomain: "tkr-operations-app.firebaseapp.com",
  projectId: "tkr-operations-app",
  storageBucket: "tkr-operations-app.firebasestorage.app",
  messagingSenderId: "158080247079",
  appId: "1:158080247079:web:7cb7786d2b7f9ee172b502",
};
// Must match the Firestore rules.
const ADMINS = ["muneer@tkroperations.com", "amogelang@tkroperations.com"];

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
let db;
try { db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
catch { db = initializeFirestore(fbApp, {}); }

/* ---------- helpers ---------- */
const loadLib = src => new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)?.dataset.ok) return res(); const s = document.createElement("script"); s.src = src; s.onload = () => { s.dataset.ok = 1; res(); }; s.onerror = rej; document.head.appendChild(s); });
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const longDate = s => parse(s).toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmt = s => { const [y, m, d] = s.split("-"); return `${d}/${m}/${y}`; };
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const STATUSES = [["Not started", "s-idle"], ["In progress", "s-prog"], ["Done", "s-done"], ["Blocked", "s-block"]];
const cls = s => (STATUSES.find(x => x[0] === s) || STATUSES[0])[1];
function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 3000); }
function fail(e) { console.warn(e); toast(e?.code === "permission-denied" ? "You are not allowed to do that." : "That change didn't save. Try again."); }
function cleanUrl(v) {
  v = String(v || "").trim(); if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = "https://" + v;
  try { const u = new URL(v); return /^https?:$/.test(u.protocol) && u.hostname.includes(".") ? u.href : null; } catch { return null; }
}
function linkLabel(l) { if (l.label) return l.label; try { const u = new URL(l.url); return u.hostname.includes("google.") ? "Google Drive file" : u.hostname.replace(/^www\./, ""); } catch { return l.url; } }

/* ---------- state ---------- */
let user = null, email = "", managers = [], team = [], tasks = [], selected = ymd(new Date());
let me = "", managing = false, linkFor = null, unsubTasks = null, teamLoaded = false, pendingWrites = false;
const isAdmin = () => ADMINS.includes(email);
const isManager = () => isAdmin() || (email && managers.includes(email));
const myEmp = () => (user && !user.isAnonymous && team.find(p => p.uid && p.uid === user.uid)) || null;
const canEdit = personId => isAdmin() || (!!personId && myEmp()?.id === personId);
// Employees sign in with their name and a 4-digit PIN. Behind it is a Firebase sign-in with a hidden staff address.
const staffEmail = p => `emp.${p.id}.${p.resets || 0}@staff.tkroperations.app`.toLowerCase();
const pinPass = (pin, p) => `tkr-${pin}-${p.id}`;
const isStaffEmail = e => e.endsWith("@staff.tkroperations.app");

/* ---------- auth ---------- */
onAuthStateChanged(auth, async u => {
  if (!u) { try { await signInAnonymously(auth); } catch (e) { netNote("Can't connect yet. Open the board with signal the first time."); } return; }
  user = u; email = (u.email || "").toLowerCase();
  $("signBtn").textContent = u.isAnonymous ? "Manager sign in" : "Sign out";
  start();
});
$("signBtn").onclick = async () => {
  if (user && !user.isAnonymous) { await signOut(auth); me = ""; managing = false; $("manageBox").hidden = true; $("exportBox").hidden = true; tasks = []; return; }
  $("sErr").textContent = ""; $("signDlg").hidden = false; $("sEmail").focus();
};
$("sCancel").onclick = () => $("signDlg").hidden = true;
$("signForm").onsubmit = async e => {
  e.preventDefault(); $("sErr").textContent = "";
  try { await signInWithEmailAndPassword(auth, toLogin($("sEmail").value), $("sPass").value); $("signDlg").hidden = true; $("sPass").value = ""; toast("Signed in"); }
  catch (err) {
    const c = err?.code || "";
    $("sErr").textContent = c.includes("invalid") || c.includes("wrong") || c.includes("not-found") ? "Email or password is wrong." : c.includes("network") ? "No signal. Sign in needs signal." : "Sign in didn't work. Try again.";
  }
};

/* ---------- live data ---------- */
let started = false, unsubTeam = null, unsubRoles = null, unsubOps = null, getOps = [], unsubReqs = null, getReqs = [];
function start() {
  if (unsubTeam) unsubTeam(); if (unsubRoles) unsubRoles(); if (unsubOps) { unsubOps(); unsubOps = null; }
  if (unsubReqs) { unsubReqs(); unsubReqs = null; }
  if (isAdmin()) unsubReqs = onSnapshot(collection(db, "getExportRequests"), s => { getReqs = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 15); renderManage(); }, () => {});
  if (isAdmin()) unsubOps = onSnapshot(collection(db, "getOperators"), s => { getOps = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.approved - b.approved) || a.name.localeCompare(b.name)); renderManage(); }, () => {});
  unsubRoles = onSnapshot(doc(db, "config", "roles"), s => { managers = ((s.exists() && s.data().managers) || []).map(x => String(x).toLowerCase()); renderAll(); }, () => {});
  unsubTeam = onSnapshot(collection(db, "team"), s => {
    team = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
    teamLoaded = true; renderAll();
  }, e => netNote("The board couldn't load. Check the signal and open it again."));
  subKey = ""; subscribeTasks(true); started = true;
}
let subKey = "";
function subscribeTasks(force) {
  const mine = myEmp();
  const key = isManager() ? "all:" + selected : mine ? "me:" + mine.id : "none";
  if (!force && key === subKey && unsubTasks) return;
  subKey = key;
  if (unsubTasks) { unsubTasks(); unsubTasks = null; }
  if (key === "none") { tasks = []; render(); return; }
  // Managers load the week on screen; an employee loads only their own tasks (Firebase blocks the rest).
  const q = isManager() ? query(collection(db, "tasks"), where("date", ">=", addDays(selected, -6)), where("date", "<=", selected))
    : query(collection(db, "tasks"), where("person", "==", mine.id));
  unsubTasks = onSnapshot(q, { includeMetadataChanges: true }, s => {
    tasks = s.docs.map(d => ({ id: d.id, ...d.data() }));
    pendingWrites = s.metadata.hasPendingWrites; updateNet(); render();
  }, () => {});
}
function netNote(m) { const n = $("net"); n.textContent = m; n.hidden = !m; }
function updateNet() {
  if (!navigator.onLine) netNote("No signal. You can keep working. Changes are saved on this phone and sent when the signal is back.");
  else if (pendingWrites) netNote("Sending changes…");
  else netNote("");
}
addEventListener("online", updateNet); addEventListener("offline", updateNet);

/* ---------- rendering ---------- */
const dayTasks = (date, person) => tasks.filter(t => t.date === date && (!person || t.person === person));
function counts(list) { const c = { total: list.length, done: 0, prog: 0, block: 0, idle: 0 }; list.forEach(t => { if (t.status === "Done") c.done++; else if (t.status === "In progress") c.prog++; else if (t.status === "Blocked") c.block++; else c.idle++; }); return c; }
function segs(c) { if (!c.total) return ""; return [["done", "var(--ok)"], ["prog", "#2f6fb8"], ["block", "var(--bad)"], ["idle", "var(--line)"]].map(([k, v]) => c[k] ? `<span style="width:${c[k] / c.total * 100}%;background:${v}"></span>` : "").join(""); }

function renderAll() { me = myEmp()?.id || ""; subscribeTasks(); renderSelects(); renderControls(); renderManage(); render(); }
function renderSelects() {
  const meSel = $("me"), f = $("filter"), cur = f.value, mine = myEmp();
  meSel.innerHTML = `<option value="">Choose your name</option>` + team.map(p => `<option value="${esc(p.id)}" ${mine && p.id === mine.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  meSel.disabled = !!(user && !user.isAnonymous);
  $("meWrap").hidden = !!(user && !user.isAnonymous && !mine);
  $("filter").hidden = !isManager();
  $("signBtn").textContent = !user || user.isAnonymous ? "Manager sign in" : "Sign out";
  $("who").textContent = !user || user.isAnonymous ? "" : mine ? `Signed in as ${mine.name}` : `Signed in as ${showName(email)}${isAdmin() ? " · app admin" : " · manager"}`;
  f.innerHTML = `<option value="">Everyone</option>` + team.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("");
  f.value = team.some(p => p.id === cur) ? cur : "";
}
function renderControls() {
  $("exportBtn").hidden = !isManager();
  $("manageBtn").hidden = !isAdmin();
  if (!isManager()) $("exportBox").hidden = true;
  if (!isAdmin()) { managing = false; $("manageBox").hidden = true; }
}
function render() {
  $("date").value = selected;
  $("dayname").textContent = longDate(selected);
  const filter = $("filter").value, list = dayTasks(selected, filter), c = counts(list);
  $("nTotal").textContent = c.total; $("nDone").textContent = c.done; $("nProg").textContent = c.prog; $("nBlock").textContent = c.block;
  $("meter").innerHTML = segs(c);
  $("pct").textContent = c.total ? `${Math.round(c.done / c.total * 100)}% complete` : "No tasks yet";
  $("sumhead").textContent = filter ? `Day summary · ${(team.find(p => p.id === filter) || {}).name || ""}` : "Day summary · whole team";
  renderChart(filter); renderTeam(filter);
}
function renderChart(filter) {
  const days = []; for (let i = 6; i >= 0; i--) days.push(addDays(selected, -i));
  const data = days.map(d => counts(dayTasks(d, filter))), max = Math.max(1, ...data.map(x => x.total));
  const W = 420, H = 150, top = 18, bot = 30, bw = 34, gap = (W - bw * 7) / 7, sc = v => v / max * (H - top - bot);
  let g = `<line x1="0" x2="${W}" y1="${H - bot}" y2="${H - bot}" stroke="var(--line)"/>`;
  data.forEach((c, i) => {
    const x = gap / 2 + i * (bw + gap), base = H - bot, ht = sc(c.total), hd = sc(c.done), d = parse(days[i]), sel = days[i] === selected;
    g += `<g style="cursor:pointer" data-day="${days[i]}"><rect x="${x - gap / 2}" y="0" width="${bw + gap}" height="${H}" fill="transparent"/>
      ${c.total ? `<rect x="${x}" y="${base - ht}" width="${bw}" height="${ht}" rx="3" fill="var(--line)"/>` : ""}
      ${c.done ? `<rect x="${x}" y="${base - hd}" width="${bw}" height="${hd}" rx="3" fill="var(--ok)"/>` : ""}
      ${sel ? `<rect x="${x}" y="${base + 3}" width="${bw}" height="2" fill="var(--gold)"/>` : ""}
      <text x="${x + bw / 2}" y="${base - ht - 5}" text-anchor="middle">${c.total ? `${c.done}/${c.total}` : ""}</text>
      <text x="${x + bw / 2}" y="${H - 12}" text-anchor="middle" style="${sel ? "fill:var(--fg);font-weight:600" : ""}">${d.toLocaleDateString("en-ZA", { weekday: "short" })}</text>
      <text x="${x + bw / 2}" y="${H - 1}" text-anchor="middle">${d.getDate()}</text></g>`;
  });
  $("chart").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tasks done per day, last 7 days">${g}</svg>`;
  $("chart").querySelectorAll("g[data-day]").forEach(el => el.onclick = () => setDate(el.dataset.day));
}
function ring(c) {
  const r = 14, C = 2 * Math.PI * r, p = c.total ? c.done / c.total : 0;
  return `<svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true" style="flex:none;margin-left:auto"><circle cx="20" cy="20" r="${r}" fill="none" stroke="var(--panel2)" stroke-width="4"/>
    <circle cx="20" cy="20" r="${r}" fill="none" stroke="var(--ok)" stroke-width="4" stroke-linecap="round" stroke-dasharray="${C * p} ${C}" transform="rotate(-90 20 20)"/>
    <text x="20" y="23.5" text-anchor="middle" style="font-family:var(--mono);font-size:10px;fill:var(--fg)">${Math.round(p * 100)}%</text></svg>`;
}
function renderTeam(filter) {
  const box = $("team");
  if (!teamLoaded) return;
  if (!team.length) { box.innerHTML = `<div class="card empty"><b>No employees yet</b>${isAdmin() ? "Tap Manage to add the people on the board." : "Ask admin to add you to the board."}</div>`; return; }
  const mine = myEmp();
  if (!isManager() && !mine) { box.innerHTML = `<div class="card empty"><b>Choose your name to start</b>Tap "I am", choose your name and type your PIN. The first time, you make your own 4-digit PIN.</div>`; return; }
  const people = isManager() ? team.filter(p => !filter || p.id === filter) : [mine];
  box.innerHTML = people.map(p => {
    const list = dayTasks(selected, p.id).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)), c = counts(list), ed = canEdit(p.id);
    const prevOpen = dayTasks(addDays(selected, -1), p.id).filter(t => t.status !== "Done");
    const rows = list.map(t => `<li class="task ${t.status === "Done" ? "is-done" : ""}" data-id="${esc(t.id)}">
        <select class="${cls(t.status)}" data-act="status" aria-label="Status" ${ed ? "" : "disabled"}>${STATUSES.map(([s]) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select>
        <input class="title" data-act="title" value="${esc(t.title)}" maxlength="200" aria-label="Task" ${ed ? "" : "disabled"}>
        ${ed ? `<button class="ib" data-act="addlink" title="Add a link to the work" aria-label="Add a link to the work">🔗</button><button class="ib" data-act="del" title="Delete task" aria-label="Delete task">×</button>` : "<span></span><span></span>"}
        ${linkFor === t.id ? `<form class="linkform" data-task="${esc(t.id)}"><input name="u" type="url" inputmode="url" placeholder="Paste the Google Drive link" aria-label="Link"><input name="l" class="lbl" placeholder="Name (optional)" maxlength="80"><button class="primary">Save link</button><button type="button" class="ghost" data-act="cancellink">Cancel</button></form>` : ""}
        ${t.byName && t.byName !== p.name ? `<div class="links muted" style="font-size:12px">${t.editedBy && t.editedBy !== t.byName ? "edited by " + esc(t.editedBy) : "added by " + esc(t.byName)}</div>` : t.editedBy && t.editedBy !== p.name ? `<div class="links muted" style="font-size:12px">edited by ${esc(t.editedBy)}</div>` : ""}
        ${(t.links || []).length ? `<div class="links">${t.links.map(l => `<span class="lnk" data-link="${esc(l.id)}"><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(linkLabel(l))}</a>${ed ? `<button data-act="unlink" aria-label="Remove link">×</button>` : ""}</span>`).join("")}</div>` : ""}
      </li>`).join("");
    return `<article class="card" data-person="${esc(p.id)}">
      <div class="ph"><div class="avatar">${esc((p.name || "?").trim().charAt(0).toUpperCase())}</div>
        <div><b>${esc(p.name)}${p.id === me ? `<span class="you">You</span>` : ""}</b><span class="muted">${c.done} of ${c.total} done${c.block ? ` · ${c.block} blocked` : ""}</span></div>${ring(c)}</div>
      <div class="minibar">${segs(c)}</div>
      ${list.length ? `<ul class="tasks">${rows}</ul>` : `<div class="none">No tasks for this day.</div>`}
      ${ed ? `<form class="addtask" data-person="${esc(p.id)}"><input name="t" placeholder="Add a task" maxlength="200" aria-label="New task for ${esc(p.name)}"><button class="primary">Add</button></form>
        ${prevOpen.length ? `<div class="cardfoot"><button data-act="carry">Carry over ${prevOpen.length} open from ${parse(addDays(selected, -1)).toLocaleDateString("en-ZA", { weekday: "short" })}</button></div>` : ""}`
        : ""}
    </article>`;
  }).join("");
}
function renderManage() {
  if (!isAdmin()) return;
  $("teamList").innerHTML = team.length ? team.map(p => `<div class="it"><span>${esc(p.name)} <span class="muted">· ${p.uid ? "PIN set" : "no PIN yet"}</span></span><span class="row" style="gap:6px">${p.uid ? `<button data-resetpin="${esc(p.id)}">Reset PIN</button>` : ""}<button class="danger" data-rm="${esc(p.id)}">Remove</button></span></div>`).join("") : `<div class="muted">No employees yet.</div>`;
  $("opList").innerHTML = getOps.length ? getOps.map(o => `<div class="it"><span>${esc(o.name)} <span class="muted">· ${o.approved ? "approved" : "waiting for approval"}</span></span><span class="row" style="gap:6px">${o.approved ? "" : `<button class="primary" data-opok="${esc(o.id)}">Approve</button>`}<button class="danger" data-opdel="${esc(o.id)}">${o.approved ? "Reset PIN / remove" : "Decline"}</button></span></div>`).join("") : `<div class="muted">No GET operators have registered yet.</div>`;
  $("reqList").innerHTML = getReqs.length ? getReqs.map(q => `<div class="it"><span>${esc(q.opName)} <span class="muted">· ${fmt(q.from)} to ${fmt(q.to)} · ${q.status === "pending" ? "waiting" : q.status}</span></span>${q.status === "pending" ? `<span class="row" style="gap:6px"><button class="primary" data-reqok="${esc(q.id)}">Approve</button><button class="danger" data-reqno="${esc(q.id)}">Decline</button></span>` : ""}</div>`).join("") : `<div class="muted">No export requests.</div>`;
  $("mgrList").innerHTML = (managers.length ? managers : []).map(m => `<div class="it"><span>${esc(m)}</span><button class="danger" data-rmmgr="${esc(m)}">Remove</button></div>`).join("") || `<div class="muted">No managers added yet.</div>`;
}

/* ---------- actions ---------- */
function setDate(d) { if (!d || d === selected) return; selected = d; linkFor = null; subscribeTasks(); render(); }
$("prev").onclick = () => setDate(addDays(selected, -1));
$("next").onclick = () => setDate(addDays(selected, 1));
$("today").onclick = () => setDate(ymd(new Date()));
$("date").onchange = e => setDate(e.target.value);
$("filter").onchange = render;
let pinFor = null;
$("me").onchange = e => {
  const p = team.find(x => x.id === e.target.value); if (!p) return;
  pinFor = p; const first = !p.uid;
  $("pTitle").textContent = first ? `Make your PIN, ${p.name}` : `Hello ${p.name}`;
  $("pHelp").textContent = first ? "Choose 4 numbers you will remember. You type them each time you sign in on a new phone." : "Type your 4-digit PIN.";
  $("pConfirmWrap").hidden = !first; $("pPin").value = ""; $("pPin2").value = ""; $("pErr").textContent = "";
  $("pinDlg").hidden = false; $("pPin").focus();
};
$("pCancel").onclick = () => { $("pinDlg").hidden = true; renderSelects(); };
$("pinForm").onsubmit = async e => {
  e.preventDefault();
  const p = pinFor, pin = $("pPin").value.trim(); if (!p) return;
  if (!/^\d{4}$/.test(pin)) { $("pErr").textContent = "The PIN must be 4 numbers."; return; }
  const first = !p.uid;
  if (first && pin !== $("pPin2").value.trim()) { $("pErr").textContent = "The two PINs are not the same."; return; }
  $("pErr").textContent = first ? "Making your PIN…" : "Signing in…";
  const em = first ? staffEmail(p) : (p.authEmail || staffEmail(p)), pw = pinPass(pin, p);
  try {
    if (first) {
      try { await createUserWithEmailAndPassword(auth, em, pw); }
      catch (err) { if (err?.code === "auth/email-already-in-use") await signInWithEmailAndPassword(auth, em, pw); else throw err; }
      await updateDoc(doc(db, "team", p.id), { uid: auth.currentUser.uid, authEmail: em, pinSetAt: Date.now() });
      toast("Your PIN is made");
    } else {
      await signInWithEmailAndPassword(auth, em, pw); toast(`Signed in as ${p.name}`);
    }
    $("pinDlg").hidden = true;
  } catch (err) {
    const c = err?.code || "";
    $("pErr").textContent = c.includes("too-many") ? "Too many tries. Wait a few minutes, or ask admin to reset your PIN."
      : c.includes("network") ? "No signal. Signing in needs signal the first time."
      : c === "permission-denied" ? "Someone has already made a PIN for this name. Ask admin to reset it."
      : first ? "The PIN couldn't be made. Try again." : "Wrong PIN. If you forgot it, ask admin to reset it.";
  }
};
$("copy").onclick = async () => {
  const lines = [`Daily tasks – ${longDate(selected)}`, ""];
  team.forEach(p => {
    const list = dayTasks(selected, p.id), c = counts(list);
    lines.push(`${p.name} (${c.done}/${c.total} done)`);
    if (!list.length) lines.push("- No tasks for this day");
    list.forEach(t => { lines.push(`- ${t.title} [${t.status}]`); (t.links || []).forEach(l => lines.push(`  ${l.label ? l.label + ": " : ""}${l.url}`)); });
    lines.push("");
  });
  const all = counts(dayTasks(selected)); lines.push(`Team total: ${all.done} of ${all.total} done${all.block ? `, ${all.block} blocked` : ""}`);
  const txt = lines.join("\n");
  try { await navigator.clipboard.writeText(txt); toast("Summary copied. Paste it into WhatsApp or email."); }
  catch { const ta = document.createElement("textarea"); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); toast("Summary copied"); } catch { toast("Copy isn't available here"); } ta.remove(); }
};
const byName = () => myEmp()?.name || email || "Unknown";
async function addTask(person, title, status = "Not started") {
  const now = Date.now();
  await addDoc(collection(db, "tasks"), { person, date: selected, title, status, links: [], createdAt: now, updatedAt: now, byUid: user?.uid || "", byName: byName() });
}
const stamp = () => ({ updatedAt: Date.now(), editedBy: byName() });
const team$ = $("team");
team$.addEventListener("submit", async e => {
  e.preventDefault();
  const lf = e.target.closest("form.linkform");
  if (lf) {
    const id = lf.dataset.task, url = cleanUrl(lf.u.value), label = lf.l.value.trim();
    if (!url) { toast("Paste the full link, starting with https://"); lf.u.focus(); return; }
    const t = tasks.find(x => x.id === id); if (!t) return;
    linkFor = null;
    updateDoc(doc(db, "tasks", id), { links: [...(t.links || []), { id: "l" + Date.now().toString(36), url, label }], ...stamp() }).catch(fail);
    render(); toast("Link added"); return;
  }
  const f = e.target.closest("form.addtask"); if (!f) return;
  const v = f.t.value.trim(); if (!v) return; f.t.value = "";
  addTask(f.dataset.person, v).catch(fail);
  setTimeout(() => { const i = team$.querySelector(`form.addtask[data-person="${CSS.escape(f.dataset.person)}"] input`); i && i.focus(); }, 60);
});
team$.addEventListener("change", e => {
  if (e.target.dataset.act !== "status") return;
  const id = e.target.closest(".task").dataset.id;
  updateDoc(doc(db, "tasks", id), { status: e.target.value, ...stamp() }).catch(fail);
});
team$.addEventListener("focusout", e => {
  if (e.target.dataset.act !== "title") return;
  const id = e.target.closest(".task").dataset.id, t = tasks.find(x => x.id === id), v = e.target.value.trim();
  if (!t || v === t.title) return;
  if (!v) { e.target.value = t.title; return; }
  updateDoc(doc(db, "tasks", id), { title: v, ...stamp() }).catch(fail);
});
team$.addEventListener("keydown", e => { if (e.target.dataset.act === "title" && e.key === "Enter") e.target.blur(); });
team$.addEventListener("click", async e => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const act = b.dataset.act, li = b.closest(".task"), id = li?.dataset.id, card = b.closest(".card"), person = card?.dataset.person;
  if (act === "del") { if (confirm("Delete this task?")) deleteDoc(doc(db, "tasks", id)).catch(fail); return; }
  if (act === "addlink") { linkFor = linkFor === id ? null : id; render(); const i = team$.querySelector("form.linkform input"); i && i.focus(); return; }
  if (act === "cancellink") { linkFor = null; render(); return; }
  if (act === "unlink") {
    const t = tasks.find(x => x.id === id), lid = b.closest(".lnk").dataset.link;
    if (t && confirm("Remove this link?")) updateDoc(doc(db, "tasks", id), { links: (t.links || []).filter(l => l.id !== lid), ...stamp() }).catch(fail);
    return;
  }
  if (act === "carry") {
    const open = dayTasks(addDays(selected, -1), person).filter(t => t.status !== "Done");
    const have = new Set(dayTasks(selected, person).map(t => t.title.toLowerCase()));
    let n = 0; for (const t of open) { if (have.has(t.title.toLowerCase())) continue; addTask(person, t.title, t.status === "Blocked" ? "Blocked" : t.status).catch(fail); n++; }
    toast(n ? `${n} task${n > 1 ? "s" : ""} carried over` : "Those tasks are already on this day");
  }
});

/* ---------- manage (admins) ---------- */
$("manageBtn").onclick = () => { managing = !managing; $("manageBox").hidden = !managing; $("manageBtn").setAttribute("aria-pressed", managing); renderManage(); };
$("addPerson").onsubmit = e => {
  e.preventDefault(); const name = $("newPerson").value.trim(); if (!name) return;
  addDoc(collection(db, "team"), { name, order: Date.now() }).then(() => toast(`${name} added`)).catch(fail);
  $("newPerson").value = "";
};
$("manageBox").addEventListener("click", async e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.reqok) {
    const q = getReqs.find(x => x.id === b.dataset.reqok);
    // The grant lets that operator read every operator's GET records for 24 hours, so their export is the combined report.
    Promise.all([updateDoc(doc(db, "getExportRequests", b.dataset.reqok), { status: "approved", approvedBy: email, approvedAt: Date.now() }),
      q ? setDoc(doc(db, "getExportGrants", q.opUid), { until: Date.now() + 24 * 3600e3, by: email }) : null]).then(() => toast("Export approved")).catch(fail);
    return;
  }
  if (b.dataset.reqno) { updateDoc(doc(db, "getExportRequests", b.dataset.reqno), { status: "declined", approvedBy: email, approvedAt: Date.now() }).catch(fail); return; }
  if (b.dataset.opok) { updateDoc(doc(db, "getOperators", b.dataset.opok), { approved: true, approvedBy: email, approvedAt: Date.now() }).then(() => toast("Approved")).catch(fail); return; }
  if (b.dataset.opdel) { const o = getOps.find(x => x.id === b.dataset.opdel); if (o && confirm(`Remove ${o.name}'s GET sign-in? They can register again with a new PIN.`)) deleteDoc(doc(db, "getOperators", o.id)).catch(fail); return; }
  if (b.dataset.resetpin) {
    const p = team.find(x => x.id === b.dataset.resetpin);
    if (p && confirm(`Reset ${p.name}'s PIN? Their tasks stay. Next time they choose their name, they make a new PIN.`))
      updateDoc(doc(db, "team", p.id), { uid: null, authEmail: null, resets: (p.resets || 0) + 1 }).then(() => toast(`${p.name} can now make a new PIN`)).catch(fail);
    return;
  }
  if (b.dataset.rm) { const p = team.find(x => x.id === b.dataset.rm); if (p && confirm(`Remove ${p.name} from the board? Their past tasks are kept.`)) deleteDoc(doc(db, "team", p.id)).catch(fail); }
  if (b.dataset.rmmgr) { if (confirm(`Remove ${b.dataset.rmmgr} as a manager?`)) setDoc(doc(db, "config", "roles"), { managers: arrayRemove(b.dataset.rmmgr) }, { merge: true }).catch(fail); }
});
$("addMgr").onsubmit = async e => {
  e.preventDefault();
  const em = toLogin($("mgrEmail").value).toLowerCase(), pw = $("mgrPass").value;
  if (!$("mgrEmail").value.trim()) { $("mgrMsg").textContent = "Type the manager's username or email."; return; }
  if (pw && pw.length < 6) { $("mgrMsg").textContent = "The password must be at least 6 characters."; return; }
  $("mgrMsg").textContent = "Adding…";
  let note = "";
  if (pw) {
    // A second Firebase connection creates the manager's sign-in without signing the admin out.
    const tmp = initializeApp(firebaseConfig, "add-" + Date.now());
    try { await createUserWithEmailAndPassword(getAuth(tmp), em, pw); note = " Their sign-in is made."; }
    catch (err) { note = err?.code === "auth/email-already-in-use" ? " They already had a sign-in, so their old password stays." : ""; if (!note) { $("mgrMsg").textContent = "The sign-in couldn't be made. Check the email and try again."; deleteApp(tmp).catch(() => {}); return; } }
    deleteApp(tmp).catch(() => {});
  }
  try { await setDoc(doc(db, "config", "roles"), { managers: arrayUnion(em) }, { merge: true }); $("mgrMsg").textContent = `${em} can now sign in and download.${note}`; $("mgrEmail").value = ""; $("mgrPass").value = ""; }
  catch (err) { fail(err); $("mgrMsg").textContent = ""; }
};

/* ---------- export (managers) ---------- */
$("exportBtn").onclick = () => {
  const box = $("exportBox"); box.hidden = !box.hidden;
  if (!box.hidden) { if (!$("exFrom").value) $("exFrom").value = addDays(selected, -6); if (!$("exTo").value) $("exTo").value = selected; $("exMsg").textContent = ""; }
};
$("exGo").onclick = async () => {
  const from = $("exFrom").value, to = $("exTo").value;
  if (!from || !to || from > to) { $("exMsg").textContent = "Choose a From date before the To date."; return; }
  $("exMsg").textContent = "Making the Excel file…";
  try { await loadLib("../lib/exceljs.min.js"); } catch { $("exMsg").textContent = "The export needs signal the first time."; return; }
  try {
    const s = await getDocs(query(collection(db, "tasks"), where("date", ">=", from), where("date", "<=", to)));
    const list = s.docs.map(d => d.data()).sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
    const names = Object.fromEntries(team.map(p => [p.id, p.name]));
    const out = await brandedWorkbook(list, from, to, names);
    const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const name = `TKR_Daily_Tasks_${fmt(from).replace(/\//g, "-")}_to_${fmt(to).replace(/\//g, "-")}.xlsx`;
    const { deliver } = await import("../lib/deliver.js");
    deliver(blob, name, { doneLabel: "Done – clear this phone's copy", onDone: async () => { const fb = await import("../lib/firebase.js"); const { clearPhoneCopy } = await import("../lib/deliver.js"); await clearPhoneCopy(fb, [db], toast); } });
    $("exMsg").textContent = `${list.length} task${list.length === 1 ? "" : "s"} exported.`;
  } catch (err) { console.warn(err); $("exMsg").textContent = err?.code === "permission-denied" ? "Only managers can export." : "The export needs signal. Try again with signal."; }
};


/* ---------- branded Excel (TKR black and gold, logo) ---------- */
const BLACK = "FF111111", HEAD = "FF262626", GOLD = "FFD4A12A", CREAM = "FFFFF8E6", WHITE = "FFFFFFFF", GRID = "FFD9D3C5";
const STATUS_FILL = { "Done": "FFDDF1E3", "In progress": "FFDCE8F7", "Blocked": "FFF8DDD8", "Not started": "FFEFEDE7" };
const STATUS_FONT = { "Done": "FF1E6B3A", "In progress": "FF1F4F8A", "Blocked": "FF9B2C1E", "Not started": "FF5E584C" };
async function brandedWorkbook(list, from, to, names) {
  const ExcelJS = window.ExcelJS, wb = new ExcelJS.Workbook();
  wb.creator = "TKR Operations"; wb.created = new Date();
  let logo = null;
  try { const buf = await (await fetch("../icons/icon-512.png")).arrayBuffer(); logo = wb.addImage({ buffer: buf, extension: "png" }); } catch {}
  const period = `${fmt(from)} to ${fmt(to)}`;
  const thin = { style: "thin", color: { argb: GRID } };
  const box = { top: thin, left: thin, bottom: thin, right: thin };
  function band(ws, cols, title) {
    ws.views = [{ showGridLines: false }];
    for (let r = 1; r <= 4; r++) { ws.getRow(r).height = r === 1 ? 8 : 22; for (let c = 1; c <= cols; c++) ws.getCell(r, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } }; }
    for (let c = 1; c <= cols; c++) ws.getCell(5, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: GOLD } };
    ws.getRow(5).height = 4;
    if (logo !== null) ws.addImage(logo, { tl: { col: 0.15, row: 1.05 }, ext: { width: 62, height: 62 } });
    const t = ws.getCell("B2"); t.value = title; t.font = { name: "Arial", size: 18, bold: true, color: { argb: WHITE } };
    const sub = ws.getCell("B3"); sub.value = "TKR OPERATIONS  ·  THARISA MINE"; sub.font = { name: "Arial", size: 9, bold: true, color: { argb: GOLD } };
    const per = ws.getCell("B4"); per.value = `Period: ${period}`; per.font = { name: "Arial", size: 10, color: { argb: "FFE8E2D4" } };
  }
  function header(ws, rowNo, labels) {
    const row = ws.getRow(rowNo); row.height = 24;
    labels.forEach((l, i) => { const c = row.getCell(i + 1); c.value = l; c.font = { name: "Arial", size: 10, bold: true, color: { argb: WHITE } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEAD } }; c.alignment = { vertical: "middle", horizontal: i === 0 ? "left" : "center", wrapText: true }; c.border = box; });
  }
  // Sum up
  const ws1 = wb.addWorksheet("Sum up", { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  ws1.columns = [{ width: 30 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 12 }, { width: 14 }, { width: 12 }];
  band(ws1, 7, "Daily Task Board – Sum up");
  header(ws1, 7, ["Employee", "Tasks", "Done", "In progress", "Blocked", "Not started", "% done"]);
  const ids = [...new Set([...team.map(p => p.id), ...list.map(t => t.person)])].filter(id => list.some(t => t.person === id));
  let r = 8;
  ids.forEach((id, i) => {
    const c = counts(list.filter(t => t.person === id));
    const row = ws1.getRow(r++); row.values = [names[id] || "Former employee", c.total, c.done, c.prog, c.block, c.idle, c.total ? c.done / c.total : 0];
    row.eachCell({ includeEmpty: true }, (cell, n) => { if (n > 7) return; cell.border = box; cell.font = { name: "Arial", size: 10 };
      if (i % 2) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CREAM } }; cell.alignment = { vertical: "middle", horizontal: n === 1 ? "left" : "center" }; });
    row.getCell(7).numFmt = "0%"; row.height = 20;
  });
  const all = counts(list);
  const tot = ws1.getRow(r); tot.values = ["Team total", all.total, all.done, all.prog, all.block, all.idle, all.total ? all.done / all.total : 0];
  tot.eachCell({ includeEmpty: true }, (cell, n) => { if (n > 7) return; cell.font = { name: "Arial", size: 11, bold: true }; cell.border = { ...box, top: { style: "medium", color: { argb: GOLD } } };
    cell.alignment = { vertical: "middle", horizontal: n === 1 ? "left" : "center" }; });
  tot.getCell(7).numFmt = "0%"; tot.height = 22;
  if (ids.length) ws1.addConditionalFormatting({ ref: `G8:G${r - 1}`, rules: [{ type: "dataBar", minLength: 0, maxLength: 100, cfvo: [{ type: "num", value: 0 }, { type: "num", value: 1 }], color: { argb: "FF5FB37C" } }] });
  const note = ws1.getCell(`A${r + 2}`); note.value = `Exported ${new Date().toLocaleString("en-ZA")}${email ? " by " + email : ""}`; note.font = { name: "Arial", size: 9, italic: true, color: { argb: "FF6B6558" } };
  // Tasks
  const ws2 = wb.addWorksheet("Tasks", { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  ws2.columns = [{ width: 13 }, { width: 24 }, { width: 52 }, { width: 14 }, { width: 46 }];
  band(ws2, 5, "Daily Task Board – Tasks");
  header(ws2, 7, ["Date", "Employee", "Task", "Status", "Link to the work"]);
  r = 8;
  list.forEach((t, i) => {
    const links = t.links || [];
    const row = ws2.getRow(r);
    row.values = [fmt(t.date), names[t.person] || "Former employee", t.title, t.status || "Not started", ""];
    row.eachCell({ includeEmpty: true }, (cell, n) => { if (n > 5) return; cell.border = box; cell.font = { name: "Arial", size: 10 };
      cell.alignment = { vertical: "top", wrapText: true, horizontal: n === 1 || n === 4 ? "center" : "left" };
      if (i % 2 && n !== 4) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: CREAM } }; });
    const st = row.getCell(4), sv = t.status || "Not started";
    st.fill = { type: "pattern", pattern: "solid", fgColor: { argb: STATUS_FILL[sv] || CREAM } }; st.font = { name: "Arial", size: 10, bold: true, color: { argb: STATUS_FONT[sv] || "FF000000" } };
    const lc = row.getCell(5);
    if (links.length === 1) { lc.value = { text: linkLabel(links[0]), hyperlink: links[0].url }; lc.font = { name: "Arial", size: 10, color: { argb: "FF1F4F8A" }, underline: true }; }
    else if (links.length > 1) { lc.value = links.map(l => `${linkLabel(l)}: ${l.url}`).join("\n"); }
    row.height = Math.max(20, 15 * Math.max(1, links.length, Math.ceil(String(t.title).length / 55)));
    r++;
  });
  if (!list.length) { const c = ws2.getCell("A8"); c.value = "No tasks in this period."; c.font = { name: "Arial", italic: true, color: { argb: "FF6B6558" } }; }
  ws2.views = [{ state: "frozen", ySplit: 7, showGridLines: false }];
  if (list.length) ws2.autoFilter = { from: "A7", to: `E${r - 1}` };
  ws1.views = [{ state: "frozen", ySplit: 7, showGridLines: false }];
  return await wb.xlsx.writeBuffer();
}

// A new version of the app was installed: load it straight away instead of on the next open.
if("serviceWorker" in navigator&&navigator.serviceWorker.controller){let reloaded=false;navigator.serviceWorker.addEventListener("controllerchange",()=>{if(reloaded)return;reloaded=true;location.reload()})}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js", { scope: "../", updateViaCache: "none" }).then(r => r.update()).catch(() => {});
render();
