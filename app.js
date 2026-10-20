"use strict";
/* TKR GET Bakkie Log — offline app. Everything is saved on this device (IndexedDB).
   Excel export makes the sum-up; the backup file moves the records to a new device. */

const ITEMS = ["140 mm bits", "102 mm bits", "Rods", "Starter rods", "Shanks", "Other"];
const RIGS = ["TDR 013", "TDR 015", "TDR 014"];
const TYPES = {
  received: { label: "Received from store", cls: "in", rig: false },
  fitted:   { label: "Fitted on rig", cls: "out", rig: true },
  returned: { label: "Old item back from rig", cls: "in", rig: true },
  back:     { label: "Handed back to store", cls: "out", rig: false },
  lost:     { label: "Lost in hole", cls: "lost", rig: true },
};

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
      const r = indexedDB.open("tkr-get-bakkie-log", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("shifts", { keyPath: "id" });
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction("shifts", mode), os = t.objectStore("shifts");
      const out = fn(os);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  },
  all() { return this.tx("readonly", os => os.getAll()); },
  put(s) { return this.tx("readwrite", os => os.put(s)); },
  del(id) { return this.tx("readwrite", os => os.delete(id)); },
};

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
  return { id: newId(), date: isoDate(d), shift: night ? "Night" : "Day", operator: prev?.operator || "", bakkie: prev?.bakkie || "", supervisor: "",
    timeOut: nowHM(), timeBack: "", start, moves: [], rigs, comments: "",
    handover: { fromLabel: prev ? fmtDate(prev.date) + " " + prev.shift : "", handedBy: prev?.operator || "", takenBy: "", time: nowHM(), checked: "", notes: "" },
    signOperator: "", signSupervisor: "", signStore: "", closed: false, createdAt: Date.now() };
}

/* ---------- home ---------- */
function render() {
  if (current) return renderShift();
  const tab = (k, t) => `<button role="tab" aria-selected="${view === k}" data-view="${k}">${t}</button>`;
  const dates = `<label style="flex:1 1 150px">From <input type="date" id="fFrom" value="${range.from}"></label>
      <label style="flex:1 1 150px">To <input type="date" id="fTo" value="${range.to}"></label>`;
  let body = "";
  if (view === "shifts") body = `<div class="row" style="margin-bottom:14px;align-items:flex-end">${dates}
      <button class="primary" id="newShift" style="flex:1 1 220px">Start shift / shift change</button></div>` + shiftList(inRange());
  else if (view === "log") body = `<div class="row" style="margin-bottom:14px;align-items:flex-end">${dates}
      <button class="primary" id="xlsx" style="flex:1 1 220px">Export to Excel</button></div>` + logTable(inRange());
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
      <span><b>${esc(s.shift)} shift</b><br><span class="muted">${esc(s.operator || "No operator yet")}${s.bakkie ? " · " + esc(s.bakkie) : ""} · ${n} movement${n === 1 ? "" : "s"}${s.timeOut ? " · out " + esc(s.timeOut) : ""}${s.timeBack ? " – back " + esc(s.timeBack) : ""}</span></span>
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
    <thead><tr><th>Date</th><th>Shift</th><th>Time</th><th>On board</th><th>Movement</th><th>Rig</th><th>Item</th><th class="num">Qty</th><th>Item no.</th><th>Old no. back</th><th>Block / hole</th><th>Received by</th><th>Operator</th></tr></thead>
    <tbody>${rows.map(({ s, m }) => `<tr><td>${esc(fmtDate(s.date))}</td><td>${esc(s.shift)}</td><td class="num">${esc(m.time)}</td><td class="num">${esc(m.onBoard)}</td>
      <td class="${m.type === "lost" ? "flag" : ""}">${esc(TYPES[m.type]?.label || m.type)}</td><td>${esc(m.rig)}</td><td>${esc(m.item)}</td><td class="num">${esc(m.qty)}</td>
      <td>${esc(m.itemNo)}</td><td>${esc(m.oldNo)}</td><td>${esc(m.block)}</td><td>${esc(m.by)}</td><td>${esc(s.operator)}</td></tr>`).join("")}</tbody></table></div></div>`;
}

function backupView() {
  const last = localGet("lastBackup");
  return `<div class="card">
      <h2>Backup</h2>
      <p style="margin-top:0">The records are saved on this device only. Make a backup at least once a week and send it on WhatsApp or email. If this device is lost or replaced, open the app on the new device and restore the backup file.</p>
      <p class="muted">${shifts.length} shift${shifts.length === 1 ? "" : "s"} on this device. ${last ? "Last backup: " + esc(last) + "." : "No backup made yet on this device."}</p>
      <div class="row"><button class="primary" id="backup">Make backup file</button>
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
  const startRows = ITEMS.map(i => {
    const b = bal[i], st = s.start?.[i] || {};
    return `<tr><td><b>${i}</b></td>
      <td style="width:76px">${field(`start.${i}.qty`, st.qty, 'inputmode="numeric" aria-label="Start qty"')}</td>
      <td style="width:110px">${field(`start.${i}.time`, st.time, 'type="time" aria-label="Time on board"')}</td>
      <td class="num">${b.received}</td><td class="num">${b.fitted}</td><td class="num">${b.returned}</td><td class="num">${b.back}</td>
      <td class="num end">${b.end}</td>
      <td style="min-width:170px">${field(`start.${i}.nos`, st.nos, 'aria-label="Item numbers" placeholder="Item numbers"')}</td></tr>`;
  }).join("");
  const moves = (s.moves || []).slice().sort((a, b) => (a.time || "").localeCompare(b.time || "")).map(m => {
    const t = TYPES[m.type] || TYPES.received;
    const detail = [m.onBoard && "on board " + m.onBoard, m.itemNo && "No. " + m.itemNo, m.oldNo && "old " + m.oldNo + " back", m.block && "block/hole " + m.block, m.by && "received by " + m.by].filter(Boolean).join(" · ");
    return `<div class="move ${t.cls}"><span class="t">${esc(m.time)}</span>
      <span class="what"><b>${esc(m.qty)} × ${esc(m.item)} – ${esc(t.label)}${t.rig && m.rig ? " – " + esc(m.rig) : ""}</b><span class="muted">${esc(detail)}</span></span>
      ${ro ? "" : `<button class="ghost" data-del="${esc(m.id)}">Remove</button>`}</div>`;
  }).join("") || `<div class="muted">No movements yet. Add one line every time GET goes on or off the bakkie.</div>`;
  const rigRows = RIGS.map(r => {
    const g = s.rigs?.[r] || {};
    return `<tr><td><b>${r}</b></td>
      <td style="width:70px">${field(`rigs.${r}.bits`, g.bits, 'inputmode="numeric" aria-label="Bits on rig"')}</td>
      <td>${field(`rigs.${r}.bitNo`, g.bitNo, 'aria-label="Bit no."')}</td>
      <td style="width:70px">${field(`rigs.${r}.rods`, g.rods, 'inputmode="numeric" aria-label="Rods on rig"')}</td>
      <td style="width:70px">${field(`rigs.${r}.shanks`, g.shanks, 'inputmode="numeric" aria-label="Shanks on rig"')}</td>
      <td>${field(`rigs.${r}.shankNo`, g.shankNo, 'aria-label="Shank no."')}</td>
      <td style="width:110px">${field(`rigs.${r}.time`, g.time, 'type="time" aria-label="Time on board"')}</td></tr>`;
  }).join("");
  const lost = (s.moves || []).filter(m => m.type === "lost");
  app.innerHTML = `
    <div class="sticky row" style="justify-content:space-between">
      <button class="ghost" id="back">← All shifts</button>
      <span class="status" id="status">${esc(statusMsg)}</span>
    </div>
    <section class="card">
      <h2>${esc(dayName(s.date))} ${esc(fmtDate(s.date))} · ${esc(s.shift)} shift <span class="pill ${s.closed ? "closed" : "open"}">${s.closed ? "Closed" : "Open"}</span></h2>
      <div class="grid">
        <label>Date ${field("date", s.date, 'type="date"')}</label>
        <label>Shift <select data-f="shift" ${off}>${["Day", "Night"].map(x => `<option ${s.shift === x ? "selected" : ""}>${x}</option>`).join("")}</select></label>
        <label>Time out of store ${field("timeOut", s.timeOut, 'type="time"')}</label>
        <label>Time back at store ${field("timeBack", s.timeBack, 'type="time"')}</label>
        <label>GET operator ${field("operator", s.operator, 'placeholder="Name"')}</label>
        <label>Bakkie no. ${field("bakkie", s.bakkie, 'placeholder="Bakkie no."')}</label>
        <label>Supervisor ${field("supervisor", s.supervisor, 'placeholder="Name"')}</label>
      </div>
    </section>

    <section class="card">
      <h2>Shift change</h2>
      ${ho.fromLabel ? `<div class="info">Start counts and rig counts were carried over from the <b>${esc(ho.fromLabel)}</b> shift. Count what is really in the bakkie and on the rigs, and change any number that is different.</div>`
        : `<div class="info">First shift on the log. Count what is in the bakkie and on each rig and type it in.</div>`}
      <div class="grid">
        <label>Handed over by ${field("handover.handedBy", ho.handedBy, 'placeholder="Outgoing GET operator"')}</label>
        <label>Taken over by ${field("handover.takenBy", ho.takenBy, 'placeholder="Incoming GET operator"')}</label>
        <label>Handover time ${field("handover.time", ho.time, 'type="time"')}</label>
        <label>Counts checked together? <select data-f="handover.checked" ${off}>${["", "Yes, counts match", "No, see notes"].map(x => `<option ${ho.checked === x ? "selected" : ""} value="${x}">${x || "Choose"}</option>`).join("")}</select></label>
      </div>
      <label style="margin-top:12px">Handover notes ${field("handover.notes", ho.notes, 'placeholder="Anything the next shift must know"')}</label>
    </section>

    <section class="card">
      <h2>A. GET in the bakkie</h2>
      <div class="tbl wide"><table>
        <thead><tr><th>Item</th><th>Start qty</th><th>Time on board</th><th class="num">Received</th><th class="num">Fitted</th><th class="num">Old back</th><th class="num">To store</th><th class="num">In bakkie now</th><th>Item numbers</th></tr></thead>
        <tbody>${startRows}</tbody></table></div>
      <p class="muted" style="margin:8px 0 0">In bakkie now = start + received − fitted + old back − to store. It updates with every movement.</p>
    </section>

    <div class="cols">
      <section class="card">
        <h2>B. Add a movement</h2>
        <form id="moveForm" class="grid" autocomplete="off">
          <label>Movement <select id="mType" ${off}>${Object.entries(TYPES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join("")}</select></label>
          <label id="rigWrap">Rig <select id="mRig" ${off}>${RIGS.map(r => `<option>${r}</option>`).join("")}</select></label>
          <label>Item <select id="mItem" ${off}>${ITEMS.map(i => `<option>${i}</option>`).join("")}</select></label>
          <label>Qty <input id="mQty" inputmode="numeric" value="1" ${off}></label>
          <label>Time <input id="mTime" type="time" value="${nowHM()}" ${off}></label>
          <label>Time on board <input id="mOnBoard" type="time" ${off}></label>
          <label>Item no. <input id="mNo" placeholder="Item no." ${off}></label>
          <label>Old item no. back <input id="mOld" placeholder="Worn item no." ${off}></label>
          <label>Block / hole no. <input id="mBlock" placeholder="Block / hole" ${off}></label>
          <label>Received by <input id="mBy" placeholder="Name" ${off}></label>
          <div style="grid-column:1/-1"><button class="primary" type="submit" style="width:100%" ${off}>Add movement</button></div>
        </form>
        <div id="moveErr" class="flag" style="margin-top:8px"></div>
      </section>
      <section class="card">
        <h2>Movements this shift</h2>
        <div class="moves">${moves}</div>
        <h3>D. Lost in hole</h3>
        <p class="muted" style="margin:0">${lost.length ? `${lost.length} line${lost.length === 1 ? "" : "s"} lost in hole. The supervisor signs at the bottom.` : "Nothing lost in hole. Choose “Lost in hole” as the movement if a bit or rod stays in the hole."}</p>
      </section>
    </div>

    <section class="card">
      <h2>C. On each rig at end of shift</h2>
      <div class="tbl wide"><table>
        <thead><tr><th>Rig</th><th>Bits</th><th>Bit no.</th><th>Rods</th><th>Shanks</th><th>Shank no.</th><th>Time on board</th></tr></thead>
        <tbody>${rigRows}</tbody></table></div>
    </section>

    <section class="card">
      <h2>Sign-off</h2>
      <label style="margin-bottom:12px">Comments <textarea data-f="comments" rows="2" ${off}>${esc(s.comments)}</textarea></label>
      <div class="grid">
        <label>GET operator ${field("signOperator", s.signOperator, 'placeholder="Full name"')}</label>
        <label>Shift supervisor ${field("signSupervisor", s.signSupervisor, 'placeholder="Full name"')}</label>
        <label>Store controller (items back) ${field("signStore", s.signStore, 'placeholder="Full name"')}</label>
      </div>
      <div class="row" style="margin-top:12px;justify-content:space-between">
        ${s.closed ? `<span></span><button id="reopen">Reopen shift</button>` : `<button class="danger" id="delShift">Delete shift</button><button class="primary" id="close">Close shift</button>`}
      </div>
      <div id="closeMsg" class="flag" style="margin-top:6px"></div>
    </section>`;
  toggleRig();
}

function toggleRig() { const t = $("#mType"); if (t) $("#rigWrap").hidden = !TYPES[t.value].rig; }
function setStatus(m) { statusMsg = m; const el = $("#status"); if (el) el.textContent = m; }

/* ---------- saving ---------- */
async function save(msg = "Saved " + nowHM()) {
  clearTimeout(saveTimer);
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
function buildWorkbook(list) {
  const XL = window.XLSX, wb = XL.utils.book_new(), rows = logRows(list);
  const chron = list.slice().reverse();
  // Sum up
  const t = {}; ITEMS.forEach(i => t[i] = { received: 0, fitted: 0, returned: 0, back: 0, lost: 0 });
  const perRig = {}; RIGS.forEach(r => { perRig[r] = {}; ITEMS.forEach(i => perRig[r][i] = 0); });
  rows.forEach(({ m }) => { if (t[m.item]) t[m.item][m.type] += Number(m.qty) || 0; if (m.type === "fitted" && perRig[m.rig]) perRig[m.rig][m.item] += Number(m.qty) || 0; });
  const lastShift = list[0], lb = lastShift ? balance(lastShift) : null;
  const sum = [
    ["TKR Operations – GET Bakkie Log"],
    ["Sum up from " + fmtDate(range.from) + " to " + fmtDate(range.to)],
    ["Shifts logged", list.length, "", "Movements logged", rows.length],
    [],
    ["Item", "Received from store", "Fitted on rigs", "Old items back from rigs", "Handed back to store", "Lost in hole", "In bakkie at end of last shift"],
    ...ITEMS.map(i => [i, t[i].received, t[i].fitted, t[i].returned, t[i].back, t[i].lost, lb ? lb[i].end : 0]),
    [],
    ["Fitted per rig", ...ITEMS],
    ...RIGS.map(r => [r, ...ITEMS.map(i => perRig[r][i])]),
  ];
  if (lastShift) {
    sum.push([], ["On each rig at end of last shift (" + fmtDate(lastShift.date) + " " + lastShift.shift + ")"], ["Rig", "Bits", "Bit no.", "Rods", "Shanks", "Shank no."]);
    RIGS.forEach(r => { const g = lastShift.rigs?.[r] || {}; sum.push([r, num(g.bits), g.bitNo || "", num(g.rods), num(g.shanks), g.shankNo || ""]); });
  }
  const ws1 = XL.utils.aoa_to_sheet(sum); ws1["!cols"] = [{ wch: 26 }, ...Array(6).fill({ wch: 18 })];
  XL.utils.book_append_sheet(wb, ws1, "Sum up");
  // Shifts
  const sh = [["Date", "Shift", "GET operator", "Bakkie no.", "Supervisor", "Time out of store", "Time back at store", "Handed over by", "Taken over by", "Handover time", "Counts checked", "Handover notes", "Movements", "Comments", "Signed GET operator", "Signed supervisor", "Signed store controller", "Status"]];
  chron.forEach(s => { const h = s.handover || {}; sh.push([fmtDate(s.date), s.shift, s.operator, s.bakkie, s.supervisor, s.timeOut, s.timeBack, h.handedBy, h.takenBy, h.time, h.checked, h.notes, (s.moves || []).length, s.comments, s.signOperator, s.signSupervisor, s.signStore, s.closed ? "Closed" : "Open"]); });
  const ws2 = XL.utils.aoa_to_sheet(sh); ws2["!cols"] = sh[0].map(() => ({ wch: 16 }));
  XL.utils.book_append_sheet(wb, ws2, "Shifts");
  // Movements
  const mv = [["Date", "Shift", "Time", "Time on board", "Movement", "Rig", "Item", "Qty", "Item no.", "Old item no. returned", "Block / hole", "Received by", "GET operator", "Bakkie no."]];
  rows.forEach(({ s, m }) => mv.push([fmtDate(s.date), s.shift, m.time, m.onBoard, TYPES[m.type]?.label || m.type, m.rig, m.item, Number(m.qty) || 0, m.itemNo, m.oldNo, m.block, m.by, s.operator, s.bakkie]));
  const ws3 = XL.utils.aoa_to_sheet(mv); ws3["!cols"] = mv[0].map(() => ({ wch: 16 }));
  XL.utils.book_append_sheet(wb, ws3, "Movements");
  // Bakkie and rig counts per shift
  const bk = [["Date", "Shift", "Item", "Start qty", "Time on board", "Received", "Fitted", "Old back", "To store", "Lost in hole", "End qty", "Item numbers"]];
  chron.forEach(s => { const b = balance(s); ITEMS.forEach(i => { const st = s.start?.[i] || {}; if (b[i].start || b[i].received || b[i].fitted || b[i].returned || b[i].back || b[i].lost || st.nos)
    bk.push([fmtDate(s.date), s.shift, i, b[i].start, st.time || "", b[i].received, b[i].fitted, b[i].returned, b[i].back, b[i].lost, b[i].end, st.nos || ""]); }); });
  const rg = [["Date", "Shift", "Rig", "Bits", "Bit no.", "Rods", "Shanks", "Shank no.", "Time on board"]];
  chron.forEach(s => RIGS.forEach(r => { const g = s.rigs?.[r] || {}; if (g.bits || g.rods || g.shanks || g.bitNo || g.shankNo) rg.push([fmtDate(s.date), s.shift, r, num(g.bits), g.bitNo || "", num(g.rods), num(g.shanks), g.shankNo || "", g.time || ""]); }));
  const ws4 = XL.utils.aoa_to_sheet(bk); ws4["!cols"] = bk[0].map(() => ({ wch: 14 }));
  XL.utils.book_append_sheet(wb, ws4, "Bakkie per shift");
  const ws5 = XL.utils.aoa_to_sheet(rg); ws5["!cols"] = rg[0].map(() => ({ wch: 14 }));
  XL.utils.book_append_sheet(wb, ws5, "Rigs per shift");
  return wb;
}
function num(v) { return v === "" || v == null ? "" : (isNaN(Number(v)) ? v : Number(v)); }

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
app.addEventListener("click", async e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.view) { view = t.dataset.view; render(); return; }
  if (t.dataset.open) { current = structuredClone(shifts.find(x => x.id === t.dataset.open)); statusMsg = ""; render(); scrollTo(0, 0); return; }
  if (t.id === "back") { if (saveTimer) await save(); current = null; render(); return; }
  if (t.id === "newShift") {
    const open = shifts.find(x => !x.closed);
    if (open && !confirm(`The ${fmtDate(open.date)} ${open.shift} shift is still open. Start the next shift anyway?`)) return;
    current = newShift(); await save("Shift started"); render(); scrollTo(0, 0); return;
  }
  if (t.id === "xlsx") {
    const list = inRange();
    if (!list.length) { alert("There are no shifts in these dates."); return; }
    const out = XLSX.write(buildWorkbook(list), { bookType: "xlsx", type: "array" });
    const blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await shareOrDownload(blob, `TKR_GET_Bakkie_Log_${fmtDate(range.from).replace(/\//g, "-")}_to_${fmtDate(range.to).replace(/\//g, "-")}.xlsx`);
    return;
  }
  if (t.id === "backup") {
    const blob = new Blob([JSON.stringify({ app: "tkr-get-bakkie-log", version: 1, made: new Date().toISOString(), shifts }, null, 1)], { type: "application/json" });
    const r = await shareOrDownload(blob, `TKR_GET_Bakkie_Log_Backup_${fmtDate(isoDate(new Date())).replace(/\//g, "-")}.json`);
    if (r !== "cancelled") { localSet("lastBackup", fmtDate(isoDate(new Date())) + " " + nowHM()); render(); }
    return;
  }
  if (t.id === "restoreBtn") { $("#restoreFile").click(); return; }
  if (t.dataset.del) { current.moves = (current.moves || []).filter(m => m.id !== t.dataset.del); await save("Movement removed"); render(); return; }
  if (t.id === "delShift") {
    if (!confirm("Delete this whole shift and all its movements? This cannot be undone.")) return;
    await store.del(current.id); shifts = shifts.filter(x => x.id !== current.id); current = null; render(); return;
  }
  if (t.id === "close") {
    if (!current.signOperator || !current.signSupervisor) { $("#closeMsg").textContent = "Type the GET operator and supervisor names before closing the shift."; return; }
    current.timeBack = current.timeBack || nowHM(); current.closed = true; await save("Shift closed"); render(); return;
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
  if (e.target.id !== "moveForm") return;
  e.preventDefault();
  const type = $("#mType").value, qty = Number($("#mQty").value);
  if (!Number.isInteger(qty) || qty <= 0) { $("#moveErr").textContent = "Type the quantity as a whole number, for example 1."; return; }
  const m = { id: newId(), type, item: $("#mItem").value, qty, time: $("#mTime").value || nowHM(), onBoard: $("#mOnBoard").value,
    rig: TYPES[type].rig ? $("#mRig").value : "", itemNo: $("#mNo").value.trim(), oldNo: $("#mOld").value.trim(), block: $("#mBlock").value.trim(), by: $("#mBy").value.trim() };
  if (type === "fitted" || type === "back") {
    const b = balance(current)[m.item];
    if (qty > b.end) { $("#moveErr").textContent = `Only ${b.end} ${m.item.toLowerCase()} in the bakkie. Log what came from the store first.`; return; }
  }
  current.moves = [...(current.moves || []), m];
  await save("Movement added " + m.time); render();
});
addEventListener("pagehide", () => { if (saveTimer && current) save(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && saveTimer && current) save(); });

/* ---------- install button + offline ---------- */
let installEvt = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("#installBtn").hidden = false; });
$("#installBtn").addEventListener("click", async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("#installBtn").hidden = true; });
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));

(async () => {
  try {
    await store.open(); shifts = await store.all();
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    render();
  } catch { app.innerHTML = `<div class="card notice">This browser cannot save records. Open the app in Chrome.</div>`; }
})();
