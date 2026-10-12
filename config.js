// ipad_repair/config.js
// Fill in googleClientId after the one-time Google Cloud setup (README.md).
export const CONFIG = {
  version: '2026.10.12-2009',                    // bump on every deploy: refreshes the offline cache
  googleClientId: '228169122143-al91gjm1piilu5naluf1slvj7leia6i2.apps.googleusercontent.com',
  // the exchange folder in your Drive (the workstation writes G:/My Drive/<this>)
  exchangeFolder: 'MORPHISTO repair',
  // read the batches the workstation wrote; create the files the app commits
  scopes: 'https://www.googleapis.com/auth/drive.readonly ' +
          'https://www.googleapis.com/auth/drive.file',
  pyodide: 'https://cdn.jsdelivr.net/pyodide/v0.29.0/full/',
};
