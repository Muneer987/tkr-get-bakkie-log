"use strict";
const loadLib = src => new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)?.dataset.ok) return res(); const s = document.createElement("script"); s.src = src; s.onload = () => { s.dataset.ok = 1; res(); }; s.onerror = rej; document.head.appendChild(s); });
/* TKR GET Bakkie Log — offline app. Everything is saved on this device (IndexedDB).
   Excel export makes the sum-up; the backup file moves the records to a new device. */

const ITEMS = ["140 mm bits", "102 mm bits", "Rods", "Starter rods", "Shanks", "Other"];
const RIGS = ["TDR 013", "TDR 015", "TDR 014"];
const TYPES = {
  received: { label: "Taken from the store", cls: "in", rig: false },
  fitted:   { label: "Put on rig", cls: "out", rig: true },
  returned: { label: "Old item back from rig", cls: "in", rig: true },
  back:     { label: "Taken back to the store", cls: "out", rig: false },
  lost:     { label: "Lost in hole", cls: "lost", rig: true },
  extra:    { label: "Extra", cls: "in", rig: false },
};
const PICK = ["received", "fitted", "back", "lost"];          // what the driver chooses from ("returned" stays for older records)
const GET_ITEMS = ITEMS.filter(i => i !== "Other");          // anything else goes in Extras
const TYPE_SHORT = { received: "📦 Took from the store", fitted: "🔧 Put on a rig", back: "↩️ Took back to the store", lost: "❌ Lost in the hole" };
let pick = { type: "received", item: GET_ITEMS[0], rig: RIGS[0] };   // the big buttons on the Add card
let addMode = "get";

const $ = (s, el = document) => el.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad = n => String(n).padStart(2, "0");
const isoDate = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const nowHM = () => { const d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
const fmtDate = s => { if (!s) return ""; const [y, m, d] = s.split("-"); return d + "/" + m + "/" + y; };
const dayName = s => s ? new Date(s + "T12:00").toLocaleDateString("en-ZA", { weekday: "long" }) : "";
const shiftKey = s => (s.date || "") + (s.shift === "Night" ? "2" : "1");
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- storage on the device ---------- */
const store = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("tkr-get-bakkie-log", 3);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("shifts")) db.createObjectStore("shifts", { keyPath: "id" });
        if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "id" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "id" });
      };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(name, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(name, mode), os = t.objectStore(name);
      const out = fn(os);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx("shifts", "readonly", os => os.getAll()); },
  put(s) { if (typeof markShift === "function") markShift(s.id); return this.tx("shifts", "readwrite", os => os.put(s)); },
  del(id) { return this.tx("shifts", "readwrite", os => os.delete(id)); },
  photo(id) { return this.tx("photos", "readonly", os => os.get(id)); },
  putPhoto(p) { if (typeof markPhoto === "function") markPhoto(p.id); return this.tx("photos", "readwrite", os => os.put(p)); },
  getMeta(id) { return this.tx("meta", "readonly", os => os.get(id)); },
  putMeta(m) { return this.tx("meta", "readwrite", os => os.put(m)); },
  delPhoto(id) { return this.tx("photos", "readwrite", os => os.delete(id)); },
};

/* ---------- photos: optional, shrunk to about 200 KB each so the tablet does not fill up ---------- */
let draftPhotos = []; // photos taken in the add-movement form, not yet saved
const photoURLs = new Map();
async function shrinkPhoto(file) {
  const bmp = await createImageBitmap(file);
  const max = 1600, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  return new Promise(res => c.toBlob(res, "image/jpeg", 0.75));
}
async function photoURL(id) {
  if (photoURLs.has(id)) return photoURLs.get(id);
  const p = await store.photo(id); if (!p) return "";
  const u = URL.createObjectURL(p.blob); photoURLs.set(id, u); return u;
}
async function fillThumbs() {
  for (const img of app.querySelectorAll("img[data-photo]")) { const u = await photoURL(img.dataset.photo); if (u) img.src = u; else img.remove(); }
  for (const img of app.querySelectorAll("img[data-draft]")) img.src = draftPhotos[+img.dataset.draft]?.url || "";
}
async function deletePhotos(ids) { for (const id of ids || []) { await store.delPhoto(id); const u = photoURLs.get(id); if (u) URL.revokeObjectURL(u); photoURLs.delete(id); } }
const safe = s => String(s || "").replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-|-$/g, "");
function photoNames(s, m) {
  return (m.photos || []).map((id, n) => `${s.date}_${s.shift}_${(m.time || "").replace(":", "h")}_${safe(TYPES[m.type]?.label || m.type)}_${safe(m.item)}${m.itemNo ? "_" + safe(m.itemNo) : ""}_${n + 1}.jpg`);
}
const signNames = s => (s.signPhotos || []).map((id, n) => `${s.date}_${s.shift}_Signed-sheet_${n + 1}.jpg`);
const allPhotos = s => [...(s.moves || []).flatMap(m => m.photos || []), ...(s.signPhotos || [])];
function blobToDataURL(b) { return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); }); }
async function dataURLToBlob(u) { return (await fetch(u)).blob(); }

let shifts = [], current = null, view = "shifts", statusMsg = "", saveTimer = null;
const monthStart = new Date(); monthStart.setDate(1);
let range = { from: isoDate(monthStart), to: isoDate(new Date()) };
const app = $("#app");

function balance(s) {
  const out = {};
  ITEMS.forEach(i => out[i] = { start: Number(s.start?.[i]?.qty) || 0, received: 0, fitted: 0, returned: 0, back: 0, lost: 0 });
  (s.moves || []).forEach(m => { const b = out[m.item]; if (b && m.type in b) b[m.type] += Number(m.qty) || 0; });
  ITEMS.forEach(i => { const b = out[i]; b.end = b.start + b.received - b.fitted + b.returned - b.back; });
  return out;
}
const sorted = list => list.slice().sort((a, b) => shiftKey(b).localeCompare(shiftKey(a)) || (b.createdAt || 0) - (a.createdAt || 0));
const inRange = () => sorted(shifts.filter(s => (!range.from || s.date >= range.from) && (!range.to || s.date <= range.to)));

/* New shift: date and Day/Night from the clock (after midnight still counts as the night before).
   Shift change: last shift's bakkie end balance and rig counts carry over as the new start. */
function newShift() {
  const now = new Date(), h = now.getHours(), night = h >= 18 || h < 6;
  const d = new Date(now); if (h < 6) d.setDate(d.getDate() - 1);
  const prev = sorted(shifts)[0], pb = prev ? balance(prev) : null;
  const start = {}, rigs = {};
  ITEMS.forEach(i => start[i] = { qty: pb && pb[i].end ? String(pb[i].end) : "", time: "", nos: prev?.start?.[i]?.nos || "" });
  RIGS.forEach(r => rigs[r] = prev?.rigs?.[r] ? { ...prev.rigs[r], time: "" } : { bits: "", bitNo: "", rods: "", shanks: "", shankNo: "", time: "" });
  return { id: newId(), date: isoDate(d), shift: night ? "Night" : "Day", operator: opNow?.name || prev?.operator || "", bakkie: prev?.bakkie || "", supervisor: "",
    timeOut: nowHM(), timeBack: "", trips: [{ id: newId(), out: nowHM(), back: "" }], start, moves: [], rigs, comments: "",
    handover: { fromLabel: prev ? fmtDate(prev.date) + " " + prev.shift : "", handedBy: prev?.operator || "", takenBy: "", time: nowHM(), checked: "", notes: "" },
    signOperator: "", signSupervisor: "", signStore: "", signPhotos: [], closed: false, createdAt: Date.now() };
}

/* ---------- trips: each run to the store in a shift. Shift time out = first trip out, time back = last trip back ---------- */
function tripsOf(s) {
  if (!Array.isArray(s.trips)) s.trips = (s.timeOut || s.timeBack) ? [{ id: "t1", out: s.timeOut || "", back: s.timeBack || "" }] : [];
  return s.trips;
}
const tripNo = (s, id) => { const i = tripsOf(s).findIndex(t => t.id === id); return i < 0 ? "" : i + 1; };
function syncTimes(s) { const t = tripsOf(s); s.timeOut = t[0]?.out || ""; s.timeBack = t.length ? (t.at(-1).back || "") : ""; }

/* ---------- clear after export: keeps the latest shift (for the shift-change carry-over) and any open shift ---------- */
let lastExport = null;
function clearable() {
  if (waiting()) return [];
  if (!lastExport) return [];
  const keep = sorted(shifts)[0]?.id;
  return shifts.filter(s => lastExport.ids.includes(s.id) && s.id !== keep && s.closed);
}
/* closed shifts older than a few days can be cleared from the tablet without an export, once they are safely in Firebase */
const OLD_DAYS = 3;
function oldClearable() {
  if (waiting()) return [];
  const keep = sorted(shifts)[0]?.id, d = new Date(); d.setDate(d.getDate() - OLD_DAYS);
  const cut = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return shifts.filter(s => s.closed && s.id !== keep && (s.date || "") < cut);
}
function oldCard() {
  const list = oldClearable(); if (!list.length) return "";
  return `<div class="info">${list.length} closed shift${list.length === 1 ? " is" : "s are"} older than ${OLD_DAYS} days and already sent to Firebase. You can clear ${list.length === 1 ? "it" : "them"} from this tablet; admin still has ${list.length === 1 ? "it" : "them"} for the export.
    <div class="row" style="margin-top:10px"><button class="danger" id="clearOld">Clear old shifts</button></div></div>`;
}
async function clearOld() {
  if (waiting()) { await syncNow?.(); }
  if (waiting()) { alert("Some shifts are still sending, so nothing is cleared yet. Try again when there is signal."); return; }
  const list = oldClearable(); if (!list.length) { render(); return; }
  const nPh = list.reduce((n, s) => n + allPhotos(s).length, 0);
  if (!confirm(`Clear ${list.length} old shift${list.length === 1 ? "" : "s"}${nPh ? ` and ${nPh} photo${nPh === 1 ? "" : "s"}` : ""} from this tablet? They stay in Firebase.`)) return;
  for (const s of list) { await store.del(s.id); await deletePhotos(allPhotos(s)); }
  const gone = new Set(list.map(s => s.id)); shifts = shifts.filter(s => !gone.has(s.id));
  render(); setStatus?.(`${list.length} old shift${list.length === 1 ? "" : "s"} cleared from this tablet`);
}
function clearCard() {
  if (!lastExport) return "";
  const list = clearable();
  if (!list.length) return `<div class="info">Export done. There are no closed shifts to clear. The latest shift and open shifts always stay on the tablet.</div>`;
  return `<div class="info"><b>Export done.</b> Check that the file arrived on WhatsApp or email, then you can clear these ${list.length} closed shift${list.length === 1 ? "" : "s"} (${fmtDate(lastExport.from)} to ${fmtDate(lastExport.to)}) from this tablet.
    The latest shift and open shifts stay.${lastExport.photos || !list.some(s => allPhotos(s).length) ? "" :" <b>You exported Excel only, so clearing also deletes the photos of these shifts.</b>"}
    <div class="row" style="margin-top:10px"><button class="danger" id="clearExported">Clear these shifts</button><button class="ghost" id="keepExported">Keep them</button></div></div>`;
}

/* ---------- home ---------- */
function render() {
  if (current) {
    const keep = {}; app.querySelectorAll("#moveForm [id]").forEach(el => { if ("value" in el && el.type !== "hidden") keep[el.id] = el.value; });
    renderShift();
    Object.entries(keep).forEach(([id, v]) => { const el = document.getElementById(id); if (el && el.closest("#moveForm") && !el.disabled) el.value = v; });
    toggleRig(); fillThumbs(); return;
  }
  const tab = (k, t) => `<button role="tab" aria-selected="${view === k}" data-view="${k}">${t}</button>`;
  const dates = `<label style="flex:1 1 150px">From <input type="date" id="fFrom" value="${range.from}"></label>
      <label style="flex:1 1 150px">To <input type="date" id="fTo" value="${range.to}"></label>`;
  let body = "";
  if (view === "shifts") body = `<div class="row" style="margin-bottom:14px;align-items:flex-end">${dates}
      <button class="primary" id="newShift" style="flex:1 1 220px">Start shift / shift change</button></div>` + oldCard() + shiftList(inRange());
  else if (view === "log") body = `<div class="row" style="margin-bottom:14px;align-items:flex-end">${dates}
      ${canExport() ? `<button class="primary" id="xlsx" style="flex:1 1 200px">Combined report – all GET operators (Excel, photos zipped)</button>` : ""}</div>` + syncLine() + exportGate() + clearCard() + logTable(inRange());
  else body = backupView();
  app.innerHTML = `<div class="tabs" role="tablist">${tab("shifts", "Shifts")}${tab("log", "Movement log")}${tab("backup", "Backup")}</div>${body}`;
}

function shiftList(list) {
  if (!shifts.length) return `<div class="card empty"><b>No shifts logged yet</b>Tap “Start shift / shift change” when you load the bakkie. Every movement, rig count and sign-off for that shift goes on one log.</div>`;
  if (!list.length) return `<div class="card empty"><b>No shifts in these dates</b>Change the From and To dates to see other shifts.</div>`;
  let html = "", lastDate = "";
  list.forEach(s => {
    const n = (s.moves || []).length;
    if (s.date !== lastDate) { if (lastDate) html += `</div>`; html += `<div class="datehead">${esc(dayName(s.date))} ${esc(fmtDate(s.date))}</div><div class="shifts">`; lastDate = s.date; }
    html += `<button class="shift card" data-open="${esc(s.id)}">
      <span><b>${esc(s.shift)} shift</b><br><span class="muted">${esc(s.operator || "No operator yet")}${s.bakkie ? " · " + esc(s.bakkie) : ""} · ${tripsOf(s).length} trip${tripsOf(s).length === 1 ? "" : "s"} · ${n} movement${n === 1 ? "" : "s"}${s.timeOut ? " · out " + esc(s.timeOut) : ""}${s.timeBack ? " – back " + esc(s.timeBack) : ""}</span></span>
      <span class="pill ${s.closed ? "closed" : "open"}">${s.closed ? "Closed" : "Open"}</span></button>`;
  });
  return html + `</div>`;
}

function logRows(list) {
  const rows = [];
  list.slice().reverse().forEach(s => (s.moves || []).slice().sort((a, b) => (a.time || "").localeCompare(b.time || "")).forEach(m => rows.push({ s, m })));
  return rows;
}
function logTable(list) {
  const rows = logRows(list);
  if (!rows.length) return `<div class="card empty"><b>No movements in these dates</b>Every item that goes on or off the bakkie shows here, shift by shift.</div>`;
  const sum = {}; rows.forEach(({ m }) => { sum[m.type] = (sum[m.type] || 0) + (Number(m.qty) || 0); });
  return `<div class="card" style="padding:12px 16px"><div class="row" style="gap:18px">${Object.entries(TYPES).map(([k, t]) => `<span><span class="muted">${t.label}</span> <b class="num">${sum[k] || 0}</b></span>`).join("")}</div></div>
  <div class="card wide"><div class="tbl"><table>
    <thead><tr><th>Date</th><th>Shift</th><th>Trip</th><th>Time</th><th>On board</th><th>Movement</th><th>Rig</th><th>Item</th><th class="num">Qty</th><th>Item no.</th><th>Old no. back</th><th>Block / hole</th><th>Received by</th><th>Comment</th><th>Operator</th><th class="num">Photos</th></tr></thead>
    <tbody>${rows.map(({ s, m }) => `<tr><td>${esc(fmtDate(s.date))}</td><td>${esc(s.shift)}</td><td class="num">${tripNo(s, m.trip)}</td><td class="num">${esc(m.time)}</td><td class="num">${esc(m.onBoard)}</td>
      <td class="${m.type === "lost" ? "flag" : ""}">${esc(TYPES[m.type]?.label || m.type)}</td><td>${esc(m.rig)}</td><td>${esc(m.item)}</td><td class="num">${esc(m.qty)}</td>
      <td>${esc(m.itemNo)}</td><td>${esc(m.oldNo)}</td><td>${esc(m.block)}</td><td>${esc(m.by)}</td><td>${esc(m.note)}</td><td>${esc(s.operator)}</td><td class="num">${(m.photos || []).length || ""}</td></tr>`).join("")}</tbody></table></div></div>`;
}

function backupView() {
  const last = localGet("lastBackup");
  return `<div class="card">
      <h2>Backup</h2>
      <p style="margin-top:0">The records are saved on this device only. Make a backup at least once a week and send it on WhatsApp or email. If this device is lost or replaced, open the app on the new device and restore the backup file.</p>
      <p class="muted">${shifts.length} shift${shifts.length === 1 ? "" : "s"} on this device. ${last ? "Last backup: " + esc(last) + "." : "No backup made yet on this device."}</p>
      ${canExport() ? "" : `<p class="muted">Making a backup file needs admin. Ask admin in Movement log.</p>`}
      <div class="row"><button class="primary" id="backup" ${canExport() ? "" : "disabled"}>Make backup file</button>
      <label class="row" style="flex-direction:row"><span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400"></span>
        <button id="restoreBtn" type="button">Restore from backup file</button><input type="file" id="restoreFile" accept=".json,application/json" hidden></label></div>
      <div id="backupMsg" class="muted" style="margin-top:10px"></div>
    </div>`;
}
function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

/* ---------- one shift ---------- */
function field(path, value, attrs = "") { return `<input data-f="${path}" value="${esc(value)}" ${attrs} ${current.closed ? "disabled" : ""}>`; }

function renderShift() {
  const s = current, ro = s.closed, bal = balance(s), off = ro ? "disabled" : "", ho = s.handover || {};
  const startRows = ITEMS.filter(i => i !== "Other" || bal[i].start || bal[i].received || bal[i].fitted || bal[i].back).map(i => {
    const b = bal[i];
    return `<tr><td><b>${i}</b></td><td class="num">${b.start}</td><td class="num">${b.received}</td><td class="num">${b.fitted}</td><td class="num">${b.back}</td><td class="num">${b.lost}</td><td class="num end ${b.end < 0 ? "flag" : ""}">${b.end}</td></tr>`;
  }).join("");
  const short = ITEMS.some(i => bal[i].end < 0);
  const moves = (s.moves || []).slice().sort((a, b) => (a.time || "").localeCompare(b.time || "")).map(m => {
    const t = TYPES[m.type] || TYPES.received;
    const tn = tripNo(s, m.trip);
    if (m.type === "extra") return `<div class="move in"><span class="t">${esc(m.time)}</span>
      <span class="what"><b>Extra: ${m.qty ? esc(m.qty) + " × " : ""}${esc(m.item)}</b><span class="muted">${tn ? "Trip " + tn : ""}</span>${m.note ? `<span class="muted" style="display:block;font-style:italic">Comment: ${esc(m.note)}</span>` : ""}
        ${(m.photos || []).length || !ro ? `<span class="thumbs">${(m.photos || []).map(id => `<img class="thumb" data-photo="${esc(id)}" data-move="${esc(m.id)}" alt="Photo">`).join("")}${ro ? "" : `<button class="ghost addph" data-addphoto="${esc(m.id)}">+ Photo</button>`}</span>` : ""}</span>
      ${ro ? "" : `<button class="ghost" data-del="${esc(m.id)}">Remove</button>`}</div>`;
    const detail = [tn && "Trip " + tn, m.onBoard && "on board " + m.onBoard, m.itemNo && "No. " + m.itemNo, m.oldNo && "old " + m.oldNo + " back", m.block && "block/hole " + m.block, m.by && "received by " + m.by].filter(Boolean).join(" · ");
    const note = m.note ? `<span class="muted" style="display:block;font-style:italic">Comment: ${esc(m.note)}</span>` : "";
    const thumbs = (m.photos || []).map(id => `<img class="thumb" data-photo="${esc(id)}" data-move="${esc(m.id)}" alt="Photo">`).join("");
    return `<div class="move ${t.cls}"><span class="t">${esc(m.time)}</span>
      <span class="what"><b>${esc(m.qty)} × ${esc(m.item)} – ${esc(t.label)}${t.rig && m.rig ? " – " + esc(m.rig) : ""}</b><span class="muted">${esc(detail)}</span>${note}
        ${thumbs || !ro ? `<span class="thumbs">${thumbs}${ro ? "" : `<button class="ghost addph" data-addphoto="${esc(m.id)}">+ Photo</button>`}</span>` : ""}</span>
      ${ro ? "" : `<button class="ghost" data-del="${esc(m.id)}">Remove</button>`}</div>`;
  }).join("") || `<div class="muted">Nothing yet. Add a line every time GET goes on or off the bakkie, or for any extra.</div>`;
  const rigRows = RIGS.map(r => {
    const g = s.rigs?.[r] || {};
    return `<tr><td><b>${r}</b></td>
      <td>${field(`rigs.${r}.bits`, g.bits, 'inputmode="numeric" aria-label="Bits on rig"')}</td>
      <td>${field(`rigs.${r}.rods`, g.rods, 'inputmode="numeric" aria-label="Rods on rig"')}</td>
      <td>${field(`rigs.${r}.shanks`, g.shanks, 'inputmode="numeric" aria-label="Shanks on rig"')}</td></tr>`;
  }).join("");
  const lost = (s.moves || []).filter(m => m.type === "lost");
  const trips = tripsOf(s);
  const tripRows = trips.map((tr, i) => {
    const mv = (s.moves || []).filter(m => m.trip === tr.id);
    const loaded = mv.filter(m => m.type === "received").reduce((n, m) => n + (Number(m.qty) || 0), 0);
    return `<tr><td><b>Trip ${i + 1}</b></td>
      <td>${field(`trips.${i}.out`, tr.out, 'type="time" aria-label="Time out of store"')}</td>
      <td>${field(`trips.${i}.back`, tr.back, 'type="time" aria-label="Time back at store"')}</td>
      <td>${ro ? "" : (!tr.back ? `<button data-tripback="${i}">Back now</button>` : "") + (!mv.length && trips.length > 1 ? ` <button class="ghost" data-tripdel="${i}">Remove</button>` : "")}</td></tr>`;
  }).join("");
  app.innerHTML = `
    <div class="sticky row" style="justify-content:space-between">
      <button class="ghost" id="back">← All shifts</button>
      <span class="status" id="status">${esc(statusMsg)}</span>
    </div>
    ${ro ? "" : `<div class="how"><b>How it works</b><ol><li><b>Start:</b> type your name and the bakkie number.</li><li><b>During the shift:</b> every time GET goes onto or off the bakkie, tap what happened, the item and how many, then tap <b>Save</b>.</li><li><b>End:</b> fill in what is on each rig, sign and tap <b>Close shift</b>.</li></ol></div>`}
    <section class="card">
      <h2><span class="bign">1</span>Start of shift · ${esc(dayName(s.date))} ${esc(fmtDate(s.date))} · ${esc(s.shift)} <span class="pill ${s.closed ? "closed" : "open"}">${s.closed ? "Closed" : "Open"}</span></h2>
      <div class="grid">
        <label>Date ${field("date", s.date, 'type="date"')}</label>
        <label>Shift <select data-f="shift" ${off}>${["Day", "Night"].map(x => `<option ${s.shift === x ? "selected" : ""}>${x}</option>`).join("")}</select></label>
        <label>GET operator ${field("operator", s.operator, 'placeholder="Name"')}</label>
        <label>Bakkie no. ${field("bakkie", s.bakkie, 'placeholder="Bakkie no."')}</label>
      </div>
    </section>

    <div class="cols">
      <section class="card">
        <h2><span class="bign">2</span>During the shift: log a move</h2>
        <div class="row" role="tablist" style="gap:8px;margin-bottom:12px">
          <button type="button" class="${addMode === "get" ? "primary" : "ghost"}" data-mode="get" ${off}>Bits, rods, shanks</button>
          <button type="button" class="${addMode === "extra" ? "primary" : "ghost"}" data-mode="extra" ${off}>Something else</button>
        </div>
        <form id="moveForm" class="grid" autocomplete="off">
          ${trips.length === 1 ? `<input type="hidden" id="mTrip" value="${esc(trips[0].id)}">` : ""}${trips.length > 1 ? `<label>Trip <select id="mTrip" ${off}>${trips.map((tr, i) => `<option value="${esc(tr.id)}" ${i === trips.length - 1 ? "selected" : ""}>Trip ${i + 1}</option>`).join("")}</select></label>` : ""}
          ${addMode === "get" ? `
          <input type="hidden" id="mType" value="${esc(pick.type)}"><input type="hidden" id="mItem" value="${esc(pick.item)}"><input type="hidden" id="mRig" value="${esc(pick.rig)}">
          <div class="step" style="grid-column:1/-1">What happened?</div>
          <div class="tiles4" style="grid-column:1/-1">${PICK.map(k => `<button type="button" class="tile4 ${TYPES[k].cls}" data-pk="type:${k}" aria-pressed="${pick.type === k}" ${off}>${TYPE_SHORT[k]}</button>`).join("")}</div>
          ${TYPES[pick.type].rig ? `<div class="step" style="grid-column:1/-1">Which rig?</div>
          <div class="tiles4" style="grid-column:1/-1">${RIGS.map(r => `<button type="button" class="tile4" data-pk="rig:${esc(r)}" aria-pressed="${pick.rig === r}" ${off}>${esc(r)}</button>`).join("")}</div>` : ""}
          <div class="step" style="grid-column:1/-1">Which item?</div>
          <div class="tiles4" style="grid-column:1/-1">${GET_ITEMS.map(i => `<button type="button" class="tile4" data-pk="item:${esc(i)}" aria-pressed="${pick.item === i}" ${off}>${esc(i)}</button>`).join("")}</div>
          <div class="step" style="grid-column:1/-1">How many?</div>
          <div class="qtyrow" style="grid-column:1/-1"><button type="button" data-qty="-1" aria-label="One less" ${off}>−</button><input id="mQty" inputmode="numeric" value="1" aria-label="Quantity" ${off}><button type="button" data-qty="1" aria-label="One more" ${off}>+</button></div>` : `
          <label style="grid-column:1/-1">What is it <input id="mWhat" placeholder="For example 20 L hydraulic oil, hose, grease" ${off}></label>
          <label>Qty (optional) <input id="mQty" inputmode="numeric" ${off}></label>`}
          <details class="more" style="grid-column:1/-1" ${addMode === "extra" ? "open" : ""}><summary>Time, comment or photo (optional)</summary>
          <div class="grid" style="margin-top:10px">
          <label>Time <input id="mTime" type="time" value="${nowHM()}" ${off}></label>
          <label style="grid-column:1/-1">Comment <textarea id="mNote" rows="2" placeholder="Type anything" ${off}></textarea></label>
          <div style="grid-column:1/-1">
            <span class="muted">Photo</span>
            <div class="thumbs" style="margin-top:6px">${draftPhotos.map((p, i) => `<img class="thumb" data-draft="${i}" alt="New photo">`).join("")}
              <button type="button" class="ghost addph" id="takePhoto" ${off}>Take photo</button></div>
          </div></div></details>
          <div style="grid-column:1/-1"><button class="primary savebig" type="submit" style="width:100%" ${off}>${"Save"}${draftPhotos.length ? ` with ${draftPhotos.length} photo${draftPhotos.length === 1 ? "" : "s"}` : ""}</button></div>
        </form>
        <div id="moveErr" class="flag" style="margin-top:8px"></div>
      </section>
      <section class="card">
        <h2>In the bakkie now</h2>
        <div class="nowtiles">${GET_ITEMS.filter(i => ["140 mm bits", "Rods", "Shanks"].includes(i) || bal[i].start || bal[i].received || bal[i].fitted || bal[i].back || bal[i].lost).map(i => `<div class="nowt ${bal[i].end < 0 ? "neg" : ""}"><span>${esc(i)}</span><b>${bal[i].end}</b></div>`).join("")}</div>
        <p class="muted" style="margin:6px 0 0">The app works this out from what you save. You don't type it.</p>${short ? `<p class="flag" style="margin:6px 0 0">Below 0: more was fitted or taken back than came from the store. Check that everything from the store is saved.</p>` : ""}
        <details class="more" style="margin-top:10px"><summary>See how it is worked out</summary><div style="margin-top:10px">
      <div class="tbl mini"><table>
          <thead><tr><th>Item</th><th class="num">Start</th><th class="num">Store</th><th class="num">Fitted</th><th class="num">Back</th><th class="num">Lost</th><th class="num">Now</th></tr></thead>
          <tbody>${startRows}</tbody></table></div>
        <p class="muted" style="margin:8px 0 0">Start = left after the last shift. Store = from the store. Now = what should be in the bakkie. The app works it out from what you log.</p>${short ? `<p class="flag" style="margin:6px 0 0">Below 0 means more was fitted or sent back than came from the store. Check that everything from the store is logged.</p>` : ""}
      </div></details>
        <details class="more" style="margin-top:10px"><summary>Trips to the store${trips.length > 1 ? " (" + trips.length + ")" : ""}</summary><div style="margin-top:10px">
      ${trips.length ? `<div class="tbl mini"><table>
        <thead><tr><th>Trip</th><th>Out</th><th>Back</th><th></th></tr></thead>
        <tbody>${tripRows}</tbody></table></div>` : ""}
      <div class="row" style="margin-top:10px;justify-content:space-between">
        <span class="muted">Every time the bakkie goes to the store, start a new trip.</span>
        ${ro ? "" : `<button class="primary" id="newTrip">Start a new trip</button>`}
      </div>
    </div></details>
      </section>
      <section class="card">
        <h2>Saved this shift</h2>
        <div class="moves">${moves}</div>

      </section>
    </div>

    <section class="card">
      <h2><span class="bign">3</span>End of shift</h2>
      <h3 style="margin-top:4px">What is on each rig now</h3>
      <div class="tbl"><table>
        <thead><tr><th>Rig</th><th>Bits</th><th>Rods</th><th>Shanks</th></tr></thead>
        <tbody>${rigRows}</tbody></table></div>
      <h3>Sign</h3>
      <label style="margin-bottom:12px">Comments <textarea data-f="comments" rows="2" ${off}>${esc(s.comments)}</textarea></label>
      <div class="grid">
        <label>GET operator ${field("signOperator", s.signOperator, 'placeholder="Full name"')}</label>
        <label>Shift supervisor ${field("signSupervisor", s.signSupervisor, 'placeholder="Full name"')}</label>
        <label>Store controller (items back) ${field("signStore", s.signStore, 'placeholder="Full name"')}</label>
      </div>
      <div style="margin-top:12px">
        <span class="muted">Photo of anything signed (optional), for example the signed shift sheet or delivery note</span>
        <div class="thumbs" style="margin-top:6px">${(s.signPhotos || []).map(id => `<img class="thumb" data-photo="${esc(id)}" data-move="sign" alt="Signed sheet">`).join("")}
          ${ro ? "" : `<button type="button" class="ghost addph" data-addphoto="sign">+ Photo</button>`}</div>
      </div>
      <div class="row" style="margin-top:12px;justify-content:space-between">
        ${s.closed ? `<span></span><button id="reopen">Reopen shift</button>` : `<button class="danger" id="delShift">Delete shift</button><button class="primary" id="close">Close shift</button>`}
      </div>
      <div id="closeMsg" class="flag" style="margin-top:6px"></div>
    </section>`;
  toggleRig();
}

function toggleRig() { const t = $("#mType"), w = $("#rigWrap"); if (t && w) w.hidden = !TYPES[t.value].rig; }
function setStatus(m) { statusMsg = m; const el = $("#status"); if (el) el.textContent = m; }

/* ---------- saving ---------- */
async function save(msg = "Saved " + nowHM()) {
  clearTimeout(saveTimer);
  syncTimes(current);
  const i = shifts.findIndex(x => x.id === current.id);
  if (i >= 0) shifts[i] = current; else shifts.push(current);
  try { await store.put(structuredClone(current)); setStatus(msg); }
  catch { setStatus("Not saved. The device storage may be full."); }
}
function editField(path, val) {
  const parts = path.split("."); let o = current;
  for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] || {}; o = o[parts[i]]; }
  o[parts.at(-1)] = val;
  setStatus("Saving…"); clearTimeout(saveTimer); saveTimer = setTimeout(() => save(), 400);
}

/* ---------- Excel export ---------- */
/* ---------- branded Excel export (TKR black and gold, logo, photos inside the file) ---------- */
const XC = { BLACK: "FF111111", HEAD: "FF262626", GOLD: "FFD4A12A", CREAM: "FFFFF8E6", WHITE: "FFFFFFFF", GRID: "FFD9D3C5", MUTED: "FF6B6558" };
const MOVE_FILL = { received: "FFDDF1E3", fitted: "FFFFF2CC", returned: "FFDDF1E3", back: "FFEFEDE7", lost: "FFF8DDD8" };
async function buildBrandedGET(list, who, photoBlob = async id => (await store.photo(id))?.blob) {
  const ExcelJS = window.ExcelJS, wb = new ExcelJS.Workbook(); wb.creator = "TKR Operations"; wb.created = new Date();
  const rows = logRows(list), chron = list.slice().reverse(), period = `${fmtDate(range.from)} to ${fmtDate(range.to)}`;
  let logo = null; try { logo = wb.addImage({ buffer: await (await fetch("../icons/icon-512.png")).arrayBuffer(), extension: "png" }); } catch {}
  const thin = { style: "thin", color: { argb: XC.GRID } }, box = { top: thin, left: thin, bottom: thin, right: thin };
  const fill = c => ({ type: "pattern", pattern: "solid", fgColor: { argb: c } });
  const sheet = (name, widths, title) => {
    const ws = wb.addWorksheet(name, { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
    ws.columns = widths.map(w => ({ width: w }));
    const cols = Math.max(widths.length, 6);
    for (let r = 1; r <= 4; r++) { ws.getRow(r).height = r === 1 ? 8 : 22; for (let c = 1; c <= cols; c++) ws.getCell(r, c).fill = fill(XC.BLACK); }
    for (let c = 1; c <= cols; c++) ws.getCell(5, c).fill = fill(XC.GOLD); ws.getRow(5).height = 4;
    if (logo !== null) ws.addImage(logo, { tl: { col: 0.15, row: 1.05 }, ext: { width: 62, height: 62 } });
    Object.assign(ws.getCell("B2"), { value: title }); ws.getCell("B2").font = { name: "Arial", size: 18, bold: true, color: { argb: XC.WHITE } };
    ws.getCell("B3").value = "TKR OPERATIONS  ·  DRILL STORES  ·  THARISA MINE"; ws.getCell("B3").font = { name: "Arial", size: 9, bold: true, color: { argb: XC.GOLD } };
    ws.getCell("B4").value = `Period: ${period}`; ws.getCell("B4").font = { name: "Arial", size: 10, color: { argb: "FFE8E2D4" } };
    ws.views = [{ showGridLines: false }];
    return ws;
  };
  const header = (ws, rowNo, labels) => {
    const row = ws.getRow(rowNo); row.height = 30;
    labels.forEach((l, i) => { const c = row.getCell(i + 1); c.value = l; c.font = { name: "Arial", size: 10, bold: true, color: { argb: XC.WHITE } }; c.fill = fill(XC.HEAD); c.border = box; c.alignment = { vertical: "middle", horizontal: i ? "center" : "left", wrapText: true }; });
  };
  const line = (ws, rowNo, values, i, opts = {}) => {
    const row = ws.getRow(rowNo); row.values = values; row.height = opts.h || 20;
    for (let c = 1; c <= values.length; c++) { const cell = row.getCell(c); cell.border = box; cell.font = { name: "Arial", size: 10, bold: !!opts.bold };
      cell.alignment = { vertical: "middle", wrapText: true, horizontal: typeof values[c - 1] === "number" ? "center" : "left" }; if (i % 2) cell.fill = fill(XC.CREAM); }
    return row;
  };
  const title = (ws, rowNo, text) => { const c = ws.getCell(rowNo, 1); c.value = text; c.font = { name: "Arial", size: 12, bold: true, color: { argb: XC.BLACK } }; ws.getRow(rowNo).height = 22; };
  const freeze = (ws, y) => { ws.views = [{ state: "frozen", ySplit: y, showGridLines: false }]; };
  const nPhotos = list.reduce((n, x) => n + allPhotos(x).length, 0);

  // Sum up
  const t = {}; ITEMS.forEach(i => t[i] = { received: 0, fitted: 0, returned: 0, back: 0, lost: 0 });
  const perRig = {}; RIGS.forEach(r => { perRig[r] = {}; ITEMS.forEach(i => perRig[r][i] = 0); });
  rows.forEach(({ m }) => { if (t[m.item]) t[m.item][m.type] += Number(m.qty) || 0; if (m.type === "fitted" && perRig[m.rig]) perRig[m.rig][m.item] += Number(m.qty) || 0; });
  const lastShift = list[0];
  // In the bakkies now: each operator's latest shift added together (list is newest first)
  const seen = new Set(), lb = {}; ITEMS.forEach(i => lb[i] = { end: 0 });
  list.forEach(x => { const who = x.ownerUid || x.operator || "one"; if (seen.has(who)) return; seen.add(who); const b = balance(x); ITEMS.forEach(i => lb[i].end += b[i].end); });
  const ws1 = sheet("Sum up", [26, 16, 14, 16, 16, 13, 18], "GET Bakkie Log – Sum up");
  [["Shifts logged", list.length], ["Movements logged", rows.length], ["Photos", nPhotos]].forEach(([k, v], i) => {
    const c = ws1.getCell(7, 1 + i * 2), d = ws1.getCell(8, 1 + i * 2);
    c.value = k; c.font = { name: "Arial", size: 9, bold: true, color: { argb: XC.MUTED } };
    d.value = v; d.font = { name: "Arial", size: 20, bold: true, color: { argb: XC.BLACK } };
  });
  ws1.getRow(8).height = 28;
  header(ws1, 10, ["Item", "Received from store", "Fitted on rigs", "Old items back", "Handed back to store", "Lost in hole", "In the bakkies now"]);
  ITEMS.forEach((i, n) => line(ws1, 11 + n, [i, t[i].received, t[i].fitted, t[i].returned, t[i].back, t[i].lost, lb[i].end], n));
  let r = 11 + ITEMS.length + 1;
  title(ws1, r++, "Fitted per rig");
  header(ws1, r++, ["Rig", ...ITEMS]);
  RIGS.forEach((g, n) => line(ws1, r++, [g, ...ITEMS.map(i => perRig[g][i])], n));
  if (lastShift) {
    r++; title(ws1, r++, `On each rig at end of last shift (${fmtDate(lastShift.date)} ${lastShift.shift})`);
    header(ws1, r++, ["Rig", "Bits", "Bit no.", "Rods", "Shanks", "Shank no."]);
    RIGS.forEach((g, n) => { const x = lastShift.rigs?.[g] || {}; line(ws1, r++, [g, num(x.bits), x.bitNo || "", num(x.rods), num(x.shanks), x.shankNo || ""], n); });
  }
  r++; const note = ws1.getCell(r, 1); note.value = `Exported ${new Date().toLocaleString("en-ZA")}${who ? " · " + who : ""}`; note.font = { name: "Arial", size: 9, italic: true, color: { argb: XC.MUTED } };

  // Movements with photo thumbnails
  const ws2 = sheet("Movements", [11, 8, 6, 8, 9, 22, 10, 14, 6, 12, 13, 13, 16, 30, 18, 14, 14, 14, 14], "GET Bakkie Log – Movements");
  header(ws2, 7, ["Date", "Shift", "Trip", "Time", "On board", "Movement", "Rig", "Item", "Qty", "Item no.", "Old no. back", "Block / hole", "Received by", "Comment", "Logged by", "GET operator", "Photo", "Photo", "Photo"]);
  r = 8; let k = 0; const photoList = [];
  for (const { s, m } of rows) {
    const ph = m.photos || [], names = photoNames(s, m);
    const row = line(ws2, r, [fmtDate(s.date), s.shift, tripNo(s, m.trip) || "", m.time || "", m.onBoard || "", TYPES[m.type]?.label || m.type, m.rig || "", m.item, m.qty === "" ? "" : Number(m.qty) || 0, m.itemNo || "", m.oldNo || "", m.block || "", m.by || "", m.note || "", m.loggedBy || "", s.operator || "", "", "", ""], k++, { h: ph.length ? 60 : 20 });
    row.getCell(6).fill = fill(MOVE_FILL[m.type] || XC.CREAM); row.getCell(6).font = { name: "Arial", size: 10, bold: true };
    for (let i = 0; i < ph.length; i++) {
      const blob = await photoBlob(ph[i]); if (!blob) continue;
      const buf = await blob.arrayBuffer(), img = wb.addImage({ buffer: buf, extension: "jpeg" });
      let w = 1, h = 1; try { const bm = await createImageBitmap(blob); w = bm.width; h = bm.height; bm.close?.(); } catch {}
      photoList.push({ img, w, h, cap: `${fmtDate(s.date)} ${s.shift} ${m.time || ""} · ${TYPES[m.type]?.label || m.type} · ${m.qty} × ${m.item}${m.itemNo ? " · No. " + m.itemNo : ""}${m.rig ? " · " + m.rig : ""}`, name: names[i] });
      if (i < 3) { const th = 72, tw = Math.min(96, Math.round(th * w / h)); ws2.addImage(img, { tl: { col: 16 + i + 0.05, row: r - 1 + 0.05 }, ext: { width: tw, height: th } }); }
    }
    if (ph.length > 3) row.getCell(19).note = `${ph.length} photos – all are on the Photos sheet`;
    r++;
  }
  if (!rows.length) { ws2.getCell("A8").value = "No movements in this period."; ws2.getCell("A8").font = { name: "Arial", italic: true, color: { argb: XC.MUTED } }; }
  freeze(ws2, 7); if (rows.length) ws2.autoFilter = { from: "A7", to: `P${r - 1}` };

  // photos of the signed sheets go on the Photos sheet too
  for (const x of chron) for (const id of x.signPhotos || []) {
    const blob = await photoBlob(id); if (!blob) continue;
    const img = wb.addImage({ buffer: await blob.arrayBuffer(), extension: "jpeg" });
    let w = 1, h = 1; try { const bm = await createImageBitmap(blob); w = bm.width; h = bm.height; bm.close?.(); } catch {}
    photoList.push({ img, w, h, cap: `${fmtDate(x.date)} ${x.shift} · Signed sheet${x.operator ? " · " + x.operator : ""}` });
  }

  // Photos sheet, large
  const ws3 = sheet("Photos", [52, 4, 52], "GET Bakkie Log – Photos");
  if (!photoList.length) { ws3.getCell("A7").value = "No photos were taken in this period."; ws3.getCell("A7").font = { name: "Arial", italic: true, color: { argb: XC.MUTED } }; }
  photoList.forEach((ph, i) => {
    const col = (i % 2) * 2, rowImg = 7 + Math.floor(i / 2) * 2;
    ws3.getRow(rowImg).height = 200; ws3.getRow(rowImg + 1).height = 34;
    const H = 255, Wd = Math.min(360, Math.round(H * ph.w / ph.h));
    ws3.addImage(ph.img, { tl: { col: col + 0.05, row: rowImg - 1 + 0.05 }, ext: { width: Wd, height: H } });
    const c = ws3.getCell(rowImg + 1, col + 1); c.value = ph.cap; c.font = { name: "Arial", size: 9, color: { argb: XC.BLACK } }; c.alignment = { wrapText: true, vertical: "top" };
  });

  // Shifts
  const ws4 = sheet("Shifts", [11, 8, 18, 11, 16, 11, 11, 7, 16, 16, 10, 15, 24, 10, 24, 16, 16, 16, 11, 9], "GET Bakkie Log – Shifts");
  header(ws4, 7, ["Date", "Shift", "GET operator", "Bakkie no.", "Supervisor", "First out of store", "Last back at store", "Trips", "Handed over by", "Taken over by", "Handover time", "Counts checked", "Handover notes", "Movements", "Comments", "Signed GET operator", "Signed supervisor", "Signed store controller", "Signed sheet photos", "Status"]);
  chron.forEach((x, n) => { const h = x.handover || {}; line(ws4, 8 + n, [fmtDate(x.date), x.shift, x.operator || "", x.bakkie || "", x.supervisor || "", x.timeOut || "", x.timeBack || "", tripsOf(x).length, h.handedBy || "", h.takenBy || "", h.time || "", h.checked || "", h.notes || "", (x.moves || []).length, x.comments || "", x.signOperator || "", x.signSupervisor || "", x.signStore || "", (x.signPhotos || []).length, x.closed ? "Closed" : "Open"], n); });
  freeze(ws4, 7);

  // Trips
  const ws5 = sheet("Trips", [11, 8, 6, 14, 14, 11, ...ITEMS.map(() => 13)], "GET Bakkie Log – Trips");
  header(ws5, 7, ["Date", "Shift", "Trip", "Out of store", "Back at store", "Movements", ...ITEMS.map(i => "Loaded: " + i)]);
  r = 8; k = 0;
  chron.forEach(x => tripsOf(x).forEach((tr, i) => { const mv = (x.moves || []).filter(m => m.trip === tr.id);
    line(ws5, r++, [fmtDate(x.date), x.shift, i + 1, tr.out || "", tr.back || "", mv.length, ...ITEMS.map(it => mv.filter(m => m.type === "received" && m.item === it).reduce((a, m) => a + (Number(m.qty) || 0), 0))], k++); }));
  freeze(ws5, 7);

  // Bakkie and rigs per shift
  const ws6 = sheet("Bakkie per shift", [11, 8, 14, 10, 11, 10, 10, 10, 10, 11, 10, 26], "GET Bakkie Log – Bakkie per shift");
  header(ws6, 7, ["Date", "Shift", "Item", "Start qty", "On board", "Received", "Fitted", "Old back", "To store", "Lost in hole", "End qty", "Item numbers"]);
  r = 8; k = 0;
  chron.forEach(x => { const b = balance(x); ITEMS.forEach(i => { const st = x.start?.[i] || {}; if (b[i].start || b[i].received || b[i].fitted || b[i].returned || b[i].back || b[i].lost || st.nos)
    line(ws6, r++, [fmtDate(x.date), x.shift, i, b[i].start, st.time || "", b[i].received, b[i].fitted, b[i].returned, b[i].back, b[i].lost, b[i].end, st.nos || ""], k++); }); });
  freeze(ws6, 7);
  const ws7 = sheet("Rigs per shift", [11, 8, 10, 8, 14, 8, 8, 14, 11], "GET Bakkie Log – Rigs per shift");
  header(ws7, 7, ["Date", "Shift", "Rig", "Bits", "Bit no.", "Rods", "Shanks", "Shank no.", "On board"]);
  r = 8; k = 0;
  chron.forEach(x => RIGS.forEach(g => { const y = x.rigs?.[g] || {}; if (y.bits || y.rods || y.shanks || y.bitNo || y.shankNo) line(ws7, r++, [fmtDate(x.date), x.shift, g, num(y.bits), y.bitNo || "", num(y.rods), num(y.shanks), y.shankNo || "", y.time || ""], k++); }));
  freeze(ws7, 7);
  freeze(ws1, 5);
  return await wb.xlsx.writeBuffer();
}


/* The Excel shows every photo; when there are photos, the download is a zip with the Excel and a Photos folder. */
async function packExport(out, list, photoBlob, base) {
  const xlsx = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const items = []; logRows(list).forEach(({ s, m }) => { const names = photoNames(s, m); (m.photos || []).forEach((id, i) => items.push([id, names[i]])); });
  list.forEach(x => { const names = signNames(x); (x.signPhotos || []).forEach((id, i) => items.push([id, names[i]])); });
  if (!items.length) return { blob: xlsx, name: base + ".xlsx" };
  await loadLib("../lib/jszip.min.js");
  const zip = new JSZip(); zip.file(base + ".xlsx", xlsx); const folder = zip.folder("Photos");
  for (const [id, name] of items) { const local = (await store.photo(id))?.blob; const b = local || await photoBlob(id); if (b) folder.file(name, b); }
  return { blob: await zip.generateAsync({ type: "blob", mimeType: "application/zip" }), name: base + ".zip" };
}

/* ---------- who may export: an admin signs in on the tablet, or an admin approves the operator's request ---------- */
let exportPass = null, exportReq = null, exportMsg = "", showAdminExport = false;
const canExport = () => !!exportPass && Date.now() < exportPass.until;
try { exportReq = JSON.parse(localStorage.getItem("get-export-req") || "null"); } catch {}
const saveReq = () => { try { exportReq ? localStorage.setItem("get-export-req", JSON.stringify(exportReq)) : localStorage.removeItem("get-export-req"); } catch {} };
function exportGate() {
  if (canExport()) return `<div class="info">Export allowed until ${new Date(exportPass.until).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })} (${esc(exportPass.by)}).</div>`;
  const req = exportReq && exportReq.op === opNow?.uid ? exportReq : null;
  return `<div class="card">
    <h2>Exporting is done by admin</h2>
    <p class="muted" style="margin-top:0">An admin can sign in here to export, or you can ask admin for permission. Both need signal.</p>
    ${req ? `<p>Your request for ${fmtDate(req.from)} to ${fmtDate(req.to)} is <b>${req.status === "approved" ? "approved" : req.status === "declined" ? "declined" : "waiting for admin"}</b>.</p>` : ""}
    <div class="row">
      <button class="primary" id="askExport">${req && req.status === "pending" ? "Check again" : "Ask admin for permission"}</button>
      <button id="adminExport">Admin: sign in to export</button>
    </div>
    ${showAdminExport ? `<form id="adminExportForm" class="grid" style="margin-top:12px" autocomplete="off">
      <label>Admin email <input id="aeEmail" type="email" autocomplete="username"></label>
      <label>Password <input id="aePass" type="password" autocomplete="current-password"></label>
      <div style="display:flex;align-items:flex-end"><button class="primary" style="width:100%">Sign in</button></div></form>` : ""}
    <p class="flag" id="exportErr">${esc(exportMsg)}</p>
  </div>`;
}
async function askOrCheckExport() {
  exportMsg = "";
  if (!navigator.onLine) { exportMsg = "No signal. Asking for permission needs signal."; render(); return; }
  try {
    await ensureSignedIn();
    if (fbAuth.currentUser?.uid !== opNow?.uid) { exportMsg = "Lock the log and sign in again with your PIN while you have signal, then try again."; render(); return; }
    const req = exportReq && exportReq.op === opNow.uid ? exportReq : null;
    if (req && req.status === "pending") {
      const d = await fb.getDoc(fb.doc(fbDb, "getExportRequests", req.id));
      if (!d.exists()) { exportReq = null; saveReq(); exportMsg = "The request was removed. Ask again."; render(); return; }
      const v = d.data(); req.status = v.status; saveReq();
      if (v.status === "approved") { exportPass = { by: "approved by " + (v.approvedBy || "an admin"), until: Math.min((v.approvedAt || Date.now()) + 24 * 3600e3, Date.now() + 24 * 3600e3) }; range.from = v.from; range.to = v.to; }
      else exportMsg = v.status === "declined" ? "Admin declined the request." : "Still waiting for admin.";
      render(); return;
    }
    const ref = await fb.addDoc(fb.collection(fbDb, "getExportRequests"), { opUid: opNow.uid, opName: opNow.name, from: range.from, to: range.to, status: "pending", createdAt: Date.now() });
    exportReq = { id: ref.id, op: opNow.uid, from: range.from, to: range.to, status: "pending" }; saveReq();
    exportMsg = "Request sent. Tap Check again once admin has approved it."; render();
  } catch (x) { exportMsg = "That didn't work. Check the signal and try again."; render(); }
}

function num(v) { return v === "" || v == null ? "" : (isNaN(Number(v)) ? v : Number(v)); }

/* After an export: the closed shifts in the file are taken off this tablet once everything is sent to Firebase.
   The latest shift and open shifts stay, so the next shift still starts from the last counts. */
async function clearTabletCopy(ask) {
  if (waiting()) { await syncNow?.(); }
  if (waiting()) { alert("Some shifts are still sending, so they stay on this tablet. They clear after the next export with signal."); return; }
  const list = clearable(); if (!list.length) { lastExport = null; render(); return; }
  const nPh = list.reduce((n, s) => n + allPhotos(s).length, 0);
  if (ask && !confirm(`Clear ${list.length} shift${list.length === 1 ? "" : "s"}${nPh ? ` and ${nPh} photo${nPh === 1 ? "" : "s"}` : ""} from this tablet? They stay in Firebase and in the export.`)) return;
  for (const s of list) { await store.del(s.id); await deletePhotos(allPhotos(s)); }
  const gone = new Set(list.map(s => s.id)); shifts = shifts.filter(s => !gone.has(s.id));
  lastExport = null; render(); setStatus?.(`${list.length} exported shift${list.length === 1 ? "" : "s"} cleared from this tablet`);
}
async function shareOrDownload(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return "shared"; }
    catch (e) { if (e.name === "AbortError") return "cancelled"; }
  }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return "downloaded";
}

/* ---------- events ---------- */
let photoTarget = null, viewing = null;
function clearDrafts() { draftPhotos.forEach(p => URL.revokeObjectURL(p.url)); draftPhotos = []; }
app.addEventListener("click", async e => {
  const img = e.target.closest("img.thumb");
  if (img) {
    viewing = img.dataset.photo ? { id: img.dataset.photo, move: img.dataset.move } : { draft: +img.dataset.draft };
    $("#viewerImg").src = img.src; $("#viewerDel").hidden = !!current?.closed; $("#viewer").hidden = false; return;
  }
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.view) { view = t.dataset.view; render(); return; }
  if (t.dataset.pk && current) { const [k, v] = t.dataset.pk.split(/:(.*)/s); pick[k] = v; render(); return; }
  if (t.dataset.qty && current) { const q = $("#mQty"); q.value = Math.max(1, (parseInt(q.value, 10) || 0) + Number(t.dataset.qty)); return; }
  if (t.dataset.mode && current) { addMode = t.dataset.mode; renderShift(); fillThumbs(); return; }
  if (t.dataset.open) { clearDrafts(); current = structuredClone(shifts.find(x => x.id === t.dataset.open)); statusMsg = ""; render(); scrollTo(0, 0); return; }
  if (t.id === "back") { if (saveTimer) await save(); clearDrafts(); current = null; render(); return; }
  if (t.id === "newShift") {
    const open = shifts.find(x => !x.closed);
    if (open && !confirm(`The ${fmtDate(open.date)} ${open.shift} shift is still open. Start the next shift anyway?`)) return;
    current = newShift(); await save("Shift started"); render(); scrollTo(0, 0); return;
  }
  if (t.id === "askExport") { t.disabled = true; await askOrCheckExport(); return; }
  if (t.id === "adminExport") { const sa = await sharedAdmin(); if (sa) { exportPass = { by: sa.email, until: Date.now() + 8 * 3600e3, db: sa.db }; exportMsg = ""; render(); return; } showAdminExport = !showAdminExport; exportMsg = ""; render(); return; }
  if (t.id === "xlsx") {
    if (!canExport()) { render(); return; }
    try { await loadLib("../lib/exceljs.min.js"); } catch { alert("The export needs the app to be opened once with signal."); return; }
    if (!navigator.onLine) { alert("The combined report needs signal."); return; }
    await syncNow();
    const list = inRange();
    t.disabled = true; t.textContent = "Making the combined report…";
    try {
      const src = exportPass.db || fbDb;
      const { list: all, photoBlob } = await combinedData(src);
      if (!all.length) { alert("There are no GET shifts online for these dates yet."); render(); return; }
      const out = await buildBrandedGET(all, exportPass.by + " · all GET operators", photoBlob);
      const pk = await packExport(out, all, photoBlob, `TKR_GET_Bakkie_Log_All_Operators_${fmtDate(range.from).replace(/\//g, "-")}_to_${fmtDate(range.to).replace(/\//g, "-")}`);
      lastExport = { ids: all.map(s => s.id), from: range.from, to: range.to, photos: true };
      const { deliver } = await import("../lib/deliver.js");
      deliver(pk.blob, pk.name, { doneLabel: "Done – clear this tablet's copy", onDone: clearTabletCopy });
    } catch (x) { console.warn(x); alert("The Excel file couldn't be made. Try a shorter date range."); }
    render(); return;
  }
  if (t.id === "newTrip") {
    const tr = tripsOf(current); if (tr.length && !tr.at(-1).back) tr.at(-1).back = nowHM();
    const nt = { id: newId(), out: nowHM(), back: "" }; tr.push(nt);
    await save(`Trip ${tr.length} started`); render(); const sel = $("#mTrip"); if (sel) sel.value = nt.id; return;
  }
  if (t.dataset.tripback) { tripsOf(current)[+t.dataset.tripback].back = nowHM(); await save("Back at store " + nowHM()); render(); return; }
  if (t.dataset.tripdel) { tripsOf(current).splice(+t.dataset.tripdel, 1); await save("Trip removed"); render(); return; }
  if (t.id === "keepExported") { lastExport = null; render(); return; }
  if (t.id === "clearExported") { await clearTabletCopy(true); return; }
  if (t.id === "clearOld") { await clearOld(); return; }
  if (t.id === "takePhoto") { photoTarget = null; $("#camera").click(); return; }
  if (t.dataset.addphoto) { photoTarget = t.dataset.addphoto; $("#camera").click(); return; }
  if (t.id === "backup") {
    if (!canExport()) { alert("Making a backup file needs admin. Go to Movement log to ask admin."); return; }
    t.disabled = true; t.textContent = "Making backup…";
    const photos = [];
    for (const s of shifts) for (const id of allPhotos(s)) { const p = await store.photo(id); if (p) photos.push({ id, data: await blobToDataURL(p.blob) }); }
    const blob = new Blob([JSON.stringify({ app: "tkr-get-bakkie-log", version: 2, made: new Date().toISOString(), shifts, photos })], { type: "application/json" });
    const r = await shareOrDownload(blob, `TKR_GET_Bakkie_Log_Backup_${fmtDate(isoDate(new Date())).replace(/\//g, "-")}.json`);
    if (r !== "cancelled") localSet("lastBackup", fmtDate(isoDate(new Date())) + " " + nowHM());
    render(); return;
  }
  if (t.id === "restoreBtn") { $("#restoreFile").click(); return; }
  if (t.dataset.del) {
    const gone = (current.moves || []).find(m => m.id === t.dataset.del);
    if (gone?.photos?.length && !confirm("Remove this movement and its photos?")) return;
    current.moves = (current.moves || []).filter(m => m.id !== t.dataset.del);
    await save("Movement removed"); await deletePhotos(gone?.photos); markDelPhotos(gone?.photos); render(); return;
  }
  if (t.id === "delShift") {
    if (!confirm("Delete this whole shift and all its movements and photos? This cannot be undone.")) return;
    await store.del(current.id); await deletePhotos(allPhotos(current)); markDelShift(current.id, allPhotos(current));
    shifts = shifts.filter(x => x.id !== current.id); clearDrafts(); current = null; render(); return;
  }
  if (t.id === "close") {
    if (!current.signOperator || !current.signSupervisor) { $("#closeMsg").textContent = "Type the GET operator and supervisor names before closing the shift."; return; }
    const tr = tripsOf(current); if (tr.length && !tr.at(-1).back) tr.at(-1).back = nowHM();
    current.closed = true; await save("Shift closed"); render(); return;
  }
  if (t.id === "reopen") { current.closed = false; await save("Shift reopened"); render(); }
});
app.addEventListener("input", e => { const f = e.target.dataset.f; if (f && current) editField(f, e.target.value); });
app.addEventListener("change", async e => {
  const id = e.target.id;
  if (id === "fFrom" || id === "fTo") { range[id === "fFrom" ? "from" : "to"] = e.target.value; render(); return; }
  if (id === "restoreFile") {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== "tkr-get-bakkie-log" || !Array.isArray(data.shifts)) throw new Error();
      const have = new Set(shifts.map(s => s.id)), add = data.shifts.filter(s => s && s.id && !have.has(s.id));
      if (!confirm(`This backup has ${data.shifts.length} shifts. ${add.length} are not on this device yet and will be added. Shifts already here stay as they are. Continue?`)) return;
      const need = new Set(add.flatMap(allPhotos));
      for (const p of data.photos || []) if (need.has(p.id)) await store.putPhoto({ id: p.id, blob: await dataURLToBlob(p.data) });
      for (const s of add) await store.put(s);
      shifts = await store.all(); render(); $("#backupMsg").textContent = add.length + " shifts restored.";
    } catch { $("#backupMsg").textContent = "That file is not a GET Bakkie Log backup."; }
    return;
  }
  const f = e.target.dataset.f;
  if (f && current) { editField(f, e.target.value); if (f.startsWith("start.") || f === "date" || f === "shift") { await save(); render(); } }
  if (id === "mType") toggleRig();
});
app.addEventListener("submit", async e => {
  if (e.target.id === "adminExportForm") {
    e.preventDefault(); exportMsg = "Checking…"; $("#exportErr").textContent = exportMsg;
    try {
      await firebase();
      const tmp = fb.initializeApp(FIREBASE_CONFIG, "get-admin-" + Date.now()), a = fb.getAuth(tmp);
      const cred = await fb.signInWithEmailAndPassword(a, $("#aeEmail").value.trim(), $("#aePass").value);
      const em = (cred.user.email || "").toLowerCase();
      if (!["muneer@tkroperations.com", "amogelang@tkroperations.com"].includes(em)) { await fb.signOut(a).catch(() => {}); fb.deleteApp(tmp).catch(() => {}); exportMsg = "Only an admin can export."; render(); return; }
      exportPass = { by: em, until: Date.now() + 15 * 60e3, db: fb.initializeFirestore(tmp, {}) }; exportMsg = ""; showAdminExport = false; render();
    } catch (x) { exportMsg = !navigator.onLine ? "No signal. Signing in needs signal." : "Email or password is wrong."; render(); }
    return;
  }
  if (e.target.id !== "moveForm") return;
  e.preventDefault();
  const err = $("#moveErr"), qtxt = $("#mQty").value.trim(), qty = Number(qtxt), base = { id: newId(), loggedBy: opNow?.name || "", trip: $("#mTrip")?.value || "", time: $("#mTime").value || nowHM(), note: ($("#mNote")?.value || "").trim() };
  let m;
  if (addMode === "extra") {
    const what = $("#mWhat").value.trim();
    if (!what) { err.textContent = "Type what it is, for example 20 L hydraulic oil."; return; }
    if (qtxt && (!Number.isInteger(qty) || qty <= 0)) { err.textContent = "Type the quantity as a whole number, or leave it empty."; return; }
    m = { ...base, type: "extra", item: what, qty: qtxt ? qty : "", rig: "" };
  } else {
    const type = $("#mType").value;
    if (!Number.isInteger(qty) || qty <= 0) { err.textContent = "Type the quantity as a whole number, for example 1."; return; }
    m = { ...base, type, item: $("#mItem").value, qty, rig: TYPES[type].rig ? $("#mRig").value : "" };
  }
  err.textContent = "";
  if (draftPhotos.length) {
    m.photos = [];
    for (const p of draftPhotos) { const id = newId(); await store.putPhoto({ id, blob: p.blob }); m.photos.push(id); }
    clearDrafts();
  }
  current.moves = [...(current.moves || []), m];
  e.target.reset();
  await save((m.type === "extra" ? "Extra added " : "GET added ") + m.time); render();
});

/* camera: one hidden input for the add form and for "+ Photo" on a saved movement */
$("#camera").addEventListener("change", async e => {
  const files = [...e.target.files]; e.target.value = "";
  if (!files.length || !current) return;
  setStatus("Saving photo…");
  try {
    const blobs = []; for (const f of files) blobs.push(await shrinkPhoto(f));
    if (photoTarget) {
      const m = photoTarget === "sign" ? { photos: current.signPhotos = current.signPhotos || [] } : (current.moves || []).find(x => x.id === photoTarget); if (!m) return;
      m.photos = m.photos || [];
      for (const b of blobs) { const id = newId(); await store.putPhoto({ id, blob: b }); m.photos.push(id); }
      await save("Photo added");
    } else {
      blobs.forEach(b => draftPhotos.push({ blob: b, url: URL.createObjectURL(b) })); setStatus("Photo ready. Tap Add movement to save it.");
    }
    render();
  } catch { setStatus("The photo could not be saved."); }
});
$("#viewerClose").addEventListener("click", () => { $("#viewer").hidden = true; viewing = null; });
$("#viewerDel").addEventListener("click", async () => {
  if (!viewing || !confirm("Delete this photo?")) return;
  if (viewing.draft !== undefined) { const [p] = draftPhotos.splice(viewing.draft, 1); if (p) URL.revokeObjectURL(p.url); }
  else if (viewing.move === "sign") { current.signPhotos = (current.signPhotos || []).filter(id => id !== viewing.id); await save("Photo deleted"); await deletePhotos([viewing.id]); markDelPhotos([viewing.id]); }
  else { const m = (current.moves || []).find(x => x.id === viewing.move); if (m) { m.photos = (m.photos || []).filter(id => id !== viewing.id); await save("Photo deleted"); await deletePhotos([viewing.id]); markDelPhotos([viewing.id]); } }
  $("#viewer").hidden = true; viewing = null; render();
});
addEventListener("pagehide", () => { if (saveTimer && current) save(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && saveTimer && current) save(); });

/* ---------- install button + offline ---------- */
let installEvt = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("#installBtn").hidden = false; });
$("#installBtn").addEventListener("click", async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("#installBtn").hidden = true; });
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("../sw.js", { scope: "../", updateViaCache: "none" }).then(r => r.update()).catch(() => {}));

/* ---------- sending GET records online, so admins can export one combined report for all operators ----------
   Every save is kept on the device first. Changes are sent when there is signal and an approved operator is signed in.
   Photos go up as smaller copies (about 50 KB) to stay on Firebase's free plan; the tablet keeps the full photo. */
let dirty = { shifts: [], photos: [], delShifts: [], delPhotos: [] }, syncing = false, syncNote = "";
async function loadDirty() { try { const d = await store.getMeta("dirty"); if (d) dirty = { shifts: [], photos: [], delShifts: [], delPhotos: [], ...d }; } catch {} }
async function saveDirty() { try { await store.putMeta({ id: "dirty", ...dirty }); } catch {} }
const addTo = (k, id) => { if (id && !dirty[k].includes(id)) dirty[k].push(id); };
function markShift(id) { addTo("shifts", id); saveDirty(); scheduleSync(); }
function markPhoto(id) { addTo("photos", id); saveDirty(); scheduleSync(); }
function markDelShift(id, photoIds = []) { addTo("delShifts", id); dirty.shifts = dirty.shifts.filter(x => x !== id); photoIds.forEach(p => { addTo("delPhotos", p); dirty.photos = dirty.photos.filter(x => x !== p); }); saveDirty(); scheduleSync(); }
function markDelPhotos(ids = []) { ids.forEach(p => { addTo("delPhotos", p); dirty.photos = dirty.photos.filter(x => x !== p); }); saveDirty(); scheduleSync(); }
const waiting = () => dirty.shifts.length + dirty.photos.length + dirty.delShifts.length + dirty.delPhotos.length;
let syncTimer = null;
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 2500); }
async function smallPhoto(blob) {
  const bm = await createImageBitmap(blob), k = Math.min(1, 640 / Math.max(bm.width, bm.height));
  const c = document.createElement("canvas"); c.width = Math.round(bm.width * k); c.height = Math.round(bm.height * k);
  c.getContext("2d").drawImage(bm, 0, 0, c.width, c.height); bm.close?.();
  return new Promise(res => c.toBlob(b => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(b); }, "image/jpeg", 0.6));
}
async function syncNow() {
  if (syncing || !waiting() || !navigator.onLine || !opNow || !(await firebase())) return;
  await fbAuth.authStateReady?.(); if (fbAuth.currentUser?.uid !== opNow.uid) return;
  syncing = true;
  try {
    const shiftOf = pid => shifts.find(x => allPhotos(x).includes(pid));
    for (const id of [...dirty.delPhotos]) { await fb.deleteDoc(fb.doc(fbDb, "getPhotos", id)); dirty.delPhotos = dirty.delPhotos.filter(x => x !== id); }
    for (const id of [...dirty.delShifts]) { await fb.deleteDoc(fb.doc(fbDb, "getShifts", id)); dirty.delShifts = dirty.delShifts.filter(x => x !== id); }
    for (const id of [...dirty.shifts]) {
      const sh = shifts.find(x => x.id === id);
      if (sh) await fb.setDoc(fb.doc(fbDb, "getShifts", id), { ...JSON.parse(JSON.stringify(sh)), ownerUid: opNow.uid, ownerName: opNow.name, syncedAt: Date.now() });
      dirty.shifts = dirty.shifts.filter(x => x !== id); await saveDirty();
    }
    for (const id of [...dirty.photos]) {
      const p = await store.photo(id), sh = shiftOf(id);
      if (p && sh) await fb.setDoc(fb.doc(fbDb, "getPhotos", id), { shiftId: sh.id, date: sh.date, ownerUid: opNow.uid, data: await smallPhoto(p.blob), syncedAt: Date.now() });
      dirty.photos = dirty.photos.filter(x => x !== id); await saveDirty();
    }
    syncNote = "";
  } catch (x) { console.warn(x); syncNote = "Some changes couldn't be sent yet. They will be sent later."; }
  syncing = false; await saveDirty();
  if (!current && view === "log") render();
}
addEventListener("online", () => scheduleSync());
setInterval(() => { if (waiting()) syncNow(); }, 120000);
function syncLine() {
  const n = waiting();
  return `<p class="muted" style="margin:0 0 10px">${n ? `${n} change${n === 1 ? "" : "s"} on this device waiting to be sent online${navigator.onLine ? "…" : " (no signal)"}.` : "Everything on this device has been sent online."} ${esc(syncNote)}</p>`;
}
async function combinedData(db) {
  const s = await fb.getDocs(fb.query(fb.collection(db, "getShifts"), fb.where("date", ">=", range.from), fb.where("date", "<=", range.to)));
  const list = sorted(s.docs.map(d => d.data()));
  const ps = await fb.getDocs(fb.query(fb.collection(db, "getPhotos"), fb.where("date", ">=", range.from), fb.where("date", "<=", range.to)));
  const photos = new Map(ps.docs.map(d => [d.id, d.data().data]));
  return { list, photoBlob: async id => photos.has(id) ? await (await fetch(photos.get(id))).blob() : null };
}

/* ---------- GET operator sign-in: own name + 4-digit PIN, approved by an app admin ----------
   Firebase holds the operators list and the approvals (needs signal the first time on a tablet).
   After that the tablet keeps a hash of the PIN, so the operator can unlock with no signal. */
const LOCK_AFTER_MS = 10 * 60 * 1000;
const FIREBASE_CONFIG = { apiKey: "AIzaSyALzOBLObrONGVD1bS0Tz02aNKhQ40TRoI", authDomain: "tkr-operations-app.firebaseapp.com", projectId: "tkr-operations-app", appId: "1:158080247079:web:7cb7786d2b7f9ee172b502" };
let fb = null, fbApp = null, fbAuth = null, fbDb = null, adminNow = null;
let ops = [], localOps = [], opNow = null, picked = null, unlocked = false, lastUse = Date.now(), lockMode = "pick";
async function firebase() {
  if (fbDb) return true;
  try {
    fb = await import("../lib/firebase.js");
    fbApp = fb.initializeApp(FIREBASE_CONFIG, "get"); // separate sign-in from the Task Board
    fbAuth = fb.getAuth(fbApp); fbDb = fb.initializeFirestore(fbApp, {});
    return true;
  } catch { return false; }
}
// The one TKR admin sign-in shared by every section: an admin signed in elsewhere in the app can export here without typing the password again.
let mainApp = null;
async function sharedAdmin() {
  if (!(await firebase())) return null;
  try { mainApp = mainApp || fb.initializeApp(FIREBASE_CONFIG); const a = fb.getAuth(mainApp); await a.authStateReady?.();
    const em = (a.currentUser?.email || "").toLowerCase();
    return ["muneer@tkroperations.com", "amogelang@tkroperations.com"].includes(em) ? { email: em, db: fb.initializeFirestore(mainApp, {}) } : null; } catch { return null; }
}
async function ensureSignedIn() {
  await firebase(); await fbAuth.authStateReady?.();
  if (!fbAuth.currentUser) await fb.signInAnonymously(fbAuth);
}
async function loadOps() {
  if (!navigator.onLine) return false;
  try { await ensureSignedIn(); const s = await fb.getDocs(fb.collection(fbDb, "getOperators")); ops = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((x, y) => x.name.localeCompare(y.name)); return true; }
  catch { return false; }
}
async function hashPin(pin, salt) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + ":" + pin));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const opEmail = key => `get.${key}@staff.tkroperations.app`;
const opPass = (pin, key) => `tkr-get-${pin}-${key}`;
const randKey = () => [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");
async function saveLocal() { try { await store.putMeta({ id: "ops", list: localOps }); } catch {} }
async function rememberOp(op, pin) {
  const salt = randKey();
  localOps = localOps.filter(o => o.uid !== op.id);
  localOps.push({ uid: op.id, name: op.name, authEmail: op.authEmail, key: op.key, salt, hash: await hashPin(pin, salt), approved: !!op.approved });
  await saveLocal();
}
function lockView(mode, msg = "") {
  lockMode = mode; unlocked = false; app.hidden = true; $("#lock").hidden = false;
  const el = $("#lockBody"), err = `<p class="flag" id="lErr" style="margin:0">${esc(msg)}</p>`;
  const pinIn = (id, label) => `<label>${label} <input id="${id}" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off"></label>`;
  if (mode === "pick") {
    const names = new Map(); ops.forEach(o => names.set(o.id, o)); localOps.forEach(o => { if (!names.has(o.uid)) names.set(o.uid, { id: o.uid, name: o.name, approved: o.approved }); });
    const list = [...names.values()].sort((x, y) => x.name.localeCompare(y.name));
    el.innerHTML = `<h2>Who is using the GET log?</h2>
      <p class="muted" style="margin:0">Choose your name and type your PIN.</p>
      <div class="list" style="display:flex;flex-direction:column;gap:8px">${list.length ? list.map(o => `<button type="button" data-op="${esc(o.id)}" style="text-align:left">${esc(o.name)}${o.approved ? "" : ' <span class="muted">· waiting for approval</span>'}</button>`).join("")
        : `<div class="muted">${navigator.onLine ? "No GET operators yet." : "No signal. The first sign-in on this tablet needs signal."}</div>`}</div>
      ${err}<button type="button" class="primary" id="lNew">New GET operator? Register</button>
      <button type="button" class="ghost" id="lAdmin">Admin: export all operators to Excel</button>`;
  } else if (mode === "pin") {
    el.innerHTML = `<h2>Hello ${esc(picked.name)}</h2><p class="muted" style="margin:0">Type your 4-digit PIN.</p>${pinIn("lPin", "PIN")}${err}
      <button class="primary">Sign in</button>
      <div class="row" style="justify-content:space-between"><button type="button" class="ghost" id="lSwitch">Not you?</button><button type="button" class="ghost" id="lForgot">Forgot your PIN?</button></div>`;
  } else if (mode === "register") {
    el.innerHTML = `<h2>Register as a GET operator</h2><p class="muted" style="margin:0">Type your full name and make a 4-digit PIN. Then ask admin to approve you. This needs signal.</p>
      <label>Full name <input id="lName" maxlength="60" autocomplete="off"></label>${pinIn("lPin", "PIN")}${pinIn("lPin2", "Type the PIN again")}${err}
      <button class="primary">Register</button><button type="button" class="ghost" id="lSwitch">Back</button>`;
  } else if (mode === "wait") {
    el.innerHTML = `<h2>Waiting for approval</h2><p style="margin:0">${esc(picked?.name || "")}, you are registered. Ask admin to approve you. Then tap Check again.</p>${err}
      <button type="button" class="primary" id="lCheck">Check again</button><button type="button" class="ghost" id="lSwitch">Back</button>`;
  } else if (mode === "admin") {
    const sa = adminNow;
    el.innerHTML = `<h2>Combined report</h2><p class="muted" style="margin:0">${sa ? `Signed in as ${esc(sa.email)}. Choose the dates and download one Excel report for all GET operators.` : "Admin: sign in, choose the dates and download one Excel report for all GET operators. Needs signal."}</p>
      ${sa ? "" : `<label>Admin email <input id="laEmail" type="email" autocomplete="username"></label><label>Password <input id="laPass" type="password" autocomplete="current-password"></label>`}
      <div class="row"><label style="flex:1">From <input type="date" id="laFrom" value="${range.from}"></label><label style="flex:1">To <input type="date" id="laTo" value="${range.to}"></label></div>
      ${err}<button class="primary" id="laGo">Download combined report</button><button type="button" class="ghost" id="lSwitch">Back</button>`;
  } else if (mode === "forgot") {
    el.innerHTML = `<h2>Forgot your PIN</h2><p style="margin:0">Ask admin to reset your PIN. Then register again with your name and a new PIN, and admin approves you. Your GET records stay.</p>
      <button type="button" class="primary" id="lSwitch">OK</button>`;
  }
  setTimeout(() => el.querySelector("input")?.focus(), 50);
}
function unlock(op) {
  opNow = { uid: op.uid || op.id, name: op.name }; unlocked = true; lastUse = Date.now();
  $("#lock").hidden = true; app.hidden = false; $("#opName").textContent = opNow.name; $("#lockBtn").hidden = false; render(); scheduleSync();
}
async function checkStillApproved() {
  // Online: a removed or unapproved operator is locked out the next time the tablet has signal.
  if (!opNow || !navigator.onLine || !(await firebase())) return;
  try {
    await ensureSignedIn();
    const d = await fb.getDoc(fb.doc(fbDb, "getOperators", opNow.uid));
    const ok = d.exists() && d.data().approved;
    const lo = localOps.find(o => o.uid === opNow.uid); if (lo) { lo.approved = !!ok; await saveLocal(); }
    if (!ok) { if (saveTimer && current) await save(); opNow = null; lockView("pick", d.exists() ? "You are not approved yet." : "Your sign-in was removed. Register again."); }
  } catch {}
}
$("#lockForm").addEventListener("click", async e => {
  const t = e.target.closest("button"); if (!t || t.type === "submit") return;
  if (t.dataset.op) { picked = ops.find(o => o.id === t.dataset.op) || (() => { const l = localOps.find(o => o.uid === t.dataset.op); return l && { id: l.uid, name: l.name, authEmail: l.authEmail, key: l.key, approved: l.approved }; })(); lockView("pin"); }
  if (t.id === "lNew") lockView("register");
  if (t.id === "lAdmin") { adminNow = await sharedAdmin(); lockView("admin"); }
  if (t.id === "lSwitch") { await loadOps(); lockView("pick"); }
  if (t.id === "lForgot") lockView("forgot");
  if (t.id === "lCheck") { await loadOps(); const o = ops.find(x => x.id === picked?.id); if (o?.approved) { lockView("pin", "You are approved. Type your PIN."); picked = o; } else $("#lErr").textContent = navigator.onLine ? "Not approved yet." : "No signal."; }
});
$("#lockForm").addEventListener("submit", async e => {
  e.preventDefault(); const err = () => $("#lErr");
  if (lockMode === "admin") {
    if (!navigator.onLine) { err().textContent = "No signal. The combined report needs signal."; return; }
    range.from = $("#laFrom").value || range.from; range.to = $("#laTo").value || range.to;
    if (range.from > range.to) { err().textContent = "Choose a From date before the To date."; return; }
    err().textContent = adminNow ? "Making the combined report…" : "Signing in…";
    let tmp;
    try {
      await firebase(); let em, adb;
      if (adminNow) { em = adminNow.email; adb = adminNow.db; }
      else {
        tmp = fb.initializeApp(FIREBASE_CONFIG, "get-admin-" + Date.now()); const a = fb.getAuth(tmp);
        const cred = await fb.signInWithEmailAndPassword(a, $("#laEmail").value.trim(), $("#laPass").value);
        em = (cred.user.email || "").toLowerCase(); adb = fb.initializeFirestore(tmp, {});
        if (!["muneer@tkroperations.com", "amogelang@tkroperations.com"].includes(em)) { err().textContent = "Only an admin can do this."; return; }
      }
      err().textContent = "Making the combined report…";
      await loadLib("../lib/exceljs.min.js");
      const { list, photoBlob } = await combinedData(adb);
      if (!list.length) { err().textContent = "There are no GET shifts online for these dates yet."; return; }
      const out = await buildBrandedGET(list, em + " · all GET operators", photoBlob);
      const pk = await packExport(out, list, photoBlob, `TKR_GET_Bakkie_Log_All_Operators_${fmtDate(range.from).replace(/\//g, "-")}_to_${fmtDate(range.to).replace(/\//g, "-")}`);
      const { deliver } = await import("../lib/deliver.js"); deliver(pk.blob, pk.name);
      err().textContent = `Done: ${list.length} shift${list.length === 1 ? "" : "s"} from all GET operators.`;
    } catch (x) { console.warn(x); err().textContent = String(x?.code || "").includes("auth") ? "Email or password is wrong." : "The report couldn't be made. Check the signal and try again."; }
    finally { $("#laPass") && ($("#laPass").value = ""); if (tmp) { fb.getAuth(tmp).signOut?.(); fb.deleteApp(tmp).catch(() => {}); } }
    return;
  }
  const pin = $("#lPin")?.value.trim() || "";
  if (!/^\d{4}$/.test(pin)) { err().textContent = "The PIN must be 4 numbers."; return; }
  if (lockMode === "register") {
    const name = $("#lName").value.trim().replace(/\s+/g, " ");
    if (name.length < 3) { err().textContent = "Type your full name."; return; }
    if (pin !== $("#lPin2").value.trim()) { err().textContent = "The two PINs are not the same."; return; }
    if (!navigator.onLine) { err().textContent = "No signal. Registering needs signal."; return; }
    err().textContent = "Registering…";
    try {
      await firebase(); const key = randKey(), em = opEmail(key);
      const cred = await fb.createUserWithEmailAndPassword(fbAuth, em, opPass(pin, key));
      const op = { name, authEmail: em, key, approved: false, createdAt: Date.now() };
      await fb.setDoc(fb.doc(fbDb, "getOperators", cred.user.uid), op);
      picked = { id: cred.user.uid, ...op }; await rememberOp(picked, pin); lockView("wait");
    } catch (x) { err().textContent = "Registering didn't work. Check the signal and try again."; }
    return;
  }
  if (lockMode === "pin") {
    const lo = localOps.find(o => o.uid === picked.id);
    if (lo && lo.hash && (await hashPin(pin, lo.salt)) === lo.hash) {
      if (!lo.approved && !navigator.onLine) { err().textContent = "You are not approved yet. Check again with signal."; return; }
      if (lo.approved) {
        unlock(lo);
        (async () => { try { if (navigator.onLine && await firebase()) { await fbAuth.authStateReady?.(); if (fbAuth.currentUser?.uid !== lo.uid) await fb.signInWithEmailAndPassword(fbAuth, lo.authEmail, opPass(pin, lo.key)); } } catch {} checkStillApproved(); })();
        return;
      }
    } else if (lo && lo.hash && !navigator.onLine) { $("#lPin").value = ""; err().textContent = "Wrong PIN."; return; }
    if (!navigator.onLine) { err().textContent = "No signal. The first sign-in on this tablet needs signal."; return; }
    err().textContent = "Signing in…";
    try {
      await firebase();
      const src = ops.find(o => o.id === picked.id) || picked;
      await fb.signInWithEmailAndPassword(fbAuth, src.authEmail, opPass(pin, src.key));
      const d = await fb.getDoc(fb.doc(fbDb, "getOperators", picked.id));
      if (!d.exists()) { err().textContent = "Your sign-in was removed. Register again."; return; }
      const op = { id: d.id, ...d.data() }; await rememberOp(op, pin);
      if (!op.approved) { picked = op; lockView("wait"); return; }
      unlock(op);
    } catch (x) {
      const c = String(x?.code || "");
      $("#lPin").value = "";
      err().textContent = c.includes("too-many") ? "Too many tries. Wait a few minutes." : c.includes("network") ? "No signal. Try again with signal." : "Wrong PIN.";
    }
  }
});
$("#lockBtn").onclick = async () => { if (saveTimer && current) await save(); picked = opNow ? { id: opNow.uid, name: opNow.name } : null; opNow = null; lockView(picked ? "pin" : "pick"); };
["pointerdown", "keydown", "input"].forEach(ev => document.addEventListener(ev, () => { if (unlocked) lastUse = Date.now(); }, { passive: true }));
const checkIdle = async () => { if (unlocked && Date.now() - lastUse > LOCK_AFTER_MS) { if (saveTimer && current) await save(); picked = { id: opNow.uid, name: opNow.name }; opNow = null; lockView("pin", "Locked after 10 minutes. Type your PIN."); } };
setInterval(checkIdle, 30000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkIdle(); });

(async () => {
  try {
    await store.open(); shifts = await store.all();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    localOps = (await store.getMeta("ops"))?.list || []; await loadDirty();
    lockView("pick", navigator.onLine ? "" : "No signal. Choose your name to unlock.");
    if (await loadOps()) lockView("pick");
  } catch { app.innerHTML = `<div class="card notice">This browser cannot save records. Open the app in Chrome.</div>`; }
})();
