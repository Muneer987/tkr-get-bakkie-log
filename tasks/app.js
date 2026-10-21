/* TKR Daily Task Board — shared online through Firebase. Changes made with no signal are kept on the
   device and sent when the signal comes back. Employees: no sign-in (anonymous). Admins and managers: email + password. */
import {
  initializeApp, deleteApp, getAuth, signInAnonymously, signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, addDoc, setDoc, updateDoc, deleteDoc, getDocs,
  onSnapshot, query, where, arrayUnion, arrayRemove,
} from "../lib/firebase.js";

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
let me = lsGet("tkr-me") || "", managing = false, linkFor = null, unsubTasks = null, teamLoaded = false, pendingWrites = false;
const isAdmin = () => ADMINS.includes(email);
const isManager = () => isAdmin() || (email && managers.includes(email));
const canEdit = personId => isAdmin() || (personId && personId === me);

/* ---------- auth ---------- */
onAuthStateChanged(auth, async u => {
  if (!u) { try { await signInAnonymously(auth); } catch (e) { netNote("Can't connect yet. Open the board with signal the first time."); } return; }
  user = u; email = (u.email || "").toLowerCase();
  $("signBtn").textContent = u.isAnonymous ? "Manager sign in" : "Sign out";
  $("who").textContent = u.isAnonymous ? "" : `Signed in as ${email}${isAdmin() ? " · app admin" : ""}`;
  start();
});
$("signBtn").onclick = async () => {
  if (user && !user.isAnonymous) { await signOut(auth); managing = false; $("manageBox").hidden = true; $("exportBox").hidden = true; return; }
  $("sErr").textContent = ""; $("signDlg").hidden = false; $("sEmail").focus();
};
$("sCancel").onclick = () => $("signDlg").hidden = true;
$("signForm").onsubmit = async e => {
  e.preventDefault(); $("sErr").textContent = "";
  try { await signInWithEmailAndPassword(auth, $("sEmail").value.trim(), $("sPass").value); $("signDlg").hidden = true; $("sPass").value = ""; toast("Signed in"); }
  catch (err) {
    const c = err?.code || "";
    $("sErr").textContent = c.includes("invalid") || c.includes("wrong") || c.includes("not-found") ? "Email or password is wrong." : c.includes("network") ? "No signal. Sign in needs signal." : "Sign in didn't work. Try again.";
  }
};

/* ---------- live data ---------- */
let started = false, unsubTeam = null, unsubRoles = null;
function start() {
  if (unsubTeam) unsubTeam(); if (unsubRoles) unsubRoles();
  unsubRoles = onSnapshot(doc(db, "config", "roles"), s => { managers = ((s.exists() && s.data().managers) || []).map(x => String(x).toLowerCase()); renderAll(); }, () => {});
  unsubTeam = onSnapshot(collection(db, "team"), s => {
    team = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order || 0) - (b.order || 0));
    teamLoaded = true; renderAll();
  }, e => netNote("The board couldn't load. Check the signal and open it again."));
  subscribeTasks(); started = true;
}
function subscribeTasks() {
  if (unsubTasks) unsubTasks();
  const q = query(collection(db, "tasks"), where("date", ">=", addDays(selected, -6)), where("date", "<=", selected));
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

function renderAll() { renderSelects(); renderControls(); renderManage(); render(); }
function renderSelects() {
  const meSel = $("me"), f = $("filter"), cur = f.value;
  meSel.innerHTML = `<option value="">Choose your name</option>` + team.map(p => `<option value="${esc(p.id)}" ${p.id === me ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  if (me && !team.some(p => p.id === me) && teamLoaded) { me = ""; lsSet("tkr-me", null); }
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
  if (!team.length) { box.innerHTML = `<div class="card empty"><b>No employees yet</b>${isAdmin() ? "Tap Manage to add the people on the board." : "An app admin adds the employees. Muneer or Amogelang sign in with Manager sign in, then tap Manage."}</div>`; return; }
  const people = team.filter(p => !filter || p.id === filter);
  people.sort((a, b) => (b.id === me) - (a.id === me));
  box.innerHTML = people.map(p => {
    const list = dayTasks(selected, p.id).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)), c = counts(list), ed = canEdit(p.id);
    const prevOpen = dayTasks(addDays(selected, -1), p.id).filter(t => t.status !== "Done");
    const rows = list.map(t => `<li class="task ${t.status === "Done" ? "is-done" : ""}" data-id="${esc(t.id)}">
        <select class="${cls(t.status)}" data-act="status" aria-label="Status" ${ed ? "" : "disabled"}>${STATUSES.map(([s]) => `<option ${s === t.status ? "selected" : ""}>${s}</option>`).join("")}</select>
        <input class="title" data-act="title" value="${esc(t.title)}" maxlength="200" aria-label="Task" ${ed ? "" : "disabled"}>
        ${ed ? `<button class="ib" data-act="addlink" title="Add a link to the work" aria-label="Add a link to the work">🔗</button><button class="ib" data-act="del" title="Delete task" aria-label="Delete task">×</button>` : "<span></span><span></span>"}
        ${linkFor === t.id ? `<form class="linkform" data-task="${esc(t.id)}"><input name="u" type="url" inputmode="url" placeholder="Paste the Google Drive link" aria-label="Link"><input name="l" class="lbl" placeholder="Name (optional)" maxlength="80"><button class="primary">Save link</button><button type="button" class="ghost" data-act="cancellink">Cancel</button></form>` : ""}
        ${(t.links || []).length ? `<div class="links">${t.links.map(l => `<span class="lnk" data-link="${esc(l.id)}"><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(linkLabel(l))}</a>${ed ? `<button data-act="unlink" aria-label="Remove link">×</button>` : ""}</span>`).join("")}</div>` : ""}
      </li>`).join("");
    return `<article class="card" data-person="${esc(p.id)}">
      <div class="ph"><div class="avatar">${esc((p.name || "?").trim().charAt(0).toUpperCase())}</div>
        <div><b>${esc(p.name)}${p.id === me ? `<span class="you">You</span>` : ""}</b><span class="muted">${c.done} of ${c.total} done${c.block ? ` · ${c.block} blocked` : ""}</span></div>${ring(c)}</div>
      <div class="minibar">${segs(c)}</div>
      ${list.length ? `<ul class="tasks">${rows}</ul>` : `<div class="none">No tasks for this day.</div>`}
      ${ed ? `<form class="addtask" data-person="${esc(p.id)}"><input name="t" placeholder="Add a task" maxlength="200" aria-label="New task for ${esc(p.name)}"><button class="primary">Add</button></form>
        ${prevOpen.length ? `<div class="cardfoot"><button data-act="carry">Carry over ${prevOpen.length} open from ${parse(addDays(selected, -1)).toLocaleDateString("en-ZA", { weekday: "short" })}</button></div>` : ""}`
        : (!me && !user?.email ? `<div class="none">Choose your name at the top ("I am") to add your own tasks.</div>` : "")}
    </article>`;
  }).join("");
}
function renderManage() {
  if (!isAdmin()) return;
  $("teamList").innerHTML = team.length ? team.map(p => `<div class="it"><span>${esc(p.name)}</span><button class="danger" data-rm="${esc(p.id)}">Remove</button></div>`).join("") : `<div class="muted">No employees yet.</div>`;
  $("mgrList").innerHTML = (managers.length ? managers : []).map(m => `<div class="it"><span>${esc(m)}</span><button class="danger" data-rmmgr="${esc(m)}">Remove</button></div>`).join("") || `<div class="muted">No managers added yet.</div>`;
}

/* ---------- actions ---------- */
function setDate(d) { if (!d || d === selected) return; selected = d; linkFor = null; subscribeTasks(); render(); }
$("prev").onclick = () => setDate(addDays(selected, -1));
$("next").onclick = () => setDate(addDays(selected, 1));
$("today").onclick = () => setDate(ymd(new Date()));
$("date").onchange = e => setDate(e.target.value);
$("filter").onchange = render;
$("me").onchange = e => { me = e.target.value; lsSet("tkr-me", me || null); render(); };
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
async function addTask(person, title, status = "Not started") {
  const now = Date.now();
  await addDoc(collection(db, "tasks"), { person, date: selected, title, status, links: [], createdAt: now, updatedAt: now });
}
const team$ = $("team");
team$.addEventListener("submit", async e => {
  e.preventDefault();
  const lf = e.target.closest("form.linkform");
  if (lf) {
    const id = lf.dataset.task, url = cleanUrl(lf.u.value), label = lf.l.value.trim();
    if (!url) { toast("Paste the full link, starting with https://"); lf.u.focus(); return; }
    const t = tasks.find(x => x.id === id); if (!t) return;
    linkFor = null;
    updateDoc(doc(db, "tasks", id), { links: [...(t.links || []), { id: "l" + Date.now().toString(36), url, label }], updatedAt: Date.now() }).catch(fail);
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
  updateDoc(doc(db, "tasks", id), { status: e.target.value, updatedAt: Date.now() }).catch(fail);
});
team$.addEventListener("focusout", e => {
  if (e.target.dataset.act !== "title") return;
  const id = e.target.closest(".task").dataset.id, t = tasks.find(x => x.id === id), v = e.target.value.trim();
  if (!t || v === t.title) return;
  if (!v) { e.target.value = t.title; return; }
  updateDoc(doc(db, "tasks", id), { title: v, updatedAt: Date.now() }).catch(fail);
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
    if (t && confirm("Remove this link?")) updateDoc(doc(db, "tasks", id), { links: (t.links || []).filter(l => l.id !== lid), updatedAt: Date.now() }).catch(fail);
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
  if (b.dataset.rm) { const p = team.find(x => x.id === b.dataset.rm); if (p && confirm(`Remove ${p.name} from the board? Their past tasks are kept.`)) deleteDoc(doc(db, "team", p.id)).catch(fail); }
  if (b.dataset.rmmgr) { if (confirm(`Remove ${b.dataset.rmmgr} as a manager?`)) setDoc(doc(db, "config", "roles"), { managers: arrayRemove(b.dataset.rmmgr) }, { merge: true }).catch(fail); }
});
$("addMgr").onsubmit = async e => {
  e.preventDefault();
  const em = $("mgrEmail").value.trim().toLowerCase(), pw = $("mgrPass").value;
  if (!em.includes("@")) { $("mgrMsg").textContent = "Type the manager's email."; return; }
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
  try {
    const s = await getDocs(query(collection(db, "tasks"), where("date", ">=", from), where("date", "<=", to)));
    const list = s.docs.map(d => d.data()).sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt || 0) - (b.createdAt || 0));
    const names = Object.fromEntries(team.map(p => [p.id, p.name]));
    const XL = window.XLSX, wb = XL.utils.book_new();
    const people = [...new Set(list.map(t => t.person))];
    const sum = [["TKR Operations – Daily Task Board"], [`From ${fmt(from)} to ${fmt(to)}`], [], ["Employee", "Tasks", "Done", "In progress", "Blocked", "Not started", "% done"]];
    people.forEach(id => { const c = counts(list.filter(t => t.person === id)); sum.push([names[id] || "Former employee", c.total, c.done, c.prog, c.block, c.idle, c.total ? Math.round(c.done / c.total * 100) : 0]); });
    const all = counts(list); sum.push(["Team total", all.total, all.done, all.prog, all.block, all.idle, all.total ? Math.round(all.done / all.total * 100) : 0]);
    const ws1 = XL.utils.aoa_to_sheet(sum); ws1["!cols"] = [{ wch: 26 }, ...Array(6).fill({ wch: 13 })];
    XL.utils.book_append_sheet(wb, ws1, "Sum up");
    const rows = [["Date", "Employee", "Task", "Status", "Links to the work"]];
    list.forEach(t => rows.push([fmt(t.date), names[t.person] || "Former employee", t.title, t.status, (t.links || []).map(l => (l.label ? l.label + ": " : "") + l.url).join("\n")]));
    const ws2 = XL.utils.aoa_to_sheet(rows); ws2["!cols"] = [{ wch: 12 }, { wch: 22 }, { wch: 50 }, { wch: 13 }, { wch: 70 }];
    XL.utils.book_append_sheet(wb, ws2, "Tasks");
    const out = XL.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const name = `TKR_Daily_Tasks_${fmt(from).replace(/\//g, "-")}_to_${fmt(to).replace(/\//g, "-")}.xlsx`;
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia("(pointer:coarse)").matches) {
      try { await navigator.share({ files: [file], title: name }); } catch {}
    } else { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
    $("exMsg").textContent = `${list.length} task${list.length === 1 ? "" : "s"} exported.`;
  } catch (err) { console.warn(err); $("exMsg").textContent = err?.code === "permission-denied" ? "Only managers can export." : "The export needs signal. Try again with signal."; }
};

if ("serviceWorker" in navigator) navigator.serviceWorker.register("../sw.js", { scope: "../", updateViaCache: "none" }).then(r => r.update()).catch(() => {});
render();
