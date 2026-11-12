/* IDEDITOR shared, dependency-free application logic. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.IDEditorCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function inferLanguage(path) {
    const ext = String(path).split('.').pop().toLowerCase();
    return ({html:'html',htm:'html',css:'css',js:'javascript',mjs:'javascript',jsx:'javascript',ts:'typescript',tsx:'typescript',json:'json',md:'markdown',xml:'xml',svg:'xml',txt:'plaintext'})[ext] || 'plaintext';
  }
  function normalizeProjectFiles(files) {
    const normalized = {};
    Object.entries(files && typeof files === 'object' ? files : {}).forEach(([path, raw]) => {
      if (typeof raw === 'string') normalized[path] = { lang: inferLanguage(path), content: raw };
      else if (raw && typeof raw === 'object') normalized[path] = { lang: typeof raw.lang === 'string' ? raw.lang : inferLanguage(path), content: String(raw.content == null ? '' : raw.content) };
    });
    return normalized;
  }
  function nextProjectIdAfterRemoval(projects, removedId) {
    return Object.keys(projects || {}).find(id => id !== removedId) || null;
  }
  function sameFileSnapshots(left, right) {
    left = left || {}; right = right || {};
    const a = Object.keys(left).sort(), b = Object.keys(right).sort();
    return a.length === b.length && a.every((key, i) => key === b[i] && left[key] === right[key]);
  }
  function mergeFileSnapshots(base, local, remote) {
    base = base || {}; local = local || {}; remote = remote || {};
    const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);
    const files = {}, conflicts = [];
    const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
    const equal = (a, b, key) => has(a, key) === has(b, key) && (!has(a, key) || a[key] === b[key]);
    [...keys].sort().forEach(path => {
      if (equal(local, base, path)) { if (has(remote, path)) files[path] = remote[path]; }
      else if (equal(remote, base, path) || equal(local, remote, path)) { if (has(local, path)) files[path] = local[path]; }
      else conflicts.push(path);
    });
    return { files: conflicts.length ? null : files, conflicts };
  }
  function canPublishAgainst(remoteHead, expectedHead) {
    return Boolean(remoteHead && expectedHead && remoteHead === expectedHead);
  }
  function buildGitTreeEntries(localFiles, baseFiles, blobShas) {
    localFiles = localFiles || {}; baseFiles = baseFiles || {}; blobShas = blobShas || {};
    const entries = [];
    Object.keys(localFiles).sort().forEach(path => {
      if (!Object.prototype.hasOwnProperty.call(baseFiles, path) || localFiles[path] !== baseFiles[path]) {
        if (!blobShas[path]) throw new Error('Missing uploaded blob for ' + path);
        entries.push({ path, mode:'100644', type:'blob', sha:blobShas[path] });
      }
    });
    Object.keys(baseFiles).sort().forEach(path => {
      if (!Object.prototype.hasOwnProperty.call(localFiles, path)) entries.push({ path, mode:'100644', type:'blob', sha:null });
    });
    return entries;
  }
  function normalizeProjectPath(path) {
    const parts = String(path || '').replace(/\\/g, '/').split('/');
    const normalized = [];
    parts.forEach(part => {
      if (!part || part === '.') return;
      if (part === '..') normalized.pop();
      else normalized.push(part);
    });
    return normalized.join('/');
  }
  function mimeForPath(path) {
    const ext = String(path).split('.').pop().toLowerCase();
    return ({
      css:'text/css', js:'text/javascript', mjs:'text/javascript', json:'application/json',
      svg:'image/svg+xml', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg',
      gif:'image/gif', webp:'image/webp', ico:'image/x-icon', txt:'text/plain',
      html:'text/html', htm:'text/html', xml:'application/xml', woff:'font/woff',
      woff2:'font/woff2', ttf:'font/ttf', otf:'font/otf'
    })[ext] || 'application/octet-stream';
  }
  function dataUriFor(path, content) {
    return 'data:' + mimeForPath(path) + ';charset=utf-8,' + encodeURIComponent(String(content));
  }
  function rewriteLocalCss(css, ownerPath, files) {
    const base = String(ownerPath || '').split('/').slice(0, -1).join('/');
    return String(css || '').replace(/url\(\s*(["']?)([^)'"]+)\1\s*\)/gi, (match, quote, rawPath) => {
      const value = String(rawPath).trim();
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) return match;
      const resolved = normalizeProjectPath((base ? base + '/' : '') + value.split(/[?#]/)[0]);
      if (!Object.prototype.hasOwnProperty.call(files, resolved)) return match;
      return 'url("' + dataUriFor(resolved, files[resolved]) + '")';
    });
  }
  function rewriteLocalHtmlResources(html, files) {
    return String(html || '').replace(/\b(src|href)\s*=\s*(["'])([^"']+)\2/gi, (match, attribute, quote, rawPath) => {
      const value = String(rawPath).trim();
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|mailto:|tel:)/i.test(value)) return match;
      const resolved = normalizeProjectPath(value.split(/[?#]/)[0]);
      if (!Object.prototype.hasOwnProperty.call(files, resolved)) return match;
      if (resolved === 'style.css' || resolved === 'script.js') return match;
      if (attribute.toLowerCase() === 'href' && /\.css$/i.test(resolved)) {
        return attribute + '=' + quote + dataUriFor(resolved, rewriteLocalCss(files[resolved], resolved, files)) + quote;
      }
      if (attribute.toLowerCase() === 'src' && /\.(?:js|mjs)$/i.test(resolved)) {
        return attribute + '=' + quote + dataUriFor(resolved, files[resolved]) + quote;
      }
      return attribute + '=' + quote + dataUriFor(resolved, files[resolved]) + quote;
    });
  }
  function buildPreviewDocument(html, css, js, projectFiles) {
    const files = {};
    Object.entries(projectFiles || {}).forEach(([path, content]) => { files[normalizeProjectPath(path)] = String(content == null ? '' : content); });
    const openScript = '<scr' + 'ipt>', closeScript = '</scr' + 'ipt>';
    const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\' data:; style-src \'unsafe-inline\' data:; img-src data: blob:; font-src data:; media-src data: blob:; connect-src \'none\'; frame-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">';
    const hook = openScript + "(function(){function ser(v){if(typeof v==='string')return v;if(v instanceof Error)return v.message;try{return JSON.stringify(v);}catch(e){return String(v);}}function send(type,args){try{parent.postMessage({__preview:true,type:type,msg:Array.prototype.map.call(args,ser).join(' ')},'*');}catch(e){}}['log','info','warn','error'].forEach(function(t){var orig=console[t]?console[t].bind(console):function(){};console[t]=function(){orig.apply(null,arguments);send(t,arguments);};});window.addEventListener('error',function(e){send('error',[e.message+' @ line '+e.lineno]);});window.addEventListener('unhandledrejection',function(e){send('error',['Unhandled rejection: '+ser(e.reason)]);});})();" + closeScript;
    const additionalStyles = Object.keys(files).filter(path => /\.css$/i.test(path) && path !== 'style.css')
      .sort().map(path => '<style data-ideditor-file="' + path.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">' + '\n' + rewriteLocalCss(files[path], path, files) + '\n</style>').join('');
    const head = csp + hook + '<style>\n' + rewriteLocalCss(css || '', 'style.css', files) + '\n</style>' + additionalStyles;
    const body = openScript + '\ntry{\n' + (js || '') + '\n}catch(e){ console.error(e && e.message ? e.message : e); }\n' + closeScript;
    const source = rewriteLocalHtmlResources(html || '', files);
    if (/<html[\s>]/i.test(source)) {
      let output = source;
      if (/<head[\s>]/i.test(output)) output = output.replace(/<head[^>]*>/i, match => match + head);
      else output = output.replace(/<html[^>]*>/i, match => match + '<head>' + head + '</head>');
      if (/<\/body>/i.test(output)) output = output.replace(/<\/body>/i, body + '</body>');
      else output += body;
      return output;
    }
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + head + '</head><body>' + source + body + '</body></html>';
  }
  async function orchestrateAgents(mode, prompt, agents, runAgent, onPipelineStep, startIndex, previousOutput) {
    if (!agents || !agents.length) return { ok:false, error:new Error('No agents selected.') };
    const firstIndex = Number.isInteger(startIndex) ? Math.max(0, Math.min(startIndex, agents.length - 1)) : 0;
    if (mode === 'single') return runAgent(prompt, agents[firstIndex], firstIndex, previousOutput || '');
    if (mode === 'parallel') return Promise.all(agents.map((agent, index) => runAgent(prompt, agent, index, '')));
    if (mode !== 'pipeline') throw new Error('Unknown AI orchestration mode: ' + mode);
    let previous = previousOutput || '';
    for (let index = firstIndex; index < agents.length; index++) {
      const agent = agents[index];
      const stepPrompt = index === 0 ? prompt : 'Previous agent (' + agents[index - 1].name + ') produced:\n\n' + previous + '\n\nNow improve/fix/complete this:\n' + prompt;
      const result = await runAgent(stepPrompt, agent, index, previous);
      if (!result || !result.ok) return result || { ok:false };
      previous = result.result;
      if (index < agents.length - 1 && onPipelineStep) onPipelineStep(agents[index + 1].name);
    }
    return { ok:true, result:previous };
  }
  function shouldApplyCloudProject(isActive, hasUnsavedChanges, hasPendingCommit) {
    return !hasPendingCommit && (!isActive || !hasUnsavedChanges);
  }
  function decodeBase64Text(base64, path) {
    const extension = String(path || '').split('.').pop().toLowerCase();
    const binaryExtensions = new Set(['png','jpg','jpeg','gif','webp','bmp','ico','tif','tiff','pdf','zip','gz','7z','rar','exe','dll','so','dylib','wasm','mp3','wav','ogg','mp4','mov','avi','mkv','woff','woff2','ttf','otf','eot','psd','ai','blend','glb','bin','class','jar']);
    if (binaryExtensions.has(extension)) throw new Error('Binary file is not supported yet: ' + path + '. Clone stopped without changing the project.');
    let binary;
    try {
      binary = typeof atob === 'function' ? atob(String(base64 || '')) : Buffer.from(String(base64 || ''), 'base64').toString('binary');
    } catch (error) {
      throw new Error('Invalid base64 content in ' + path);
    }
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (bytes.includes(0)) throw new Error('Binary file is not supported yet: ' + path + '. Clone stopped without changing the project.');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error('File is not valid UTF-8 text: ' + path + '. Clone stopped without changing the project.');
    }
  }
  return { inferLanguage, normalizeProjectFiles, nextProjectIdAfterRemoval, sameFileSnapshots, mergeFileSnapshots, canPublishAgainst, buildGitTreeEntries, buildPreviewDocument, orchestrateAgents, shouldApplyCloudProject, decodeBase64Text };
}));
