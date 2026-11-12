'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const html = read('index.html');
const script = read('script.js');
const agents = read('ai-agents.js');
const worker = read('sw.js');
const manifest = JSON.parse(read('manifest.json'));

test('preview iframe is sandboxed without same-origin privileges', () => {
  const tag = html.match(/<iframe\b[^>]*\bid=["']preview["'][^>]*>/i)?.[0] || '';
  assert.ok(tag, 'preview iframe must exist');
  assert.match(tag, /\bsandbox=["']allow-scripts["']/i);
  assert.doesNotMatch(tag, /allow-same-origin|allow-top-navigation|allow-popups/i);
});

test('preview messages are accepted only from the preview frame', () => {
  assert.match(script, /event\.source !== frame\.contentWindow/);
  assert.match(script, /PREVIEW_MESSAGE_TYPES/);
  assert.match(script, /typeof data\.msg !== 'string'/);
  assert.match(script, /data\.msg\.slice\(0,\s*5000\)/);
});

test('preview export downloads a file instead of opening an unsandboxed blob window', () => {
  const start = script.indexOf("btnOpen.addEventListener('click'");
  const end = script.indexOf('let autoOn = false', start);
  assert.ok(start >= 0 && end > start);
  const handler = script.slice(start, end);
  assert.match(handler, /link\.download\s*=/);
  assert.doesNotMatch(handler, /window\.open/);
});

test('GitHub tokens are memory-only and legacy local storage is cleared', () => {
  assert.match(script, /let volatileGitToken = ''/);
  assert.match(script, /localStorage\.removeItem\(GIT_TOKEN_KEY\)/);
  assert.doesNotMatch(script, /localStorage\.setItem\(GIT_TOKEN_KEY/);
  assert.doesNotMatch(script, /data\.token/);
  assert.match(html, /localStorage\.removeItem\('idEditor\.gitToken'\)/);
});

test('AI provider keys are excluded from persisted agent settings', () => {
  const saveBody = agents.match(/function save\(\) \{([\s\S]*?)\n  \}/)?.[1] || '';
  assert.match(saveBody, /const \{ apiKey, \.\.\.safeAgent \} = agent/);
  assert.match(saveBody, /writeJson\(STORAGE\.agents, safeAgents\)/);
  assert.match(agents, /localStorage\.removeItem\(LEGACY\.key\)/);
  assert.match(html, /localStorage\.removeItem\('idEditor\.aiKey'\)/);
});

test('AI Markdown is sanitized before DOM insertion', () => {
  assert.match(agents, /function sanitizeMarkdownHtml\(markup\)/);
  assert.match(agents, /contentDiv\.appendChild\(sanitizeMarkdownHtml\(window\.marked\.parse\(text\(value\)\)\)\)/);
  assert.match(agents, /MARKDOWN_DROP_TAGS/);
});

test('GitHub pushes are fast-forward only and branch refs are URL-encoded', () => {
  assert.match(script, /encodeURIComponent\(branch\)/);
  assert.match(script, /force:\s*false/);
  assert.doesNotMatch(script, /force:\s*true/);
});

test('local application scripts exist and are referenced', () => {
  assert.match(html, /src=["']\.\/editor-core\.js["']/);
  assert.match(html, /src=["']script\.js["']/);
  assert.match(html, /src=["']ai-agents\.js["']/);
  assert.ok(fs.existsSync(path.join(root, 'script.js')));
  assert.ok(fs.existsSync(path.join(root, 'ai-agents.js')));
});

test('dashboard clone uses memory-only credentials and supports public repositories', () => {
  assert.doesNotMatch(script, /localStorage\.getItem\(GIT_TOKEN_KEY\)/);
  assert.match(script, /gitClone\(\{ replace: true \}\)/);
});

test('Commit Changes stages locally while Push publishes staged snapshots', () => {
  const commitStart = script.indexOf('async function gitCommit()');
  const pushStart = script.indexOf('async function gitPush()', commitStart);
  const commitBody = script.slice(commitStart, pushStart);
  const pushBody = script.slice(pushStart, script.indexOf('async function updateGitStatus()', pushStart));
  assert.match(commitBody, /project\.pendingCommit\s*=/);
  assert.match(commitBody, /if \(project\.pendingCommit\)/);
  assert.doesNotMatch(commitBody, /gitPush\(/);
  assert.match(pushBody, /!project \|\| !pending/);
  assert.match(pushBody, /canPublishAgainst/);
  assert.match(pushBody, /buildGitTreeEntries/);
});

test('Pull uses three-way sync and stops before replacing conflicted files', () => {
  const pullStart = script.indexOf('async function gitPull(');
  const pullEnd = script.indexOf('async function gitCommit()', pullStart);
  const pullBody = script.slice(pullStart, pullEnd);
  assert.match(pullBody, /mergeFileSnapshots/);
  assert.match(pullBody, /Pull conflict\. No files changed/);
  assert.match(pullBody, /applyWorkspaceFiles\(mergedFiles\)/);
});

test('branch cancellation restores the previous branch selection', () => {
  assert.match(script, /if \(!confirm\('Switch to branch /);
  assert.match(script, /e\.target\.value = previousBranch/);
  assert.match(script, /gitPull\(selectedBranch\)/);
});

test('Git remotes and branches are scoped to the active project', () => {
  assert.match(script, /function getRepoConfig\(project = currentProject\(\)\)/);
  assert.match(script, /tracking\.remoteUrl/);
  assert.match(script, /tracking\.branch \|\|/);
  assert.match(script, /projectGitTracking\(currentProject\(\)\)/);
  assert.match(script, /setCurrentProjectRemoteUrl\(url\)/);
  assert.doesNotMatch(script, /localStorage\.(?:getItem|setItem)\(GIT_BRANCH_KEY/);
  assert.match(script, /localStorage\.removeItem\(GIT_BRANCH_KEY\)/);
});

test('cloud loading protects dirty active work and keeps local Git metadata', () => {
  assert.match(script, /const persistedActiveFiles = \{\}/);
  assert.match(script, /sameFileSnapshots\(activeFiles, persistedActiveFiles\)/);
  assert.match(script, /pendingProjectWrites\.get\(activeId\)/);
  assert.match(script, /shouldApplyCloudProject/);
  assert.match(script, /activeCloudFiles/);
  assert.match(script, /const localProject = newProjects\[docSnap\.id\] \|\| \{\}/);
});

test('GitHub clone rejects binary and non-regular Git tree entries before applying files', () => {
  assert.match(script, /decodeBase64Text\(data\.content/);
  assert.match(script, /item\.mode !== '100644'/);
  assert.match(script, /Unsupported Git entry/);
});

test('preview CSP blocks external network requests and embeds project resources', () => {
  const core = read('editor-core.js');
  assert.match(core, /connect-src.*none/);
  assert.match(core, /rewriteLocalHtmlResources/);
  assert.match(core, /rewriteLocalCss/);
  assert.match(script, /collectWorkspaceFiles\(\)\);/);
});

test('PWA caches the application shell and declares a scalable icon', () => {
  assert.match(worker, /cache\.addAll\(SHELL_ASSETS\)/);
  assert.match(worker, /ideditor-shell-v3/);
  assert.match(worker, /project-storage[.]js/);
  assert.equal(manifest.icons[0].src, './icon.svg');
  assert.equal(manifest.icons[0].sizes, 'any');
});

test('project autosaves flush on page lifecycle exit', () => {
  assert.match(script, /window\.addEventListener\('pagehide', flushPendingProjectSave\)/);
});

test('project writes are enqueued before a later delete can be scheduled', () => {
  const start = script.indexOf('function saveProjectsToStorage(');
  const end = script.indexOf('function saveCurrentProjectFiles(', start);
  const body = script.slice(start, end);
  assert.match(body, /const writes = validIds\.map\(id => projectStorage\.saveProject/);
  assert.doesNotMatch(body, /validIds\.reduce\(/);
});

test('Git clone, pull, and commit wait for local project persistence', () => {
  const cloneStart = script.indexOf('async function gitClone(');
  const pullStart = script.indexOf('async function gitPull(', cloneStart);
  const commitStart = script.indexOf('async function gitCommit(', pullStart);
  const pushStart = script.indexOf('async function gitPush(', commitStart);
  assert.ok(cloneStart >= 0 && pullStart > cloneStart && commitStart > pullStart && pushStart > commitStart);
  assert.match(script.slice(cloneStart, pullStart), /await saveProjectsToStorage\(\[targetProjectId\]\)/);
  assert.match(script.slice(pullStart, commitStart), /await saveProjectsToStorage\(\[targetProjectId\]\)/);
  assert.match(script.slice(commitStart, pushStart), /await saveProjectsToStorage\(\[targetProjectId\]\)/);
});

test('Git push waits for IndexedDB to confirm the updated local workspace', () => {
  const pushStart = script.indexOf('async function gitPush(');
  const statusStart = script.indexOf('async function updateGitStatus(', pushStart);
  const pushBody = script.slice(pushStart, statusStart);
  assert.match(pushBody, /await saveCurrentProjectFiles\(\)/);
  assert.match(pushBody, /GitHub accepted the push, but local sync data could not be saved/);
});

test('asynchronous Git operations stay bound to the project that started them', () => {
  const cloneStart = script.indexOf('async function gitClone(');
  const pullStart = script.indexOf('async function gitPull(', cloneStart);
  const commitStart = script.indexOf('async function gitCommit(', pullStart);
  const pushStart = script.indexOf('async function gitPush(', commitStart);
  assert.match(script.slice(cloneStart, pullStart), /const targetProjectId = currentProjectId/);
  assert.match(script.slice(cloneStart, pullStart), /currentProjectId !== targetProjectId/);
  assert.match(script.slice(pullStart, commitStart), /const targetProjectId = currentProjectId/);
  assert.match(script.slice(pullStart, commitStart), /currentProject\(\) !== project/);
  assert.match(script.slice(commitStart, pushStart), /saveProjectsToStorage\(\[targetProjectId\]\)/);
  assert.match(script.slice(pushStart), /saveProjectsToStorage\(\[targetProjectId\]\)/);
});

test('large workspaces create Monaco models only for files that are opened', () => {
  const initStart = script.indexOf('function initEditor(');
  const initEnd = script.indexOf('editor = monaco.editor.create', initStart);
  assert.ok(initStart >= 0 && initEnd > initStart);
  assert.match(script.slice(initStart, initEnd), /ensureModel\(activeFile\)/);
  assert.doesNotMatch(script.slice(initStart, initEnd), /filesList\.forEach\(ensureModel\)/);

  const switchStart = script.indexOf('function switchProject(');
  const switchEnd = script.indexOf('function createNewProject(', switchStart);
  assert.match(script.slice(switchStart, switchEnd), /ensureModel\(activeFile\)/);
  assert.doesNotMatch(script.slice(switchStart, switchEnd), /filesList\.forEach\(ensureModel\)/);

  const applyStart = script.indexOf('function applyWorkspaceFiles(');
  const applyEnd = script.indexOf('async function gitClone(', applyStart);
  assert.match(script.slice(applyStart, applyEnd), /ensureModel\(activeFile\)/);
  assert.doesNotMatch(script.slice(applyStart, applyEnd), /filesList\.forEach\(ensureModel\)/);
});

test('workspace exports, preview, and Git snapshots include unopened files', () => {
  const start = script.indexOf('function collectWorkspaceFiles(');
  const end = script.indexOf('function currentProject(', start);
  const body = script.slice(start, end);
  assert.match(body, /Object\.entries\(FILES/);
  assert.match(body, /Object\.entries\(models\)/);
  assert.match(script, /const data = collectWorkspaceFiles\(\)/);
  assert.match(script, /Object\.entries\(collectWorkspaceFiles\(\)\)/);
  assert.match(script, /readProjectFile\('index\.html'\)/);
});

test('dirty indicators use cached elements instead of querying the whole DOM per keystroke', () => {
  assert.match(script, /const tabElements = new Map\(\)/);
  assert.match(script, /const sidebarFileElements = new Map\(\)/);
  const start = script.indexOf('function markDirtyState(');
  const end = script.indexOf('let saveTimer', start);
  const body = script.slice(start, end);
  assert.doesNotMatch(body, /querySelector(All)?/);
  assert.match(body, /findTabEl\(file\)/);
  assert.match(body, /findSideItemEl\(file\)/);
});

test('sidebar folders render children on demand and file search is debounced', () => {
  assert.match(script, /childrenContainer\.dataset\.rendered === 'true'/);
  assert.match(script, /if \(isExpanded\) renderChildren\(\)/);
  assert.match(script, /function scheduleSidebarRender\(\)/);
  assert.match(script, /fileFilter\.addEventListener\('input', scheduleSidebarRender\)/);
});

test('cloud loading protects all lazy-loaded files and in-flight autosaves', () => {
  assert.match(script, /const persistedActiveFiles = \{\}/);
  assert.match(script, /pendingProjectWrites\.get\(activeId\)/);
  assert.match(script, /sameFileSnapshots\(activeFiles, persistedActiveFiles\)/);
});

test('cloud saves and local commits wait for the local workspace save', () => {
  const cloudStart = script.indexOf('async function saveToCloud(');
  const cloudEnd = script.indexOf('async function loadFromCloud(', cloudStart);
  assert.match(script.slice(cloudStart, cloudEnd), /await saveCurrentProjectFiles\(\)/);
  const commitStart = script.indexOf('async function gitCommit(');
  const pushStart = script.indexOf('async function gitPush(', commitStart);
  assert.match(script.slice(commitStart, pushStart), /await saveCurrentProjectFiles\(\)/);
});
