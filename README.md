# TKR Operations app

One app with sections. Home screen: choose a section.

## GET Bakkie Log (get/) – works offline
The GET operator logs every bit, rod and shank that goes on or off the bakkie, shift by shift: trips to the store, movements, rig counts, photos, sign-off, Excel and zip export, backup. Records are saved on the device only.

## Attendance (attendance/) – shared online (Firebase), works offline
Mark the register, add or remove employees, daily and cycle reports, flags and Excel export. Moved in from the separate TKR Attendance app; same Firebase data. Firestore rules for it are in attendance/firestore-rules.txt.

## Daily Task Board (tasks/) – shared online (Firebase)
Each employee picks their name and updates their own tasks, with links to their work in Google Drive. Works with no signal and sends changes when the signal is back.
App admins (Muneer, Amogelang) sign in with "Manager sign in" to add employees and managers. Managers sign in to download the Excel export.

## Adding a section
Add one line to SECTIONS in index.html and a folder with the section's page, and add its files to sw.js.

## Install
Android / Honor: open the link in Chrome, tap Install app (or ⋮ → Install app).
iPhone / iPad: open it in Safari, tap Share → Add to Home Screen.
Windows PC: open it in Chrome or Edge, click the install icon in the address bar.
