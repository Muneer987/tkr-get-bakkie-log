/* Every export in the TKR app ends here: the file is saved to the phone or PC, then a bar offers
   "Email a copy" (opens Gmail, Outlook or WhatsApp with the file attached, sent to muneer@tkroperations.com)
   and "Done". Done runs the section's clean-up (clearing that phone's copy), when the section gives one. */
export const COPY_TO = "muneer@tkroperations.com";

function save(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

export function deliver(blob, name, { onDone, doneLabel = "Done" } = {}) {
  save(blob, name);
  document.getElementById("tkr-deliver")?.remove();
  const bar = document.createElement("div"); bar.id = "tkr-deliver";
  bar.setAttribute("role", "dialog"); bar.setAttribute("aria-label", "Export saved");
  bar.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(14px + env(safe-area-inset-bottom,0px));z-index:50;width:min(560px,calc(100% - 24px));" +
    "background:#111;color:#f2efe8;border:2px solid #d4a12a;border-radius:12px;padding:14px 16px;box-shadow:0 8px 28px rgba(0,0,0,.35);font:15px/1.4 Roboto,'Segoe UI',Arial,sans-serif";
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const btn = "font:inherit;font-weight:600;border-radius:8px;min-height:44px;padding:8px 14px;cursor:pointer;";
  bar.innerHTML = `<div style="font-weight:700;color:#d4a12a;margin-bottom:2px">Saved to your downloads</div>
    <div style="font-size:13.5px;color:#cfc8b8;word-break:break-word;margin-bottom:10px">${esc(name)}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button type="button" data-act="mail" style="${btn}background:#d4a12a;color:#141006;border:1px solid #d4a12a;flex:1 1 220px">Email a copy to ${COPY_TO}</button>
      <button type="button" data-act="done" style="${btn}background:transparent;color:#f2efe8;border:1px solid #6b6558;flex:0 1 auto">${esc(doneLabel)}</button>
    </div><div data-note style="font-size:13px;color:#cfc8b8;margin-top:8px"></div>`;
  document.body.appendChild(bar);
  const note = t => { bar.querySelector("[data-note]").textContent = t; };
  bar.addEventListener("click", async e => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.act === "mail") {
      const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
      const subject = "TKR export: " + name;
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { try { await navigator.clipboard?.writeText(COPY_TO); } catch {}
          note(`Choose Gmail or Outlook. ${COPY_TO} is copied, so paste it in the To box if it is empty.`);
          await navigator.share({ files: [file], title: subject, text: `${subject}\nFor ${COPY_TO}` }); note("Sent to the share menu. Check it went in your email app."); }
        catch (x) { if (x.name !== "AbortError") note("Sharing didn't open. Attach the file from your downloads in an email to " + COPY_TO + "."); }
      } else {
        location.href = `mailto:${COPY_TO}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent("The export " + name + " is attached.\n\n(Attach it from your Downloads folder.)")}`;
        note("Your email opened. Attach the file from your Downloads folder, then send.");
      }
      return;
    }
    if (b.dataset.act === "done") {
      b.disabled = true;
      try { if (onDone) { note("Clearing this phone's copy…"); await onDone(); } } catch (x) { console.warn(x); }
      bar.remove();
    }
  });
}

/* Clear a section's copy on this phone (the Firestore offline copy). Only once every change has reached Firebase,
   so nothing that was typed without signal is lost. The page then reloads from Firebase. */
export async function clearPhoneCopy(fb, dbs, toast) {
  if (!navigator.onLine) { toast?.("No signal, so this phone's copy is kept. It clears after the next export with signal."); return false; }
  try {
    for (const db of dbs) await Promise.race([fb.waitForPendingWrites(db), new Promise((_, rej) => setTimeout(() => rej(new Error("slow")), 15000))]);
  } catch { toast?.("Some changes are still sending, so this phone's copy is kept for now."); return false; }
  try { for (const db of dbs) { await fb.terminate(db); await fb.clearIndexedDbPersistence(db); } }
  catch (x) { console.warn(x); toast?.("Close the app in other tabs, then export again to clear this phone's copy."); setTimeout(() => location.reload(), 1800); return false; }
  toast?.("This phone's copy is cleared. Everything is still in Firebase."); setTimeout(() => location.reload(), 1200); return true;
}
