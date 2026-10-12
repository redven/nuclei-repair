# Nuclei Repair (iPad)

Repair nuclei segmentation crops with the Apple Pencil. The workstation exports
crop windows into a Google Drive folder; this web app repairs them with the
workstation's own repair code (`py/label_repair.py`, run in the browser by
Pyodide) and writes the committed crops back into the same folder, in the
training format; the workstation imports them.

```
G:/My Drive/MORPHISTO repair/batches/<batch>/
    batch.json   crops/   <- written by the workstation (D_label_repair, section 2)
    repaired/    status/  <- written by the iPad app
```

Image data stays in your Drive and on the iPad. Only the app's code is on
GitHub Pages.

## Using it

- **Workstation:** `notebooks/D_label_repair.ipynb`. Section 1 loads the data,
  section 2 exports the masks selected in napari, section 3 imports what the
  iPad committed.
- **iPad:** open the app from the Home Screen and sign in. Pick a batch, then
  repair each crop. When you are done, **Commit** it, or **Skip** a bad one.
  - **Apple Pencil:** draws with the current tool. One finger pans, two
    fingers zoom, and a double tap with a finger fits the view.
  - **Tools:** Paint, Erase, Pick (take the label under the Pencil), New
    (a new label), Cut (draw across a mask to split it), Merge / Merge 3D (tap
    the mask to keep, then the one to merge into it), Delete / Delete 3D,
    Relabel (a new label in this plane), and Undo.
  - **What a commit keeps:** the whole crop in XY, and the Z planes of the
    edited masks and of the crop's own mask.
  - **Offline:** commits made offline wait in the app and upload when you
    tap the orange note.

## One-time setup

### 1. Publish the app (GitHub Pages)

1. Create an empty **public** repository on GitHub, e.g. `nuclei-repair`.
2. Clone it next to the project, e.g. `D:/claude/nuclei-repair-pages`.
3. Run `python ipad_repair/deploy.py --repo D:/claude/nuclei-repair-pages`.
   This builds the app, copies it into the clone, commits and pushes.
4. On GitHub, open Settings > Pages and choose *Deploy from a branch*,
   `main`, `/ (root)`. The app is then at
   `https://<your-user>.github.io/nuclei-repair/`.

### 2. Allow it to read and write your Drive folder (Google Cloud, about 15 min)

1. Go to <https://console.cloud.google.com/> and create a project, e.g.
   *Nuclei Repair*.
2. Under *APIs & Services > Library*, enable the **Google Drive API**.
3. Under *Google Auth Platform*, set up the app:
   - **Branding:** an app name and your email.
   - **Audience:** *External*, and add your Google account under
     *Test users*. The app stays in testing mode, so only test users can
     sign in.
   - **Data Access:** add the scopes `.../auth/drive.readonly` and
     `.../auth/drive.file`.
4. Under *Clients*, choose *Create client* > *Web application*:
   - *Authorized JavaScript origins:* `https://<your-user>.github.io`, and
     `http://localhost:8765` for local tests.
   - Copy the **Client ID**.
5. Put the Client ID into `ipad_repair/config.js` (`googleClientId`) and run
   `deploy.py` again.

The Client ID is not a secret; it only works from the origins listed in step 4.

### 3. Install it on the iPad

1. Open the app's address in Safari.
2. Choose *Share > Add to Home Screen*, then open it from the Home Screen.
3. Sign in with Google. Use the account whose Drive holds `MORPHISTO repair`;
   that folder appears with the first export.

The first start downloads Python, about 35 MB; after that it starts from the
iPad's cache, also offline.

## Development

- **Desktop browser:** run
  `python ipad_repair/dev_server.py --exchange "G:/My Drive/MORPHISTO repair"`
  and open `http://localhost:8765/?store=local`. This is the same app, reading
  and writing a local exchange folder.
- **On the local network:** add `--host 0.0.0.0` and open
  `http://<workstation>:8765/?store=local` on the iPad. That works online only;
  the Home Screen install needs https.
- **Building:** `build.py` copies `src/label_repair.py` into `py/` (the one
  source of truth), fetches the tifffile wheel and draws the icons.
  `dev_server.py` and `deploy.py` run it automatically.
- **Tests:** `tests/test_ipad_batches.py` covers the batch export, the repair
  session (`py/repair_core.py`) and the import.
