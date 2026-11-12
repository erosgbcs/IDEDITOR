(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.IDEditorProjectStorage = api.IDEditorProjectStorage;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DATABASE_NAME = 'ideditor-workspace';
  const DATABASE_VERSION = 1;
  const PROJECT_STORE = 'projects';
  const META_STORE = 'meta';
  const LEGACY_KEY = 'idEditor.projectsData';

  function clone(value) {
    if (value === undefined || value === null) return value;
    // Browser-native structured cloning avoids the JSON stringify/parse
    // allocation path during autosaves, with JSON as a compatibility fallback.
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch (error) { /* Use the plain-data fallback below. */ }
    }
    return JSON.parse(JSON.stringify(value));
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
  }

  function projectTimestamp(project) {
    const value = project && project.updatedAt;
    const numeric = typeof value === 'number' ? value : Number(value);
    if (value !== null && value !== undefined && value !== '' && Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function transactionResult(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve(true);
      transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
      transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction was aborted.'));
    });
  }

  function safeLocalStorage() {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (error) {
      return null;
    }
  }

  class IDEditorProjectStorage {
    constructor(options = {}) {
      const globalRoot = typeof globalThis !== 'undefined' ? globalThis : {};
      this.indexedDB = Object.prototype.hasOwnProperty.call(options, 'indexedDB')
        ? options.indexedDB
        : globalRoot.indexedDB;
      this.localStorage = Object.prototype.hasOwnProperty.call(options, 'localStorage')
        ? options.localStorage
        : safeLocalStorage();
      this.legacyKey = options.legacyKey || LEGACY_KEY;
      this.db = null;
      this.mode = 'uninitialized';
      this.lastError = null;
      this.fallbackState = { projects: {}, currentProjectId: null };
      this.writeQueue = Promise.resolve();
    }

    async open() {
      if (!this.indexedDB) {
        this.mode = this.localStorage ? 'localStorage-fallback' : 'memory-fallback';
        this.fallbackState = this._readLegacy() || { projects: {}, currentProjectId: null, deletedProjectIds: [] };
        return clone(this.fallbackState);
      }

      try {
        this.db = await this._openDatabase();
        await this._migrateLegacyData();
        this.mode = 'indexedDB';
        return await this._loadIndexedDB();
      } catch (error) {
        this.db = null;
        this.lastError = error;
        const legacy = this._readLegacy();
        if (legacy) {
          this.mode = this.localStorage ? 'localStorage-fallback' : 'memory-fallback';
          this.fallbackState = legacy;
          return clone(this.fallbackState);
        }
        throw new Error('IndexedDB could not be opened and no legacy project backup is available. The workspace was not reset. ' + (error && error.message ? error.message : ''));
      }
    }

    _openDatabase() {
      return new Promise((resolve, reject) => {
        let settled = false;
        const request = this.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(PROJECT_STORE)) {
            db.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(META_STORE)) {
            db.createObjectStore(META_STORE, { keyPath: 'key' });
          }
        };
        request.onsuccess = () => {
          if (settled) {
            request.result.close();
            return;
          }
          settled = true;
          resolve(request.result);
        };
        request.onerror = () => {
          if (settled) return;
          settled = true;
          reject(request.error || new Error('Unable to open the project database.'));
        };
        request.onblocked = () => {
          if (settled) return;
          settled = true;
          reject(new Error('The project database upgrade is blocked by another open IDEDITOR tab. Close older tabs and reload.'));
        };
      });
    }

    _readLegacy() {
      if (!this.localStorage) return null;
      try {
        const raw = this.localStorage.getItem(this.legacyKey);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.projects || typeof parsed.projects !== 'object' || Array.isArray(parsed.projects)) return null;
        return {
          projects: clone(parsed.projects),
          currentProjectId: parsed.currentProjectId || null,
          deletedProjectIds: Array.isArray(parsed.deletedProjectIds)
            ? [...new Set(parsed.deletedProjectIds.filter(id => typeof id === 'string' && id))]
            : []
        };
      } catch (error) {
        return null;
      }
    }

    async _migrateLegacyData() {
      const legacy = this._readLegacy();
      if (!legacy || (Object.keys(legacy.projects).length === 0 && !(legacy.deletedProjectIds || []).length)) return;

      // Merge rather than discard the fallback: IndexedDB projects absent from the
      // legacy snapshot are retained, a legacy project replaces an existing
      // record only when it is newer, and explicit fallback deletions are honored.
      await this._mergeLegacyIntoIndexedDB(legacy);

      // Cleanup is best-effort. A failed remove must never force the app into a
      // stale localStorage fallback after IndexedDB has already been recovered.
      try {
        this.localStorage.removeItem(this.legacyKey);
      } catch (error) {
        this.lastError = error;
      }
    }

    _mergeLegacyIntoIndexedDB(legacy) {
      const transaction = this.db.transaction([PROJECT_STORE, META_STORE], 'readwrite');
      const done = transactionResult(transaction);
      done.catch(() => {});
      const projectStore = transaction.objectStore(PROJECT_STORE);
      const metaStore = transaction.objectStore(META_STORE);

      const deletedIds = new Set(legacy.deletedProjectIds || []);
      deletedIds.forEach(id => projectStore.delete(id));

      Object.entries(legacy.projects).forEach(([id, incoming]) => {
        if (typeof id !== 'string' || !id || deletedIds.has(id)) return;
        const request = projectStore.get(id);
        request.onsuccess = () => {
          const existing = request.result && request.result.project;
          if (!existing || projectTimestamp(incoming) > projectTimestamp(existing)) {
            projectStore.put({ id, project: clone(incoming) });
          }
        };
      });

      const orderRequest = metaStore.get('projectOrder');
      orderRequest.onsuccess = () => {
        const order = orderRequest.result && Array.isArray(orderRequest.result.value)
          ? orderRequest.result.value.filter(id => !deletedIds.has(id))
          : [];
        Object.keys(legacy.projects).forEach(id => {
          if (!deletedIds.has(id) && !order.includes(id)) order.push(id);
        });
        metaStore.put({ key: 'projectOrder', value: order });
      };

      const currentRequest = metaStore.get('currentProjectId');
      currentRequest.onsuccess = () => {
        const storedId = currentRequest.result && currentRequest.result.value;
        // Retain the existing selection when possible; otherwise let the
        // normal startup validator choose the first project if this ID is stale.
        const candidateId = storedId || legacy.currentProjectId || null;
        const selectedId = candidateId && deletedIds.has(candidateId) ? null : candidateId;
        metaStore.put({ key: 'currentProjectId', value: selectedId });
      };

      return done;
    }

    async _getAllRecords() {
      const transaction = this.db.transaction([PROJECT_STORE], 'readonly');
      const done = transactionResult(transaction);
      done.catch(() => {});
      const records = await requestResult(transaction.objectStore(PROJECT_STORE).getAll());
      await done;
      return records;
    }

    async _loadIndexedDB() {
      await this.writeQueue;
      const transaction = this.db.transaction([PROJECT_STORE, META_STORE], 'readonly');
      const done = transactionResult(transaction);
      done.catch(() => {});
      const recordsRequest = transaction.objectStore(PROJECT_STORE).getAll();
      const orderRequest = transaction.objectStore(META_STORE).get('projectOrder');
      const currentRequest = transaction.objectStore(META_STORE).get('currentProjectId');
      const [records, orderRecord, currentRecord] = await Promise.all([
        requestResult(recordsRequest),
        requestResult(orderRequest),
        requestResult(currentRequest)
      ]);
      await done;

      const byId = {};
      // IndexedDB already returns structured clones, so do not clone each
      // project a second time while rebuilding the in-memory workspace.
      records.forEach(record => {
        if (record && typeof record.id === 'string') byId[record.id] = record.project || {};
      });
      const storedOrder = orderRecord && Array.isArray(orderRecord.value) ? orderRecord.value : [];
      const order = storedOrder.filter(id => Object.prototype.hasOwnProperty.call(byId, id));
      Object.keys(byId).forEach(id => { if (!order.includes(id)) order.push(id); });
      const projects = {};
      order.forEach(id => { projects[id] = byId[id]; });
      return {
        projects,
        currentProjectId: currentRecord ? currentRecord.value : null
      };
    }

    _writeIndexedDB(state) {
      const transaction = this.db.transaction([PROJECT_STORE, META_STORE], 'readwrite');
      const done = transactionResult(transaction);
      const projectStore = transaction.objectStore(PROJECT_STORE);
      const metaStore = transaction.objectStore(META_STORE);
      const orderRequest = metaStore.get('projectOrder');
      orderRequest.onsuccess = () => {
        const order = orderRequest.result && Array.isArray(orderRequest.result.value)
          ? orderRequest.result.value.slice()
          : [];
        Object.entries(state.projects || {}).forEach(([id, project]) => {
          const request = projectStore.get(id);
          request.onsuccess = () => {
            const existing = request.result && request.result.project;
            if (!existing || projectTimestamp(project) >= projectTimestamp(existing)) {
              projectStore.put({ id, project: clone(project) });
            }
          };
          if (!order.includes(id)) order.push(id);
        });
        metaStore.put({ key: 'projectOrder', value: order });
      };
      metaStore.put({ key: 'currentProjectId', value: state.currentProjectId || null });
      return done;
    }

    _enqueue(operation) {
      const result = this.writeQueue.then(operation, operation);
      this.writeQueue = result.catch(() => {});
      return result;
    }

    async saveAll(projects, currentProjectId) {
      const snapshot = {
        projects: clone(projects || {}),
        currentProjectId: currentProjectId || null
      };
      return this._enqueue(async () => {
        if (!this.db) {
          const deletedProjectIds = (this.fallbackState.deletedProjectIds || [])
            .filter(id => !Object.prototype.hasOwnProperty.call(snapshot.projects, id));
          this.fallbackState = { ...snapshot, deletedProjectIds };
          return this._writeFallback();
        }
        await this._writeIndexedDB(snapshot);
        return true;
      });
    }

    async saveProject(id, project, currentProjectId) {
      const projectSnapshot = clone(project || {});
      return this._enqueue(async () => {
        if (!this.db) {
          this.fallbackState.projects[id] = projectSnapshot;
          this.fallbackState.deletedProjectIds = (this.fallbackState.deletedProjectIds || []).filter(deletedId => deletedId !== id);
          if (currentProjectId !== undefined) this.fallbackState.currentProjectId = currentProjectId || null;
          return this._writeFallback();
        }
        const transaction = this.db.transaction([PROJECT_STORE, META_STORE], 'readwrite');
        const done = transactionResult(transaction);
        transaction.objectStore(PROJECT_STORE).put({ id, project: projectSnapshot });
        const metaStore = transaction.objectStore(META_STORE);
        const orderRequest = metaStore.get('projectOrder');
        orderRequest.onsuccess = () => {
          const order = orderRequest.result && Array.isArray(orderRequest.result.value)
            ? orderRequest.result.value.slice()
            : [];
          if (!order.includes(id)) order.push(id);
          metaStore.put({ key: 'projectOrder', value: order });
        };
        if (currentProjectId !== undefined) {
          metaStore.put({ key: 'currentProjectId', value: currentProjectId || null });
        }
        await done;
        return true;
      });
    }

    async deleteProject(id, currentProjectId) {
      return this._enqueue(async () => {
        if (!this.db) {
          delete this.fallbackState.projects[id];
          this.fallbackState.deletedProjectIds = [...new Set([...(this.fallbackState.deletedProjectIds || []), id])];
          if (currentProjectId !== undefined) this.fallbackState.currentProjectId = currentProjectId || null;
          return this._writeFallback();
        }
        const transaction = this.db.transaction([PROJECT_STORE, META_STORE], 'readwrite');
        const done = transactionResult(transaction);
        transaction.objectStore(PROJECT_STORE).delete(id);
        const metaStore = transaction.objectStore(META_STORE);
        const orderRequest = metaStore.get('projectOrder');
        orderRequest.onsuccess = () => {
          const order = orderRequest.result && Array.isArray(orderRequest.result.value)
            ? orderRequest.result.value.filter(projectId => projectId !== id)
            : [];
          metaStore.put({ key: 'projectOrder', value: order });
        };
        if (currentProjectId !== undefined) {
          metaStore.put({ key: 'currentProjectId', value: currentProjectId || null });
        }
        await done;
        return true;
      });
    }

    async setCurrentProjectId(id) {
      return this._enqueue(async () => {
        if (!this.db) {
          this.fallbackState.currentProjectId = id || null;
          return this._writeFallback();
        }
        const transaction = this.db.transaction([META_STORE], 'readwrite');
        const done = transactionResult(transaction);
        transaction.objectStore(META_STORE).put({ key: 'currentProjectId', value: id || null });
        await done;
        return true;
      });
    }

    _writeFallback() {
      if (!this.localStorage) return false;
      try {
        this.fallbackState.deletedProjectIds = [...new Set(this.fallbackState.deletedProjectIds || [])];
        this.localStorage.setItem(this.legacyKey, JSON.stringify(this.fallbackState));
        return true;
      } catch (error) {
        this.lastError = error;
        throw error;
      }
    }
  }

  return { IDEditorProjectStorage };
});
