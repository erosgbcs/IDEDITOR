/* =========================================================
   IDEDITOR — Multi-provider, Multi-agent AI engine (v2)
   =========================================================
   Changes in v2:
     • Streaming responses (OpenAI-compat SSE + Gemini SSE)
     • Multi-turn conversation history (New Chat button)
     • Selection-aware context
     • File-context truncation (MAX_CONTEXT_CHARS)
     • Code blocks: language label + Copy / Insert / Apply (SVG)
     • Apply modes: replace / insert / replace-selection
     • Bugfix: Keep/Discard uses editor.pushStackElement (undoable)
     • Bugfix: warn if active file drifted since block was rendered
     • All emoji replaced with inline SVG icons
     • Responsive toolbar + settings modal (mobile-first)
   ========================================================= */
(function () {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────
  const STORAGE = {
    agents:   'idEditor.agents.v1',
    active:   'idEditor.activeAgentId',
    mode:     'idEditor.orchestrationMode',
    compare:  'idEditor.compareAgentIds',
    pipeline: 'idEditor.pipelineAgentIds'
  };
  const LEGACY = {
    provider: 'idEditor.aiProvider',
    key:      'idEditor.aiKey',
    model:    'idEditor.aiModel'
  };
  const DEFAULT_PROMPT       = 'You are an expert AI coding assistant inside IDEDITOR.';
  const MAX_PARALLEL         = 4;
  const MAX_CONTEXT_CHARS    = 24000;
  const MAX_HISTORY_MESSAGES = 20;

  const LABELS = {
    openai:'OpenAI', groq:'Groq', gemini:'Gemini', together:'Together',
    openrouter:'OpenRouter', fireworks:'Fireworks', mistral:'Mistral',
    ollama:'Ollama', custom:'Custom', mock:'Mock'
  };

  const PRESETS = {
    openai:     ['https://api.openai.com/v1', ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini']],
    groq:       ['https://api.groq.com/openai/v1', ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct']],
    gemini:     ['https://generativelanguage.googleapis.com/v1beta', ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash']],
    together:   ['https://api.together.xyz/v1', []],
    openrouter: ['https://openrouter.ai/api/v1', []],
    fireworks:  ['https://api.fireworks.ai/inference/v1', []],
    mistral:    ['https://api.mistral.ai/v1', ['mistral-large-latest', 'mistral-small-latest']],
    ollama:     ['http://localhost:11434/v1', ['llama3.2', 'qwen2.5-coder', 'deepseek-coder-v2']],
    custom:     ['', []],
    mock:       ['mock', ['mock-model']]
  };

  const PROVIDER_ORDER = ['openai','groq','gemini','together','openrouter','fireworks','mistral','ollama','custom','mock'];

  // ─── SVG Icons (no emoji) ─────────────────────────────────
  const I = (path, opts) => {
    opts = opts || {};
    return '<svg viewBox="0 0 24 24" width="' + (opts.w || 14) + '" height="' + (opts.h || 14)
      + '" fill="' + (opts.fill || 'none') + '" stroke="' + (opts.fill ? 'none' : 'currentColor')
      + '" stroke-width="' + (opts.sw || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      + path + '</svg>';
  };
  const SVG = {
    apply:   I('<path d="M13 2 3 14h7l-1 8 12-16h-7z"/>', { fill: 'currentColor' }),
    keep:    I('<path d="M20 6 9 17l-5-5"/>', { sw: 2.4 }),
    discard: I('<path d="M18 6 6 18M6 6l12 12"/>', { sw: 2.4 }),
    copy:    I('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    insert:  I('<path d="M12 5v14M5 12h14"/>'),
    replace: I('<path d="M4 8h12m0 0-3-3m3 3-3 3M20 16H8m0 0 3-3m-3 3 3 3"/>'),
    gear:    I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    stop:    I('<rect x="6" y="6" width="12" height="12" rx="2"/>', { fill: 'currentColor' }),
    clear:   I('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
    newchat: I('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 8v6M9 11h6"/>'),
    arrow:   I('<path d="M12 5v14M5 12l7 7 7-7"/>', { w: 12, h: 12 }),
    edit:    I('<path d="M4 20h4l10-10a2 2 0 0 0-4-4L4 16v4z"/>', { w: 12, h: 12 }),
    dup:     I('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>', { w: 12, h: 12 }),
    del:     I('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', { w: 12, h: 12 }),
    chevron: I('<path d="M6 9l6 6 6-6"/>', { w: 12, h: 12 })
  };

  // ─── State ────────────────────────────────────────────────
  const state = { agents: [], active: '', mode: 'single', compare: [], pipeline: [] };
  let history       = [];   // [{role:'user'|'assistant', content:string}]
  let context       = null; // { editor, models, getActiveFile }
  let controllers   = new Set();
  let attached      = false;
  let modalBody     = null;
  let formState     = null;
  let pickerMenu    = null;
  let stopButton    = null;
  let sendButton    = null;
  let isStreaming   = false;

  // ─── Helpers ──────────────────────────────────────────────
  const get       = id => document.getElementById(id);
  const text      = v => String(v == null ? '' : v);
  const esc       = v => text(v).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const pLabel    = p => LABELS[p] || p;
  const makeId    = () => 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const toast     = msg => { if (typeof window.showToast === 'function') window.showToast(msg); };
  const readJson  = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fb : v; } catch { return fb; } };
  const writeJson = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const truncate  = (s, n) => s.length <= n ? s : s.slice(0, Math.floor(n / 2)) + '\n\n/* …context truncated… */\n\n' + s.slice(-Math.floor(n / 2));
  const basename  = p => p.split('/').pop();

  // ─── Agent model ──────────────────────────────────────────
  function normalizeAgent(agent) {
    const provider = PRESETS[agent.provider] ? agent.provider : 'custom';
    const preset = PRESETS[provider];
    const rawBase = text(agent.baseUrl) || preset[0];
    const apiShape = rawBase === 'mock' ? 'mock'
      : provider === 'gemini' ? 'gemini'
      : provider === 'mock' ? 'mock'
      : 'openai';
    return {
      id: text(agent.id) || makeId(),
      name: text(agent.name) || 'New Agent',
      enabled: agent.enabled !== false,
      provider,
      baseUrl: rawBase,
      apiShape,
      apiKey: text(agent.apiKey),
      model: text(agent.model),
      systemPrompt: text(agent.systemPrompt) || DEFAULT_PROMPT,
      temperature: Number.isFinite(Number(agent.temperature))
        ? Math.max(0, Math.min(2, Number(agent.temperature)))
        : 0.7,
      maxTokens: Math.max(1, Number(agent.maxTokens) || 1024),
      stream: agent.stream !== false,
      createdAt: Number(agent.createdAt) || Date.now(),
      updatedAt: Date.now()
    };
  }

  // ─── Persistence ──────────────────────────────────────────
  function save() {
    writeJson(STORAGE.agents, state.agents);
    localStorage.setItem(STORAGE.active, state.active);
    localStorage.setItem(STORAGE.mode, state.mode);
    writeJson(STORAGE.compare, state.compare);
    writeJson(STORAGE.pipeline, state.pipeline);
  }

  function load() {
    const stored = localStorage.getItem(STORAGE.agents);
    if (stored === null) {
      const provider = localStorage.getItem(LEGACY.provider);
      const key      = localStorage.getItem(LEGACY.key);
      const model    = localStorage.getItem(LEGACY.model);
      if (provider || key || model) {
        const preset = PRESETS[provider] || PRESETS.openai;
        state.agents = [normalizeAgent({
          id: 'a_legacy', name: 'Default Agent',
          provider: provider || 'openai',
          baseUrl: preset[0], apiKey: key,
          model: model || preset[1][0]
        })];
        state.active = 'a_legacy';
      }
    } else {
      const parsed = readJson(STORAGE.agents, []);
      state.agents = Array.isArray(parsed) ? parsed.map(normalizeAgent) : [];
    }
    state.active   = localStorage.getItem(STORAGE.active) || state.agents[0]?.id || '';
    const storedMode = localStorage.getItem(STORAGE.mode);
    state.mode     = ['single','parallel','pipeline'].includes(storedMode) ? storedMode : 'single';
    state.compare  = readJson(STORAGE.compare, []);
    state.pipeline = readJson(STORAGE.pipeline, []);
    repairSelections();
    save();
  }

  function repairSelections() {
    const ids = enabledAgents().map(a => a.id);
    const set = new Set(ids);
    if (!set.has(state.active)) state.active = ids[0] || '';
    state.compare  = state.compare.filter(id => set.has(id)).slice(0, MAX_PARALLEL);
    state.pipeline = state.pipeline.filter(id => set.has(id)).slice(0, MAX_PARALLEL);
    if (!state.compare.length && state.active)  state.compare  = [state.active];
    if (!state.pipeline.length && state.active) state.pipeline = [state.active];
  }

  // ─── Lookup & validation ──────────────────────────────────
  const enabledAgents = () => state.agents.filter(a => a.enabled);
  const agentById     = id => state.agents.find(a => a.id === id);

  function validate(agent) {
    if (!agent) throw new Error('No agent configured.');
    if (agent.apiShape === 'mock') return;
    if (!agent.model) throw new Error(agent.name + ': model is required.');
    if (!agent.apiKey) throw new Error(agent.name + ': API key is required.');
    const ok = agent.baseUrl.startsWith('https://')
      || agent.baseUrl.startsWith('http://localhost:')
      || agent.baseUrl.startsWith('http://127.0.0.1:');
    if (!ok) throw new Error(agent.name + ': base URL must use HTTPS or localhost.');
  }

  // ─── Provider dispatch ────────────────────────────────────
  function buildOpenAIBody(agent, userText, maxTokens, stream) {
    const msgs = [{ role: 'system', content: agent.systemPrompt }];
    for (const h of history) msgs.push({ role: h.role, content: h.content });
    msgs.push({ role: 'user', content: userText });
    const body = {
      model: agent.model,
      messages: msgs,
      temperature: agent.temperature,
      max_tokens: maxTokens || agent.maxTokens
    };
    if (stream) body.stream = true;
    return body;
  }

  function buildGeminiBody(agent, userText, maxTokens, stream) {
    const contents = history.map(h => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    }));
    contents.push({ role: 'user', parts: [{ text: userText }] });
    return {
      systemInstruction: { parts: [{ text: agent.systemPrompt }] },
      contents,
      generationConfig: {
        temperature: agent.temperature,
        maxOutputTokens: maxTokens || agent.maxTokens
      }
    };
  }

  function getUrlOptions(agent, userText, maxTokens, stream, signal) {
    if (agent.apiShape === 'gemini') {
      const method = stream ? ':streamGenerateContent' : ':generateContent';
      const alt = stream ? '&alt=sse' : '';
      return {
        url: agent.baseUrl.replace(/\/$/, '') + '/models/'
          + encodeURIComponent(agent.model) + method
          + '?key=' + encodeURIComponent(agent.apiKey) + alt,
        options: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildGeminiBody(agent, userText, maxTokens, stream)),
          signal
        }
      };
    }
    return {
      url: agent.baseUrl.replace(/\/$/, '') + '/chat/completions',
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + agent.apiKey
        },
        body: JSON.stringify(buildOpenAIBody(agent, userText, maxTokens, stream)),
        signal
      }
    };
  }

  function extractText(agent, json) {
    return agent.apiShape === 'gemini'
      ? (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')
      : (json.choices?.[0]?.message?.content || '');
  }

  function extractDelta(agent, json) {
    return agent.apiShape === 'gemini'
      ? (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')
      : (json.choices?.[0]?.delta?.content || '');
  }

  async function streamResponse(res, agent, onDelta, signal) {
    if (!res.body || !res.body.getReader) return await res.text();
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', full = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal && signal.aborted) throw new DOMException('Request aborted', 'AbortError');
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          if (!payload) continue;
          try {
            const json = JSON.parse(payload);
            const delta = extractDelta(agent, json);
            if (delta) { full += delta; onDelta && onDelta(delta, full); }
          } catch (_) { /* skip */ }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch (_) {}
    }
    return full;
  }

  async function request(agent, userText, signal, maxTokens, onDelta) {
    validate(agent);

    if (agent.apiShape === 'mock') {
      return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new DOMException('Request aborted', 'AbortError')); return; }
        const full = 'Mock response from ' + agent.name + ' (' + agent.provider + '/' + agent.model + ').\nEcho: ' + userText;
        let i = 0;
        const timer = setInterval(() => {
          if (signal.aborted) { clearInterval(timer); reject(new DOMException('Request aborted','AbortError')); return; }
          if (i < full.length) {
            const chunk = full.slice(i, i + 6);
            i += 6;
            onDelta && onDelta(chunk, full.slice(0, i));
          } else {
            clearInterval(timer);
            resolve(full);
          }
        }, 25);
        signal.addEventListener('abort', () => clearInterval(timer), { once: true });
      });
    }

    const useStream = !!onDelta && agent.stream !== false;
    const { url, options } = getUrlOptions(agent, userText, maxTokens, useStream, signal);
    const res = await fetch(url, options);

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data.error?.message) || ('HTTP ' + res.status));
    }

    if (useStream) {
      const out = await streamResponse(res, agent, onDelta, signal);
      if (!out) throw new Error('Provider returned no message content.');
      return out;
    }

    const data = await res.json().catch(() => ({}));
    const out = extractText(agent, data);
    if (!out) throw new Error(data.error?.message || 'Provider returned no message content.');
    return out;
  }

  // ─── Editor helpers ───────────────────────────────────────
  function getEditor()    { return context?.editor || null; }
  function getModel(file) { return context?.models?.[file] || null; }
  function getActiveFile(){ return context?.getActiveFile ? context.getActiveFile() : ''; }

  function editorModelIsActive(model) {
    const ed = getEditor();
    return !!ed && ed.getModel() === model;
  }

  function applyEditToModel(model, range, text) {
    const ed = getEditor();
    if (editorModelIsActive(model)) {
      ed.pushStackElement();
      ed.executeEdits('ai-apply', [{ range, text, forceMoveMarkers: true }]);
      ed.pushStackElement();
    } else {
      model.pushEditOperations([], [{ range, text }], () => null);
    }
  }

  function getSelectionText() {
    const ed = getEditor();
    if (!ed) return '';
    const model = ed.getModel();
    if (!model) return '';
    const sel = ed.getSelection();
    if (!sel || sel.isEmpty()) return '';
    return model.getValueInRange(sel);
  }

  // ─── Apply / Keep / Discard ───────────────────────────────
  function applyCodeAsSuggestion(code, block, mode) {
    mode = mode || 'replace';
    const file = getActiveFile();
    const model = getModel(file);
    if (!model) { toast('No active file'); return; }
    if (model.isDisposed && model.isDisposed()) { toast('File no longer open'); return; }

    const renderedFor = block && block.dataset ? block.dataset.renderedFor : '';
    if (renderedFor && renderedFor !== file) {
      if (!confirm('This block was generated for "' + renderedFor
        + '", but the active file is "' + file
        + '". Apply to "' + file + '" anyway?')) return;
    }

    const ed = getEditor();
    const originalContent = model.getValue();
    const originalFile = file;

    if (mode === 'insert' && ed && editorModelIsActive(model)) {
      const sel = ed.getSelection();
      applyEditToModel(model, sel, code);
    } else if (mode === 'replace-selection' && ed && editorModelIsActive(model)) {
      const sel = ed.getSelection();
      const range = (sel && !sel.isEmpty()) ? sel : model.getFullModelRange();
      applyEditToModel(model, range, code);
    } else {
      applyEditToModel(model, model.getFullModelRange(), code);
    }

    const pendingState = {
      model,
      originalContent,
      originalFile,
      appliedVersion: model.getAlternativeVersionId()
    };
    renderKeepDiscardButtons(block, pendingState, code);
    toast('Change applied — Keep or Discard');
  }

  function renderKeepDiscardButtons(block, pendingState, code) {
    const actions = block.querySelector('.ai-code-actions');
    if (!actions) return;
    actions.innerHTML = '';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'ai-icon-btn';
    copyBtn.type = 'button';
    copyBtn.title = 'Copy code';
    copyBtn.innerHTML = SVG.copy + '<span class="ai-btn-label">Copy</span>';
    copyBtn.onclick = () => copyCode(code, copyBtn);

    const keepBtn = document.createElement('button');
    keepBtn.className = 'ai-icon-btn ai-keep-btn';
    keepBtn.type = 'button';
    keepBtn.innerHTML = SVG.keep + '<span class="ai-btn-label">Keep</span>';
    keepBtn.onclick = () => {
      actions.innerHTML = '';
      const done = document.createElement('span');
      done.className = 'ai-applied-indicator';
      done.innerHTML = SVG.keep + '<span>Applied to ' + esc(basename(pendingState.originalFile)) + '</span>';
      actions.appendChild(done);
      toast('Change kept');
    };

    const discardBtn = document.createElement('button');
    discardBtn.className = 'ai-icon-btn ai-discard-btn';
    discardBtn.type = 'button';
    discardBtn.innerHTML = SVG.discard + '<span class="ai-btn-label">Discard</span>';
    discardBtn.onclick = () => {
      if (pendingState.model.isDisposed && pendingState.model.isDisposed()) {
        restoreApplyRow(actions, block, code);
        return;
      }
      const userModified =
        pendingState.model.getAlternativeVersionId() !== pendingState.appliedVersion;
      if (userModified) {
        const ok = confirm(
          'You modified this file after applying. Discard will revert to the '
          + 'original content and lose your edits. Continue?'
        );
        if (!ok) return;
      }
      applyEditToModel(pendingState.model, pendingState.model.getFullModelRange(), pendingState.originalContent);
      restoreApplyRow(actions, block, code);
      toast('Change discarded');
    };

    actions.append(copyBtn, keepBtn, discardBtn);
  }

  function restoreApplyRow(actions, block, code) {
    actions.innerHTML = '';
    actions.appendChild(makeCopyBtn(code));
    actions.appendChild(makeInsertBtn(code, block));
    actions.appendChild(makeReplaceSelBtn(code, block));
    actions.appendChild(makeApplyBtn(code, block));
  }

  // ─── Code block button factories ──────────────────────────
  function makeCopyBtn(code) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-icon-btn';
    btn.title = 'Copy code';
    btn.innerHTML = SVG.copy + '<span class="ai-btn-label">Copy</span>';
    btn.onclick = () => copyCode(code, btn);
    return btn;
  }

  function makeInsertBtn(code, block) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-icon-btn';
    btn.title = 'Insert at cursor';
    btn.innerHTML = SVG.insert + '<span class="ai-btn-label">Insert</span>';
    btn.onclick = () => applyCodeAsSuggestion(code, block, 'insert');
    return btn;
  }

  function makeReplaceSelBtn(code, block) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-icon-btn';
    btn.title = 'Replace current selection';
    btn.innerHTML = SVG.replace + '<span class="ai-btn-label">Replace</span>';
    btn.onclick = () => applyCodeAsSuggestion(code, block, 'replace-selection');
    return btn;
  }

  function makeApplyBtn(code, block) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-icon-btn ai-icon-btn-primary';
    btn.title = 'Replace whole file';
    btn.innerHTML = SVG.apply + '<span class="ai-btn-label">Apply</span>';
    btn.onclick = () => applyCodeAsSuggestion(code, block, 'replace');
    return btn;
  }

  async function copyCode(code, btn) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(code);
      } else {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      const original = btn.innerHTML;
      btn.innerHTML = SVG.keep + '<span class="ai-btn-label">Copied</span>';
      setTimeout(() => { btn.innerHTML = original; }, 1200);
    } catch (_) {
      toast('Copy failed');
    }
  }

  // ─── Code block builder ───────────────────────────────────
  function detectLang(codeEl) {
    const cls = (codeEl.className || '').match(/language-([a-z0-9+#-]+)/i);
    if (cls) return cls[1];
    const matches = (codeEl.className || '').match(/lang-([a-z0-9+#-]+)/i);
    return matches ? matches[1] : 'code';
  }

  function buildCodeBlock(codeEl) {
    const code = codeEl.textContent;
    const lang = detectLang(codeEl);
    if (typeof window.hljs !== 'undefined') {
      try { window.hljs.highlightElement(codeEl); } catch (_) {}
    }
    const pre = codeEl.parentElement;

    const block = document.createElement('div');
    block.className = 'ai-code-block';
    block.dataset.renderedFor = getActiveFile() || '';

    const header = document.createElement('div');
    header.className = 'ai-code-header';

    const langEl = document.createElement('span');
    langEl.className = 'ai-code-lang';
    langEl.textContent = lang;

    const actions = document.createElement('div');
    actions.className = 'ai-code-actions';
    actions.appendChild(makeCopyBtn(code));
    actions.appendChild(makeInsertBtn(code, block));
    actions.appendChild(makeReplaceSelBtn(code, block));
    actions.appendChild(makeApplyBtn(code, block));

    header.append(langEl, actions);

    pre.replaceWith(block);
    block.append(header, pre);
    return block;
  }

  // ─── Message rendering ────────────────────────────────────
  function renderMessage(role, value, meta) {
    const container = get('aiMessages');
    if (!container) return null;

    const div = document.createElement('div');
    div.className = 'ai-msg ai-' + role;
    if (meta?.error) div.classList.add('ai-error-card');

    if (meta?.agent) {
      const chip = document.createElement('span');
      chip.className = 'ai-agent-chip';
      chip.textContent = meta.agent.name + ' · ' + pLabel(meta.agent.provider);
      div.appendChild(chip);
    }

    const hasMarked = typeof window.marked !== 'undefined';
    if (hasMarked) {
      const contentDiv = document.createElement('div');
      contentDiv.className = 'ai-md-content';
      try {
        contentDiv.innerHTML = window.marked.parse(text(value));
      } catch (_) {
        contentDiv.textContent = text(value);
      }
      contentDiv.querySelectorAll('pre code').forEach(codeEl => buildCodeBlock(codeEl));
      div.appendChild(contentDiv);
    } else {
      const parts = text(value).split(/(```[\s\S]*?```)/g);
      parts.forEach(part => {
        if (part.startsWith('```') && part.endsWith('```')) {
          const code = part.slice(3, -3).replace(/^[a-zA-Z0-9_-]+\n/, '');
          const block = document.createElement('div');
          block.className = 'ai-code-block';
          block.dataset.renderedFor = getActiveFile() || '';
          const header = document.createElement('div');
          header.className = 'ai-code-header';
          const langEl = document.createElement('span');
          langEl.className = 'ai-code-lang';
          langEl.textContent = 'code';
          const actions = document.createElement('div');
          actions.className = 'ai-code-actions';
          actions.appendChild(makeCopyBtn(code));
          actions.appendChild(makeInsertBtn(code, block));
          actions.appendChild(makeReplaceSelBtn(code, block));
          actions.appendChild(makeApplyBtn(code, block));
          header.append(langEl, actions);
          const pre = document.createElement('pre');
          pre.textContent = code;
          block.append(header, pre);
          div.appendChild(block);
        } else if (part) {
          const p = document.createElement('div');
          p.innerHTML = esc(part).replace(/\n/g, '<br>');
          div.appendChild(p);
        }
      });
    }

    if (meta?.retry) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'btn';
      retryBtn.textContent = 'Retry';
      retryBtn.onclick = meta.retry;
      div.appendChild(retryBtn);
    }

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  }

  function createStreamingPlaceholder(agent) {
    const container = get('aiMessages');
    if (!container) return null;
    const div = document.createElement('div');
    div.className = 'ai-msg ai-assistant ai-streaming';
    if (agent) {
      const chip = document.createElement('span');
      chip.className = 'ai-agent-chip';
      chip.textContent = agent.name + ' · ' + pLabel(agent.provider);
      div.appendChild(chip);
    }
    const body = document.createElement('div');
    body.className = 'ai-streaming-body';
    div.appendChild(body);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return { div, body };
  }

  function clearMessages() {
    const container = get('aiMessages');
    if (container) container.innerHTML = '';
  }

  function clearHistory() {
    history = [];
  }

  // ─── Context builders ─────────────────────────────────────
  function fileContext() {
    const file = getActiveFile();
    if (!file) return '';
    const model = getModel(file);
    const content = model ? model.getValue() : '';
    const truncated = truncate(content, MAX_CONTEXT_CHARS);
    let ctx = '\nThe user is currently working on "' + file + '".\nCurrent code:\n```\n'
      + truncated + '\n```';
    const sel = getSelectionText();
    if (sel) ctx += '\n\nUser has selected this text:\n```\n' + sel + '\n```';
    return ctx;
  }

  // ─── Request lifecycle ────────────────────────────────────
  function beginRequest() {
    const c = new AbortController();
    controllers.add(c);
    updateStreamingState(true);
    return c;
  }
  function endRequest(c) {
    controllers.delete(c);
    updateStreamingState(controllers.size > 0);
  }
  function stopRequests() {
    controllers.forEach(c => { try { c.abort(); } catch (_) {} });
    controllers.clear();
    updateStreamingState(false);
  }
  function updateStreamingState(active) {
    isStreaming = active;
    if (stopButton) stopButton.style.display = active ? 'inline-flex' : 'none';
    if (sendButton) {
      sendButton.disabled = active;
      sendButton.classList.toggle('is-loading', active);
    }
  }

  // ─── Sending ──────────────────────────────────────────────
  function selectedAgents() {
    const ids = state.mode === 'single' ? [state.active]
      : state.mode === 'parallel' ? state.compare
      : state.pipeline;
    return ids.map(agentById).filter(Boolean);
  }

  async function runAgent(prompt, agent, opts) {
    opts = opts || {};
    const controller = beginRequest();
    const placeholder = opts.stream ? createStreamingPlaceholder(agent) : null;
    let lastPaint = 0;

    try {
      const full = opts.skipContext ? prompt : prompt + fileContext();
      const onDelta = placeholder ? (delta, acc) => {
        const now = Date.now();
        if (now - lastPaint < 30) return;
        lastPaint = now;
        placeholder.body.textContent = acc;
        const c = get('aiMessages');
        if (c) c.scrollTop = c.scrollHeight;
      } : null;

      const result = await request(agent, full, controller.signal, null, onDelta);
      if (placeholder) placeholder.div.remove();
      renderMessage('assistant', result, { agent, groupId: opts.groupId });
      if (!opts.skipHistory) {
        history.push({ role: 'assistant', content: result });
      }
      return { ok: true, result };
    } catch (error) {
      if (placeholder) placeholder.div.remove();
      if (error && error.name === 'AbortError') return { ok: false, error, aborted: true };
      renderMessage('assistant',
        pLabel(agent.provider) + ': ' + (error.message || String(error)),
        { agent, error: true, retry: opts.retry || null });
      return { ok: false, error };
    } finally {
      endRequest(controller);
    }
  }

  async function runSingle(prompt, agents) {
    const agent = agents[0];
    const retry = () => runSingle(prompt, agents);
    await runAgent(prompt, agent, { retry, stream: true });
  }

  async function runParallel(prompt, agents) {
    const groupId = makeId();
    await Promise.all(agents.map(agent => runAgent(prompt, agent, {
      groupId,
      stream: true,
      retry: () => runAgent(prompt, agent, { groupId, stream: true })
    })));
  }

  async function runPipeline(prompt, agents, startIndex, previousOutput) {
    startIndex = startIndex || 0;
    const groupId = makeId();
    let previous = previousOutput || '';
    for (let i = startIndex; i < agents.length; i++) {
      const agent = agents[i];
      const stepPrompt = i === 0
        ? prompt
        : 'Previous agent (' + agents[i - 1].name + ' via '
          + pLabel(agents[i - 1].provider) + ') produced:\n\n'
          + previous + '\n\nNow improve/fix/complete this:\n' + prompt;
      const isLast = i === agents.length - 1;
      const retry = () => runPipeline(prompt, agents, i, previous);
      const result = await runAgent(stepPrompt, agent, {
        groupId, retry, stream: true, skipHistory: !isLast
      });
      if (!result.ok) return;
      previous = result.result;
      if (!isLast) appendPipelineDivider(agents[i + 1].name);
    }
  }

  function appendPipelineDivider(nextAgentName) {
    const container = get('aiMessages');
    if (!container) return;
    const divider = document.createElement('div');
    divider.className = 'ai-pipeline-divider';
    divider.innerHTML = SVG.arrow + '<span>passed to ' + esc(nextAgentName) + '</span>';
    container.appendChild(divider);
    container.scrollTop = container.scrollHeight;
  }

  async function send() {
    const input = get('aiInput');
    const prompt = input?.value.trim();
    if (!prompt || isStreaming) return;
    input.value = '';
    input.style.height = '36px';

    const agents = selectedAgents();
    if (!agents.length) {
      renderMessage('system', 'No enabled agent is configured. Open AI Settings to add one.');
      return;
    }

    renderMessage('user', prompt);
    history.push({ role: 'user', content: prompt });
    trimHistory();

    try {
      if (state.mode === 'single')        await runSingle(prompt, agents);
      else if (state.mode === 'parallel') await runParallel(prompt, agents);
      else if (state.mode === 'pipeline') await runPipeline(prompt, agents);
    } catch (_) { /* per-agent errors already rendered */ }
  }

  function trimHistory() {
    if (history.length > MAX_HISTORY_MESSAGES) {
      history = history.slice(-MAX_HISTORY_MESSAGES);
    }
  }

  // ─── Toolbar ──────────────────────────────────────────────
  function renderToolbar() {
    const panel = get('aiPanel');
    const messagesEl = get('aiMessages');
    if (!panel || !messagesEl || panel.querySelector('.ai-toolbar')) return;

    const toolbar = document.createElement('div');
    toolbar.className = 'ai-toolbar';

    // Agent picker
    const picker = document.createElement('div');
    picker.className = 'ai-agent-picker';
    const pickerButton = document.createElement('button');
    pickerButton.type = 'button';
    pickerButton.className = 'btn';
    const menu = document.createElement('div');
    menu.className = 'ai-agent-menu';
    pickerMenu = menu;
    picker.append(pickerButton, menu);

    // Mode select
    const mode = document.createElement('select');
    mode.className = 'git-input ai-mode-select';
    ['single', 'parallel', 'pipeline'].forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      mode.appendChild(opt);
    });

    // Icon buttons
    const manage = document.createElement('button');
    manage.type = 'button';
    manage.className = 'ai-icon-btn';
    manage.title = 'Manage agents';
    manage.innerHTML = SVG.gear + '<span class="ai-btn-label">Agents</span>';

    const newChat = document.createElement('button');
    newChat.type = 'button';
    newChat.className = 'ai-icon-btn';
    newChat.title = 'New chat';
    newChat.innerHTML = SVG.newchat + '<span class="ai-btn-label">New</span>';

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'ai-icon-btn';
    clear.title = 'Clear messages';
    clear.innerHTML = SVG.clear + '<span class="ai-btn-label">Clear</span>';

    stopButton = document.createElement('button');
    stopButton.type = 'button';
    stopButton.className = 'ai-icon-btn ai-icon-btn-danger';
    stopButton.title = 'Stop';
    stopButton.innerHTML = SVG.stop + '<span class="ai-btn-label">Stop</span>';
    stopButton.style.display = 'none';

    toolbar.append(picker, mode, manage, newChat, clear, stopButton);
    panel.insertBefore(toolbar, messagesEl);
    mode.value = state.mode;

    function refresh() {
      menu.innerHTML = '';
      const chosen = state.mode === 'single' ? [state.active]
        : state.mode === 'parallel' ? state.compare
        : state.pipeline;
      const names = chosen.map(id => agentById(id)?.name).filter(Boolean);
      pickerButton.textContent = names.length ? names.join(', ') : 'Select agents';

      const enabled = enabledAgents();
      if (!enabled.length) {
        const empty = document.createElement('div');
        empty.className = 'ai-agent-menu-empty';
        empty.textContent = 'No enabled agents.';
        menu.appendChild(empty);
        return;
      }
      enabled.forEach(agent => {
        const label = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = chosen.includes(agent.id);
        label.append(cb, document.createTextNode(' ' + agent.name + ' · ' + pLabel(agent.provider) + ' · ' + agent.model));
        cb.onchange = () => handleToggle(agent, cb, chosen);
        menu.appendChild(label);
      });
    }

    function handleToggle(agent, checkbox, chosen) {
      if (state.mode === 'single') {
        if (checkbox.checked) state.active = agent.id;
        else { checkbox.checked = true; return; }
      } else {
        const key = state.mode === 'parallel' ? 'compare' : 'pipeline';
        let arr = state[key].filter(id => id !== agent.id);
        if (checkbox.checked) {
          if (arr.length >= MAX_PARALLEL) {
            checkbox.checked = false;
            toast('Maximum ' + MAX_PARALLEL + ' agents in ' + state.mode + ' mode');
            return;
          }
          arr.push(agent.id);
        }
        state[key] = arr;
      }
      save();
      refresh();
    }

    pickerButton.onclick = e => { e.stopPropagation(); menu.classList.toggle('open'); };
    document.addEventListener('click', e => {
      if (pickerMenu && !picker.contains(e.target)) pickerMenu.classList.remove('open');
    });

    mode.onchange = () => {
      stopRequests();
      state.mode = mode.value;
      repairSelections();
      save();
      refresh();
    };

    manage.onclick  = () => openModal('agents');
    newChat.onclick = () => { stopRequests(); clearMessages(); clearHistory(); };
    clear.onclick   = () => { stopRequests(); clearMessages(); };
    stopButton.onclick = stopRequests;

    refresh();
  }

  // ─── Modal ────────────────────────────────────────────────
  function openModal(tab) {
    const modal = get('aiSettingsModal');
    if (!modal) return;
    modal.style.display = 'flex';

    if (!modalBody) {
      const content = modal.querySelector('.modal-content');
      if (!content) return;

      const legacyIds = ['aiProvider', 'aiApiKey', 'aiModel'];
      const legacyEls = legacyIds.map(id => document.getElementById(id)).filter(Boolean);

      content.innerHTML =
        '<h3>AI Assistant Settings</h3>' +
        '<div class="ai-settings-tabs">' +
          '<button class="btn active" data-tab="agents" type="button">Agents</button>' +
          '<button class="btn" data-tab="help" type="button">How it works</button>' +
        '</div>' +
        '<div class="ai-settings-body"></div>' +
        '<div class="modal-buttons">' +
          '<button class="btn primary" id="btnSaveAISettings" style="display:none;" type="button">Save Settings</button>' +
          '<button class="btn" id="btnCloseAISettings" type="button">Close</button>' +
        '</div>';

      legacyEls.forEach(el => { el.style.display = 'none'; content.appendChild(el); });

      modalBody = content.querySelector('.ai-settings-body');
      content.querySelectorAll('[data-tab]').forEach(btn => {
        btn.onclick = () => {
          content.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b === btn));
          renderModal(btn.dataset.tab);
        };
      });
      const closeBtn = get('btnCloseAISettings');
      if (closeBtn) closeBtn.onclick = () => { modal.style.display = 'none'; };
    }

    renderModal(tab || 'agents');
  }

  function renderModal(tab) {
    if (!modalBody) return;
    modalBody.innerHTML = '';

    if (tab === 'help') {
      modalBody.innerHTML =
        '<p style="font-size:12px;line-height:1.6;">' +
        '<strong>Single</strong> — one agent answers.<br>' +
        '<strong>Parallel</strong> — up to ' + MAX_PARALLEL + ' agents answer simultaneously.<br>' +
        '<strong>Pipeline</strong> — agents run in sequence; each gets the previous output.<br><br>' +
        '<strong>Providers:</strong> ' + Object.values(LABELS).join(', ') + '.<br><br>' +
        '<strong>Code blocks:</strong> Copy, Insert, Replace selection, or Apply whole file. ' +
        'After Apply you can Keep or Discard — undoable with Ctrl+Z.<br><br>' +
        '<strong>History:</strong> conversation is remembered within the session. ' +
        'Use "New" in the toolbar to start fresh.' +
        '</p>';
      return;
    }

    const list = document.createElement('div');
    if (!state.agents.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No agents yet. Click "Add Agent" to create one.';
      empty.style.cssText = 'font-size:12px;color:var(--muted);padding:8px 0;';
      list.appendChild(empty);
    }

    state.agents.forEach(agent => {
      const row = document.createElement('div');
      row.className = 'ai-agent-row';

      const label = document.createElement('label');
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = agent.enabled;
      toggle.onchange = e => {
        agent.enabled = e.target.checked;
        repairSelections();
        save();
      };
      label.append(toggle, document.createTextNode(' ' + agent.name));

      const info = document.createElement('span');
      info.textContent = pLabel(agent.provider) + ' · ' + agent.model;

      const actions = document.createElement('span');
      actions.className = 'ai-agent-row-actions';
      [
        { label: 'Edit',      icon: SVG.edit, act: 'Edit' },
        { label: 'Duplicate', icon: SVG.dup,  act: 'Duplicate' },
        { label: 'Delete',    icon: SVG.del,  act: 'Delete', danger: true }
      ].forEach(({ label, icon, act, danger }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ai-icon-btn' + (danger ? ' ai-icon-btn-danger' : '');
        btn.title = label;
        btn.innerHTML = icon + '<span class="ai-btn-label">' + label + '</span>';
        btn.onclick = () => {
          if (act === 'Edit') {
            showForm(agent);
          } else if (act === 'Duplicate') {
            state.agents.push(normalizeAgent({ ...agent, id: makeId(), name: agent.name + ' Copy' }));
            repairSelections();
            save();
            renderModal('agents');
          } else {
            if (!confirm('Delete agent "' + agent.name + '"?')) return;
            state.agents = state.agents.filter(a => a.id !== agent.id);
            repairSelections();
            save();
            renderModal('agents');
          }
        };
        actions.appendChild(btn);
      });

      row.append(label, info, actions);
      list.appendChild(row);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn primary';
    add.style.cssText = 'width:100%;justify-content:center;margin-top:8px;';
    add.textContent = 'Add Agent';
    add.onclick = () => showForm();

    modalBody.append(list, add);
  }

  function showForm(existing) {
    formState = existing
      ? normalizeAgent(existing)
      : normalizeAgent({ id: makeId(), name: 'New Agent', provider: 'openai', model: 'gpt-4o-mini' });

    modalBody.innerHTML = '';

    const form = document.createElement('form');
    form.className = 'ai-agent-form';
    form.autocomplete = 'off';
    const inputs = {};

    const datalistId = 'ai-model-datalist';
    const datalist = document.createElement('datalist');
    datalist.id = datalistId;
    form.appendChild(datalist);

    const fields = [
      ['provider',     'Provider preset', 'select'],
      ['name',         'Name',            'text'],
      ['baseUrl',      'Base URL',        'text'],
      ['apiKey',       'API key',         'password'],
      ['model',        'Model',           'text'],
      ['systemPrompt', 'System prompt',   'textarea'],
      ['temperature',  'Temperature',     'range'],
      ['maxTokens',    'Max tokens',      'number']
    ];

    fields.forEach(([key, labelText, type]) => {
      const wrapper = document.createElement('label');
      wrapper.textContent = labelText;

      let input;
      if (type === 'textarea')      input = document.createElement('textarea');
      else if (type === 'select')   {
        input = document.createElement('select');
        PROVIDER_ORDER.forEach(v => {
          if (!PRESETS[v]) return;
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = LABELS[v] + (v === 'mock' ? ' (test)' : '');
          input.appendChild(opt);
        });
      } else {
        input = document.createElement('input');
        input.type = type;
      }

      if (key === 'model')      input.setAttribute('list', datalistId);
      if (key === 'temperature') { input.min = 0; input.max = 2; input.step = 0.1; }
      if (key === 'maxTokens')   input.min = 1;

      input.value = formState[key];
      wrapper.appendChild(input);
      form.appendChild(wrapper);
      inputs[key] = input;
    });

    function refreshDatalist() {
      datalist.innerHTML = '';
      const preset = PRESETS[inputs.provider.value];
      if (!preset) return;
      preset[1].forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        datalist.appendChild(opt);
      });
    }
    refreshDatalist();

    inputs.provider.onchange = () => {
      const preset = PRESETS[inputs.provider.value];
      if (!preset) return;
      const allBases = Object.values(PRESETS).map(p => p[0]);
      if (!inputs.baseUrl.value || allBases.includes(inputs.baseUrl.value)) {
        inputs.baseUrl.value = preset[0];
      }
      const allModels = Object.values(PRESETS).flatMap(p => p[1]);
      if (!inputs.model.value || allModels.includes(inputs.model.value)) {
        inputs.model.value = preset[1][0] || '';
      }
      formState.provider = inputs.provider.value;
      refreshDatalist();
    };

    const buttons = document.createElement('div');
    buttons.className = 'ai-form-buttons';
    const test = document.createElement('button');
    test.type = 'button'; test.className = 'btn'; test.textContent = 'Test';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit'; saveBtn.className = 'btn primary'; saveBtn.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'Cancel';
    buttons.append(test, saveBtn, cancel);
    form.appendChild(buttons);
    modalBody.appendChild(form);

    function collect() {
      const values = {};
      Object.keys(inputs).forEach(k => { values[k] = inputs[k].value; });
      return normalizeAgent({ ...formState, ...values });
    }

    test.onclick = async () => {
      const candidate = collect();
      const controller = beginRequest();
      try {
        await request(candidate, 'Respond with one token.', controller.signal, 1, null);
        toast('Connected');
      } catch (err) {
        toast(err.message);
      } finally {
        endRequest(controller);
      }
    };

    cancel.onclick = () => renderModal('agents');

    form.onsubmit = e => {
      e.preventDefault();
      const candidate = collect();
      if (candidate.provider === 'custom' && !candidate.baseUrl) {
        toast('Custom agents need a base URL.');
        return;
      }
      state.agents = state.agents.filter(a => a.id !== candidate.id);
      state.agents.push(candidate);
      repairSelections();
      save();
      renderModal('agents');
    };
  }

  // ─── Attach ───────────────────────────────────────────────
  function attach(options) {
    if (attached) return;
    context = options;
    try { load(); } catch (err) {
      console.error('[ai-agents] Failed to load state', err);
      return;
    }
    attached = true;
    renderToolbar();

    const settingsBtn = get('btnAISettings');
    if (settingsBtn) settingsBtn.addEventListener('click', () => openModal('agents'));

    sendButton = get('btnSendAI');
    if (sendButton) sendButton.addEventListener('click', send);

    const aiInput = get('aiInput');
    if (aiInput) {
      aiInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      });
      aiInput.addEventListener('input', () => {
        aiInput.style.height = 'auto';
        aiInput.style.height = Math.min(aiInput.scrollHeight, 120) + 'px';
      });
    }
  }

  // ─── Public API ───────────────────────────────────────────
  window.AIAgents = {
    attach,
    send,
    stop: stopRequests,
    renderMessage: (role, value, meta) => renderMessage(role, value, meta),
    clearHistory,
    getHistory: () => history.slice()
  };

  if (window.__aiAttachOptions) attach(window.__aiAttachOptions);
}());
