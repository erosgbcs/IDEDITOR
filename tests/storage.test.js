'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IDEditorProjectStorage } = require('../project-storage.js');

function makeLocalStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class FakeTransaction {
  constructor(database, storeNames) {
    this.database = database;
    this.storeNames = storeNames;
    this.pending = 0;
    this.completed = false;
    this.completionScheduled = false;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
  }

  objectStore(name) {
    if (!this.storeNames.includes(name)) throw new Error('Store is not part of this transaction');
    const records = this.database.stores.get(name);
    if (!records) throw new Error('Object store does not exist: ' + name);
    return new FakeObjectStore(this, name, records, this.database.keyPaths.get(name));
  }

  request(operation) {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.pending += 1;
    queueMicrotask(() => {
      try {
        request.result = operation();
        if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
      } catch (error) {
        request.error = error;
        if (typeof request.onerror === 'function') request.onerror({ target: request });
        this.completed = true;
        if (typeof this.onerror === 'function') this.onerror({ target: this });
        if (typeof this.onabort === 'function') this.onabort({ target: this });
      }
      this.pending -= 1;
      this.scheduleCompletion();
    });
    return request;
  }

  scheduleCompletion() {
    if (this.pending !== 0 || this.completionScheduled || this.completed) return;
    this.completionScheduled = true;
    queueMicrotask(() => {
      if (this.pending === 0 && !this.completed) {
        this.completed = true;
        if (typeof this.oncomplete === 'function') this.oncomplete({ target: this });
      } else {
        this.completionScheduled = false;
        this.scheduleCompletion();
      }
    });
  }
}

class FakeObjectStore {
  constructor(transaction, name, records, keyPath) {
    this.transaction = transaction;
    this.name = name;
    this.records = records;
    this.keyPath = keyPath;
  }

  put(value) {
    return this.transaction.request(() => {
      const key = value[this.keyPath];
      this.records.set(key, copy(value));
      return key;
    });
  }

  get(key) {
    return this.transaction.request(() => copy(this.records.get(key)));
  }

  getAll() {
    return this.transaction.request(() => Array.from(this.records.values()).map(copy));
  }

  clear() {
    return this.transaction.request(() => this.records.clear());
  }

  delete(key) {
    return this.transaction.request(() => this.records.delete(key));
  }
}

class FakeDatabase {
  constructor() {
    this.stores = new Map();
    this.keyPaths = new Map();
    this.objectStoreNames = { contains: name => this.stores.has(name) };
  }

  createObjectStore(name, options = {}) {
    this.stores.set(name, new Map());
    this.keyPaths.set(name, options.keyPath || 'id');
    return {};
  }

  transaction(names) {
    return new FakeTransaction(this, Array.isArray(names) ? names : [names]);
  }

  close() {}
}

class FakeIndexedDB {
  constructor() {
    this.database = null;
  }

  open() {
    const request = {};
    queueMicrotask(() => {
      const needsUpgrade = !this.database;
      if (needsUpgrade) this.database = new FakeDatabase();
      request.result = this.database;
      if (needsUpgrade && typeof request.onupgradeneeded === 'function') {
        request.onupgradeneeded({ target: request });
      }
      queueMicrotask(() => {
        if (typeof request.onsuccess === 'function') request.onsuccess({ target: request });
      });
    });
    return request;
  }
}

test('legacy localStorage projects migrate to IndexedDB before the legacy key is removed', async () => {
  const legacy = {
    currentProjectId: 'active',
    projects: {
      active: {
        name: 'Current workspace',
        files: { 'index.html': { lang: 'html', content: '<h1>Keep me</h1>' } },
        updatedAt: 123,
        gitTracking: { branch: 'main' }
      },
      archive: {
        name: 'Archive',
        files: { 'notes.md': { lang: 'markdown', content: 'Saved notes' } },
        updatedAt: 100
      }
    }
  };
  const localStorage = makeLocalStorage({ 'idEditor.projectsData': JSON.stringify(legacy) });
  const indexedDB = new FakeIndexedDB();
  const storage = new IDEditorProjectStorage({ indexedDB, localStorage });

  const migrated = await storage.open();
  assert.equal(storage.mode, 'indexedDB');
  assert.deepEqual(migrated.projects, legacy.projects);
  assert.equal(migrated.currentProjectId, 'active');
  assert.equal(localStorage.getItem('idEditor.projectsData'), null);

  const reloaded = await new IDEditorProjectStorage({ indexedDB, localStorage }).open();
  assert.deepEqual(reloaded.projects, legacy.projects);
  assert.equal(reloaded.currentProjectId, 'active');
});

test('IndexedDB saves update one project and retain the other project records', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = makeLocalStorage();
  const storage = new IDEditorProjectStorage({ indexedDB, localStorage });
  await storage.open();
  await storage.saveAll({
    alpha: { name: 'Alpha', files: { 'index.html': { content: 'A' } } },
    beta: { name: 'Beta', files: { 'index.html': { content: 'B' } } }
  }, 'alpha');

  await storage.saveProject('alpha', {
    name: 'Alpha updated',
    files: { 'index.html': { content: 'A2' } }
  }, 'alpha');

  const loaded = await new IDEditorProjectStorage({ indexedDB, localStorage }).open();
  assert.equal(loaded.projects.alpha.name, 'Alpha updated');
  assert.equal(loaded.projects.alpha.files['index.html'].content, 'A2');
  assert.equal(loaded.projects.beta.files['index.html'].content, 'B');
  assert.equal(loaded.currentProjectId, 'alpha');
});

test('project deletion removes the record and keeps the stored project order consistent', async () => {
  const indexedDB = new FakeIndexedDB();
  const storage = new IDEditorProjectStorage({ indexedDB, localStorage: makeLocalStorage() });
  await storage.open();
  await storage.saveAll({ first: { name: 'First' }, second: { name: 'Second' } }, 'first');
  await storage.deleteProject('first', 'second');

  const loaded = await new IDEditorProjectStorage({ indexedDB, localStorage: makeLocalStorage() }).open();
  assert.deepEqual(Object.keys(loaded.projects), ['second']);
  assert.equal(loaded.currentProjectId, 'second');
});

test('localStorage fallback preserves the legacy workspace when IndexedDB is unavailable', async () => {
  const legacy = {
    currentProjectId: 'project-a',
    projects: { 'project-a': { name: 'Legacy', files: { 'index.html': { content: 'saved' } } } }
  };
  const localStorage = makeLocalStorage({ 'idEditor.projectsData': JSON.stringify(legacy) });
  const storage = new IDEditorProjectStorage({ indexedDB: null, localStorage });

  const loaded = await storage.open();
  assert.equal(storage.mode, 'localStorage-fallback');
  assert.deepEqual(loaded.projects, legacy.projects);
  assert.notEqual(localStorage.getItem('idEditor.projectsData'), null);

  await storage.saveProject('project-a', {
    name: 'Updated legacy project',
    files: { 'index.html': { content: 'new content' } }
  }, 'project-a');

  const persisted = JSON.parse(localStorage.getItem('idEditor.projectsData'));
  assert.equal(persisted.projects['project-a'].files['index.html'].content, 'new content');
  assert.equal(persisted.currentProjectId, 'project-a');
});

test('failed IndexedDB open keeps the legacy backup untouched and loads it through fallback', async () => {
  const legacy = {
    currentProjectId: 'safe',
    projects: { safe: { name: 'Safe copy', files: {} } }
  };
  const localStorage = makeLocalStorage({ 'idEditor.projectsData': JSON.stringify(legacy) });
  const brokenIndexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.error = new Error('database blocked');
        if (typeof request.onerror === 'function') request.onerror({ target: request });
      });
      return request;
    }
  };
  const storage = new IDEditorProjectStorage({ indexedDB: brokenIndexedDB, localStorage });
  const loaded = await storage.open();

  assert.equal(storage.mode, 'localStorage-fallback');
  assert.deepEqual(loaded.projects, legacy.projects);
  assert.notEqual(localStorage.getItem('idEditor.projectsData'), null);
});


test('legacy recovery merges missing projects and keeps the newest project version', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = makeLocalStorage();
  const initialStorage = new IDEditorProjectStorage({ indexedDB, localStorage });
  await initialStorage.open();
  await initialStorage.saveAll({
    current: { name: 'Current DB copy', updatedAt: 300, files: { 'index.html': { content: 'database-newer' } } },
    shared: { name: 'Shared DB copy', updatedAt: 100, files: { 'index.html': { content: 'database-older' } } }
  }, 'current');

  const legacy = {
    currentProjectId: 'shared',
    projects: {
      current: { name: 'Stale backup copy', updatedAt: 200, files: { 'index.html': { content: 'backup-older' } } },
      shared: { name: 'Newer backup copy', updatedAt: 200, files: { 'index.html': { content: 'backup-newer' } } },
      recovered: { name: 'Recovered project', updatedAt: 250, files: { 'notes.md': { content: 'not lost' } } }
    }
  };
  localStorage.setItem('idEditor.projectsData', JSON.stringify(legacy));

  const recovered = await new IDEditorProjectStorage({ indexedDB, localStorage }).open();
  assert.equal(recovered.projects.current.files['index.html'].content, 'database-newer');
  assert.equal(recovered.projects.shared.files['index.html'].content, 'backup-newer');
  assert.equal(recovered.projects.recovered.files['notes.md'].content, 'not lost');
  assert.equal(recovered.currentProjectId, 'current');
  assert.equal(localStorage.getItem('idEditor.projectsData'), null);
});

test('saveAll upserts projects without erasing records absent from a stale tab snapshot', async () => {
  const indexedDB = new FakeIndexedDB();
  const storage = new IDEditorProjectStorage({ indexedDB, localStorage: makeLocalStorage() });
  await storage.open();
  await storage.saveAll({
    first: { name: 'First', updatedAt: 1 },
    second: { name: 'Second', updatedAt: 2 }
  }, 'first');

  // Simulate another tab adding a project after this tab loaded its snapshot.
  await storage.saveProject('other-tab', { name: 'Created in another tab', updatedAt: 3 }, 'other-tab');
  await storage.saveAll({ first: { name: 'First updated', updatedAt: 4 } }, 'first');

  const loaded = await new IDEditorProjectStorage({ indexedDB, localStorage: makeLocalStorage() }).open();
  assert.equal(loaded.projects.first.name, 'First updated');
  assert.equal(loaded.projects.second.name, 'Second');
  assert.equal(loaded.projects['other-tab'].name, 'Created in another tab');
});


test('legacy backup cleanup failure does not force a stale localStorage fallback', async () => {
  const legacy = {
    currentProjectId: 'active',
    projects: { active: { name: 'Backup', updatedAt: 10, files: { 'index.html': { content: 'safe' } } } }
  };
  const localStorage = makeLocalStorage({ 'idEditor.projectsData': JSON.stringify(legacy) });
  const originalRemove = localStorage.removeItem.bind(localStorage);
  localStorage.removeItem = () => { throw new Error('storage cleanup blocked'); };
  const indexedDB = new FakeIndexedDB();
  const storage = new IDEditorProjectStorage({ indexedDB, localStorage });

  const loaded = await storage.open();
  assert.equal(storage.mode, 'indexedDB');
  assert.equal(loaded.projects.active.files['index.html'].content, 'safe');
  assert.match(storage.lastError.message, /cleanup blocked/);
  assert.notEqual(localStorage.getItem('idEditor.projectsData'), null);

  localStorage.removeItem = originalRemove;
});

test('bulk persistence does not replace a newer project with an older snapshot', async () => {
  const indexedDB = new FakeIndexedDB();
  const storage = new IDEditorProjectStorage({ indexedDB, localStorage: makeLocalStorage() });
  await storage.open();
  await storage.saveAll({
    shared: { name: 'Newest', updatedAt: 500, files: { 'index.html': { content: 'latest' } } }
  }, 'shared');
  await storage.saveAll({
    shared: { name: 'Stale tab', updatedAt: 100, files: { 'index.html': { content: 'old' } } },
    additional: { name: 'New project', updatedAt: 200, files: {} }
  }, 'shared');

  const loaded = await new IDEditorProjectStorage({ indexedDB, localStorage: makeLocalStorage() }).open();
  assert.equal(loaded.projects.shared.files['index.html'].content, 'latest');
  assert.equal(loaded.projects.additional.name, 'New project');
});


test('project deletions made in fallback mode do not reappear when IndexedDB recovers', async () => {
  const indexedDB = new FakeIndexedDB();
  const seed = new IDEditorProjectStorage({ indexedDB, localStorage: makeLocalStorage() });
  await seed.open();
  await seed.saveAll({
    active: { name: 'Active', updatedAt: 20, files: {} },
    deleted: { name: 'Deleted elsewhere', updatedAt: 10, files: {} }
  }, 'active');

  const localStorage = makeLocalStorage({
    'idEditor.projectsData': JSON.stringify({
      currentProjectId: 'active',
      projects: {
        active: { name: 'Active', updatedAt: 20, files: {} },
        deleted: { name: 'Deleted elsewhere', updatedAt: 10, files: {} }
      }
    })
  });
  const fallback = new IDEditorProjectStorage({ indexedDB: null, localStorage });
  await fallback.open();
  await fallback.deleteProject('deleted', 'active');

  const recovery = new IDEditorProjectStorage({ indexedDB, localStorage });
  const restored = await recovery.open();
  assert.deepEqual(Object.keys(restored.projects), ['active']);
  assert.equal(restored.currentProjectId, 'active');
  assert.equal(localStorage.getItem('idEditor.projectsData'), null);
});


test('background save without a selection change does not steal the active project', async () => {
  const indexedDB = new FakeIndexedDB();
  const storage = new IDEditorProjectStorage({ indexedDB, localStorage: makeLocalStorage() });
  await storage.open();
  await storage.saveAll({
    first: { name: 'First', updatedAt: 1 },
    second: { name: 'Second', updatedAt: 2 }
  }, 'first');

  await storage.saveProject('second', { name: 'Second edited', updatedAt: 3 });

  const loaded = await new IDEditorProjectStorage({ indexedDB, localStorage: makeLocalStorage() }).open();
  assert.equal(loaded.currentProjectId, 'first');
  assert.equal(loaded.projects.second.name, 'Second edited');
});

test('a migrated IndexedDB workspace is not replaced with an empty default when the database later becomes unavailable', async () => {
  const indexedDB = new FakeIndexedDB();
  const localStorage = makeLocalStorage();
  const original = new IDEditorProjectStorage({ indexedDB, localStorage });
  await original.open();
  await original.saveProject('saved', {
    name: 'Migrated workspace',
    updatedAt: 50,
    files: { 'index.html': { lang: 'html', content: '<h1>Still here</h1>' } }
  }, 'saved');

  const unavailableIndexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.error = new Error('database unavailable');
        if (typeof request.onerror === 'function') request.onerror({ target: request });
      });
      return request;
    }
  };
  const unavailable = new IDEditorProjectStorage({ indexedDB: unavailableIndexedDB, localStorage });
  await assert.rejects(unavailable.open(), /no legacy project backup is available/);
  assert.equal(localStorage.getItem('idEditor.projectsData'), null);

  const recovered = await new IDEditorProjectStorage({ indexedDB, localStorage }).open();
  assert.equal(recovered.projects.saved.files['index.html'].content, '<h1>Still here</h1>');
  assert.equal(recovered.currentProjectId, 'saved');
});
