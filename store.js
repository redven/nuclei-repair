// ipad_repair/store.js
// Where batches come from and commits go to: the Google Drive exchange folder
// (DriveStore) or, for testing and the local network, dev_server.py
// (LocalStore).  Both offer the same calls; paths are relative to the
// exchange folder ("batches/<batch>/crops/<file>").  Commits go through an
// outbox kept in the browser, so a commit made offline uploads later.

import { CONFIG } from './config.js';

const FOLDER = 'application/vnd.google-apps.folder';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

// ------------------------------------------------------------------ Drive
export class DriveStore {
  constructor() {
    this.kind = 'drive';
    this.token = null;
    this.expires = 0;
    this.ids = new Map();               // path -> file id
  }

  get signedIn() { return this.token && Date.now() < this.expires - 60_000; }

  // Must run inside a user gesture: Safari blocks the sign-in popup otherwise.
  signIn() {
    return new Promise((resolve, reject) => {
      if (!CONFIG.googleClientId) {
        reject(new Error('No Google client ID in config.js (see README)'));
        return;
      }
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.googleClientId,
        scope: CONFIG.scopes,
        prompt: this.token ? '' : 'consent',
        callback: (r) => {
          if (r.error) { reject(new Error(r.error)); return; }
          this.token = r.access_token;
          this.expires = Date.now() + (Number(r.expires_in) || 3600) * 1000;
          resolve();
        },
        error_callback: (e) => reject(new Error(e.message || e.type || 'sign-in failed')),
      });
      client.requestAccessToken();
    });
  }

  async _fetch(url, options = {}) {
    if (!this.signedIn) throw new Error('signed out');
    const r = await fetch(url, { ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${this.token}` } });
    if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r;
  }

  async _children(parentId, query = '') {
    const files = [];
    let page = '';
    do {
      const q = encodeURIComponent(`'${parentId}' in parents and trashed=false${query}`);
      const r = await this._fetch(`${API}?q=${q}&pageSize=1000&fields=nextPageToken,` +
        `files(id,name,mimeType,modifiedTime)${page ? `&pageToken=${page}` : ''}`);
      const body = await r.json();
      files.push(...body.files);
      page = body.nextPageToken || '';
    } while (page);
    return files;
  }

  async _id(path, create = false) {
    if (this.ids.has(path)) return this.ids.get(path);
    const parts = path.split('/').filter(Boolean);
    let id;
    if (!parts.length) {
      const q = encodeURIComponent(`name='${CONFIG.exchangeFolder}' and mimeType='${FOLDER}' ` +
                                   `and trashed=false`);
      const r = await (await this._fetch(`${API}?q=${q}&fields=files(id)`)).json();
      if (!r.files.length) throw new Error(`no folder "${CONFIG.exchangeFolder}" in your Drive`);
      id = r.files[0].id;
    } else {
      const parent = await this._id(parts.slice(0, -1).join('/'), create);
      const name = parts[parts.length - 1];
      const hit = (await this._children(parent, ` and name='${name.replace(/'/g, "\\'")}'`))[0];
      if (hit) id = hit.id;
      else if (create) {
        const r = await this._fetch(API, { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, mimeType: FOLDER, parents: [parent] }) });
        id = (await r.json()).id;
      } else return null;
    }
    this.ids.set(path, id);
    return id;
  }

  async list(path) {
    const id = await this._id(path);
    if (!id) return [];
    return (await this._children(id)).map((f) => ({ name: f.name, dir: f.mimeType === FOLDER }));
  }

  async read(path) {
    const id = await this._id(path);
    if (!id) throw new Error(`missing: ${path}`);
    return new Uint8Array(await (await this._fetch(`${API}/${id}?alt=media`)).arrayBuffer());
  }

  async write(path, bytes, mime = 'application/octet-stream') {
    const parts = path.split('/');
    const name = parts.pop();
    const parent = await this._id(parts.join('/'), true);
    const existing = (await this._children(parent, ` and name='${name}'`))[0];
    if (existing) {                       // status files are rewritten
      await this._fetch(`${UPLOAD}/${existing.id}?uploadType=media`,
                        { method: 'PATCH', headers: { 'Content-Type': mime }, body: bytes });
      return;
    }
    const boundary = `nuclei${Math.random().toString(16).slice(2)}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify({ name, parents: [parent] }),
      `\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, bytes, `\r\n--${boundary}--`]);
    const r = await this._fetch(`${UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    this.ids.set(path, (await r.json()).id);
  }
}

// ------------------------------------------------------------------ local
export class LocalStore {
  constructor(base = '/exchange/') {
    this.kind = 'local';
    this.base = base;
    this.signedIn = true;
  }

  async signIn() {}

  async list(path) {
    const r = await fetch(this.base + path.replace(/\/?$/, '/'));
    return r.ok ? r.json() : [];
  }

  async read(path) {
    const r = await fetch(this.base + path);
    if (!r.ok) throw new Error(`missing: ${path}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async write(path, bytes) {
    const r = await fetch(this.base + path, { method: 'PUT', body: bytes });
    if (!r.ok) throw new Error(`upload failed (${r.status}): ${path}`);
  }
}

// ------------------------------------------------------------------ on the iPad
// The outbox keeps commits until every file is uploaded; drafts keep the
// uncommitted edits of each crop, so leaving a crop -- or iOS closing the
// app -- loses nothing.
const DB = 'nuclei-repair';
let opened = null;

function db() {
  if (!opened) {
    opened = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('outbox')) {
          d.createObjectStore('outbox', { autoIncrement: true });
        }
        if (!d.objectStoreNames.contains('drafts')) d.createObjectStore('drafts');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return opened;
}

function request(name, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(name, mode);
    const req = fn(t.objectStore(name));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}

export const drafts = {
  get: (key) => request('drafts', 'readonly', (s) => s.get(key)),
  put: (key, value) => request('drafts', 'readwrite', (s) => s.put(value, key)),
  remove: (key) => request('drafts', 'readwrite', (s) => s.delete(key)),
  keys: () => request('drafts', 'readonly', (s) => s.getAllKeys()),
};

let flushing = null;

export const outbox = {
  add: (entry) => request('outbox', 'readwrite', (s) => s.add(entry)),
  async entries() {
    const d = await db();
    return new Promise((resolve, reject) => {
      const items = [];
      const req = d.transaction('outbox').objectStore('outbox').openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (c) { items.push({ key: c.key, ...c.value }); c.continue(); } else resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  },
  remove: (key) => request('outbox', 'readwrite', (s) => s.delete(key)),
  async count() { return (await this.entries()).length; },

  // A file still waiting to upload (a commit reopened before it reached Drive);
  // the newest, if the crop was committed again meanwhile.
  async find(path) {
    let bytes = null;
    for (const entry of await this.entries()) {
      const hit = entry.files.find((f) => f.path === path);
      if (hit) bytes = hit.bytes;
    }
    return bytes;
  },

  // Upload what is waiting, one flush at a time; returns the number left.
  flush(store) {
    if (!flushing) {
      flushing = (async () => {
        for (const entry of await this.entries()) {
          try {
            for (const f of entry.files) await store.write(f.path, f.bytes, f.mime);
            await this.remove(entry.key);
          } catch (e) {
            console.warn('outbox:', e);
            break;
          }
        }
        return this.count();
      })().finally(() => { flushing = null; });
    }
    return flushing;
  },
};
