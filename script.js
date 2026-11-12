/* =========================================================
   DEFAULT FILES
   ========================================================= */
const DEFAULT_HTML = `<h1>Hello 👋</h1>\n<button id="btn">Click me</button>\n<p id="out"></p>`;
const DEFAULT_CSS = `body { font-family: system-ui, sans-serif; padding: 16px; color: #222; }\nh1 { color: #0a84ff; }\nbutton { padding: 10px 16px; font-size: 16px; border: 0; border-radius: 8px; background: #0a84ff; color: #fff; }\n#out { font-size: 18px; font-weight: 600; }`;
const DEFAULT_JS = `let n = 0;\ndocument.getElementById('btn').addEventListener('click', () => {\n  n++;\n  document.getElementById('out').textContent = 'Clicked ' + n + ' time' + (n === 1 ? '' : 's');\n  console.log('click', n);\n});`;

const DEFAULT_FILES = {
  'index.html': { lang: 'html',       content: DEFAULT_HTML },
  'style.css':  { lang: 'css',        content: DEFAULT_CSS  },
  'script.js':  { lang: 'javascript', content: DEFAULT_JS   }
};

let FILES = {};
let filesList = [];

// Storage Keys
const PROJECTS_KEY = 'idEditor.projectsData';
const THEME_KEY    = 'idEditor.theme';
const FONTSIZE_KEY = 'idEditor.fontSize';
const SIDEBAR_KEY  = 'idEditor.sidebarHidden';
const GIT_URL_KEY  = 'idEditor.gitRepo';
const GIT_TOKEN_KEY = 'idEditor.gitToken'; // Legacy key; removed during migration.
let volatileGitToken = '';
try { localStorage.removeItem(GIT_TOKEN_KEY); } catch (error) { /* Storage may be unavailable. */ }
const GIT_BRANCH_KEY = 'idEditor.gitBranch'; // Legacy global preference; project tracking replaces it.
try { localStorage.removeItem(GIT_BRANCH_KEY); } catch (error) { /* Storage may be unavailable. */ }
const MINIMAP_KEY = 'idEditor.minimap';

// AI Storage Keys
const AI_PROVIDER_KEY = 'idEditor.aiProvider';
const AI_KEY_KEY      = 'idEditor.aiKey';
const AI_MODEL_KEY    = 'idEditor.aiModel';

let currentProjectId = null;
let projectsData = {};
let projectStorage = null;
let projectStorageWarningShown = false;
const pendingProjectWrites = new Map();

/* =========================================================
   PROJECT MANAGEMENT LOGIC
   ========================================================= */
function generateId() { return 'p_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5); }

async function loadProjectsData() {
  projectStorage = new window.IDEditorProjectStorage();
  const loaded = await projectStorage.open();
  projectsData = loaded.projects || {};
  currentProjectId = loaded.currentProjectId || null;
  let createdDefaultProject = false;

  if (!projectsData || Object.keys(projectsData).length === 0) {
    const id = generateId();
    projectsData = {
      [id]: {
        name: 'My First Project',
        files: JSON.parse(JSON.stringify(DEFAULT_FILES)),
        updatedAt: Date.now()
      }
    };
    currentProjectId = id;
    createdDefaultProject = true;
  } else if (!currentProjectId || !projectsData[currentProjectId]) {
    currentProjectId = Object.keys(projectsData)[0];
  }

  Object.keys(projectsData).forEach((id) => {
    const project = projectsData[id];
    project.files = window.IDEditorCore.normalizeProjectFiles(project.files || {});
  });
  FILES = projectsData[currentProjectId].files;
  filesList = Object.keys(FILES);

  if (createdDefaultProject) await saveProjectsToStorage([currentProjectId]);
  else await projectStorage.setCurrentProjectId(currentProjectId);
  return { mode: projectStorage.mode, warning: projectStorage.lastError };
}

function handleProjectStorageError(error) {
  console.error('[IDEDITOR] Project storage failed:', error);
  if (!projectStorageWarningShown) {
    projectStorageWarningShown = true;
    showToast('Project storage failed. Export your work before closing or refreshing.');
  }
  return false;
}

function saveProjectsToStorage(projectIds) {
  if (!projectStorage) return Promise.resolve(false);
  const ids = Array.isArray(projectIds) ? [...new Set(projectIds)] : [currentProjectId];
  const validIds = ids.filter(id => id && projectsData[id]);
  if (!validIds.length) {
    return projectStorage.setCurrentProjectId(currentProjectId).catch(handleProjectStorageError);
  }

  // Snapshot and enqueue every selected project immediately. Deferring the
  // saveProject calls to a Promise callback could let a deletion enqueue first
  // and then accidentally recreate the deleted record afterward.
  const writes = validIds.map(id => projectStorage.saveProject(
    id,
    projectsData[id],
    id === currentProjectId ? currentProjectId : undefined
  ));
  return Promise.all(writes).then(results => {
    if (results.some(saved => saved === false)) {
      return handleProjectStorageError(new Error('No persistent browser storage is available.'));
    }
    return true;
  }).catch(handleProjectStorageError);
}

function saveCurrentProjectFiles() {
  if (!currentProjectId || !projectsData[currentProjectId]) return Promise.resolve(false);
  const projectId = currentProjectId;
  // Keep the workspace file map as the source of truth. Only loaded Monaco
  // models need synchronization; unloaded files remain intact on autosave.
  const data = FILES && currentProjectId === projectId
    ? FILES
    : (projectsData[projectId].files || {});
  Object.keys(models).forEach(k => {
    if (!Object.prototype.hasOwnProperty.call(data, k)) return;
    const content = models[k].getValue();
    data[k] = { lang: models[k].getLanguageId() || langFromFilename(k), content };
    savedSnapshot[k] = content;
  });
  projectsData[projectId].files = data;
  if (currentProjectId === projectId) FILES = data;
  projectsData[projectId].updatedAt = Date.now();
  hasPendingSave = false;
  Object.keys(models).forEach(markDirtyState);

  if (!projectStorage) return Promise.resolve(false);
  // Track writes so cloud imports can distinguish a clean project from one
  // whose latest edits have not yet committed to IndexedDB.
  pendingProjectWrites.set(projectId, (pendingProjectWrites.get(projectId) || 0) + 1);
  // Autosave must not change the persisted active-project selection. A
  // deliberate project switch updates that metadata through saveProjectsToStorage.
  return projectStorage.saveProject(projectId, projectsData[projectId]).then(saved => {
    if (saved === false) {
      if (currentProjectId === projectId) hasPendingSave = true;
      return handleProjectStorageError(new Error('No persistent browser storage is available.'));
    }
    return true;
  }).catch(error => {
    if (currentProjectId === projectId) {
      hasPendingSave = true;
      Object.keys(models).forEach(markDirtyState);
    }
    return handleProjectStorageError(error);
  }).finally(() => {
    const remaining = (pendingProjectWrites.get(projectId) || 1) - 1;
    if (remaining > 0) pendingProjectWrites.set(projectId, remaining);
    else pendingProjectWrites.delete(projectId);
  });
}

function renderProjectsDashboard() {
  const grid = document.getElementById('projectsGrid');
  grid.innerHTML = '';
  
  const sortedProjects = Object.entries(projectsData).sort((a, b) => b[1].updatedAt - a[1].updatedAt);

  sortedProjects.forEach(([id, proj]) => {
    const isActive = id === currentProjectId;
    const fileCount = Object.keys(proj.files).length;
    const dateStr = new Date(proj.updatedAt).toLocaleDateString() + ' ' + new Date(proj.updatedAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    
    const card = document.createElement('div');
    card.className = 'project-card';
    card.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
    
    card.innerHTML = `
      <div class="project-card-header">
        <h3>${escapeHtml(proj.name)} ${isActive ? '<span style="color:var(--accent);font-size:12px;">(Active)</span>' : ''}</h3>
        ${!isActive ? `<button class="btn-delete-project" data-id="${id}" title="Delete Project">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>` : ''}
      </div>
      <div class="project-date">Last updated: ${dateStr}</div>
      <div class="project-stats">
        <span>📄 ${fileCount} files</span>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-delete-project')) return;
      if (id !== currentProjectId) {
        switchProject(id);
      } else {
        closeProjectsDashboard();
      }
    });

    grid.appendChild(card);
  });

  document.querySelectorAll('.btn-delete-project').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (confirm(`Delete project "${projectsData[id].name}"? This cannot be undone.`)) {
        deleteProject(id);
      }
    });
  });
}

function deleteProject(id) {
  if (!Object.prototype.hasOwnProperty.call(projectsData, id)) return;
  const wasActive = currentProjectId === id;
  if (wasActive) saveCurrentProjectFiles();
  delete projectsData[id];
  // Queue the record deletion before saving the replacement active project.
  if (projectStorage) {
    projectStorage.deleteProject(id, wasActive ? null : currentProjectId).catch(handleProjectStorageError);
  }

  if (wasActive) {
    // Prevent switchProject from saving the deleted project's models into its replacement.
    currentProjectId = null;
    const nextId = window.IDEditorCore.nextProjectIdAfterRemoval(projectsData, id);
    if (nextId) switchProject(nextId);
    else {
      const replacementId = generateId();
      projectsData[replacementId] = {
        name: 'My First Project',
        files: JSON.parse(JSON.stringify(DEFAULT_FILES)),
        updatedAt: Date.now()
      };
      switchProject(replacementId);
    }
  }
  saveProjectsToStorage();
  renderProjectsDashboard();
}

function switchProject(id) {
  if (!projectsData[id]) return;
  saveCurrentProjectFiles();
  currentProjectId = id;
  const proj = projectsData[id];
  FILES = proj.files;
  filesList = Object.keys(FILES);
  
  if (editor) editor.setModel(null);
  Object.keys(models).forEach(k => { try { models[k].dispose(); } catch (e) {} delete models[k]; });
  Object.keys(savedSnapshot).forEach(k => delete savedSnapshot[k]);
  expandedFolders.clear(); foldersInitialized = false;
  
  if (filesList.length === 0) {
    FILES['index.html'] = { lang: 'html', content: DEFAULT_HTML };
    filesList.push('index.html');
  }
  activeFile = filesList[0];
  ensureModel(activeFile);
  renderTabs(); renderSidebarFiles(); switchFile(activeFile);
  saveProjectsToStorage();
  
  closeProjectsDashboard();
  showToast(`Switched to ${proj.name}`);
  updateGitStatus();
}

function createNewProject(name = 'Untitled Project') {
  const id = generateId();
  projectsData[id] = {
    name: name,
    files: JSON.parse(JSON.stringify(DEFAULT_FILES)),
    updatedAt: Date.now()
  };
  switchProject(id);
}

function openProjectsDashboard() {
  renderProjectsDashboard();
  document.getElementById('projectsView').classList.add('show');
}

function closeProjectsDashboard() {
  document.getElementById('projectsView').classList.remove('show');
}

function wireProjectsUI() {
  document.getElementById('btnProjectsHome').addEventListener('click', openProjectsDashboard);
  document.getElementById('btnCloseProjects').addEventListener('click', closeProjectsDashboard);
  
  document.getElementById('btnDashboardNewProject').addEventListener('click', () => {
    const name = prompt('Enter project name:', 'New Project');
    if (name && name.trim()) createNewProject(name.trim());
  });

  document.getElementById('btnDashboardCloneProject').addEventListener('click', async () => {
    const url = prompt('Enter GitHub Repository URL (e.g., https://github.com/octocat/Hello-World.git):');
    if (!url || !url.trim()) return;
    const normalizedUrl = url.trim();
    const parsed = parseGitHubUrl(normalizedUrl);
    if (!parsed) return showToast('Enter a valid HTTPS GitHub repository URL');

    const newProjName = prompt('Enter project name for the clone:', parsed.repo);
    if (!newProjName || !newProjName.trim()) return;

    // Public repositories can be cloned without a PAT. Private repositories use
    // the volatile token configured in Git Settings.
    localStorage.setItem(GIT_URL_KEY, normalizedUrl);
    createNewProject(newProjName.trim());
    setCurrentProjectRemoteUrl(normalizedUrl);
    document.getElementById('gitRepoUrl').value = normalizedUrl;
    await updateGitStatus();
    closeProjectsDashboard();
    bottomPanel.classList.remove('hidden');
    setActivePanel('terminal');
    addTermLine('$ git clone ' + normalizedUrl, '');
    try {
      const cloned = await gitClone({ replace: true });
      if (cloned) addTermLine('Clone successful', 'success');
    } catch (error) {
      addTermLine('Clone failed: ' + (error.message || error), 'error');
      showToast('Clone failed: ' + (error.message || 'Unknown error'));
    }
  });
}

/* =========================================================
   FIREBASE SETUP
   ========================================================= */
const firebaseConfig = {
  apiKey: "AIzaSyADeeUFn-vYEzeT5peaTUD2cT8z92f1Aos",
  authDomain: "our-story-ca956.firebaseapp.com",
  projectId: "our-story-ca956",
  storageBucket: "our-story-ca956.firebasestorage.app",
  messagingSenderId: "28026494674",
  appId: "1:28026494674:web:4e65f36f4217269336570b",
  measurementId: "G-9206ZG2YT2"
};

let fbAuth = null, fbDb = null, fbUser = null;
let firebaseEnabled = false;
let authModule = null; 

async function initFirebase() {
  try {
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js');
    authModule = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js');
    const { getFirestore } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
    const { getAuth, onAuthStateChanged, getRedirectResult } = authModule;
    
    const app = initializeApp(firebaseConfig);
    fbAuth = getAuth(app);
    fbDb = getFirestore(app);
    
    const loggedOutUI = document.getElementById('firebaseLoggedOut');
    const loggedInUI = document.getElementById('firebaseLoggedIn');
    const avatarEl = document.getElementById('userAvatar');
    const nameEl = document.getElementById('userName');
    
    const updateAuthUI = (user) => {
      if (user) {
        loggedOutUI.style.display = 'none';
        loggedInUI.style.display = 'block';
        const displayName = user.displayName || (user.email ? user.email.split('@')[0] : 'User');
        nameEl.textContent = displayName;
        if (user.photoURL) {
          avatarEl.style.backgroundImage = `url(${user.photoURL})`;
          avatarEl.style.backgroundSize = 'cover';
          avatarEl.textContent = ''; 
        } else {
          avatarEl.textContent = displayName.charAt(0).toUpperCase();
          avatarEl.style.backgroundImage = 'none';
        }
      } else {
        loggedInUI.style.display = 'none';
        loggedOutUI.style.display = 'block';
      }
    };
    
    if (fbAuth.currentUser) {
      updateAuthUI(fbAuth.currentUser);
      fbUser = fbAuth.currentUser;
      loadGitSettingsFromCloud(fbUser.uid);
    }
    
    getRedirectResult(fbAuth).then((result) => {
      if (result && result.user) {
        updateAuthUI(result.user);
        fbUser = result.user;
        showToast('Logged in as ' + (result.user.displayName || 'User'));
      }
    }).catch((error) => console.error('Redirect login error:', error));
    
    onAuthStateChanged(fbAuth, (user) => {
      fbUser = user;
      updateAuthUI(user);
      if (user) {
        addTermLine('Firebase Connected: ' + (user.displayName || 'User'), 'success');
        loadGitSettingsFromCloud(user.uid);
      }
    });
    firebaseEnabled = true;
  } catch (e) { console.warn('Firebase failed to load', e); }
}

async function saveToCloud() {
  if (!firebaseEnabled || !fbUser) return showToast('Login to save to cloud');
  try {
    showToast('Saving to cloud...');
    const projectId = currentProjectId;
    const project = currentProject();
    if (!project) return showToast('No active project');
    const savedLocally = await saveCurrentProjectFiles();
    if (!savedLocally) return showToast('Local save failed. Cloud save was cancelled to protect your project.');
    const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
    await setDoc(doc(fbDb, 'users', fbUser.uid, 'projects', projectId), {
      name: project.name,
      files: project.files,
      updatedAt: new Date().toISOString()
    });
    showToast('Saved to cloud!'); addTermLine('Project saved to cloud!', 'success');
  } catch (e) { showToast('Cloud save failed'); }
}

async function loadFromCloud() {
  if (!firebaseEnabled || !fbUser) return showToast('Login to load from cloud');
  try {
    showToast('Loading from cloud...');
    const { collection, getDocs } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
    const querySnapshot = await getDocs(collection(fbDb, 'users', fbUser.uid, 'projects'));
    if (querySnapshot.empty) return showToast('No cloud projects found');

    const activeId = currentProjectId;
    const activeProject = currentProject();
    const activeFiles = activeId ? collectWorkspaceFiles() : {};
    const persistedActiveFiles = {};
    Object.entries(activeProject && activeProject.files || {}).forEach(([path, file]) => {
      persistedActiveFiles[path] = typeof file === 'string' ? file : (file && file.content != null ? String(file.content) : '');
    });
    const activeHasUnsavedChanges = Boolean(activeId && (
      hasPendingSave ||
      (pendingProjectWrites.get(activeId) || 0) > 0 ||
      !window.IDEditorCore.sameFileSnapshots(activeFiles, persistedActiveFiles)
    ));
    let newProjects = { ...projectsData }, activeCloudFiles = null, skippedLocalWork = false;
    const importedProjectIds = [];
    querySnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const normalizedFiles = window.IDEditorCore.normalizeProjectFiles(data.files || {});
      const isActive = docSnap.id === activeId;
      if (!window.IDEditorCore.shouldApplyCloudProject(isActive, activeHasUnsavedChanges, Boolean(activeProject && activeProject.pendingCommit))) {
        skippedLocalWork = true;
        return;
      }
      const parsedDate = Date.parse(data.updatedAt || '');
      const localProject = newProjects[docSnap.id] || {};
      newProjects[docSnap.id] = {
        ...localProject,
        name: data.name || localProject.name || 'Cloud Project',
        files: normalizedFiles,
        updatedAt: Number.isFinite(parsedDate) ? parsedDate : Date.now()
      };
      importedProjectIds.push(docSnap.id);
      if (isActive) {
        activeCloudFiles = {};
        Object.entries(normalizedFiles).forEach(([path, file]) => { activeCloudFiles[path] = file.content; });
      }
    });
    projectsData = newProjects;
    if (activeCloudFiles) applyWorkspaceFiles(activeCloudFiles);
    saveProjectsToStorage(importedProjectIds);
    renderProjectsDashboard();
    showToast(skippedLocalWork
      ? 'Cloud projects loaded. Projects with unsaved or staged work kept their local version.'
      : 'Cloud projects loaded! Check Dashboard.');
  } catch (e) {
    console.error('Cloud load failed:', e);
    showToast('Cloud load failed; local workspace was preserved.');
  }
}

async function loadGitSettingsFromCloud(uid) {
  try {
    const { doc, getDoc, updateDoc, deleteField } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
    const settingsRef = doc(fbDb, 'users', uid, 'settings', 'git');
    const docSnap = await getDoc(settingsRef);
    if (docSnap.exists()) {
      const data = docSnap.data();
      if (data.url) localStorage.setItem(GIT_URL_KEY, data.url);
      if (Object.prototype.hasOwnProperty.call(data, 'token')) {
        try { await updateDoc(settingsRef, { token: deleteField() }); } catch (cleanupError) {
          console.warn('Legacy Firebase Git token cleanup could not complete.');
        }
      }
      document.getElementById('gitRepoUrl').value = data.url || '';
      document.getElementById('gitToken').value = volatileGitToken;
      updateGitStatus();
    }
  } catch (error) {
    console.warn('Failed to load Git settings');
  }
}

/* =========================================================
   HELPERS & INIT
   ========================================================= */
const isMobile = () => window.matchMedia('(max-width:899px)').matches;
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const basename = (path) => path.split('/').pop();

function langFromFilename(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return { html: 'html', htm: 'html', css: 'css', js: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', xml: 'xml', svg: 'xml', txt: 'plaintext' }[ext] || 'plaintext';
}
function parserForFile(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return { html: 'html', htm: 'html', css: 'css', js: 'babel', mjs: 'babel', jsx: 'babel', ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown' }[ext] || null;
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('[IDEDITOR] Offline cache registration unavailable:', error && error.message);
    });
  });
}
document.documentElement.setAttribute('data-theme', (localStorage.getItem(THEME_KEY) === 'vs' || localStorage.getItem(THEME_KEY) === 'light') ? 'light' : 'dark');

/* =========================================================
   THEME SETUP
   ========================================================= */
function defineCustomThemes() {
  monaco.editor.defineTheme('dracula', {
    base: 'vs-dark', inherit: true,
    rules: [ { token: 'comment', foreground: '6272a4' }, { token: 'string', foreground: 'f1fa8c' }, { token: 'keyword', foreground: 'ff79c6' }, { token: 'number', foreground: 'bd93f9' }, { token: 'type', foreground: '8be9fd' } ],
    colors: { 'editor.background': '#282a36', 'editor.foreground': '#f8f8f2' }
  });
  monaco.editor.defineTheme('monokai', {
    base: 'vs-dark', inherit: true,
    rules: [ { token: 'comment', foreground: '75715e' }, { token: 'string', foreground: 'e6db74' }, { token: 'keyword', foreground: 'f92672' }, { token: 'number', foreground: 'ae81ff' } ],
    colors: { 'editor.background': '#272822', 'editor.foreground': '#f8f8f2' }
  });
  monaco.editor.defineTheme('github-dark', {
    base: 'vs-dark', inherit: true,
    rules: [ { token: 'comment', foreground: '8b949e' }, { token: 'string', foreground: 'a5d6ff' }, { token: 'keyword', foreground: 'ff7b72' } ],
    colors: { 'editor.background': '#0d1117', 'editor.foreground': '#c9d1d9' }
  });
}

const currentTheme = localStorage.getItem(THEME_KEY) || 'vs-dark';

/* =========================================================
   EDITOR SETUP
   ========================================================= */
let editor = null, models = {}, savedSnapshot = {};
let activeFile = 'index.html', uriSeq = 0;
let minimapEnabled = localStorage.getItem(MINIMAP_KEY) === 'true';
let fontSize = parseInt(localStorage.getItem(FONTSIZE_KEY), 10) || (isMobile() ? 14 : 13);

async function bootEditorAfterStorage() {
  try {
    const storageState = await loadProjectsData();
    if (storageState.mode === 'localStorage-fallback') {
      showToast('IndexedDB unavailable. Using limited local storage fallback.');
    } else if (storageState.mode === 'memory-fallback') {
      showToast('Persistent browser storage unavailable. Changes may not survive refresh.');
    }

    if (typeof require === 'undefined') {
      document.getElementById('editor').innerHTML = '<div style="padding:20px;color:#ff7b72;font-family:sans-serif">Failed to load Monaco Editor.</div>';
      return;
    }
    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
    require(['vs/editor/editor.main'], initEditor);
  } catch (error) {
    console.error('[IDEDITOR] Workspace startup failed:', error);
    const host = document.getElementById('editor');
    if (host) {
      host.innerHTML = '<div style="padding:20px;color:#ff7b72;font-family:sans-serif">Unable to open your saved workspace. Your existing data was not reset. Close other IDEDITOR tabs and reload, or export the legacy backup if available.</div>';
    }
    showToast('Workspace storage unavailable. Existing project data was not reset.');
  }
}
bootEditorAfterStorage();

function makeUri(name) { return monaco.Uri.parse('inmemory:///' + encodeURIComponent(name) + '/' + (++uriSeq)); }

function ensureModel(name) {
  if (models[name]) return models[name];
  const rawMeta = FILES[name];
  const meta = typeof rawMeta === 'string' ? { content: rawMeta, lang: langFromFilename(name) } : (rawMeta || {});
  const model = monaco.editor.createModel(meta.content == null ? '' : meta.content, meta.lang || langFromFilename(name), makeUri(name));
  models[name] = model;
  savedSnapshot[name] = model.getValue();
  model.onDidChangeContent(() => { markDirtyState(name); scheduleSave(); });
  if (window.__hookAutoRun) window.__hookAutoRun(model);
  return model;
}

function initEditor() {
  defineCustomThemes();
  
  if (!filesList.length) filesList = ['index.html'];
  if (!filesList.includes(activeFile)) activeFile = filesList[0];
  ensureModel(activeFile);

  editor = monaco.editor.create(document.getElementById('editor'), {
    model: models[activeFile], theme: currentTheme, fontSize: fontSize,
    minimap: { enabled: minimapEnabled }, lineNumbersMinChars: 2, automaticLayout: true,
    wordWrap: 'on', scrollBeyondLastLine: false, padding: { top: 8 }, tabSize: 2,
    bracketPairColorization: { enabled: true }, guides: { bracketPairs: true },
    lineHeight: Math.round(fontSize * 1.5), lineDecorationsWidth: 8
  });

  editor.onDidChangeCursorPosition(e => {
    document.getElementById('statusCursor').textContent = 'Ln ' + e.position.lineNumber + ', Col ' + e.position.column;
  });

  renderTabs(); renderSidebarFiles();
  wireFindBar(); wireRun(); wireConsole(); wireClipboard(); wireSettings(); wirePreviewControls(); wireSidebar(); wireMobileActions(); wireTier1Features(); setupSaveFlush(); wireGitUI(); wireProjectsUI(); wireAI();
  editor.addAction({ id: 'custom-open-find', label: 'Find', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF], run: openFindBar });
  editor.addAction({ id: 'custom-run-kb', label: 'Run', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: run });

  updateStatusFont(); switchFile(activeFile);
  initFirebase();
  showToast('Loaded ' + projectsData[currentProjectId].name);
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveCurrentProjectFiles().then(saved => {
      if (saved) showToast('Project Saved');
    });
  }
});

function wireTier1Features() {
  document.getElementById('btnCmdPalette').addEventListener('click', () => { if (editor) { editor.focus(); setTimeout(() => editor.trigger('', 'editor.action.quickCommand'), 50); }});
  const btnMinimap = document.getElementById('btnMinimap');
  btnMinimap.classList.toggle('on', minimapEnabled);
  btnMinimap.addEventListener('click', () => {
    minimapEnabled = !minimapEnabled;
    editor.updateOptions({ minimap: { enabled: minimapEnabled } });
    btnMinimap.classList.toggle('on', minimapEnabled);
    localStorage.setItem(MINIMAP_KEY, minimapEnabled);
  });

  document.getElementById('btnImport').addEventListener('click', () => document.getElementById('fileImport').click());
  document.getElementById('fileImport').addEventListener('change', async (e) => {
    const files = e.target.files; if (!files.length) return;
    let firstImported = null;
    for (const file of files) {
      if (FILES[file.name] && !confirm(`Overwrite "${file.name}"?`)) continue;
      if (models[file.name]) { models[file.name].dispose(); delete models[file.name]; }
      FILES[file.name] = { lang: langFromFilename(file.name), content: await file.text() };
      if (!filesList.includes(file.name)) filesList.push(file.name);
      if (!firstImported) firstImported = file.name;
    }
    if (firstImported) ensureModel(firstImported);
    renderTabs(); renderSidebarFiles(); if (firstImported) switchFile(firstImported);
    saveCurrentProjectFiles(); showToast('Imported files'); e.target.value = '';
  });

  const resizer = document.getElementById('resizer'), editorPane = document.getElementById('editorPane'), outputPane = document.getElementById('outputPane');
  let isResizing = false, startX = 0, startY = 0, startWidth = 0, startHeight = 0;
  resizer.addEventListener('pointerdown', (e) => {
    isResizing = true; startX = e.clientX; startY = e.clientY;
    startWidth = editorPane.getBoundingClientRect().width; startHeight = editorPane.getBoundingClientRect().height;
    resizer.classList.add('active'); document.body.style.userSelect = 'none';
  });
  document.addEventListener('pointermove', (e) => {
    if (!isResizing) return;
    const panesContainer = document.getElementById('panes');
    if (isMobile()) {
      const newHeight = startHeight + (e.clientY - startY);
      const totalHeight = panesContainer.getBoundingClientRect().height;
      if (newHeight > totalHeight * 0.2 && newHeight < totalHeight * 0.8) {
        const percent = (newHeight / totalHeight) * 100;
        editorPane.style.flex = `1 1 ${percent}%`; outputPane.style.flex = `1 1 ${100 - percent}%`;
        if (editor) editor.layout();
      }
    } else {
      const newWidth = startWidth + (e.clientX - startX);
      const totalWidth = panesContainer.getBoundingClientRect().width;
      if (newWidth > totalWidth * 0.2 && newWidth < totalWidth * 0.8) {
        const percent = (newWidth / totalWidth) * 100;
        editorPane.style.flex = `1 1 ${percent}%`; outputPane.style.flex = `1 1 ${100 - percent}%`;
        if (editor) editor.layout();
      }
    }
  });
  document.addEventListener('pointerup', () => { if (isResizing) { isResizing = false; resizer.classList.remove('active'); document.body.style.userSelect = ''; } });
}

/* =========================================================
   STATUS, SAVE, RENDER
   ========================================================= */
function updateStatusFont() { const el = document.getElementById('statusFont'); if (el) el.textContent = fontSize + 'px'; }

const tabElements = new Map();
const sidebarFileElements = new Map();
function findTabEl(name) { return tabElements.get(name) || null; }
function findSideItemEl(name) { return sidebarFileElements.get(name) || null; }

function markDirtyState(file) {
  const currentContent = models[file] ? models[file].getValue() : readProjectFile(file);
  const baseline = Object.prototype.hasOwnProperty.call(savedSnapshot, file)
    ? savedSnapshot[file]
    : currentContent;
  const dirty = baseline !== currentContent;
  const tab = findTabEl(file);
  const item = findSideItemEl(file);
  if (tab) tab.classList.toggle('dirty', dirty);
  if (item) item.classList.toggle('dirty', dirty);
}

let saveTimer = null, hasPendingSave = false, sidebarRenderTimer = null;
function scheduleSave() {
  hasPendingSave = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrentProjectFiles, 650);
}
function scheduleSidebarRender() {
  clearTimeout(sidebarRenderTimer);
  sidebarRenderTimer = setTimeout(() => {
    sidebarRenderTimer = null;
    renderSidebarFiles();
  }, 90);
}
function setupSaveFlush() {
  const flushPendingProjectSave = () => {
    if (hasPendingSave) saveCurrentProjectFiles();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushPendingProjectSave();
  });
  window.addEventListener('pagehide', flushPendingProjectSave);
  window.addEventListener('beforeunload', flushPendingProjectSave);
}

function renderTabs() {
  const nav = document.getElementById('tabs');
  const fragment = document.createDocumentFragment();
  tabElements.clear();
  filesList.forEach(name => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (name === activeFile ? ' active' : '');
    btn.dataset.file = name;
    btn.textContent = basename(name);
    btn.title = name;
    attachFileMenuHandlers(btn, name);
    tabElements.set(name, btn);
    fragment.appendChild(btn);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'tab-add';
  addBtn.title = 'New file';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', promptNewFile);
  fragment.appendChild(addBtn);
  nav.replaceChildren(fragment);
  tabElements.forEach((_, name) => markDirtyState(name));
}

let foldersInitialized = false;
const expandedFolders = new Set();
function renderSidebarFiles() {
  if (sidebarRenderTimer) {
    clearTimeout(sidebarRenderTimer);
    sidebarRenderTimer = null;
  }
  if (!foldersInitialized && filesList.length > 0) {
    const activeParts = activeFile.split('/');
    let currentPath = '';
    for (let i = 0; i < activeParts.length - 1; i++) {
      currentPath = currentPath ? currentPath + '/' + activeParts[i] : activeParts[i];
      expandedFolders.add(currentPath);
    }
    foldersInitialized = true;
  }

  const list = document.getElementById('sideFiles');
  const fragment = document.createDocumentFragment();
  sidebarFileElements.clear();
  const filter = (document.getElementById('fileFilter')?.value || '').trim().toLowerCase();
  const filtering = Boolean(filter);
  const visibleFiles = filtering
    ? filesList.filter(name => name.toLowerCase().includes(filter))
    : filesList;
  const tree = Object.create(null);

  visibleFiles.forEach(path => {
    const parts = path.split('/');
    let current = tree;
    parts.forEach((part, i) => {
      if (!Object.prototype.hasOwnProperty.call(current, part)) {
        current[part] = (i === parts.length - 1) ? 'FILE' : Object.create(null);
      }
      current = current[part];
    });
  });

  function buildNode(node, path, container) {
    const keys = Object.keys(node).sort((a, b) => {
      const aIsFile = node[a] === 'FILE';
      const bIsFile = node[b] === 'FILE';
      if (aIsFile && !bIsFile) return 1;
      if (!aIsFile && bIsFile) return -1;
      return a.localeCompare(b);
    });

    keys.forEach(key => {
      const fullPath = path ? path + '/' + key : key;
      if (node[key] === 'FILE') {
        const btn = document.createElement('button');
        btn.className = 'side-item' + (fullPath === activeFile ? ' active' : '');
        btn.dataset.file = fullPath;
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.8" fill="none"/></svg><span>' + escapeHtml(key) + '</span>';
        attachFileMenuHandlers(btn, fullPath, () => { switchFile(fullPath); if (isMobile()) closeSidebar(); });
        sidebarFileElements.set(fullPath, btn);
        container.appendChild(btn);
        markDirtyState(fullPath);
        return;
      }

      const folderDiv = document.createElement('div');
      const isExpanded = filtering || expandedFolders.has(fullPath);
      const folderHeader = document.createElement('div');
      folderHeader.className = 'tree-folder' + (isExpanded ? '' : ' collapsed');
      folderHeader.setAttribute('aria-expanded', String(isExpanded));
      folderHeader.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><span>' + escapeHtml(key) + '</span>';
      const childrenContainer = document.createElement('div');
      childrenContainer.className = 'tree-folder-children' + (isExpanded ? '' : ' hidden');
      const renderChildren = () => {
        if (childrenContainer.dataset.rendered === 'true') return;
        buildNode(node[key], fullPath, childrenContainer);
        childrenContainer.dataset.rendered = 'true';
      };

      if (isExpanded) renderChildren();
      folderHeader.addEventListener('click', () => {
        const expand = childrenContainer.classList.contains('hidden');
        childrenContainer.classList.toggle('hidden', !expand);
        folderHeader.classList.toggle('collapsed', !expand);
        folderHeader.setAttribute('aria-expanded', String(expand));
        if (expand) {
          expandedFolders.add(fullPath);
          renderChildren();
        } else {
          expandedFolders.delete(fullPath);
        }
      });
      folderDiv.appendChild(folderHeader);
      folderDiv.appendChild(childrenContainer);
      container.appendChild(folderDiv);
    });
  }

  if (visibleFiles.length) buildNode(tree, '', fragment);
  else {
    const empty = document.createElement('div');
    empty.className = 'file-filter-empty';
    empty.textContent = 'No matching files';
    fragment.appendChild(empty);
  }
  list.replaceChildren(fragment);
  sidebarFileElements.forEach((_, name) => markDirtyState(name));
}

let tabMenuEl = null, tabMenuFile = null;
function getTabMenu() {
  if (tabMenuEl) return tabMenuEl;
  tabMenuEl = document.createElement('div'); tabMenuEl.className = 'tab-menu';
  tabMenuEl.innerHTML =
    '<button class="menu-item" data-act="preview"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M7 5l12 7-12 7V5z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/></svg><span>Preview</span></button>' +
    '<div class="menu-divider"></div>' +
    '<button class="menu-item" data-act="rename"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 20h4l10-10a2 2 0 0 0-4-4L4 16v4z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/></svg><span>Rename</span></button>' +
    '<button class="menu-item" data-act="delete"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Delete</span></button>';
  document.body.appendChild(tabMenuEl);
  tabMenuEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    e.stopPropagation();
    const act = btn.dataset.act, name = tabMenuFile;
    const x = e.clientX, y = e.clientY;
    closeTabMenu();
    if (act === 'preview') showPreviewLayoutMenu(x, y);
    else if (act === 'rename') {
      const newName = prompt('Rename "' + name + '" to:', name);
      if (newName && newName.trim() && newName.trim() !== name) renameFile(name, newName.trim());
    } else if (act === 'delete') deleteFile(name);
  });
  document.addEventListener('click', e => { if (tabMenuEl && !tabMenuEl.contains(e.target)) closeTabMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTabMenu(); });
  return tabMenuEl;
}
function showTabMenu(x, y, filename) {
  const menu = getTabMenu(); tabMenuFile = filename;
  menu.style.left = x + 'px'; menu.style.top = y + 'px'; menu.style.display = 'block';
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > innerWidth) menu.style.left = Math.max(8, innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > innerHeight) menu.style.top = Math.max(8, innerHeight - rect.height - 8) + 'px';
  });
}
function closeTabMenu() { if (tabMenuEl) tabMenuEl.style.display = 'none'; tabMenuFile = null; }

/* ---------- Preview layout submenu ---------- */
let previewMenuEl = null;
function getPreviewMenu() {
  if (previewMenuEl) return previewMenuEl;
  previewMenuEl = document.createElement('div');
  previewMenuEl.className = 'tab-menu';
  previewMenuEl.innerHTML =
    '<button class="menu-item" data-layout="desktop"><svg viewBox="0 0 24 24" width="14" height="14"><rect x="3" y="4" width="18" height="12" rx="1" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M8 20h8M12 16v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>Desktop Layout</span></button>' +
    '<button class="menu-item" data-layout="mobile"><svg viewBox="0 0 24 24" width="14" height="14"><rect x="7" y="3" width="10" height="18" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M11 18h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>Mobile Layout</span></button>';
  document.body.appendChild(previewMenuEl);
  previewMenuEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-layout]'); if (!btn) return;
    e.stopPropagation();
    const layout = btn.dataset.layout;
    closePreviewMenu();
    triggerPreview(layout);
  });
  document.addEventListener('click', e => { if (previewMenuEl && !previewMenuEl.contains(e.target)) closePreviewMenu(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePreviewMenu(); });
  return previewMenuEl;
}
function showPreviewLayoutMenu(x, y) {
  const menu = getPreviewMenu();
  menu.style.left = x + 'px'; menu.style.top = y + 'px'; menu.style.display = 'block';
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > innerWidth) menu.style.left = Math.max(8, innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > innerHeight) menu.style.top = Math.max(8, innerHeight - rect.height - 8) + 'px';
  });
}
function closePreviewMenu() { if (previewMenuEl) previewMenuEl.style.display = 'none'; }
function triggerPreview(layout) {
  const outputPane = document.getElementById('outputPane');
  outputPane.classList.toggle('mobile-mode', layout === 'mobile');
  run();
}

function attachFileMenuHandlers(el, filename, onClickOverride) {
  el.addEventListener('contextmenu', e => { e.preventDefault(); showTabMenu(e.clientX, e.clientY, filename); });
  let pressTimer = null, suppressClick = false;
  el.addEventListener('touchstart', e => { const touch = e.touches[0]; pressTimer = setTimeout(() => { suppressClick = true; showTabMenu(touch.clientX, touch.clientY, filename); }, 500); }, { passive: true });
  el.addEventListener('touchend', () => { clearTimeout(pressTimer); if (suppressClick) setTimeout(() => { suppressClick = false; }, 400); });
  el.addEventListener('touchmove', () => clearTimeout(pressTimer));
  el.addEventListener('touchcancel', () => clearTimeout(pressTimer));
  el.addEventListener('click', e => { if (suppressClick) { e.preventDefault(); e.stopPropagation(); return; } if (onClickOverride) onClickOverride(); else switchFile(filename); });
}

function promptNewFile() {
  const raw = prompt('New file path (e.g. src/utils.js):'); if (!raw) return;
  let name = raw.trim().replace(/^\/+/, '').replace(/[\\:*?"<>|\x00-\x1F]/g, '');
  if (!name) return showToast('Invalid name');
  if (!/\.[a-z0-9]+$/i.test(name)) name += '.txt';
  if (FILES[name]) return showToast('File already exists');
  FILES[name] = { lang: langFromFilename(name), content: '' }; filesList.push(name); ensureModel(name);
  renderTabs(); renderSidebarFiles(); switchFile(name); saveCurrentProjectFiles(); showToast('Created ' + name);
}
function promptNewFolder() {
  const raw = prompt('New folder path (e.g. src/components):'); if (!raw) return;
  let folder = raw.trim().replace(/^\/+/, '').replace(/[\\:*?"<>|\x00-\x1F]/g, '');
  if (!folder) return showToast('Invalid name');
  const placeholder = `${folder}/.gitkeep`;
  if (FILES[placeholder]) return showToast('Folder already exists');
  FILES[placeholder] = { lang: 'plaintext', content: '' }; filesList.push(placeholder);
  const parts = folder.split('/'); let currentPath = '';
  parts.forEach(p => { currentPath = currentPath ? `${currentPath}/${p}` : p; expandedFolders.add(currentPath); });
  renderTabs(); renderSidebarFiles(); saveCurrentProjectFiles(); showToast('Created folder ' + folder);
}
function renameFile(oldName, newName) {
  newName = (newName || '').trim().replace(/^\/+/, '').replace(/[\\:*?"<>|\x00-\x1F]/g, '');
  if (!newName) return showToast('Invalid name'); if (newName === oldName) return; if (FILES[newName]) return showToast('File already exists');
  const oldModel = models[oldName];
  const oldMeta = FILES[oldName];
  const oldContent = oldModel ? oldModel.getValue() : (typeof oldMeta === 'string' ? oldMeta : (oldMeta && oldMeta.content) || '');
  const newLang = langFromFilename(newName);
  if (oldModel) oldModel.dispose();
  delete models[oldName];
  FILES[newName] = { lang: newLang, content: oldContent };
  delete FILES[oldName];
  if (Object.prototype.hasOwnProperty.call(savedSnapshot, oldName)) savedSnapshot[newName] = savedSnapshot[oldName];
  else savedSnapshot[newName] = oldContent;
  delete savedSnapshot[oldName];
  filesList = filesList.map(n => n === oldName ? newName : n);
  if (activeFile === oldName) activeFile = newName;
  renderTabs(); renderSidebarFiles();
  if (activeFile === newName) ensureModel(newName);
  switchFile(activeFile);
  saveCurrentProjectFiles();
  showToast('Renamed to ' + newName);
}
function deleteFile(name) {
  if (filesList.length <= 1) return showToast('Cannot delete the last file');
  if (!confirm('Delete "' + name + '"?')) return;
  if (models[name]) { models[name].dispose(); delete models[name]; }
  delete FILES[name]; delete savedSnapshot[name]; filesList = filesList.filter(n => n !== name);
  if (activeFile === name) activeFile = filesList[0];
  renderTabs(); renderSidebarFiles(); switchFile(activeFile); saveCurrentProjectFiles(); showToast('Deleted ' + name);
}

function openSidebar() { document.getElementById('sidebar').classList.remove('hidden'); document.getElementById('sidebarBackdrop').classList.add('show'); localStorage.setItem(SIDEBAR_KEY, '0'); }
function closeSidebar() { document.getElementById('sidebar').classList.add('hidden'); document.getElementById('sidebarBackdrop').classList.remove('show'); localStorage.setItem(SIDEBAR_KEY, '1'); }
function toggleSidebar() { const sidebar = document.getElementById('sidebar'); if (sidebar.classList.contains('hidden')) openSidebar(); else closeSidebar(); }

function wireSidebar() {
  const sidebar = document.getElementById('sidebar'), toggle = document.getElementById('btnSidebarToggle'), backdrop = document.getElementById('sidebarBackdrop');
  if (localStorage.getItem(SIDEBAR_KEY) === '1' || (!localStorage.getItem(SIDEBAR_KEY) && isMobile())) sidebar.classList.add('hidden');
  else if (isMobile()) backdrop.classList.add('show');
  toggle.addEventListener('click', toggleSidebar); backdrop.addEventListener('click', closeSidebar);
  document.getElementById('btnNewFile').addEventListener('click', promptNewFile);
  document.getElementById('btnNewFolder').addEventListener('click', promptNewFolder);
  const fileFilter = document.getElementById('fileFilter');
  fileFilter.addEventListener('input', scheduleSidebarRender);
  fileFilter.addEventListener('keydown', e => {
    if (e.key === 'Escape' && fileFilter.value) {
      fileFilter.value = '';
      renderSidebarFiles();
    }
  });
  
  document.getElementById('btnReset').addEventListener('click', () => { 
    if (!confirm('Reset ALL projects and settings? This cannot be undone.')) return; 
    localStorage.clear(); location.reload(); 
  });
  
  document.getElementById('btnCloudSave').addEventListener('click', saveToCloud);
  document.getElementById('btnCloudLoad').addEventListener('click', loadFromCloud);
  
  document.getElementById('btnFirebaseLogin').addEventListener('click', async () => {
    if (!firebaseEnabled || !authModule) return showToast('Firebase loading...');
    const provider = new authModule.GoogleAuthProvider();
    try {
      await authModule.signInWithPopup(fbAuth, provider);
    } catch (error) {
      if (error.code === 'auth/popup-blocked' || error.code === 'auth/operation-not-supported-in-this-environment' || error.code === 'auth/cancelled-popup-request') {
        try { await authModule.signInWithRedirect(fbAuth, provider); } catch (e) { alert('Login Error: ' + e.message); }
      } else { alert('Login Error: ' + error.message); }
    }
  });
  document.getElementById('btnFirebaseLogout').addEventListener('click', () => { if (firebaseEnabled && authModule) authModule.signOut(fbAuth); });
}

function switchFile(file) {
  if (file !== 'preview' && !Object.prototype.hasOwnProperty.call(FILES, file)) return;

  if (file !== 'preview') {
    let currentPath = '';
    const parts = file.split('/');
    let shouldRenderTree = false;
    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath ? currentPath + '/' + parts[i] : parts[i];
      if (!expandedFolders.has(currentPath)) {
        expandedFolders.add(currentPath);
        shouldRenderTree = true;
      }
    }
    if (shouldRenderTree) renderSidebarFiles();
    ensureModel(file);
  }

  const previousFile = activeFile;
  if (previousFile !== file) {
    const oldTab = findTabEl(previousFile);
    const oldItem = findSideItemEl(previousFile);
    if (oldTab) oldTab.classList.remove('active');
    if (oldItem) oldItem.classList.remove('active');
  }
  activeFile = file;
  const currentTab = findTabEl(file);
  const currentItem = findSideItemEl(file);
  if (currentTab) currentTab.classList.add('active');
  if (currentItem) currentItem.classList.add('active');

  const panes = document.getElementById('panes'), outputPane = document.getElementById('outputPane');
  if (file === 'preview') {
    panes.classList.add('preview-tab-mode'); outputPane.classList.add('show');
    document.getElementById('editor').style.display = 'none';
    document.getElementById('statusFile').textContent = 'Preview';
    run();
  } else {
    panes.classList.remove('preview-tab-mode');
    document.getElementById('editor').style.display = 'block';
    editor.setModel(models[file]);
    document.getElementById('statusFile').textContent = basename(file);
    clearDecorations();
    if (findbar.classList.contains('show')) refreshMatches();
  }
}

function getSelectedText() { const sel = editor.getSelection(); return (!sel || sel.isEmpty()) ? '' : editor.getModel().getValueInRange(sel); }
async function writeClipboardAsync(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch (e) {}
  try { const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0'; document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length); const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok; } catch (e) { return false; }
}
async function readClipboardAsync() { try { if (navigator.clipboard && navigator.clipboard.readText) return await navigator.clipboard.readText(); } catch (e) {} return null; }
async function copySelection() { const text = getSelectedText(); if (!text) return showToast('Nothing selected'); showToast(await writeClipboardAsync(text) ? 'Copied' : 'Copy failed'); }
async function cutSelection() { const text = getSelectedText(); if (!text) return showToast('Nothing selected'); const sel = editor.getSelection(); if (!(await writeClipboardAsync(text))) return showToast('Cut failed'); editor.executeEdits('cut', [{ range: sel, text: '' }]); showToast('Cut'); }
async function pasteFromClipboard() { const text = await readClipboardAsync(); if (text === null) return showToast('Paste not allowed'); if (text === '') return showToast('Clipboard empty'); let sel = editor.getSelection() || new monaco.Range(1, 1, 1, 1); editor.executeEdits('paste', [{ range: sel, text, forceMoveMarkers: true }]); showToast('Pasted'); }

function showToast(msg, ms) {
  const t = document.createElement('div'); t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:' + (isMobile() ? 'calc(88px + env(safe-area-inset-bottom))' : '24px') + ';left:50%;transform:translateX(-50%);background:#0a84ff;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:99999;pointer-events:none;opacity:0;transition:opacity .2s;font-family:-apple-system,sans-serif;max-width:80vw;text-align:center;';
  document.body.appendChild(t); requestAnimationFrame(() => { t.style.opacity = '1'; }); setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 220); }, ms || 1200);
}

function wireClipboard() {
  document.getElementById('btnUndo').addEventListener('click', () => { editor.trigger('', 'undo'); editor.focus(); });
  document.getElementById('btnRedo').addEventListener('click', () => { editor.trigger('', 'redo'); editor.focus(); });
  document.getElementById('btnCopy').addEventListener('click', copySelection);
  document.getElementById('btnCut').addEventListener('click', cutSelection);
  document.getElementById('btnPaste').addEventListener('click', pasteFromClipboard);
  document.getElementById('btnSelectAll').addEventListener('click', () => { editor.setSelection(editor.getModel().getFullModelRange()); });
  document.getElementById('btnShare').addEventListener('click', async () => {
    if (typeof LZString === 'undefined') return showToast('Share unavailable');
    const data = collectWorkspaceFiles();
    const compressed = LZString.compressToEncodedURIComponent(JSON.stringify(data));
    const ok = await writeClipboardAsync(location.origin + location.pathname + '#s=' + compressed); showToast(ok ? 'Share link copied' : 'Copy failed', 1600);
  });
  document.getElementById('btnFormat').addEventListener('click', formatCurrent);
  document.getElementById('btnZip').addEventListener('click', downloadZip);
}

function wireMobileActions() {
  document.getElementById('mobileActions').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'undo') { editor.trigger('', 'undo'); editor.focus(); }
    else if (act === 'redo') { editor.trigger('', 'redo'); editor.focus(); }
    else if (act === 'copy') copySelection(); else if (act === 'paste') pasteFromClipboard();
    else if (act === 'format') formatCurrent(); else if (act === 'run') run();
  });
}

function loadScript(url) { return new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = url; s.onload = resolve; s.onerror = () => reject(new Error('Failed to load ' + url)); document.head.appendChild(s); }); }
let prettierReady = false;
async function ensurePrettier() {
  if (prettierReady) return;
  const base = 'https://cdn.jsdelivr.net/npm/prettier@3.3.3/';
  await loadScript(base + 'standalone.js');
  await Promise.all([loadScript(base + 'plugins/babel.js'), loadScript(base + 'plugins/estree.js'), loadScript(base + 'plugins/html.js'), loadScript(base + 'plugins/postcss.js'), loadScript(base + 'plugins/typescript.js'), loadScript(base + 'plugins/markdown.js')]);
  prettierReady = true;
}
async function formatCurrent() {
  if (!editor) return; 
  const parser = parserForFile(activeFile); 
  if (!parser) return showToast('No formatter for ' + activeFile);
  
  try {
    showToast('Formatting…'); 
    await ensurePrettier();
    
    // FIX: Prettier v3 loads plugins as an array, not an object
    const plugins = window.prettierPlugins || [];
    const model = models[activeFile], code = model.getValue();
    
    const formatted = await window.prettier.format(code, { 
      parser, 
      plugins, 
      tabWidth: 2, 
      printWidth: 80, 
      singleQuote: true 
    });
    
    if (formatted === code) return showToast('Already formatted');
    
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: formatted }], () => null); 
    showToast('Formatted');
  } catch (e) { 
    console.error('Format error:', e);
    showToast('Format failed: ' + (e.message || 'Syntax Error').substring(0, 40)); 
  }
}
async function downloadZip() {
  try {
    if (!window.JSZip) await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
    const zip = new window.JSZip();
    Object.entries(collectWorkspaceFiles()).forEach(([path, content]) => zip.file(path, content));
    const blob = await zip.generateAsync({ type: 'blob' }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `${projectsData[currentProjectId].name.replace(/\s+/g, '-')}.zip`; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60000); showToast('Downloaded');
  } catch (e) { showToast('Zip failed'); }
}
function applyFontSize(n) { fontSize = Math.max(10, Math.min(24, n)); if (editor) editor.updateOptions({ fontSize }); localStorage.setItem(FONTSIZE_KEY, fontSize); updateStatusFont(); }

function applyTheme(themeName) {
  localStorage.setItem(THEME_KEY, themeName);
  const isLight = (themeName === 'vs' || themeName === 'light' || themeName === 'github-light');
  document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark');
  if (editor) monaco.editor.setTheme(themeName);
  
  const meta = document.querySelector('meta[name="theme-color"]'); 
  if (meta) meta.content = isLight ? '#f3f3f3' : '#252526';
  
  const themeSelect = document.getElementById('themeSelect');
  if (themeSelect) themeSelect.value = themeName;
}

function wireSettings() {
  document.getElementById('btnFontMinus').addEventListener('click', () => applyFontSize(fontSize - 1));
  document.getElementById('btnFontPlus').addEventListener('click', () => applyFontSize(fontSize + 1));
  
  const themeSelect = document.getElementById('themeSelect');
  themeSelect.value = currentTheme;
  themeSelect.addEventListener('change', (e) => applyTheme(e.target.value));

  document.getElementById('btnTheme').addEventListener('click', () => { 
    const cur = localStorage.getItem(THEME_KEY) || 'vs-dark'; 
    const next = cur === 'vs' ? 'vs-dark' : 'vs';
    applyTheme(next);
  });
}

let matches = [], matchIndex = -1, decorations = [];
const findbar = document.getElementById('findbar'), findInput = document.getElementById('findInput'), replInput = document.getElementById('replaceInput'), countEl = document.getElementById('count'), caseBtn = document.getElementById('btnCase');
function normalizeNL(s) { return s.replace(/\r\n?/g, '\n'); }
function autosize(el, max) { max = max || 110; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, max) + 'px'; }
function openFindBar() { findbar.classList.add('show'); autosize(findInput); autosize(replInput); findInput.focus(); findInput.select(); refreshMatches(); }
function wireFindBar() {
  document.getElementById('btnFind').addEventListener('click', () => { if (findbar.classList.contains('show')) { findbar.classList.remove('show'); clearDecorations(); } else openFindBar(); });
  document.getElementById('btnCloseFind').addEventListener('click', () => { findbar.classList.remove('show'); clearDecorations(); });
  caseBtn.addEventListener('click', () => { caseBtn.classList.toggle('on'); refreshMatches(); });
  findInput.addEventListener('input', () => { autosize(findInput); refreshMatches(); });
  findInput.addEventListener('keydown', e => { if (e.key === 'Escape') { findbar.classList.remove('show'); clearDecorations(); return; } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); goTo(matchIndex + (e.shiftKey ? -1 : 1)); } });
  replInput.addEventListener('input', () => autosize(replInput));
  replInput.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); replaceCurrent(); } });
  document.getElementById('btnNext').addEventListener('click', () => goTo(matchIndex + 1));
  document.getElementById('btnPrev').addEventListener('click', () => goTo(matchIndex - 1));
  document.getElementById('btnReplace').addEventListener('click', replaceCurrent);
  document.getElementById('btnReplaceAll').addEventListener('click', replaceAll);
  autosize(findInput); autosize(replInput);
}
function isCaseSensitive() { return caseBtn.classList.contains('on'); }
function refreshMatches(keepIndex) {
  if (!editor) return; if (!findbar.classList.contains('show')) return clearDecorations();
  const model = editor.getModel(), q = normalizeNL(findInput.value);
  matches = q ? model.findMatches(q, false, false, isCaseSensitive(), null, false).map(r => r.range) : [];
  if (!keepIndex) matchIndex = matches.length ? 0 : -1;
  if (matchIndex >= matches.length) matchIndex = matches.length - 1;
  if (matchIndex < 0 && matches.length) matchIndex = 0;
  updateCount(); paintDecorations();
}
function updateCount() { countEl.textContent = matches.length ? (matchIndex + 1) + '/' + matches.length : '0/0'; }
function clearDecorations() { if (editor) decorations = editor.deltaDecorations(decorations, []); matches = []; matchIndex = -1; updateCount(); }
function paintDecorations() { if (!editor) return; decorations = editor.deltaDecorations(decorations, matches.map((r, i) => ({ range: r, options: { inlineClassName: i === matchIndex ? 'match-current' : 'match-all' } }))); }
function goTo(i) { if (!matches.length) return; matchIndex = ((i % matches.length) + matches.length) % matches.length; editor.revealRangeInCenter(matches[matchIndex]); updateCount(); paintDecorations(); }
function replaceCurrent() { if (!matches.length || matchIndex < 0) return refreshMatches(); editor.getModel().pushEditOperations([], [{ range: matches[matchIndex], text: normalizeNL(replInput.value) }], () => null); refreshMatches(true); }
function replaceAll() {
  const q = normalizeNL(findInput.value); if (!q) return;
  const model = editor.getModel(), found = model.findMatches(q, false, false, isCaseSensitive(), null, false);
  if (!found.length) return showToast('No matches');
  const repl = normalizeNL(replInput.value);
  const edits = found.map(r => ({ range: r.range, text: repl })).sort((a, b) => b.range.startLineNumber - a.range.startLineNumber || b.range.startColumn - a.range.startColumn);
  model.pushEditOperations([], edits, () => null); refreshMatches();
  showToast('Replaced ' + found.length + (found.length === 1 ? ' match' : ' matches'));
}

function wireRun() {
  document.getElementById('btnRun').addEventListener('click', () => {
    document.getElementById('outputPane').classList.remove('mobile-mode');
    run();
  });
}

/* =========================================================
   CONSOLE & TERMINAL (Global Panel)
   ========================================================= */
const consoleEl = document.getElementById('console');
const termEl = document.getElementById('terminal');
const termOutput = document.getElementById('termOutput');
const termInput = document.getElementById('termInput');
const bottomPanel = document.getElementById('bottomPanel');
let activePanel = 'console';

function setActivePanel(panel) {
  activePanel = panel;
  document.getElementById('btnTabConsole').classList.toggle('active', panel === 'console');
  document.getElementById('btnTabTerminal').classList.toggle('active', panel === 'terminal');
  document.getElementById('btnTabAI').classList.toggle('active', panel === 'ai');
  
  const aiPanel = document.getElementById('aiPanel');
  
  if (panel === 'console') { consoleEl.style.display = 'block'; consoleEl.classList.add('show'); termEl.style.display = 'none'; aiPanel.style.display = 'none'; }
  else if (panel === 'terminal') { consoleEl.style.display = 'none'; termEl.style.display = 'flex'; aiPanel.style.display = 'none'; termInput.focus(); }
  else if (panel === 'ai') { consoleEl.style.display = 'none'; termEl.style.display = 'none'; aiPanel.style.display = 'flex'; document.getElementById('aiInput').focus(); }
}

function wireConsole() {
  document.getElementById('btnTogglePanel').addEventListener('click', () => { bottomPanel.classList.toggle('hidden'); if (!bottomPanel.classList.contains('hidden')) { if (activePanel === 'terminal') termInput.focus(); if (editor) editor.layout(); } else { if (editor) editor.layout(); }});
  document.getElementById('btnClosePanel').addEventListener('click', () => { bottomPanel.classList.add('hidden'); if (editor) editor.layout(); });
  document.getElementById('btnTabConsole').addEventListener('click', () => setActivePanel('console'));
  document.getElementById('btnTabTerminal').addEventListener('click', () => setActivePanel('terminal'));
  document.getElementById('btnTabAI').addEventListener('click', () => setActivePanel('ai'));
  
  document.getElementById('btnCopyPanel').addEventListener('click', async () => {
    const text = activePanel === 'console' ? Array.from(consoleEl.children).map(el => el.textContent).join('\n') : termOutput.textContent;
    if (!text.trim()) return showToast('Empty'); showToast(await writeClipboardAsync(text) ? 'Copied' : 'Copy failed');
  });
  document.getElementById('btnClearPanel').addEventListener('click', () => { if (activePanel === 'console') clearConsole(); else if (activePanel === 'terminal') termOutput.innerHTML = ''; else if (activePanel === 'ai') document.getElementById('aiMessages').innerHTML = ''; });
  termInput.addEventListener('keydown', e => { if (e.key === 'Enter') { const cmd = termInput.value.trim(); termInput.value = ''; if (cmd) executeCommand(cmd); } });
  termOutput.innerHTML = `<div class="term-line term-success">Welcome to IDEDITOR Terminal.</div><div class="term-line">Type <span class="term-success">help</span> for a list of commands.</div><br>`;
}

function addTermLine(msg, type = '') {
  const div = document.createElement('div'); div.className = 'term-line' + (type ? ' term-' + type : ''); div.textContent = msg;
  termOutput.appendChild(div); termOutput.scrollTop = termOutput.scrollHeight;
}

function parseTerminalArgs(raw) {
  const args = [], pattern = /"([^"]*)"|'([^']*)'|(\S+)/g; let match;
  while ((match = pattern.exec(raw)) !== null) { args.push(match[1] !== undefined ? match[1] : match[2] !== undefined ? match[2] : match[3]); }
  return args;
}

async function executeCommand(raw) {
  addTermLine(`$ ${raw}`);
  const args = parseTerminalArgs(raw), cmd = args[0].toLowerCase();
  switch (cmd) {
    case 'help': addTermLine('Available: clear, ls, cat, touch, mkdir, run, format, git clone, git commit, git pull, git push, firebase save/load, theme', 'info'); break;
    case 'clear': termOutput.innerHTML = ''; break;
    case 'ls': addTermLine(filesList.join('    ')); break;
    case 'cat': if (!args[1] || !Object.prototype.hasOwnProperty.call(FILES, args[1])) return addTermLine('File not found', 'error'); addTermLine(readProjectFile(args[1])); break;
    case 'touch': if (!args[1]) return addTermLine('Usage: touch <file>', 'error'); if (FILES[args[1]]) return addTermLine('Exists', 'error'); FILES[args[1]] = { lang: langFromFilename(args[1]), content: '' }; filesList.push(args[1]); renderTabs(); renderSidebarFiles(); saveCurrentProjectFiles(); addTermLine(`Created ${args[1]}`, 'success'); break;
    case 'mkdir': if (!args[1]) return addTermLine('Usage: mkdir <folder>', 'error'); const placeholder = `${args[1]}/.gitkeep`; if (FILES[placeholder]) return addTermLine('Exists', 'error'); FILES[placeholder] = { lang: 'plaintext', content: '' }; filesList.push(placeholder); renderTabs(); renderSidebarFiles(); saveCurrentProjectFiles(); addTermLine(`Created folder`, 'success'); break;
    case 'run': run(); addTermLine('Preview triggered', 'success'); break;
    case 'format': await formatCurrent(); break;
    case 'theme': if (args[1]) { applyTheme(args[1]); addTermLine(`Theme set to ${args[1]}`, 'success'); } else addTermLine('Usage: theme <vs-dark|vs|dracula|monokai>', 'error'); break;
    case 'git': handleGitCommand(args); break;
    case 'firebase': handleFirebaseCommand(args); break;
    default: addTermLine(`Command not found: ${cmd}`, 'error');
  }
}

async function handleFirebaseCommand(args) {
  if (!firebaseEnabled || !fbUser) return addTermLine('Not logged in to Firebase', 'error');
  if (args[1] === 'save') await saveToCloud(); else if (args[1] === 'load') await loadFromCloud(); else addTermLine('Unknown firebase command', 'error');
}

function clearConsole() { if (consoleEl) consoleEl.innerHTML = ''; }
function addConsoleLine(type, msg) {
  if (!consoleEl) return; const row = document.createElement('div'); row.className = 'cl cl-' + type;
  row.textContent = (type === 'error' ? '✖ ' : type === 'warn' ? '⚠ ' : '') + msg;
  if (type === 'error') { const m = msg.match(/@\s*line\s+(\d+)/i); if (m) { const line = parseInt(m[1], 10); row.classList.add('cl-clickable'); row.title = 'Jump to line ' + line; row.addEventListener('click', () => { if (editor) { editor.revealLineInCenter(line); editor.setPosition({ lineNumber: line, column: 1 }); editor.focus(); }}); } }
  consoleEl.appendChild(row); 
  if (type === 'error' && bottomPanel.classList.contains('hidden')) { bottomPanel.classList.remove('hidden'); setActivePanel('console'); if (editor) editor.layout(); }
  consoleEl.scrollTop = consoleEl.scrollHeight;
}
const PREVIEW_MESSAGE_TYPES = new Set(['log', 'info', 'warn', 'error']);
window.addEventListener('message', (event) => {
  const frame = document.getElementById('preview');
  const data = event.data;
  if (!frame || event.source !== frame.contentWindow) return;
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.__preview !== true) return;
  if (!PREVIEW_MESSAGE_TYPES.has(data.type) || typeof data.msg !== 'string') return;
  addConsoleLine(data.type, data.msg.slice(0, 5000));
});

function readProjectFile(path) {
  const model = models[path];
  if (model) return model.getValue();
  const meta = FILES[path];
  return typeof meta === 'string' ? meta : (meta && meta.content != null ? String(meta.content) : '');
}

function buildDoc(html, css, js, workspaceFiles) {
  return window.IDEditorCore.buildPreviewDocument(html, css, js, workspaceFiles || collectWorkspaceFiles());
}

function run() {
  if (!editor) return;
  clearConsole();
  document.getElementById('outputPane').classList.add('show');
  document.getElementById('preview').srcdoc = buildDoc(
    readProjectFile('index.html'),
    readProjectFile('style.css'),
    readProjectFile('script.js'),
    collectWorkspaceFiles()
  );
}

function wirePreviewControls() {
  const outputPane = document.getElementById('outputPane'), btnFullscreen = document.getElementById('btnFullscreen'), btnOpen = document.getElementById('btnOpen'), btnAuto = document.getElementById('btnAuto'), btnClose = document.getElementById('btnClosePreview');
  btnClose.addEventListener('click', () => { outputPane.classList.remove('show'); document.getElementById('panes').classList.remove('preview-tab-mode'); document.getElementById('editor').style.display = 'block'; if (activeFile === 'preview') switchFile(filesList[0]); });
  function setFullscreen(on) { outputPane.classList.toggle('fullscreen', on); if (on) outputPane.classList.add('show'); btnFullscreen.classList.toggle('on', on); btnFullscreen.title = on ? 'Exit fullscreen' : 'Fullscreen preview'; }
  btnFullscreen.addEventListener('click', () => setFullscreen(!outputPane.classList.contains('fullscreen')));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && outputPane.classList.contains('fullscreen')) setFullscreen(false); });
  btnOpen.addEventListener('click', () => {
    const html = buildDoc(
      readProjectFile('index.html'),
      readProjectFile('style.css'),
      readProjectFile('script.js'),
      collectWorkspaceFiles()
    );
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ideditor-preview.html';
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    showToast('Preview HTML downloaded');
  });
  let autoOn = false, autoTimer = null;
  btnAuto.addEventListener('click', () => { autoOn = !autoOn; btnAuto.classList.toggle('on', autoOn); if (autoOn) run(); });
  const hookAuto = (m) => m.onDidChangeContent(() => { if (!autoOn) return; clearTimeout(autoTimer); autoTimer = setTimeout(run, 600); });
  Object.values(models).forEach(hookAuto); window.__hookAutoRun = hookAuto;
}

/* =========================================================
   GITHUB REST API IMPLEMENTATION
   ========================================================= */

function getRepoConfig(project = currentProject()) {
  const tracking = project && projectGitTracking(project);
  return { url: (tracking && tracking.remoteUrl) || localStorage.getItem(GIT_URL_KEY) || '', token: volatileGitToken };
}
function setCurrentProjectRemoteUrl(url) {
  const project = currentProject();
  if (!project) return;
  const tracking = projectGitTracking(project);
  if (project.pendingCommit && project.pendingCommit.remoteUrl !== url) {
    throw new Error('Push or clear the staged commit before changing this project repository.');
  }
  if (tracking.remoteUrl !== url) {
    tracking.remoteUrl = url;
    tracking.branch = '';
    tracking.branches = {};
  }
  saveProjectsToStorage();
}

function parseGitHubUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    if (parsed.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(parsed.hostname.toLowerCase())) return null;
    const parts = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/i, '').split('/').filter(Boolean);
    if (parts.length !== 2 || !parts.every(part => /^[a-zA-Z0-9_.-]+$/.test(part))) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch (error) {
    return null;
  }
}

function encodeBase64(str) { return btoa(unescape(encodeURIComponent(str))); }
function decodeBase64(str) { return decodeURIComponent(escape(atob(str))); }

async function handleGitCommand(args) {
  const sub = args[1];
  if (sub === 'clone') {
    if (!args[2]) return addTermLine('Usage: git clone <url>', 'error');
    const repoUrl = args.slice(2).join(' ').trim();
    try { setCurrentProjectRemoteUrl(repoUrl); } catch (error) { addTermLine(error.message, 'error'); return; }
    localStorage.setItem(GIT_URL_KEY, repoUrl); // Legacy default for newly created projects.
    document.getElementById('gitRepoUrl').value = repoUrl;
    addTermLine(`Cloning: ${repoUrl}...`, 'info');
    const loader = document.createElement('div'); loader.className = 'term-line term-info'; loader.textContent = '⏳ Downloading repository...'; termOutput.appendChild(loader); termOutput.scrollTop = termOutput.scrollHeight;
    try { await gitClone(); } catch (err) { addTermLine('Clone failed: ' + (err.message || err), 'error'); } finally { if (loader.parentNode) loader.parentNode.removeChild(loader); }
  } else if (sub === 'commit') {
    const msgIndex = args.indexOf('-m');
    if (msgIndex === -1 || !args[msgIndex + 1]) return addTermLine('Usage: git commit -m "message"', 'error');
    document.getElementById('gitMessage').value = args.slice(msgIndex + 1).join(' ');
    addTermLine(`Committing...`, 'info'); await gitCommit();
  } else if (sub === 'pull') {
    addTermLine('Synchronizing from remote...', 'info');
    try { await gitPull(); } catch (error) { addTermLine('Pull failed: ' + (error.message || error), 'error'); }
  } else if (sub === 'push') {
    addTermLine('Publishing staged commit...', 'info'); await gitPush();
  } else {
    addTermLine('Unknown git command', 'error');
  }
}

function collectWorkspaceFiles() {
  const snapshot = {};
  Object.entries(FILES || {}).forEach(([path, meta]) => {
    snapshot[path] = typeof meta === 'string' ? meta : (meta && meta.content != null ? String(meta.content) : '');
  });
  Object.entries(models).forEach(([path, model]) => { snapshot[path] = model.getValue(); });
  return snapshot;
}
function currentProject() { return currentProjectId && projectsData[currentProjectId] ? projectsData[currentProjectId] : null; }
function projectGitTracking(project = currentProject()) {
  if (!project) return null;
  if (!project.gitTracking || typeof project.gitTracking !== 'object') project.gitTracking = { remoteUrl:'', branch:'', branches:{} };
  if (typeof project.gitTracking.remoteUrl !== 'string') project.gitTracking.remoteUrl = '';
  if (typeof project.gitTracking.branch !== 'string') project.gitTracking.branch = '';
  if (!project.gitTracking.branches || typeof project.gitTracking.branches !== 'object') project.gitTracking.branches = {};
  return project.gitTracking;
}
async function fetchGitHubSnapshot(branchOverride) {
  const config = getRepoConfig(), parsed = parseGitHubUrl(config.url);
  if (!parsed) throw new Error('Enter a valid GitHub repository URL first.');
  const headers = { Accept:'application/vnd.github+json' };
  if (config.token) headers.Authorization = 'Bearer ' + config.token;
  const repoResponse = await fetch('https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo, { headers });
  const repoData = await repoResponse.json().catch(() => ({}));
  if (!repoResponse.ok) throw new Error(repoData.message || 'Unable to access repository.');
  const select = document.getElementById('gitBranchSelect');
  const tracking = projectGitTracking(currentProject());
  const branch = branchOverride || (tracking && tracking.remoteUrl === config.url && tracking.branch) || (select && select.value) || repoData.default_branch || 'main';
  const branchResponse = await fetch('https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo + '/branches/' + encodeURIComponent(branch), { headers });
  const branchData = await branchResponse.json().catch(() => ({}));
  if (!branchResponse.ok || !branchData.commit || !branchData.commit.sha) throw new Error(branchData.message || 'Unable to read branch ' + branch);
  const commitResponse = await fetch('https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo + '/git/commits/' + branchData.commit.sha, { headers });
  const commitData = await commitResponse.json().catch(() => ({}));
  if (!commitResponse.ok || !commitData.tree || !commitData.tree.sha) throw new Error(commitData.message || 'Unable to read branch tree.');
  const treeResponse = await fetch('https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo + '/git/trees/' + commitData.tree.sha + '?recursive=1', { headers });
  const treeData = await treeResponse.json().catch(() => ({}));
  if (!treeResponse.ok || treeData.truncated) throw new Error(treeData.message || 'Repository tree is incomplete; no files changed.');
  const entries = treeData.tree || [];
  const unsupported = entries.find(item => item.type === 'commit' || (item.type === 'blob' && item.mode !== '100644'));
  if (unsupported) throw new Error('Unsupported Git entry (' + unsupported.mode + ' ' + unsupported.type + '): ' + unsupported.path + '. Clone stopped without changing the project.');
  const blobs = entries.filter(item => item.type === 'blob'), files = {};
  for (const blob of blobs) {
    if (blob.size > 5000000) throw new Error('File exceeds the 5 MB editor limit: ' + blob.path);
    const response = await fetch(blob.url, { headers }), data = await response.json().catch(() => ({}));
    if (!response.ok || data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error('Unable to download ' + blob.path);
    files[blob.path] = window.IDEditorCore.decodeBase64Text(data.content.replace(/\n/g, ''), blob.path);
  }
  return { owner:parsed.owner, repo:parsed.repo, remoteUrl:config.url, branch, headSha:branchData.commit.sha, files };
}
function applyWorkspaceFiles(fileSnapshot) {
  const previousFile = activeFile;
  if (editor) editor.setModel(null);
  Object.keys(models).forEach(path => { try { models[path].dispose(); } catch (error) {} delete models[path]; });
  Object.keys(savedSnapshot).forEach(path => delete savedSnapshot[path]);
  Object.keys(FILES).forEach(path => delete FILES[path]);
  filesList.length = 0; expandedFolders.clear(); foldersInitialized = false;
  Object.entries(fileSnapshot || {}).forEach(([path, content]) => {
    FILES[path] = { lang:langFromFilename(path), content:String(content) };
    filesList.push(path);
  });
  if (!filesList.length) { FILES['index.html'] = { lang:'html', content:DEFAULT_HTML }; filesList.push('index.html'); }
  activeFile = filesList.includes(previousFile) ? previousFile : filesList[0];
  // Load only the file that will be visible. Other workspace files stay in
  // FILES and are materialized as Monaco models when the user opens them.
  ensureModel(activeFile);
  renderTabs(); renderSidebarFiles(); switchFile(activeFile); saveCurrentProjectFiles();
}
async function gitClone(options = {}) {
  const targetProjectId = currentProjectId;
  const config = getRepoConfig();
  if (!parseGitHubUrl(config.url)) throw new Error('Invalid GitHub URL');
  await updateGitStatus();
  const snapshot = await fetchGitHubSnapshot(options.branch || null);
  if (currentProjectId !== targetProjectId || !projectsData[targetProjectId]) {
    showToast('Clone cancelled because the active project changed. Retry from the intended project.');
    return false;
  }
  const localFiles = collectWorkspaceFiles(), defaults = {};
  Object.entries(DEFAULT_FILES).forEach(([path, value]) => { defaults[path] = value.content || ''; });
  const clean = window.IDEditorCore.sameFileSnapshots(localFiles, defaults) || Object.values(localFiles).every(value => !value);
  if (!options.replace && !clean && !confirm('Cloning will replace the current project files. Continue?')) return false;
  applyWorkspaceFiles(snapshot.files);
  const project = currentProject(), tracking = projectGitTracking(project);
  tracking.remoteUrl = snapshot.remoteUrl; tracking.branch = snapshot.branch;
  tracking.branches[snapshot.branch] = { headSha:snapshot.headSha, files:{ ...snapshot.files } };
  delete project.pendingCommit;
  const persisted = await saveProjectsToStorage([targetProjectId]);
  if (!persisted) {
    showToast('Clone loaded, but local saving failed. Export the project before closing.');
    addTermLine('Clone loaded in memory; IndexedDB did not confirm the save.', 'error');
    return false;
  }
  showToast('Cloned ' + snapshot.owner + '/' + snapshot.repo + ' (' + snapshot.branch + ')');
  addTermLine('Clone complete: ' + Object.keys(snapshot.files).length + ' files', 'success');
  await updateGitStatus();
  return true;
}
async function gitPull(branchOverride) {
  const targetProjectId = currentProjectId;
  const project = currentProject(), tracking = projectGitTracking(project), config = getRepoConfig();
  if (!project || !tracking || tracking.remoteUrl !== config.url || !tracking.branches[tracking.branch]) {
    showToast('Clone this repository into the project before using Pull.'); return false;
  }
  if (project.pendingCommit) { showToast('Push or clear the staged commit before pulling.'); return false; }
  const targetBranch = branchOverride || tracking.branch || (document.getElementById('gitBranchSelect') && document.getElementById('gitBranchSelect').value) || 'main';
  const snapshot = await fetchGitHubSnapshot(targetBranch);
  if (currentProjectId !== targetProjectId || currentProject() !== project) {
    showToast('Pull cancelled because the active project changed. Retry from the intended project.');
    return false;
  }
  const localFiles = collectWorkspaceFiles();
  const targetBase = tracking.branches[targetBranch];
  let mergedFiles;
  if (targetBase && targetBase.files) {
    const merged = window.IDEditorCore.mergeFileSnapshots(targetBase.files, localFiles, snapshot.files);
    if (merged.conflicts.length) {
      showToast('Pull stopped: conflicting files ' + merged.conflicts.slice(0,5).join(', '));
      addTermLine('Pull conflict. No files changed: ' + merged.conflicts.join(', '), 'error'); return false;
    }
    mergedFiles = merged.files;
  } else {
    const previousBase = tracking.branches[tracking.branch];
    if (!previousBase || !window.IDEditorCore.sameFileSnapshots(localFiles, previousBase.files)) {
      showToast('This branch has no sync baseline and local edits exist. Clone it into a new project first.'); return false;
    }
    mergedFiles = snapshot.files;
  }
  applyWorkspaceFiles(mergedFiles);
  tracking.remoteUrl = snapshot.remoteUrl; tracking.branch = snapshot.branch;
  tracking.branches[snapshot.branch] = { headSha:snapshot.headSha, files:{ ...snapshot.files } };
  const persisted = await saveProjectsToStorage([targetProjectId]);
  if (!persisted) {
    showToast('Pull applied in memory, but local saving failed. Export the project before closing.');
    addTermLine('Pull applied; IndexedDB did not confirm the save.', 'error');
    return false;
  }
  showToast('Pulled and synchronized ' + snapshot.branch);
  addTermLine('Pull complete. Non-overlapping local changes were preserved.', 'success');
  await updateGitStatus(); return true;
}
async function gitCommit() {
  const targetProjectId = currentProjectId;
  const project = currentProject();
  if (!project) return showToast('No active project');
  if (project.pendingCommit) return showToast('Push the staged commit before creating another one.');
  const savedLocally = await saveCurrentProjectFiles();
  if (!savedLocally) {
    showToast('Cannot stage a commit because the local project save failed.');
    return false;
  }
  if (currentProjectId !== targetProjectId || currentProject() !== project) {
    showToast('Commit cancelled because the active project changed.');
    return false;
  }
  const tracking = projectGitTracking(project);
  const branch = tracking.branch || (document.getElementById('gitBranchSelect') && document.getElementById('gitBranchSelect').value) || 'main';
  const message = (document.getElementById('gitMessage').value || 'Update from IDEDITOR').trim();
  project.pendingCommit = { id:generateId(), message, branch, remoteUrl:getRepoConfig().url, files:collectWorkspaceFiles(), createdAt:Date.now() };
  const persisted = await saveProjectsToStorage([targetProjectId]);
  if (!persisted) {
    showToast('Commit staged in memory, but could not be saved locally. Export before closing.');
    addTermLine('Commit staged in memory only; IndexedDB did not confirm the save.', 'error');
    return false;
  }
  showToast('Commit saved locally. Push to publish it.');
  addTermLine('Staged local commit: ' + message, 'success'); return true;
}
async function gitPush() {
  const targetProjectId = currentProjectId;
  const project = currentProject(), pending = project && project.pendingCommit;
  const config = getRepoConfig(), parsed = parseGitHubUrl(config.url);
  if (!project || !pending) return showToast('Commit Changes first, then Push.');
  if (!parsed || !config.token) return showToast('Set a valid repository URL and session token in Git Settings.');
  if (pending.remoteUrl !== config.url) return showToast('The staged commit belongs to a different repository.');
  const branch = pending.branch;
  const tracking = projectGitTracking(project);
  if (tracking.branch && branch !== tracking.branch) return showToast('The staged commit belongs to a different project branch.');
  const baseline = tracking && tracking.remoteUrl === config.url && tracking.branches[branch];
  if (!baseline || !baseline.headSha) return showToast('Clone or Pull this branch before pushing.');
  const headers = { Accept:'application/vnd.github+json', Authorization:'Bearer ' + config.token, 'Content-Type':'application/json' };
  try {
    const branchResponse = await fetch('https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo + '/branches/' + encodeURIComponent(branch), { headers });
    const branchData = await branchResponse.json().catch(() => ({})), remoteHead = branchData.commit && branchData.commit.sha;
    if (!branchResponse.ok) throw new Error(branchData.message || 'Unable to read remote branch.');
    if (!window.IDEditorCore.canPublishAgainst(remoteHead, baseline.headSha)) throw new Error('Remote branch moved. Pull and resolve changes before pushing.');
    const commitResponse = await fetch('https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo + '/git/commits/' + remoteHead, { headers });
    const commitData = await commitResponse.json().catch(() => ({}));
    if (!commitResponse.ok || !commitData.tree || !commitData.tree.sha) throw new Error(commitData.message || 'Unable to read remote commit tree.');
    const blobShas = {};
    for (const path of Object.keys(pending.files)) {
      if (Object.prototype.hasOwnProperty.call(baseline.files, path) && pending.files[path] === baseline.files[path]) continue;
      const blobResponse = await fetch('https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo + '/git/blobs', {
        method:'POST', headers, body:JSON.stringify({ content:pending.files[path], encoding:'utf-8' })
      });
      const blobData = await blobResponse.json().catch(() => ({}));
      if (!blobResponse.ok || !blobData.sha) throw new Error(blobData.message || 'Failed to upload ' + path);
      blobShas[path] = blobData.sha;
    }
    const treeItems = window.IDEditorCore.buildGitTreeEntries(pending.files, baseline.files, blobShas);
    if (!treeItems.length) {
      delete project.pendingCommit;
      const persisted = await saveProjectsToStorage([targetProjectId]);
      if (!persisted) {
        project.pendingCommit = pending;
        showToast('No remote changes were needed, but the local staged commit could not be cleared.');
        return false;
      }
      document.getElementById('gitMessage').value = '';
      showToast('No changes to push.'); return true;
    }
    const treeResponse = await fetch('https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo + '/git/trees', {
      method:'POST', headers, body:JSON.stringify({ base_tree:commitData.tree.sha, tree:treeItems })
    });
    const treeData = await treeResponse.json().catch(() => ({}));
    if (!treeResponse.ok || !treeData.sha) throw new Error(treeData.message || 'Failed to create Git tree.');
    const newCommitResponse = await fetch('https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo + '/git/commits', {
      method:'POST', headers, body:JSON.stringify({ message:pending.message, tree:treeData.sha, parents:[remoteHead] })
    });
    const newCommitData = await newCommitResponse.json().catch(() => ({}));
    if (!newCommitResponse.ok || !newCommitData.sha) throw new Error(newCommitData.message || 'Failed to create remote commit.');
    const updateRefResponse = await fetch('https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo + '/git/refs/heads/' + encodeURIComponent(branch), {
      method:'PATCH', headers, body:JSON.stringify({ sha:newCommitData.sha, force:false })
    });
    const updateRefData = await updateRefResponse.json().catch(() => ({}));
    if (!updateRefResponse.ok) throw new Error(updateRefData.message || 'Push rejected because remote branch moved.');
    baseline.headSha = newCommitData.sha; baseline.files = { ...pending.files };
    delete project.pendingCommit;
    const persisted = currentProjectId === targetProjectId
      ? await saveCurrentProjectFiles()
      : await saveProjectsToStorage([targetProjectId]);
    if (!persisted) {
      showToast('GitHub accepted the push, but local sync data could not be saved. Pull before attempting another push.');
      addTermLine('Remote push succeeded; local IndexedDB persistence failed.', 'error');
      await updateGitStatus();
      return false;
    }
    document.getElementById('gitMessage').value = '';
    showToast('Pushed committed snapshot to ' + branch);
    addTermLine('Push successful: ' + newCommitData.sha.slice(0,7), 'success');
    await updateGitStatus(); return true;
  } catch (error) {
    showToast('Push failed: ' + (error.message || 'Unknown GitHub error'));
    addTermLine('Push failed: ' + (error.message || error), 'error'); return false;
  }
}
async function updateGitStatus() {
  const el = document.getElementById('gitStatus'), branchSelect = document.getElementById('gitBranchSelect');
  const config = getRepoConfig(), parsed = parseGitHubUrl(config.url);
  if (!parsed) { el.textContent = 'Not connected'; branchSelect.style.display = 'none'; return; }
  const headers = { Accept:'application/vnd.github+json' };
  if (config.token) headers.Authorization = 'Bearer ' + config.token;
  try {
    const repoResponse = await fetch('https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo, { headers });
    const repoData = await repoResponse.json().catch(() => ({}));
    if (!repoResponse.ok) throw new Error(repoData.message || 'Repository unavailable');
    el.textContent = 'Connected: ' + parsed.owner + '/' + parsed.repo;
    const branchResponse = await fetch('https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo + '/branches?per_page=100', { headers });
    const branches = await branchResponse.json().catch(() => []);
    if (!branchResponse.ok || !Array.isArray(branches)) throw new Error('Unable to load branches');
    const tracking = projectGitTracking(currentProject());
    const preferred = (tracking && tracking.remoteUrl === config.url && tracking.branch) || repoData.default_branch;
    branchSelect.innerHTML = '';
    branches.forEach(info => { const option = document.createElement('option'); option.value = info.name; option.textContent = info.name; branchSelect.appendChild(option); });
    branchSelect.value = branches.some(info => info.name === preferred) ? preferred : repoData.default_branch;
    if (!branchSelect.value && branches.length) branchSelect.selectedIndex = 0;
    branchSelect.style.display = branches.length ? 'block' : 'none';
    branchSelect.dataset.currentBranch = branchSelect.value || repoData.default_branch;
  } catch (error) {
    el.textContent = 'Not connected (' + (error.message || 'API error') + ')'; branchSelect.style.display = 'none';
  }
}

function wireGitUI() {
  document.getElementById('btnGitSettings').addEventListener('click', () => {
    const { url, token } = getRepoConfig();
    document.getElementById('gitRepoUrl').value = url;
    document.getElementById('gitToken').value = token;
    document.getElementById('gitSettingsModal').style.display = 'flex';
  });

  document.getElementById('btnGitSaveSettings').addEventListener('click', async () => {
    const url = document.getElementById('gitRepoUrl').value.trim();
    const token = document.getElementById('gitToken').value.trim();
    if (url && !parseGitHubUrl(url)) {
      showToast('Enter a valid HTTPS GitHub repository URL');
      return;
    }
    try { setCurrentProjectRemoteUrl(url); } catch (error) { showToast(error.message); return; }
    localStorage.setItem(GIT_URL_KEY, url); // Legacy default for newly created projects.
    volatileGitToken = token;
    try { localStorage.removeItem(GIT_TOKEN_KEY); } catch (error) {}

    if (firebaseEnabled && fbUser) {
      try {
        const { doc, setDoc, updateDoc, deleteField } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
        const settingsRef = doc(fbDb, 'users', fbUser.uid, 'settings', 'git');
        await setDoc(settingsRef, { url, updatedAt: new Date().toISOString() }, { merge: true });
        try { await updateDoc(settingsRef, { token: deleteField() }); } catch (cleanupError) {
          console.warn('Legacy Firebase Git token cleanup could not complete.');
        }
        addTermLine('Repository URL saved to Cloud; token remains in this tab only', 'success');
      } catch (e) { addTermLine('Failed to save repository URL to cloud', 'error'); }
    }
    document.getElementById('gitSettingsModal').style.display = 'none';
    showToast('Git settings saved');
    updateGitStatus();
  });

  document.getElementById('btnGitCloseSettings').addEventListener('click', () => document.getElementById('gitSettingsModal').style.display = 'none');
  document.getElementById('btnGitCommit').addEventListener('click', gitCommit); 
  document.getElementById('btnGitPush').addEventListener('click', gitPush);
  document.getElementById('btnGitPull').addEventListener('click', () => {
    gitPull().catch(error => {
      showToast('Pull failed: ' + (error.message || 'Unknown error'));
      addTermLine('Pull failed: ' + (error.message || error), 'error');
    });
  }); 
  
  document.getElementById('gitBranchSelect').addEventListener('change', (e) => {
    const tracking = projectGitTracking(currentProject());
    const previousBranch = (tracking && tracking.branch) || e.target.dataset.currentBranch || 'main';
    const selectedBranch = e.target.value;
    if (!selectedBranch || selectedBranch === previousBranch) return;
    if (!confirm('Switch to branch "' + selectedBranch + '" and synchronize it with this project?')) {
      e.target.value = previousBranch;
      return;
    }
    gitPull(selectedBranch).then(success => {
      if (!success) e.target.value = previousBranch;
    }).catch(error => {
      e.target.value = previousBranch;
      showToast('Branch switch failed: ' + (error.message || 'Unknown error'));
      addTermLine('Branch switch failed: ' + (error.message || error), 'error');
    });
  });
  
  document.getElementById('btnGitGraph').addEventListener('click', () => { document.getElementById('gitGraphContainer').style.display = 'block'; renderGitGraph(); });
  document.getElementById('btnGitCloseGraph').addEventListener('click', () => document.getElementById('gitGraphContainer').style.display = 'none');
  
  updateGitStatus();
}

async function renderGitGraph() {
  const svg = document.getElementById('gitGraphSvg'); svg.innerHTML = '';
  const { url, token } = getRepoConfig();
  const parsed = parseGitHubUrl(url);
  if (!parsed) return showToast('No repo configured');
  
  const headers = { 'Accept': 'application/vnd.github.v3+json' };
  if (token) headers['Authorization'] = `token ${token}`;
  const tracking = projectGitTracking(currentProject());
  const branch = (tracking && tracking.branch) || (document.getElementById('gitBranchSelect') && document.getElementById('gitBranchSelect').value) || 'main';

  try {
    const res = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits?sha=${encodeURIComponent(branch)}`, { headers });
    const commits = await res.json();
    if (!commits.length) return;
    
    const rowH = 36, x = 40;
    svg.setAttribute('width', '100%'); svg.setAttribute('height', commits.length * rowH + 20); svg.style.background = 'var(--bg)';
    commits.forEach((c, i) => {
      const y = 20 + i * rowH;
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); circle.setAttribute('cx', x); circle.setAttribute('cy', y); circle.setAttribute('r', 6); circle.setAttribute('fill', '#0a84ff'); svg.appendChild(circle);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text'); text.setAttribute('x', x + 20); text.setAttribute('y', y + 4); text.setAttribute('fill', 'currentColor'); text.setAttribute('font-size', '12'); text.setAttribute('font-family', 'ui-monospace, monospace'); text.textContent = c.sha.slice(0, 7) + '  ' + c.commit.message.split('\n')[0].slice(0, 60); svg.appendChild(text);
    });
  } catch (e) { showToast('Failed to load graph'); }
}

/* =========================================================
   AI ASSISTANT IMPLEMENTATION
   ========================================================= */

const AI_PROVIDERS = {
  openai: { url: 'https://api.openai.com/v1/chat/completions', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'] },
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', models: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct'] },
  gemini: { url: 'https://generativelanguage.googleapis.com/v1beta/models/', models: ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash'] }
};

function wireAI() {
  const providerSelect = document.getElementById('aiProvider');
  const apiKeyInput = document.getElementById('aiApiKey');
  const modelSelect = document.getElementById('aiModel');
  [providerSelect, apiKeyInput, modelSelect].forEach(element => { if (element) element.style.display = 'none'; });
  const options = {
    editor,
    models,
    getActiveFile: () => activeFile,
    legacy: { providerKey: AI_PROVIDER_KEY, apiKey: AI_KEY_KEY, modelKey: AI_MODEL_KEY }
  };
  if (!window.AIAgents || typeof window.AIAgents.attach !== 'function') {
    window.__aiAttachOptions = options;
    return;
  }
  window.AIAgents.attach(options);
}

function addAIMessage(role, text) {
  if (window.AIAgents && typeof window.AIAgents.renderMessage === 'function') {
    return window.AIAgents.renderMessage(role, text);
  }
  const div = document.createElement('div');
  div.className = 'ai-msg ai-' + role;
  div.textContent = text;
  return div;
}