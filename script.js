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
const GIT_TOKEN_KEY = 'idEditor.gitToken';
const GIT_BRANCH_KEY = 'idEditor.gitBranch';
const MINIMAP_KEY = 'idEditor.minimap';

// AI Storage Keys
const AI_PROVIDER_KEY = 'idEditor.aiProvider';
const AI_KEY_KEY      = 'idEditor.aiKey';
const AI_MODEL_KEY    = 'idEditor.aiModel';

let currentProjectId = null;
let projectsData = {};

/* =========================================================
   PROJECT MANAGEMENT LOGIC
   ========================================================= */
function generateId() { return 'p_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5); }

function loadProjectsData() {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.projects) {
        projectsData = parsed.projects;
        currentProjectId = parsed.currentProjectId;
      }
    }
  } catch (e) { console.warn('Failed to load projects', e); }

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
    saveProjectsToStorage();
  } else if (!currentProjectId || !projectsData[currentProjectId]) {
    currentProjectId = Object.keys(projectsData)[0];
  }

  FILES = projectsData[currentProjectId].files;
  filesList = Object.keys(FILES);
}

function saveProjectsToStorage() {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify({
      currentProjectId: currentProjectId,
      projects: projectsData
    }));
  } catch (e) { console.warn('Failed to save projects', e); }
}

function saveCurrentProjectFiles() {
  if (!currentProjectId || !projectsData[currentProjectId]) return;
  const data = {};
  Object.keys(models).forEach(k => { data[k] = models[k].getValue(); savedSnapshot[k] = data[k]; });
  projectsData[currentProjectId].files = data;
  projectsData[currentProjectId].updatedAt = Date.now();
  saveProjectsToStorage();
  hasPendingSave = false; Object.keys(models).forEach(markDirtyState);
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
  delete projectsData[id];
  if (currentProjectId === id) {
    currentProjectId = Object.keys(projectsData)[0];
    if (currentProjectId) switchProject(currentProjectId);
    else location.reload();
  }
  saveProjectsToStorage();
  renderProjectsDashboard();
}

function switchProject(id) {
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
  filesList.forEach(ensureModel);
  
  activeFile = filesList[0];
  renderTabs(); renderSidebarFiles(); switchFile(activeFile);
  saveProjectsToStorage();
  
  closeProjectsDashboard();
  showToast(`Switched to ${proj.name}`);
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

  document.getElementById('btnDashboardCloneProject').addEventListener('click', () => {
    const url = prompt('Enter GitHub Repository URL (e.g., https://github.com/octocat/Hello-World.git):');
    if (!url || !url.trim()) return;
    
    const token = localStorage.getItem(GIT_TOKEN_KEY);
    if (!token) {
      alert('You need a Personal Access Token (PAT) to clone. Please set it in the Git Settings (Gear icon in sidebar) first.');
      return;
    }

    const repoName = url.split('/').pop().replace('.git', '');
    const newProjName = prompt('Enter project name for the clone:', repoName);
    if (!newProjName) return;

    const id = generateId();
    projectsData[id] = { name: newProjName, files: {}, updatedAt: Date.now() };
    switchProject(id);
    closeProjectsDashboard();
    
    localStorage.setItem(GIT_URL_KEY, url);
    document.getElementById('gitRepoUrl').value = url;
    
    bottomPanel.classList.remove('hidden');
    setActivePanel('terminal');
    addTermLine(`$ git clone ${url}`, '');
    
    gitClone().then(() => addTermLine('Clone successful', 'success')).catch(err => addTermLine('Clone failed: ' + err.message, 'error'));
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
    saveCurrentProjectFiles();
    const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
    await setDoc(doc(fbDb, 'users', fbUser.uid, 'projects', currentProjectId), {
      name: projectsData[currentProjectId].name,
      files: projectsData[currentProjectId].files,
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
    
    let newProjects = { ...projectsData };
    querySnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      newProjects[docSnap.id] = {
        name: data.name || 'Cloud Project',
        files: data.files || {},
        updatedAt: new Date(data.updatedAt).getTime() || Date.now()
      };
    });
    projectsData = newProjects;
    saveProjectsToStorage();
    renderProjectsDashboard();
    showToast('Cloud projects loaded! Check Dashboard.');
  } catch (e) { showToast('Cloud load failed'); }
}

async function loadGitSettingsFromCloud(uid) {
  try {
    const { doc, getDoc } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
    const docSnap = await getDoc(doc(fbDb, 'users', uid, 'settings', 'git'));
    if (docSnap.exists()) {
      const data = docSnap.data();
      if (data.url) localStorage.setItem(GIT_URL_KEY, data.url);
      if (data.token) localStorage.setItem(GIT_TOKEN_KEY, data.token);
      document.getElementById('gitRepoUrl').value = data.url || '';
      document.getElementById('gitToken').value = data.token || '';
      updateGitStatus();
    }
  } catch (e) { console.warn('Failed to load Git settings'); }
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

loadProjectsData();
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

if (typeof require === 'undefined') {
  document.getElementById('editor').innerHTML = '<div style="padding:20px;color:#ff7b72;font-family:sans-serif">Failed to load Monaco Editor.</div>';
} else {
  require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
  require(['vs/editor/editor.main'], initEditor);
}

function makeUri(name) { return monaco.Uri.parse('inmemory:///' + encodeURIComponent(name) + '/' + (++uriSeq)); }

function ensureModel(name) {
  if (models[name]) return models[name];
  const meta = FILES[name];
  const model = monaco.editor.createModel(meta ? meta.content : '', meta ? meta.lang : langFromFilename(name), makeUri(name));
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
  filesList.forEach(ensureModel);

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
  Object.values(models).forEach(m => window.__hookAutoRun && window.__hookAutoRun(m));

  editor.addAction({ id: 'custom-open-find', label: 'Find', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF], run: openFindBar });
  editor.addAction({ id: 'custom-run-kb', label: 'Run', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter], run: run });

  updateStatusFont(); switchFile(activeFile);
  initFirebase();
  showToast('Loaded ' + projectsData[currentProjectId].name);
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrentProjectFiles(); showToast('Project Saved'); }
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
      ensureModel(file.name); if (!firstImported) firstImported = file.name;
    }
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
function findTabEl(name) { return Array.from(document.querySelectorAll('.tab')).find(t => t.dataset.file === name) || null; }
function findSideItemEl(name) { return Array.from(document.querySelectorAll('.side-item[data-file]')).find(t => t.dataset.file === name) || null; }

function markDirtyState(file) {
  const dirty = (savedSnapshot[file] || '') !== (models[file] ? models[file].getValue() : '');
  const tab = findTabEl(file); if (tab) tab.classList.toggle('dirty', dirty);
  const item = findSideItemEl(file); if (item) item.classList.toggle('dirty', dirty);
}

let saveTimer = null, hasPendingSave = false;
function scheduleSave() { hasPendingSave = true; clearTimeout(saveTimer); saveTimer = setTimeout(saveCurrentProjectFiles, 500); }
function setupSaveFlush() {
  document.addEventListener('visibilitychange', () => { if (document.hidden && hasPendingSave) saveCurrentProjectFiles(); });
  window.addEventListener('beforeunload', () => { if (hasPendingSave) saveCurrentProjectFiles(); });
}

function renderTabs() {
  const nav = document.getElementById('tabs'); nav.innerHTML = '';
  filesList.forEach(name => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (name === activeFile ? ' active' : '');
    btn.dataset.file = name; btn.textContent = basename(name); btn.title = name;
    attachFileMenuHandlers(btn, name); nav.appendChild(btn);
  });
  
  // Preview tab removed — preview is triggered via Run button or file context menu

  const addBtn = document.createElement('button'); addBtn.className = 'tab-add'; addBtn.title = 'New file'; addBtn.textContent = '+';
  addBtn.addEventListener('click', promptNewFile); nav.appendChild(addBtn);
  filesList.forEach(markDirtyState);
}

let foldersInitialized = false;
const expandedFolders = new Set();
function renderSidebarFiles() {
  if (!foldersInitialized && filesList.length > 0) {
    filesList.forEach(f => {
      const parts = f.split('/'); let currentPath = '';
      for (let i = 0; i < parts.length - 1; i++) { currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i]; expandedFolders.add(currentPath); }
    });
    foldersInitialized = true;
  }
  const list = document.getElementById('sideFiles'); list.innerHTML = '';
  const filter = (document.getElementById('fileFilter')?.value || '').trim().toLowerCase();
  const visibleFiles = filter ? filesList.filter(name => name.toLowerCase().includes(filter)) : filesList;
  const tree = {};
  visibleFiles.forEach(path => {
    const parts = path.split('/'); let current = tree;
    parts.forEach((part, i) => { if (!current[part]) current[part] = (i === parts.length - 1) ? 'FILE' : {}; current = current[part]; });
  });

  function buildNode(node, path, container) {
    const keys = Object.keys(node).sort((a, b) => {
      const aIsFile = node[a] === 'FILE'; const bIsFile = node[b] === 'FILE';
      if (aIsFile && !bIsFile) return 1; if (!aIsFile && bIsFile) return -1; return a.localeCompare(b);
    });
    keys.forEach(key => {
      const fullPath = path ? `${path}/${key}` : key;
      if (node[key] === 'FILE') {
        const btn = document.createElement('button');
        btn.className = 'side-item' + (fullPath === activeFile ? ' active' : '');
        btn.dataset.file = fullPath;
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M14 3v5h5" stroke="currentColor" stroke-width="1.8" fill="none"/></svg><span>' + escapeHtml(key) + '</span>';
        attachFileMenuHandlers(btn, fullPath, () => { switchFile(fullPath); if (isMobile()) closeSidebar(); });
        container.appendChild(btn);
      } else {
        const folderDiv = document.createElement('div');
        const isExpanded = expandedFolders.has(fullPath);
        const folderHeader = document.createElement('div');
        folderHeader.className = 'tree-folder' + (isExpanded ? '' : ' collapsed');
        folderHeader.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><path d="M9 18l6-6-6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${escapeHtml(key)}</span>`;
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-folder-children' + (isExpanded ? '' : ' hidden');
        folderHeader.addEventListener('click', () => {
          const nowCollapsed = !childrenContainer.classList.contains('hidden');
          childrenContainer.classList.toggle('hidden', nowCollapsed); folderHeader.classList.toggle('collapsed', nowCollapsed);
          if (nowCollapsed) expandedFolders.delete(fullPath); else expandedFolders.add(fullPath);
        });
        folderDiv.appendChild(folderHeader); folderDiv.appendChild(childrenContainer); container.appendChild(folderDiv);
        buildNode(node[key], fullPath, childrenContainer);
      }
    });
  }
  if (visibleFiles.length) buildNode(tree, '', list);
  else { const empty = document.createElement('div'); empty.className = 'file-filter-empty'; empty.textContent = 'No matching files'; list.appendChild(empty); }
  filesList.forEach(markDirtyState);
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
  FILES[placeholder] = { lang: 'plaintext', content: '' }; filesList.push(placeholder); ensureModel(placeholder);
  const parts = folder.split('/'); let currentPath = '';
  parts.forEach(p => { currentPath = currentPath ? `${currentPath}/${p}` : p; expandedFolders.add(currentPath); });
  renderTabs(); renderSidebarFiles(); saveCurrentProjectFiles(); showToast('Created folder ' + folder);
}
function renameFile(oldName, newName) {
  newName = (newName || '').trim().replace(/^\/+/, '').replace(/[\\:*?"<>|\x00-\x1F]/g, '');
  if (!newName) return showToast('Invalid name'); if (newName === oldName) return; if (FILES[newName]) return showToast('File already exists');
  const oldModel = models[oldName], oldContent = oldModel ? oldModel.getValue() : '', newLang = langFromFilename(newName);
  if (oldModel) oldModel.dispose(); delete models[oldName];
  FILES[newName] = { lang: newLang, content: oldContent }; delete FILES[oldName];
  savedSnapshot[newName] = savedSnapshot[oldName] || oldContent; delete savedSnapshot[oldName];
  filesList = filesList.map(n => n === oldName ? newName : n); if (activeFile === oldName) activeFile = newName;
  const newModel = monaco.editor.createModel(oldContent, newLang, makeUri(newName));
  models[newName] = newModel; newModel.onDidChangeContent(() => { markDirtyState(newName); scheduleSave(); });
  if (window.__hookAutoRun) window.__hookAutoRun(newModel);
  renderTabs(); renderSidebarFiles(); switchFile(activeFile); saveCurrentProjectFiles(); showToast('Renamed to ' + newName);
}
function deleteFile(name) {
  if (filesList.length <= 1) return showToast('Cannot delete the last file');
  if (!confirm('Delete "' + name + '"?')) return;
  if (models[name]) { models[name].dispose(); delete models[name]; }
  delete FILES[name]; delete savedSnapshot[name]; filesList = filesList.filter(n => n !== name);
  if (activeFile === name) { activeFile = filesList[0]; editor.setModel(models[activeFile]); }
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
  fileFilter.addEventListener('input', renderSidebarFiles);
  fileFilter.addEventListener('keydown', e => { if (e.key === 'Escape' && fileFilter.value) { fileFilter.value = ''; renderSidebarFiles(); }});
  
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
  if (file !== 'preview' && !models[file]) return;
  activeFile = file;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.file === file));
  document.querySelectorAll('.side-item[data-file]').forEach(b => b.classList.toggle('active', b.dataset.file === file));
  const panes = document.getElementById('panes'), outputPane = document.getElementById('outputPane');
  if (file === 'preview') {
    panes.classList.add('preview-tab-mode'); outputPane.classList.add('show');
    document.getElementById('editor').style.display = 'none'; document.getElementById('statusFile').textContent = 'Preview'; run();
  } else {
    panes.classList.remove('preview-tab-mode'); document.getElementById('editor').style.display = 'block';
    editor.setModel(models[file]); document.getElementById('statusFile').textContent = basename(file);
    clearDecorations(); if (findbar.classList.contains('show')) refreshMatches();
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
    const data = {}; Object.keys(models).forEach(k => { data[k] = models[k].getValue(); });
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
    const zip = new window.JSZip(); Object.keys(models).forEach(k => zip.file(k, models[k].getValue()));
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
    case 'help': addTermLine('Available: clear, ls, cat, touch, mkdir, run, format, git clone, git commit, git push, firebase save/load, theme', 'info'); break;
    case 'clear': termOutput.innerHTML = ''; break;
    case 'ls': addTermLine(filesList.join('    ')); break;
    case 'cat': if (!args[1] || !models[args[1]]) return addTermLine('File not found', 'error'); addTermLine(models[args[1]].getValue()); break;
    case 'touch': if (!args[1]) return addTermLine('Usage: touch <file>', 'error'); if (FILES[args[1]]) return addTermLine('Exists', 'error'); FILES[args[1]] = { lang: langFromFilename(args[1]), content: '' }; filesList.push(args[1]); ensureModel(args[1]); renderTabs(); renderSidebarFiles(); saveCurrentProjectFiles(); addTermLine(`Created ${args[1]}`, 'success'); break;
    case 'mkdir': if (!args[1]) return addTermLine('Usage: mkdir <folder>', 'error'); const placeholder = `${args[1]}/.gitkeep`; if (FILES[placeholder]) return addTermLine('Exists', 'error'); FILES[placeholder] = { lang: 'plaintext', content: '' }; filesList.push(placeholder); ensureModel(placeholder); renderTabs(); renderSidebarFiles(); saveCurrentProjectFiles(); addTermLine(`Created folder`, 'success'); break;
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
window.addEventListener('message', e => { const d = e.data; if (!d || d.__preview !== true) return; addConsoleLine(d.type, d.msg); });

function buildDoc(html, css, js) {
  const openScript = '<scr' + 'ipt>', closeScript = '</scr' + 'ipt>';
  const consoleHook = `${openScript}(function(){function ser(v){if(typeof v==='string')return v;if(v instanceof Error)return v.message;try{return JSON.stringify(v);}catch(e){return String(v);}}function send(type,args){try{parent.postMessage({__preview:true,type:type,msg:Array.prototype.map.call(args,ser).join(' ')},'*');}catch(e){}}['log','info','warn','error'].forEach(function(t){var orig=console[t]?console[t].bind(console):function(){};console[t]=function(){orig.apply(null,arguments);send(t,arguments);};});window.addEventListener('error',function(e){send('error',[e.message+' @ line '+e.lineno]);});window.addEventListener('unhandledrejection',function(e){send('error',['Unhandled rejection: '+ser(e.reason)]);});})();${closeScript}`;
  const headInject = consoleHook + '<style>\n' + (css || '') + '\n</style>';
  const bodyInject = openScript + '\ntry{\n' + (js || '') + '\n}catch(e){ console.error(e && e.message ? e.message : e); }\n' + closeScript;
  const h = html || '';
  if (/<html[\s>]/i.test(h)) {
    let out = h;
    if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, headInject + '</head>'); else out = out.replace(/<html[^>]*>/i, m => m + '<head>' + headInject + '</head>');
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, bodyInject + '</body>'); else out += bodyInject;
    return out;
  }
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + headInject + '</head><body>' + h + bodyInject + '</body></html>';
}

function run() { if (!editor) return; clearConsole(); document.getElementById('outputPane').classList.add('show'); document.getElementById('preview').srcdoc = buildDoc(models['index.html'] ? models['index.html'].getValue() : '', models['style.css'] ? models['style.css'].getValue() : '', models['script.js'] ? models['script.js'].getValue() : ''); }

function wirePreviewControls() {
  const outputPane = document.getElementById('outputPane'), btnFullscreen = document.getElementById('btnFullscreen'), btnOpen = document.getElementById('btnOpen'), btnAuto = document.getElementById('btnAuto'), btnClose = document.getElementById('btnClosePreview');
  btnClose.addEventListener('click', () => { outputPane.classList.remove('show'); document.getElementById('panes').classList.remove('preview-tab-mode'); document.getElementById('editor').style.display = 'block'; if (activeFile === 'preview') switchFile(filesList[0]); });
  function setFullscreen(on) { outputPane.classList.toggle('fullscreen', on); if (on) outputPane.classList.add('show'); btnFullscreen.classList.toggle('on', on); btnFullscreen.title = on ? 'Exit fullscreen' : 'Fullscreen preview'; }
  btnFullscreen.addEventListener('click', () => setFullscreen(!outputPane.classList.contains('fullscreen')));
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && outputPane.classList.contains('fullscreen')) setFullscreen(false); });
  btnOpen.addEventListener('click', () => { const blob = new Blob([buildDoc(models['index.html'] ? models['index.html'].getValue() : '', models['style.css'] ? models['style.css'].getValue() : '', models['script.js'] ? models['script.js'].getValue() : '')], { type: 'text/html' }); const url = URL.createObjectURL(blob); const w = window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000); if (!w) alert('Popup blocked'); });
  let autoOn = false, autoTimer = null;
  btnAuto.addEventListener('click', () => { autoOn = !autoOn; btnAuto.classList.toggle('on', autoOn); if (autoOn) run(); });
  const hookAuto = (m) => m.onDidChangeContent(() => { if (!autoOn) return; clearTimeout(autoTimer); autoTimer = setTimeout(run, 600); });
  Object.values(models).forEach(hookAuto); window.__hookAutoRun = hookAuto;
}

/* =========================================================
   GITHUB REST API IMPLEMENTATION
   ========================================================= */

function getRepoConfig() {
  return { url: localStorage.getItem(GIT_URL_KEY) || '', token: localStorage.getItem(GIT_TOKEN_KEY) || '' };
}

function parseGitHubUrl(url) {
  const match = url.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function encodeBase64(str) { return btoa(unescape(encodeURIComponent(str))); }
function decodeBase64(str) { return decodeURIComponent(escape(atob(str))); }

async function handleGitCommand(args) {
  const sub = args[1];
  if (sub === 'clone') {
    if (!args[2]) return addTermLine('Usage: git clone <url>', 'error');
    const repoUrl = args.slice(2).join(' ').trim();
    localStorage.setItem(GIT_URL_KEY, repoUrl);
    document.getElementById('gitRepoUrl').value = repoUrl;
    addTermLine(`Cloning: ${repoUrl}...`, 'info');
    const loader = document.createElement('div'); loader.className = 'term-line term-info'; loader.textContent = '⏳ Downloading repository...'; termOutput.appendChild(loader); termOutput.scrollTop = termOutput.scrollHeight;
    try { await gitClone(); } catch (err) { addTermLine('Clone failed: ' + (err.message || err), 'error'); } finally { if (loader.parentNode) loader.parentNode.removeChild(loader); }
  } else if (sub === 'commit') {
    const msgIndex = args.indexOf('-m');
    if (msgIndex === -1 || !args[msgIndex + 1]) return addTermLine('Usage: git commit -m "message"', 'error');
    document.getElementById('gitMessage').value = args.slice(msgIndex + 1).join(' ');
    addTermLine(`Committing...`, 'info'); await gitCommit();
  } else if (sub === 'push') {
    addTermLine('Pushing...', 'info'); await gitPush();
  } else {
    addTermLine('Unknown git command', 'error');
  }
}

async function gitClone() {
  const { url, token } = getRepoConfig();
  const parsed = parseGitHubUrl(url);
  if (!parsed) throw new Error('Invalid GitHub URL');

  const headers = { 'Accept': 'application/vnd.github.v3+json' };
  if (token) headers['Authorization'] = `token ${token}`;

  const repoRes = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, { headers });
  if (!repoRes.ok) throw new Error(`GitHub API: ${repoRes.status} ${repoRes.statusText}`);
  const repoData = await repoRes.json();
  
  const selectedBranch = document.getElementById('gitBranchSelect').value;
  const branch = selectedBranch || repoData.default_branch || 'main';
  localStorage.setItem(GIT_BRANCH_KEY, branch);

  const treeRes = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${branch}?recursive=1`, { headers });
  if (!treeRes.ok) throw new Error(`GitHub API: ${treeRes.status} ${treeRes.statusText}`);
  const treeData = await treeRes.json();
  const blobs = treeData.tree.filter(item => item.type === 'blob');

  const newFiles = {};
  await Promise.all(blobs.map(async (blob) => {
    if (blob.size > 5000000) return; // Skip >5MB
    const contentRes = await fetch(blob.url, { headers });
    if (contentRes.ok) {
      const contentData = await contentRes.json();
      const base64 = contentData.content.replace(/\n/g, '');
      newFiles[blob.path] = decodeBase64(base64);
    }
  }));

  if (editor) editor.setModel(null);
  filesList.length = 0;
  Object.keys(FILES).forEach(k => delete FILES[k]);
  Object.keys(models).forEach(k => { try { models[k].dispose(); } catch (e) {} delete models[k]; });
  Object.keys(savedSnapshot).forEach(k => delete savedSnapshot[k]);
  expandedFolders.clear(); foldersInitialized = false;

  Object.keys(newFiles).forEach(name => {
    FILES[name] = { lang: langFromFilename(name), content: newFiles[name] };
    filesList.push(name); ensureModel(name);
  });

  if (!filesList.length) filesList = ['index.html'];
  activeFile = filesList[0];
  renderTabs(); renderSidebarFiles(); switchFile(activeFile); saveCurrentProjectFiles();
  
  showToast('Cloned successfully!');
  updateGitStatus();
}

async function gitCommit() { await gitPush(); }

async function gitPush() {
  const { url, token } = getRepoConfig();
  const parsed = parseGitHubUrl(url);
  if (!parsed || !token) return showToast('Set repo URL and token in Git Settings');
  
  const branch = localStorage.getItem(GIT_BRANCH_KEY) || 'main';
  const headers = { 'Accept': 'application/vnd.github.v3+json', 'Authorization': `token ${token}`, 'Content-Type': 'application/json' };

  try {
    let refRes = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/ref/heads/${branch}`, { headers });
    if (!refRes.ok) throw new Error('Failed to fetch latest commit ref');
    const refData = await refRes.json();
    const latestCommitSha = refData.object.sha;

    const commitRes = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/commits/${latestCommitSha}`, { headers });
    const commitData = await commitRes.json();
    const baseTreeSha = commitData.tree.sha;

    const treeItems = [];
    for (const [path, model] of Object.entries(models)) {
      const content = model.getValue();
      const blobRes = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/blobs`, {
        method: 'POST', headers, body: JSON.stringify({ content, encoding: 'utf-8' })
      });
      if (!blobRes.ok) throw new Error('Failed to upload blob for ' + path);
      const blobData = await blobRes.json();
      treeItems.push({ path, mode: '100644', type: 'blob', sha: blobData.sha });
    }

    const newTreeRes = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees`, {
      method: 'POST', headers, body: JSON.stringify({ base_tree: baseTreeSha, tree: treeItems })
    });
    const newTreeData = await newTreeRes.json();

    const msg = (document.getElementById('gitMessage').value || 'Update from IDEDITOR').trim();
    const newCommitRes = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/commits`, {
      method: 'POST', headers, body: JSON.stringify({ message: msg, tree: newTreeData.sha, parents: [latestCommitSha] })
    });
    const newCommitData = await newCommitRes.json();

    const updateRefRes = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/refs/heads/${branch}`, {
      method: 'PATCH', headers, body: JSON.stringify({ sha: newCommitData.sha, force: true })
    });
    if (!updateRefRes.ok) throw new Error('Failed to update branch');

    document.getElementById('gitMessage').value = '';
    showToast('Pushed successfully!');
    addTermLine('Push successful', 'success');
    updateGitStatus();

  } catch (e) {
    showToast('Push failed: ' + e.message);
    addTermLine('Push failed: ' + e.message, 'error');
  }
}

async function updateGitStatus() {
  const el = document.getElementById('gitStatus');
  const branchSelect = document.getElementById('gitBranchSelect');
  const { url, token } = getRepoConfig();
  const parsed = parseGitHubUrl(url);
  
  if (!parsed) { el.textContent = 'Not connected'; branchSelect.style.display = 'none'; return; }
  
  const headers = { 'Accept': 'application/vnd.github.v3+json' };
  if (token) headers['Authorization'] = `token ${token}`;
  
  try {
    const res = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, { headers });
    if (res.ok) {
      el.textContent = `Connected: ${parsed.owner}/${parsed.repo}`;
      const branchRes = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/branches`, { headers });
      if (branchRes.ok) {
        const branches = await branchRes.json();
        const currentBranch = localStorage.getItem(GIT_BRANCH_KEY) || 'main';
        branchSelect.innerHTML = '';
        branches.forEach(b => {
          const opt = document.createElement('option');
          opt.value = b.name;
          opt.textContent = b.name;
          if (b.name === currentBranch) opt.selected = true;
          branchSelect.appendChild(opt);
        });
        branchSelect.style.display = 'block';
      }
    } else { el.textContent = 'Not connected (Invalid URL/Token)'; branchSelect.style.display = 'none'; }
  } catch (e) { el.textContent = 'Not connected'; branchSelect.style.display = 'none'; }
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
    localStorage.setItem(GIT_URL_KEY, url);
    localStorage.setItem(GIT_TOKEN_KEY, token);
    
    if (firebaseEnabled && fbUser) {
      try {
        const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js');
        await setDoc(doc(fbDb, 'users', fbUser.uid, 'settings', 'git'), { url, token, updatedAt: new Date().toISOString() }, { merge: true });
        addTermLine('Git settings saved to Cloud', 'success');
      } catch (e) { addTermLine('Failed to save Git settings to cloud', 'error'); }
    }
    document.getElementById('gitSettingsModal').style.display = 'none';
    showToast('Git settings saved');
    updateGitStatus();
  });

  document.getElementById('btnGitCloseSettings').addEventListener('click', () => document.getElementById('gitSettingsModal').style.display = 'none');
  document.getElementById('btnGitCommit').addEventListener('click', gitCommit); 
  document.getElementById('btnGitPush').addEventListener('click', gitPush);
  document.getElementById('btnGitPull').addEventListener('click', gitClone); 
  
  document.getElementById('gitBranchSelect').addEventListener('change', (e) => {
    const branch = e.target.value;
    if (branch) {
      localStorage.setItem(GIT_BRANCH_KEY, branch);
      if (confirm(`Switch to branch "${branch}"? This will reload the files from that branch.`)) {
        gitClone().catch(err => addTermLine('Switch failed: ' + err.message, 'error'));
      }
    }
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
  const branch = localStorage.getItem(GIT_BRANCH_KEY) || 'main';

  try {
    const res = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits?sha=${branch}`, { headers });
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