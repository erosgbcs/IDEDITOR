/* =========================================================
   IDEDITOR — Multi-provider, Multi-agent AI engine
   =========================================================
   Providers (equal priority): OpenAI, Groq, Gemini, Together,
   OpenRouter, Fireworks, Mistral, Ollama, Custom, Mock.

   Public API (window.AIAgents):
     attach({ editor, models, getActiveFile })  — called once by script.js
     send()                                     — trigger a send (optional)
     stop()                                     — abort all in-flight requests
     renderMessage(role, text, meta?)           — render a message (legacy path)

   Storage keys:
     idEditor.agents.v1         — agent configs (JSON array)
     idEditor.activeAgentId     — single mode selection
     idEditor.orchestrationMode — single | parallel | pipeline
     idEditor.compareAgentIds   — parallel mode selection
     idEditor.pipelineAgentIds  — pipeline mode selection (ordered)

   AI code blocks support Keep / Discard:
     ⚡ Apply to Editor   — writes AI code into the active model (undoable)
     ✓ Keep               — confirms; clears buttons
     ✗ Discard            — reverts to the content that existed before Apply
                            (with confirmation if the user edited since Apply)
   ========================================================= */
(function () {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────
  const STORAGE = {
    agents: 'idEditor.agents.v1',
    active: 'idEditor.activeAgentId',
    mode: 'idEditor.orchestrationMode',
    compare: 'idEditor.compareAgentIds',
    pipeline: 'idEditor.pipelineAgentIds'
  };
  const LEGACY = {
    provider: 'idEditor.aiProvider',
    key: 'idEditor.aiKey',
    model: 'idEditor.aiModel'
  };
  const DEFAULT_PROMPT = 'You are an expert AI coding assistant inside IDEDITOR.';
  const MAX_PARALLEL = 4;
  const LABELS = {
    openai: 'OpenAI', groq: 'Groq', gemini: 'Gemini', together: 'Together',
    openrouter: 'OpenRouter', fireworks: 'Fireworks', mistral: 'Mistral',
    ollama: 'Ollama', custom: 'Custom', mock: 'Mock'
  };
  const WORKFLOWS = [
    {
      id: 'fix-current',
      label: 'Fix Current File',
      prompt: 'Find and fix problems in the active file. Return a single final code block for that file only.'
    },
    {
      id: 'refactor-current',
      label: 'Refactor Current File',
      prompt: 'Refactor the active file for readability and maintainability without changing behavior. Return only one final code block.'
    },
    {
      id: 'add-feature',
      label: 'Implement Feature',
      prompt: 'Implement the requested feature cleanly. Return complete updated code block(s) with clear file targeting.'
    },
    {
      id: 'explain-code',
      label: 'Explain Current File',
      prompt: 'Explain the active file structure, key logic, and risky areas briefly with actionable suggestions.'
    }
  ];
  const PRESETS = {
    openai: ['https://api.openai.com/v1', ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini']],
    groq: ['https://api.groq.com/openai/v1', ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct']],
    gemini: ['https://generativelanguage.googleapis.com/v1beta', ['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-2.0-flash']],
    together: ['https://api.together.xyz/v1', []],
    openrouter: ['https://openrouter.ai/api/v1', []],
    fireworks: ['https://api.fireworks.ai/inference/v1', []],
    mistral: ['https://api.mistral.ai/v1', ['mistral-large-latest', 'mistral-small-latest']],
    ollama: ['http://localhost:11434/v1', ['llama3.2', 'qwen2.5-coder', 'deepseek-coder-v2']],
    custom: ['', []],
    mock: ['mock', ['mock-model']]
  };

  // Explicit provider display order.
  // OpenAI, Groq, Gemini first (the 3 primary providers), then the rest.
  const PROVIDER_ORDER = [
    'openai',
    'groq',
    'gemini',
    'together',
    'openrouter',
    'fireworks',
    'mistral',
    'ollama',
    'custom',
    'mock'
  ];

  // ─── State ─────────────────────────────────────────────────
  const state = { agents: [], active: '', mode: 'single', compare: [], pipeline: [] };
  let context = null;
  let controllers = new Set();
  let attached = false;
  let modalBody = null;
  let formState = null;
  let pickerMenu = null;
  let stopButton = null;

  // ─── Small helpers ─────────────────────────────────────────
  const get = (id) => document.getElementById(id);
  const text = (v) => String(v == null ? '' : v);
  const esc = (v) => text(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const providerLabel = (p) => LABELS[p] || p;
  const makeId = () => 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const toast = (msg) => { if (typeof window.showToast === 'function') window.showToast(msg); };
  const readJson = (key, fb) => { try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fb : v; } catch (_) { return fb; } };
  const writeJson = (key, v) => localStorage.setItem(key, JSON.stringify(v));
  const basename = (p) => text(p).split('/').pop();

  function parseCodeTargetFromContent(rawCode) {
    const src = text(rawCode);
    const m = src.match(/^\s*(?:\/\/|#|<!--|\/\*)?\s*(?:file|filename)\s*[:=]\s*([^\s*]+)\s*(?:\*\/|-->)*\s*\n/i);
    if (!m) return { code: src, targetFile: '' };
    return { code: src.slice(m[0].length), targetFile: text(m[1]).trim() };
  }

  function parseFenceHint(value) {
    const hint = text(value).trim().toLowerCase();
    if (!hint) return { targetFile: '', langHint: '' };
    if (hint.includes('.')) return { targetFile: hint, langHint: '' };
    return { targetFile: '', langHint: hint };
  }

  function pickFileByLanguage(langHint) {
    const models = context?.models || {};
    const files = Object.keys(models);
    if (!files.length) return '';
    const active = context?.getActiveFile?.() || '';
    const byName = (name) => files.find((f) => f.toLowerCase() === name.toLowerCase()) || '';
    const byExt = (exts) => files.find((f) => exts.some((ext) => f.toLowerCase().endsWith(ext))) || '';
    const lower = text(langHint).toLowerCase();
    if (!lower) return '';

    if (['js', 'javascript', 'node', 'jsx', 'typescript', 'ts', 'tsx'].includes(lower)) {
      if (active && /\.(js|jsx|ts|tsx)$/i.test(active)) return active;
      return byName('script.js') || byName('index.js') || byExt(['.js', '.jsx', '.ts', '.tsx']);
    }
    if (['css', 'scss', 'sass', 'less'].includes(lower)) {
      if (active && /\.(css|scss|sass|less)$/i.test(active)) return active;
      return byName('style.css') || byExt(['.css', '.scss', '.sass', '.less']);
    }
    if (['html', 'htm', 'xml'].includes(lower)) {
      if (active && /\.(html|htm|xml)$/i.test(active)) return active;
      return byName('index.html') || byExt(['.html', '.htm', '.xml']);
    }
    if (['json'].includes(lower)) return byExt(['.json']);
    if (['md', 'markdown'].includes(lower)) return byExt(['.md']);
    return '';
  }

  function resolveTargetFile(preferredFile, langHint) {
    const models = context?.models || {};
    const files = Object.keys(models);
    const active = context?.getActiveFile?.();
    if (!files.length) return '';
    if (preferredFile) {
      if (models[preferredFile]) return preferredFile;
      const exactBasename = files.find((f) => basename(f).toLowerCase() === basename(preferredFile).toLowerCase());
      if (exactBasename) return exactBasename;
    }
    const fromLang = pickFileByLanguage(langHint);
    if (fromLang) return fromLang;
    if (active && models[active]) return active;
    return files[0];
  }

  // ─── Agent model ───────────────────────────────────────────
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
      createdAt: Number(agent.createdAt) || Date.now(),
      updatedAt: Date.now()
    };
  }

  // ─── Persistence ───────────────────────────────────────────
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
      const key = localStorage.getItem(LEGACY.key);
      const model = localStorage.getItem(LEGACY.model);
      if (provider || key || model) {
        const preset = PRESETS[provider] || PRESETS.openai;
        state.agents = [normalizeAgent({
          id: 'a_legacy', name: 'Default Agent',
          provider: provider || 'openai',
          baseUrl: preset[0],
          apiKey: key,
          model: model || preset[1][0]
        })];
        state.active = 'a_legacy';
        state.mode = 'single';
        console.info('[ai-agents] Migrated legacy single-agent config.');
      }
    } else {
      const parsed = readJson(STORAGE.agents, []);
      state.agents = Array.isArray(parsed) ? parsed.map(normalizeAgent) : [];
    }

    state.active = localStorage.getItem(STORAGE.active) || state.agents[0]?.id || '';
    const storedMode = localStorage.getItem(STORAGE.mode);
    state.mode = ['single', 'parallel', 'pipeline'].includes(storedMode) ? storedMode : 'single';
    state.compare = readJson(STORAGE.compare, []);
    state.pipeline = readJson(STORAGE.pipeline, []);

    repairSelections();
    save();
  }

  function repairSelections() {
    const enabledIds = enabledAgents().map((a) => a.id);
    const enabledSet = new Set(enabledIds);
    if (!enabledSet.has(state.active)) state.active = enabledIds[0] || '';
    state.compare = state.compare.filter((id) => enabledSet.has(id)).slice(0, MAX_PARALLEL);
    state.pipeline = state.pipeline.filter((id) => enabledSet.has(id)).slice(0, MAX_PARALLEL);
    if (!state.compare.length && state.active) state.compare = [state.active];
    if (!state.pipeline.length && state.active) state.pipeline = [state.active];
  }

  // ─── Lookup & validation ───────────────────────────────────
  const enabledAgents = () => state.agents.filter((a) => a.enabled);
  const agentById = (id) => state.agents.find((a) => a.id === id);

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

  // ─── Provider dispatch ─────────────────────────────────────
  function request(agent, userText, signal, maxTokens) {
    validate(agent);

    if (agent.apiShape === 'mock') {
      return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(new DOMException('Request aborted', 'AbortError')); return; }
        const timer = setTimeout(() => {
          resolve('This is a mock response from ' + agent.name + ' ('
            + agent.provider + '/' + agent.model + ').\n'
            + 'Echo of your prompt: ' + userText);
        }, 400);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Request aborted', 'AbortError'));
        }, { once: true });
      });
    }

    let url;
    let options;
    switch (agent.apiShape) {
      case 'openai':
        url = agent.baseUrl.replace(/\/$/, '') + '/chat/completions';
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + agent.apiKey },
          body: JSON.stringify({
            model: agent.model,
            messages: [
              { role: 'system', content: agent.systemPrompt },
              { role: 'user', content: userText }
            ],
            temperature: agent.temperature,
            max_tokens: maxTokens || agent.maxTokens
          }),
          signal
        };
        break;
      case 'gemini':
        url = agent.baseUrl.replace(/\/$/, '') + '/models/'
          + encodeURIComponent(agent.model)
          + ':generateContent?key=' + encodeURIComponent(agent.apiKey);
        options = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: agent.systemPrompt + '\n\n' + userText }] }],
            generationConfig: {
              temperature: agent.temperature,
              maxOutputTokens: maxTokens || agent.maxTokens
            }
          }),
          signal
        };
        break;
      default:
        return Promise.reject(new Error('Unsupported API shape: ' + agent.apiShape));
    }

    return fetch(url, options).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || 'HTTP ' + res.status);
      const out = agent.apiShape === 'openai'
        ? data.choices?.[0]?.message?.content
        : data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!out) throw new Error(data.error?.message || 'Provider returned no message content.');
      return out;
    });
  }

  // ─── Apply / Keep / Discard ────────────────────────────────
  // Applies AI-generated code to the active model and turns the block's
  // action row into Keep / Discard buttons.
  function applyCodeAsSuggestion(code, block, hints) {
    const parsed = parseCodeTargetFromContent(code);
    const preferredFile = text(hints?.targetFile || parsed.targetFile);
    const langHint = text(hints?.langHint);
    const file = resolveTargetFile(preferredFile, langHint);
    const model = file && context?.models && context.models[file];
    if (!model) { toast('No active file'); return; }
    if (model.isDisposed && model.isDisposed()) { toast('File no longer open'); return; }
    if (typeof context?.switchFile === 'function' && file !== context.getActiveFile?.()) {
      try { context.switchFile(file); } catch (_) {}
    }

    const originalContent = model.getValue();
    const originalFile = file;

    // Apply — undoable via Monaco's native Ctrl+Z
    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: code }],
      () => null
    );
    model.pushStackElement();

    const pendingState = {
      model,
      originalContent,
      originalFile,
      appliedVersion: model.getAlternativeVersionId()
    };

    renderKeepDiscardButtons(block, pendingState, parsed.code, hints);
    toast('Change applied to ' + basename(originalFile) + ' — Keep or Discard');
  }

  function renderKeepDiscardButtons(block, pendingState, code, hints) {
    const actions = block.querySelector('.ai-code-actions');
    if (!actions) return;
    actions.innerHTML = '';

    const keepBtn = document.createElement('button');
    keepBtn.className = 'btn ai-keep-btn';
    keepBtn.textContent = '✓ Keep';
    keepBtn.onclick = () => {
      actions.innerHTML = '';
      const done = document.createElement('span');
      done.className = 'ai-applied-indicator';
      done.textContent = '✓ Applied to ' + pendingState.originalFile.split('/').pop();
      actions.appendChild(done);
      toast('Change kept');
    };

    const discardBtn = document.createElement('button');
    discardBtn.className = 'btn ai-discard-btn';
    discardBtn.textContent = '✗ Discard';
    discardBtn.onclick = () => {
      if (pendingState.model.isDisposed && pendingState.model.isDisposed()) {
        restoreApplyButton(actions, code, hints);
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

      pendingState.model.pushEditOperations(
        [],
        [{ range: pendingState.model.getFullModelRange(), text: pendingState.originalContent }],
        () => null
      );
      pendingState.model.pushStackElement();

      restoreApplyButton(actions, code, hints);
      toast('Change discarded');
    };

    actions.append(keepBtn, discardBtn);
  }

  function restoreApplyButton(actions, code, hints) {
    actions.innerHTML = '';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn primary';
    applyBtn.textContent = '⚡ Apply to Editor';
    applyBtn.onclick = () => applyCodeAsSuggestion(code, applyBtn.closest('.ai-code-block'), hints || {});
    actions.appendChild(applyBtn);
  }

  // ─── Message rendering ─────────────────────────────────────
  function renderMessage(role, value, meta) {
  const container = get('aiMessages');
  if (!container) return null;
  
  const div = document.createElement('div');
  div.className = 'ai-msg ai-' + role;
  if (meta?.error) div.classList.add('ai-error-card');
  
  if (meta?.agent) {
    const chip = document.createElement('span');
    chip.className = 'ai-agent-chip';
    chip.textContent = meta.agent.name + ' · ' + providerLabel(meta.agent.provider);
    div.appendChild(chip);
  }
  
  // NEW: Use Marked.js and Highlight.js if loaded
  if (typeof window.marked !== 'undefined' && typeof window.hljs !== 'undefined') {
    const contentDiv = document.createElement('div');
    contentDiv.className = 'ai-md-content';
    contentDiv.innerHTML = window.marked.parse(text(value));
    
    // Inject Apply buttons into code blocks
    contentDiv.querySelectorAll('pre code').forEach((codeEl) => {
      const code = codeEl.textContent;
      const fenceInfo = parseFenceHint((codeEl.className.match(/language-([^\s]+)/i) || [])[1]);
      const parsedCode = parseCodeTargetFromContent(code);
      const pre = codeEl.parentElement;
      
      // Apply syntax highlighting
      window.hljs.highlightElement(codeEl);
      
      // Wrap in our custom block
      const block = document.createElement('div');
      block.className = 'ai-code-block';
      
      const actions = document.createElement('div');
      actions.className = 'ai-code-actions';
      const applyBtn = document.createElement('button');
      applyBtn.className = 'btn primary';
      applyBtn.textContent = '⚡ Apply to Editor';
      applyBtn.onclick = () => applyCodeAsSuggestion(parsedCode.code, block, {
        targetFile: fenceInfo.targetFile || parsedCode.targetFile,
        langHint: fenceInfo.langHint
      });
      actions.appendChild(applyBtn);
      
      pre.replaceWith(block);
      block.append(pre, actions);
    });
    
    div.appendChild(contentDiv);
  } else {
    // Fallback if libraries fail to load
    const parts = text(value).split(/(```[\s\S]*?```)/g);
    parts.forEach((part) => {
      if (part.startsWith('```') && part.endsWith('```')) {
        const matched = part.match(/^```([^\n]*)\n([\s\S]*?)```$/);
        const fenceRaw = matched ? matched[1] : '';
        const inner = matched ? matched[2] : part.slice(3, -3);
        const fenceInfo = parseFenceHint(fenceRaw);
        const parsedCode = parseCodeTargetFromContent(inner);
        const block = document.createElement('div');
        block.className = 'ai-code-block';
        const pre = document.createElement('pre');
        pre.textContent = parsedCode.code;
        const actions = document.createElement('div');
        actions.className = 'ai-code-actions';
        const applyBtn = document.createElement('button');
        applyBtn.className = 'btn primary';
        applyBtn.textContent = '⚡ Apply to Editor';
        applyBtn.onclick = () => applyCodeAsSuggestion(parsedCode.code, block, {
          targetFile: fenceInfo.targetFile || parsedCode.targetFile,
          langHint: fenceInfo.langHint
        });
        actions.appendChild(applyBtn);
        block.append(pre, actions);
        div.appendChild(block);
      } else if (part) {
        const paragraph = document.createElement('div');
        paragraph.innerHTML = esc(part).replace(/\n/g, '<br>');
        div.appendChild(paragraph);
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
  function clearMessages() {
    const container = get('aiMessages');
    if (container) container.innerHTML = '';
  }

  function fileContext() {
    const file = context?.getActiveFile?.();
    if (!file) return '';
    const content = context.models[file] ? context.models[file].getValue() : '';
    return '\nThe user is currently working on "' + file + '".\nCurrent code:\n```\n'
      + content + '\n```';
  }

  // ─── Request lifecycle ─────────────────────────────────────
  function beginRequest() {
    const c = new AbortController();
    controllers.add(c);
    if (stopButton) stopButton.style.display = 'inline-flex';
    return c;
  }
  function endRequest(c) {
    controllers.delete(c);
    if (!controllers.size && stopButton) stopButton.style.display = 'none';
  }
  function stopRequests() {
    controllers.forEach((c) => { try { c.abort(); } catch (_) {} });
    controllers.clear();
    if (stopButton) stopButton.style.display = 'none';
  }

  // ─── Sending ───────────────────────────────────────────────
  function selectedAgents() {
    const ids = state.mode === 'single' ? [state.active]
      : state.mode === 'parallel' ? state.compare
      : state.pipeline;
    return ids.map(agentById).filter(Boolean);
  }

  async function runAgent(prompt, agent, opts) {
    opts = opts || {};
    const controller = beginRequest();
    try {
      const full = opts.skipContext ? prompt : prompt + fileContext();
      const result = await request(agent, full, controller.signal);
      renderMessage('assistant', result, { agent, groupId: opts.groupId });
      return { ok: true, result };
    } catch (error) {
      if (error && error.name === 'AbortError') return { ok: false, error, aborted: true };
      renderMessage('assistant',
        providerLabel(agent.provider) + ': ' + (error.message || String(error)),
        { agent, error: true, retry: opts.retry || null });
      return { ok: false, error };
    } finally {
      endRequest(controller);
    }
  }

  async function runSingle(prompt, agents) {
    const agent = agents[0];
    const retry = () => runSingle(prompt, agents);
    await runAgent(prompt, agent, { retry });
  }

  async function runParallel(prompt, agents) {
    const groupId = makeId();
    const jobs = agents.map((agent) => runAgent(prompt, agent, {
      groupId,
      retry: () => runAgent(prompt, agent, { groupId })
    }));
    await Promise.all(jobs);
  }

  async function runPipeline(prompt, agents, startIndex, previousOutput) {
    startIndex = startIndex || 0;
    const groupId = makeId();
    let previous = previousOutput || '';
    for (let i = startIndex; i < agents.length; i++) {
      const agent = agents[i];
      const stepPrompt = i === 0
        ? prompt
        : 'Previous agent (' + agents[i - 1].name + ' via ' + providerLabel(agents[i - 1].provider) + ') produced:\n\n'
          + previous + '\n\nNow improve/fix/complete this:\n' + prompt;
      const retry = () => runPipeline(prompt, agents, i, previous);
      const result = await runAgent(stepPrompt, agent, { groupId, retry });
      if (!result.ok) return;
      previous = result.result;
      if (i < agents.length - 1) appendPipelineDivider(agents[i + 1].name);
    }
  }

  function appendPipelineDivider(nextAgentName) {
    const container = get('aiMessages');
    if (!container) return;
    const divider = document.createElement('div');
    divider.className = 'ai-pipeline-divider';
    divider.textContent = '↓ passed to ' + nextAgentName;
    container.appendChild(divider);
    container.scrollTop = container.scrollHeight;
  }

  async function send() {
    const input = get('aiInput');
    const prompt = input?.value.trim();
    if (!prompt) return;
    input.value = '';
    input.style.height = '36px';
    await sendPrompt(prompt);
  }

  async function sendPrompt(prompt, opts) {
    opts = opts || {};
    const displayText = opts.displayText || prompt;

    const agents = selectedAgents();
    if (!agents.length) {
      renderMessage('system', 'No enabled agent is configured. Open AI Settings to add one.');
      return;
    }

    renderMessage('user', displayText);

    try {
      if (state.mode === 'single') await runSingle(prompt, agents);
      else if (state.mode === 'parallel') await runParallel(prompt, agents);
      else if (state.mode === 'pipeline') await runPipeline(prompt, agents);
    } catch (e) {
      // individual agent failures already rendered
    }
  }

  // ─── Toolbar ───────────────────────────────────────────────
  function renderToolbar() {
    const panel = get('aiPanel');
    const messagesEl = get('aiMessages');
    if (!panel || !messagesEl || panel.querySelector('.ai-toolbar')) return;

    const toolbar = document.createElement('div');
    toolbar.className = 'ai-toolbar';

    const picker = document.createElement('div');
    picker.className = 'ai-agent-picker';
    const pickerButton = document.createElement('button');
    pickerButton.className = 'btn';
    const menu = document.createElement('div');
    menu.className = 'ai-agent-menu';
    pickerMenu = menu;
    picker.append(pickerButton, menu);

    const mode = document.createElement('select');
    mode.className = 'git-input ai-mode-select';
    ['single', 'parallel', 'pipeline'].forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      mode.appendChild(opt);
    });

    const manage = document.createElement('button');
    manage.className = 'btn';
    manage.textContent = 'Manage Agents ⚙';

    const workflow = document.createElement('select');
    workflow.className = 'git-input ai-workflow-select';
    const workflowPlaceholder = document.createElement('option');
    workflowPlaceholder.value = '';
    workflowPlaceholder.textContent = 'Workflow…';
    workflow.appendChild(workflowPlaceholder);
    WORKFLOWS.forEach((wf) => {
      const opt = document.createElement('option');
      opt.value = wf.id;
      opt.textContent = wf.label;
      workflow.appendChild(opt);
    });
    const runWorkflow = document.createElement('button');
    runWorkflow.className = 'btn';
    runWorkflow.textContent = 'Run Workflow';

    const clear = document.createElement('button');
    clear.className = 'btn';
    clear.textContent = 'Clear';

    stopButton = document.createElement('button');
    stopButton.className = 'btn';
    stopButton.textContent = 'Stop';
    stopButton.style.display = 'none';

    toolbar.append(picker, mode, workflow, runWorkflow, manage, clear, stopButton);
    panel.insertBefore(toolbar, messagesEl);
    mode.value = state.mode;

    function refresh() {
      menu.innerHTML = '';
      const chosen = state.mode === 'single' ? [state.active]
        : state.mode === 'parallel' ? state.compare
        : state.pipeline;
      const names = chosen.map((id) => agentById(id)?.name).filter(Boolean);
      pickerButton.textContent = names.length ? names.join(', ') : 'Select agents';

      const enabled = enabledAgents();
      if (!enabled.length) {
        const empty = document.createElement('div');
        empty.textContent = 'No enabled agents.';
        empty.style.cssText = 'padding:6px;font-size:11px;color:#888;';
        menu.appendChild(empty);
        return;
      }
      enabled.forEach((agent) => {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = chosen.includes(agent.id);
        label.append(checkbox, document.createTextNode(
          ' ' + agent.name + ' · ' + providerLabel(agent.provider) + ' · ' + agent.model
        ));
        checkbox.onchange = () => handleAgentToggle(agent, checkbox, chosen);
        menu.appendChild(label);
      });
    }

    function handleAgentToggle(agent, checkbox, chosen) {
      if (state.mode === 'single') {
        if (checkbox.checked) {
          state.active = agent.id;
        } else {
          checkbox.checked = true;
          return;
        }
      } else {
        const key = state.mode === 'parallel' ? 'compare' : 'pipeline';
        let arr = state[key].filter((id) => id !== agent.id);
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

    pickerButton.onclick = (e) => {
      e.stopPropagation();
      menu.classList.toggle('open');
    };
    document.addEventListener('click', (e) => {
      if (pickerMenu && !picker.contains(e.target)) pickerMenu.classList.remove('open');
    });

    mode.onchange = () => {
      stopRequests();
      state.mode = mode.value;
      repairSelections();
      save();
      refresh();
    };

    manage.onclick = () => openModal('agents');
    runWorkflow.onclick = async () => {
      const selected = WORKFLOWS.find((wf) => wf.id === workflow.value);
      if (!selected) return toast('Select a workflow');
      const file = context?.getActiveFile?.() || 'active file';
      const input = get('aiInput');
      const extra = input && input.value.trim() ? ('\n\nUser details:\n' + input.value.trim()) : '';
      if (input) {
        input.value = '';
        input.style.height = '36px';
      }
      await sendPrompt(
        'Workflow: ' + selected.label + '\n'
        + selected.prompt + '\n'
        + 'Active file: ' + file + '.'
        + extra,
        { displayText: 'Workflow → ' + selected.label + ' (' + basename(file) + ')' }
      );
    };
    clear.onclick = clearMessages;
    stopButton.onclick = stopRequests;

    refresh();
  }

  // ─── Modal ─────────────────────────────────────────────────
  function openModal(tab) {
    const modal = get('aiSettingsModal');
    if (!modal) return;
    modal.style.display = 'flex';

    if (!modalBody) {
      const content = modal.querySelector('.modal-content');
      if (!content) return;

      const legacyIds = ['aiProvider', 'aiApiKey', 'aiModel'];
      const legacyEls = legacyIds.map((id) => document.getElementById(id)).filter(Boolean);

      content.innerHTML =
        '<h3>AI Assistant Settings</h3>' +
        '<div class="ai-settings-tabs">' +
        '<button class="btn active" data-tab="agents">Agents</button>' +
        '<button class="btn" data-tab="help">How it works</button>' +
        '</div>' +
        '<div class="ai-settings-body"></div>' +
        '<div class="modal-buttons">' +
        '<button class="btn primary" id="btnSaveAISettings" style="display:none;">Save Settings</button>' +
        '<button class="btn" id="btnCloseAISettings">Close</button>' +
        '</div>';

      legacyEls.forEach((el) => {
        el.style.display = 'none';
        content.appendChild(el);
      });

      modalBody = content.querySelector('.ai-settings-body');
      content.querySelectorAll('[data-tab]').forEach((btn) => {
        btn.onclick = () => {
          content.querySelectorAll('[data-tab]').forEach((b) => {
            b.classList.toggle('active', b === btn);
          });
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
        '<p style="font-size:12px;line-height:1.5;">' +
        '<strong>Single</strong> — one agent answers.<br>' +
        '<strong>Parallel</strong> — up to ' + MAX_PARALLEL + ' agents answer simultaneously.<br>' +
        '<strong>Pipeline</strong> — agents run in sequence; each gets the previous output.<br><br>' +
        'Providers: ' + Object.values(LABELS).join(', ') + '.' +
        '</p>';
      return;
    }

    const list = document.createElement('div');
    if (!state.agents.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No agents yet. Click "Add Agent" to create one.';
      empty.style.cssText = 'font-size:12px;color:#888;padding:8px 0;';
      list.appendChild(empty);
    }

    state.agents.forEach((agent) => {
      const row = document.createElement('div');
      row.className = 'ai-agent-row';

      const label = document.createElement('label');
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = agent.enabled;
      toggle.onchange = (e) => {
        agent.enabled = e.target.checked;
        repairSelections();
        save();
      };
      label.append(toggle, document.createTextNode(' ' + agent.name));

      const info = document.createElement('span');
      info.textContent = providerLabel(agent.provider) + ' · ' + agent.model;

      const actions = document.createElement('span');
      ['Edit', 'Duplicate', 'Delete'].forEach((action) => {
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = action;
        btn.onclick = () => {
          if (action === 'Edit') {
            showForm(agent);
          } else if (action === 'Duplicate') {
            const copy = normalizeAgent({ ...agent, id: makeId(), name: agent.name + ' Copy' });
            state.agents.push(copy);
            repairSelections();
            save();
            renderModal('agents');
          } else if (action === 'Delete') {
            if (!confirm('Delete agent "' + agent.name + '"?')) return;
            state.agents = state.agents.filter((a) => a.id !== agent.id);
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
    add.className = 'btn primary';
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
    const inputs = {};

    const datalistId = 'ai-model-datalist';
    const datalist = document.createElement('datalist');
    datalist.id = datalistId;
    form.appendChild(datalist);

    const fields = [
      ['provider', 'Provider preset', 'select'],
      ['name', 'Name', 'text'],
      ['baseUrl', 'Base URL', 'text'],
      ['apiKey', 'API key', 'password'],
      ['model', 'Model', 'text'],
      ['systemPrompt', 'System prompt', 'textarea'],
      ['temperature', 'Temperature', 'range'],
      ['maxTokens', 'Max tokens', 'number']
    ];

    fields.forEach(([key, labelText, type]) => {
      const wrapper = document.createElement('label');
      wrapper.textContent = labelText;

      let input;
      if (type === 'textarea') {
        input = document.createElement('textarea');
      } else if (type === 'select') {
        input = document.createElement('select');
        PROVIDER_ORDER.forEach((v) => {
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

      if (key === 'model') input.setAttribute('list', datalistId);
      if (key === 'temperature') { input.min = 0; input.max = 2; input.step = 0.1; }
      if (key === 'maxTokens') input.min = 1;

      input.value = formState[key];
      wrapper.appendChild(input);
      form.appendChild(wrapper);
      inputs[key] = input;
    });

    function refreshDatalist() {
      datalist.innerHTML = '';
      const preset = PRESETS[inputs.provider.value];
      if (!preset) return;
      preset[1].forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        datalist.appendChild(opt);
      });
    }
    refreshDatalist();

    inputs.provider.onchange = () => {
      const preset = PRESETS[inputs.provider.value];
      if (!preset) return;

      const allPresetBases = Object.values(PRESETS).map((p) => p[0]);
      if (!inputs.baseUrl.value || allPresetBases.includes(inputs.baseUrl.value)) {
        inputs.baseUrl.value = preset[0];
      }

      const allPresetModels = Object.values(PRESETS).flatMap((p) => p[1]);
      if (!inputs.model.value || allPresetModels.includes(inputs.model.value)) {
        inputs.model.value = preset[1][0] || '';
      }

      formState.provider = inputs.provider.value;
      refreshDatalist();
    };

    const buttons = document.createElement('div');
    const test = document.createElement('button');
    test.type = 'button'; test.className = 'btn'; test.textContent = 'Test connection';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit'; saveBtn.className = 'btn primary'; saveBtn.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'Cancel';
    buttons.append(test, saveBtn, cancel);
    form.appendChild(buttons);
    modalBody.appendChild(form);

    function collect() {
      const values = {};
      Object.keys(inputs).forEach((k) => { values[k] = inputs[k].value; });
      return normalizeAgent({ ...formState, ...values });
    }

    test.onclick = async () => {
      const candidate = collect();
      const controller = beginRequest();
      try {
        await request(candidate, 'Respond with one token.', controller.signal, 1);
        toast('Connected');
      } catch (err) {
        toast(err.message);
      } finally {
        endRequest(controller);
      }
    };

    cancel.onclick = () => renderModal('agents');

    form.onsubmit = (e) => {
      e.preventDefault();
      const candidate = collect();
      if (candidate.provider === 'custom' && !candidate.baseUrl) {
        toast('Custom agents need a base URL.');
        return;
      }
      state.agents = state.agents.filter((a) => a.id !== candidate.id);
      state.agents.push(candidate);
      repairSelections();
      save();
      renderModal('agents');
    };
  }

  // ─── Attach ────────────────────────────────────────────────
  function attach(options) {
    if (attached) return;
    context = options;
    try {
      load();
    } catch (err) {
      console.error('[ai-agents] Failed to load state', err);
      return;
    }
    attached = true;
    renderToolbar();
    const settingsBtn = get('btnAISettings');
    if (settingsBtn) settingsBtn.addEventListener('click', () => openModal('agents'));
    const sendBtn = get('btnSendAI');
    if (sendBtn) sendBtn.addEventListener('click', send);
    const aiInput = get('aiInput');
    if (aiInput) {
      aiInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      });
    }
  }

  // ─── Public API ────────────────────────────────────────────
  window.AIAgents = {
    attach,
    send,
    stop: stopRequests,
    renderMessage: (role, value, meta) => renderMessage(role, value, meta)
  };

  if (window.__aiAttachOptions) attach(window.__aiAttachOptions);
}());