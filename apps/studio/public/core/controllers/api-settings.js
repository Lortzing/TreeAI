const API_SETTINGS_URL = '/api/settings/api';
const API_FORMATS = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'google-generative-ai',
];

export function registerApiSettings({ document, fetch }) {
  const openButton = document.getElementById('api-settings-open');
  const dialog = document.getElementById('api-settings-dialog');
  if (!openButton || !dialog) return () => {};

  const form = document.getElementById('api-settings-form');
  const closeButton = document.getElementById('api-settings-close');
  const providerSelect = document.getElementById('api-provider');
  const modelSelect = document.getElementById('api-model');
  const modelIdInput = document.getElementById('api-model-id');
  const keyInput = document.getElementById('api-key-value');
  const keyControls = document.getElementById('api-keychain-controls');
  const keySave = document.getElementById('api-key-save');
  const keyRemove = document.getElementById('api-key-remove');
  const keyStatus = document.getElementById('api-keychain-status');
  const keySummary = document.getElementById('api-key-summary');
  let credentialProviderId = '';
  let keychainSupported = false;
  const storedNames = new Set();
  const environmentNames = new Set();
  const formatSelect = document.getElementById('api-format');
  const baseUrlInput = document.getElementById('api-base-url');
  const keyEnvInput = document.getElementById('api-key-env');
  const contextWindowInput = document.getElementById('api-context-window');
  const maxTokensInput = document.getElementById('api-max-tokens');
  const addProviderButton = document.getElementById('api-provider-add');
  const addModelButton = document.getElementById('api-model-add');
  const testButton = document.getElementById('api-connection-test');
  const status = document.getElementById('api-settings-status');
  const configJson = document.getElementById('api-config-json');
  const jsonApplyButton = document.getElementById('api-json-apply');
  const environmentStatus = document.getElementById('api-env-status');

  const disposers = [];
  const AbortControllerCtor = document.defaultView?.AbortController ?? AbortController;
  let draft;
  let activeProviderId = '';
  let activeModelId = '';
  let requestController;
  let disabledStates;
  let disposed = false;

  function listen(target, eventName, handler) {
    if (!target?.addEventListener) return;
    target.addEventListener(eventName, handler);
    disposers.push(() => target.removeEventListener(eventName, handler));
  }

  function setStatus(message) {
    if (status) status.textContent = message;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function providersOf(config) {
    return isRecord(config?.providers) ? config.providers : {};
  }

  function modelsOf(provider) {
    return Array.isArray(provider?.models) ? provider.models : [];
  }

  function normalizeSelection(config, selection = {}) {
    const providers = providersOf(config);
    const providerIds = Object.keys(providers);
    const requestedProviderId = typeof selection.providerId === 'string' ? selection.providerId : '';
    const providerId = Object.hasOwn(providers, requestedProviderId)
      ? requestedProviderId
      : (providerIds[0] ?? '');
    const models = modelsOf(providers[providerId]);
    const requestedModelId = typeof selection.modelId === 'string' ? selection.modelId : '';
    const hasModel = models.some((model) => model && String(model.id ?? '') === requestedModelId);
    const modelId = hasModel ? requestedModelId : String(models.find((model) => model && model.id != null)?.id ?? '');
    return { providerId, modelId };
  }

  function option(select, value, label) {
    const element = document.createElement('option');
    element.value = value;
    element.textContent = label;
    select.appendChild(element);
  }

  function replaceOptions(select, entries, placeholder) {
    if (!select) return;
    while (select.firstChild) select.removeChild(select.firstChild);
    if (placeholder) option(select, '', placeholder);
    for (const [value, label] of entries) option(select, value, label);
  }

  function currentProvider() {
    return providersOf(draft?.config)[activeProviderId];
  }

  function currentModel() {
    return modelsOf(currentProvider()).find((model) => model && String(model.id ?? '') === activeModelId);
  }

  function setOptionalField(record, key, value) {
    if (value === '') {
      delete record[key];
      return;
    }
    record[key] = value;
  }

  function numericValue(input) {
    if (!input || input.value === '') return undefined;
    const value = Number(input.value);
    return Number.isFinite(value) ? value : undefined;
  }

  function flushEditor() {
    const provider = currentProvider();
    if (provider) {
      if (formatSelect) setOptionalField(provider, 'api', formatSelect.value);
      if (baseUrlInput) setOptionalField(provider, 'baseUrl', baseUrlInput.value);
      if (keyEnvInput) setOptionalField(provider, 'apiKeyEnv', keyEnvInput.value);
    }
    const model = currentModel();
    if (model) {
      if (modelIdInput?.value.trim()) {
        const id = modelIdInput.value.trim();
        if (model.name === model.id) model.name = id;
        model.id = id; activeModelId = id; draft.selection.modelId = id;
      }
      for (const [input, key] of [[contextWindowInput, 'contextWindow'], [maxTokensInput, 'maxTokens']]) {
        if (!input) continue;
        const value = numericValue(input);
        if (value === undefined) delete model[key];
        else model[key] = value;
      }
    }
  }

  function updateEnvironmentStatus(value) {
    keychainSupported = value?.credentialStore?.supported === true;
    storedNames.clear(); environmentNames.clear();
    for (const item of value?.environment ?? []) {
      if (item.stored || item.source === 'keychain') storedNames.add(item.name);
      if (item.source === 'environment') environmentNames.add(item.name);
    }
    if (!environmentStatus) return;
    const environment = Array.isArray(value?.environment) ? value.environment : [];
    const missing = [...new Set(environment
      .filter((item) => item && item.present === false && typeof item.name === 'string')
      .map((item) => item.name))];
    const messages = [];
    if (missing.length) messages.push(`尚未配置密钥：${missing.join('、')}。${keychainSupported ? '可保存到系统钥匙串，或在高级设置中使用环境变量。' : '请通过高级设置指定的环境变量提供密钥。'}`);
    else if (environment.length) messages.push('认证信息已配置，密钥值不会显示。');
    else messages.push('暂无环境变量状态。');
    if (value?.enabled === false) messages.push('API 设置当前未启用。');
    environmentStatus.textContent = messages.join(' ');
    environmentStatus.hidden = keychainSupported && missing.length === 0;
  }

  function syncJson() {
    if (!configJson || !draft) return;
    configJson.value = JSON.stringify({ config: draft.config, selection: draft.selection }, null, 2);
  }

  function renderEditor() {
    if (!draft) return;
    const providers = providersOf(draft.config);
    const providerIds = Object.keys(providers);
    draft.selection = normalizeSelection(draft.config, draft.selection);
    activeProviderId = draft.selection.providerId;
    activeModelId = draft.selection.modelId;

    replaceOptions(providerSelect, providerIds.map((id) => [id, id]), providerIds.length ? '' : '请新增提供方');
    if (providerSelect) providerSelect.value = activeProviderId;

    const provider = currentProvider();
    const labels = ['Anthropic Messages', 'OpenAI Chat Completions', 'OpenAI Responses', 'Gemini API'];
    const formats = API_FORMATS.map((format, i) => [format, labels[i]]);
    replaceOptions(formatSelect, formats, '选择 API 格式');
    if (formatSelect) formatSelect.value = API_FORMATS.includes(provider?.api) ? provider.api : '';

    const models = modelsOf(provider);
    replaceOptions(modelSelect, models
      .filter((model) => model && model.id != null)
      .map((model) => [String(model.id), String(model.name || model.id)]), models.length ? '' : '请新增模型');
    if (modelSelect) modelSelect.value = activeModelId;

    if (baseUrlInput) baseUrlInput.value = String(provider?.baseUrl ?? '');
    if (keyEnvInput) keyEnvInput.value = String(provider?.apiKeyEnv ?? '');

    const model = currentModel();
    if (contextWindowInput) contextWindowInput.value = model ? String(model.contextWindow ?? 32768) : '';
    if (maxTokensInput) maxTokensInput.value = model ? String(model.maxTokens ?? 4096) : '';

    if (formatSelect) formatSelect.disabled = !provider;
    if (baseUrlInput) baseUrlInput.disabled = !provider;
    if (keyEnvInput) keyEnvInput.disabled = !provider;
    if (modelSelect) modelSelect.disabled = !provider || models.length === 0;
    if (contextWindowInput) contextWindowInput.disabled = !model;
    if (maxTokensInput) maxTokensInput.disabled = !model;
    if (addModelButton) addModelButton.disabled = !provider;
    if (modelIdInput) { modelIdInput.value = String(model?.id ?? ''); modelIdInput.disabled = !model; }
    const hasCredential = provider && (storedNames.has(provider.apiKeyEnv) || environmentNames.has(provider.apiKeyEnv));
    if (keyControls) {
      keyControls.hidden = !keychainSupported;
      if (credentialProviderId !== activeProviderId) keyControls.open = !hasCredential;
    }
    credentialProviderId = activeProviderId;
    if (keySummary) keySummary.textContent = hasCredential ? '已配置 · 点击更换' : '尚未配置';
    if (keySave) keySave.disabled = !provider || !keychainSupported;
    if (keyRemove) keyRemove.disabled = !provider || !storedNames.has(provider.apiKeyEnv);
    if (keyStatus) keyStatus.textContent = !provider ? '先添加 API 提供方。' : storedNames.has(provider.apiKeyEnv)
      ? environmentNames.has(provider.apiKeyEnv) ? '系统钥匙串已有密钥；当前环境变量优先。' : '已保存在系统钥匙串。无需再次输入，替换时填写新的密钥。'
      : environmentNames.has(provider.apiKeyEnv) ? '当前使用环境变量中的密钥；可在此保存备用密钥。' : '密钥保存在本机系统钥匙串，不写入配置文件。';
  }

  function updateProviderField(key, value) {
    const provider = currentProvider();
    if (provider) setOptionalField(provider, key, value);
  }

  function updateModelNumber(input, key) {
    const model = currentModel();
    if (!model) return;
    const value = numericValue(input);
    if (value === undefined) delete model[key];
    else model[key] = value;
  }

  function nextId(prefix, records) {
    let number = 2;
    while (Object.hasOwn(records, `${prefix}-${number}`)) number += 1;
    return `${prefix}-${number}`;
  }

  function addProvider(event) {
    event?.preventDefault();
    if (!draft) return;
    flushEditor();
    const providers = providersOf(draft.config);
    const id = nextId('provider', providers);
    providers[id] = { api: API_FORMATS[0], baseUrl: '', apiKeyEnv: `TREEAI_${id.replaceAll('-', '_').toUpperCase()}_API_KEY`, models: [{ id: 'model-1', name: 'model-1' }] };
    draft.selection = { providerId: id, modelId: 'model-1' };
    renderEditor();
    syncJson();
    setStatus('请填写 API 地址和模型 ID，再配置密钥并测试连接。');
  }

  function addModel(event) {
    event?.preventDefault();
    const provider = currentProvider();
    if (!provider) {
      setStatus('请先新增提供方。');
      return;
    }
    flushEditor();
    if (!Array.isArray(provider.models)) provider.models = [];
    const records = Object.fromEntries(provider.models
      .filter((model) => model && model.id != null)
      .map((model) => [String(model.id), true]));
    const id = nextId('model', records);
    provider.models.push({ id, name: id });
    draft.selection.modelId = id;
    renderEditor();
    syncJson();
    setStatus('请在模型 ID 中填写服务商提供的标识。');
  }

  function applyJson(event) {
    event?.preventDefault();
    if (!draft || !configJson) return;
    flushEditor();
    try {
      const parsed = JSON.parse(configJson.value);
      const hasEnvelope = isRecord(parsed) && Object.hasOwn(parsed, 'config');
      const config = hasEnvelope ? parsed.config : parsed;
      if (!isRecord(config) || !isRecord(config.providers)) throw new Error('invalid config');
      const selection = hasEnvelope && isRecord(parsed.selection) ? parsed.selection : draft.selection;
      draft.config = clone(config);
      draft.selection = normalizeSelection(draft.config, selection);
      renderEditor();
      syncJson();
      setStatus('高级 JSON 已应用。');
    } catch {
      setStatus('JSON 格式无效，请检查语法及 providers 结构。');
    }
  }

  function setBusy(busy) {
    if (!form) return;
    if (busy) {
      if (disabledStates) return;
      disabledStates = new Map();
      for (const element of form.elements) {
        if (element === closeButton) continue;
        disabledStates.set(element, element.disabled);
        element.disabled = true;
      }
      if (testButton && !disabledStates.has(testButton)) {
        disabledStates.set(testButton, testButton.disabled);
        testButton.disabled = true;
      }
      return;
    }
    if (!disabledStates) return;
    for (const [element, wasDisabled] of disabledStates) element.disabled = wasDisabled;
    disabledStates = undefined;
    if (draft) renderEditor();
  }

  function abortRequest() {
    requestController?.abort();
  }

  function isAbort(error) {
    return error?.name === 'AbortError';
  }

  function httpErrorMessage(action, error) {
    if (typeof error?.status === 'number') return `${action}失败（HTTP ${error.status}），请检查设置后重试。`;
    return `${action}失败，无法连接设置服务，请确认服务运行后重试。`;
  }

  async function requestJson(path, options, action) {
    let response;
    try {
      response = await fetch(path, options);
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new Error(httpErrorMessage(action));
    }
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const messages = {
        'credential-store-failed': '无法访问系统钥匙串，请确认已解锁后重试。',
        'credential-store-unavailable': '当前系统未启用密钥库，请使用环境变量。',
        'settings-conflict': '设置已被其他窗口修改，请关闭后重新打开设置页。',
        'probe-busy': '另一个连接测试正在运行，请稍后重试。',
        'invalid-settings': '配置无效，请检查接口格式、地址、模型和环境变量名称。',
        'settings-unavailable': '此实例未启用设置，请检查启动方式。',
        'local-only': '设置只允许从本机同源页面访问。',
      };
      const error = new Error(messages[body?.error?.code] ?? `${action}失败（HTTP ${response.status}），请重试。`);
      error.status = response.status;
      throw error;
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`${action}失败，服务返回的数据无法读取。`);
    }
  }

  function readSnapshot(value) {
    if (!isRecord(value) || !isRecord(value.config) || !isRecord(value.config.providers)) {
      throw new Error('服务返回的设置格式无法识别，请稍后重试。');
    }
    draft = {
      config: clone(value.config),
      selection: normalizeSelection(value.config, value.selection),
      revision: typeof value.revision === 'string' ? value.revision : '',
    };
    updateEnvironmentStatus(value);
    credentialProviderId = '';
    renderEditor();
    syncJson();
  }

  async function runRequest(action, operation) {
    const controller = new AbortControllerCtor();
    requestController = controller;
    setBusy(true);
    setStatus(`${action}中…`);
    try {
      await operation(controller.signal);
    } catch (error) {
      if (!isAbort(error) && !disposed) setStatus(error?.message || `${action}失败，请稍后重试。`);
    } finally {
      if (requestController === controller) {
        requestController = undefined;
        setBusy(false);
      }
    }
  }

  async function loadSettings() {
    await runRequest('读取设置', async (signal) => {
      const value = await requestJson(API_SETTINGS_URL, { signal }, '读取设置');
      if (signal.aborted || disposed) return;
      readSnapshot(value);
      setStatus(value.configurationWarning ? '已保存的配置无法读取；可重新配置并保存。' : value.restartRequired ? '已有保存的配置等待生效；请重启服务。' : '设置已加载。');
    });
  }

  function selectionPayload() {
    flushEditor();
    draft.selection = { providerId: activeProviderId, modelId: activeModelId };
    syncJson();
    return { config: clone(draft.config), selection: clone(draft.selection) };
  }

  async function testConnection(event) {
    event?.preventDefault();
    if (!draft || requestController) return;
    const payload = selectionPayload();
    await runRequest('连接测试', async (signal) => {
      const result = await requestJson(API_SETTINGS_URL + '/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TreeAI-Settings': '1' },
        body: JSON.stringify(payload),
        signal,
      }, '连接测试');
      if (signal.aborted || disposed) return;
      if (result?.ok === true) {
        setStatus('连接测试成功。');
        return;
      }
      const messages = {
        'missing-api-key': '未配置 API 密钥环境变量。',
        missing_api_key: '未配置 API 密钥环境变量。',
        'invalid-api-key': 'API 密钥无效，请检查服务环境配置。',
        invalid_api_key: 'API 密钥无效，请检查服务环境配置。',
        unauthorized: '服务拒绝了认证信息，请检查密钥配置。',
        timeout: '连接超时，请检查网络或服务地址。',
        network_error: '无法连接目标服务，请检查网络或服务地址。',
      };
      const message = typeof result?.code === 'string' ? messages[result.code] : undefined;
      setStatus(`连接测试未通过。${message ?? '请检查提供方、模型及服务地址。'}`);
    });
  }

  async function saveSettings(event) {
    event?.preventDefault();
    if (!draft || requestController) return;
    const payload = selectionPayload();
    payload.revision = draft.revision;
    await runRequest('保存设置', async (signal) => {
      const value = await requestJson(API_SETTINGS_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-TreeAI-Settings': '1' },
        body: JSON.stringify(payload),
        signal,
      }, '保存设置');
      if (signal.aborted || disposed) return;
      readSnapshot(value);
      setStatus('保存成功；设置需重启服务后生效。');
    });
  }

  async function saveCredential(event, remove = false) {
    event?.preventDefault();
    if (!draft || requestController || !keychainSupported) return;
    const value = keyInput?.value ?? '';
    if (!remove && !value.trim()) { setStatus('请先输入 API key。'); return; }
    const payload = selectionPayload();
    if (!remove) payload.value = value;
    if (keyInput) keyInput.value = '';
    await runRequest(remove ? '移除密钥' : '保存密钥', async (signal) => {
      const result = await requestJson(API_SETTINGS_URL + '/credentials', {
        method: remove ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json', 'X-TreeAI-Settings': '1' },
        body: JSON.stringify(payload), signal,
      }, '密钥操作');
      if (signal.aborted || disposed) return;
      const name = currentProvider()?.apiKeyEnv;
      if (name) { if (result.stored) storedNames.add(name); else storedNames.delete(name); }
      if (environmentStatus) environmentStatus.textContent = remove ? '已移除系统钥匙串中的密钥。' : '当前提供方的密钥已保存到本机。';
      setStatus(remove ? '已移除钥匙串中的密钥。环境变量不受影响。' : result.environmentOverride
        ? '已保存到钥匙串；当前环境变量优先。' : '密钥已保存。可以测试连接；连接配置需保存设置后生效。');
    });
  }

  function openDialog() {
    if (dialog.open || dialog.hasAttribute('open')) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    dialog.scrollTop = 0;
    setStatus('正在读取设置…');
    void loadSettings();
  }

  function closeDialog(event) {
    event?.preventDefault();
    abortRequest();
    if (keyInput) keyInput.value = '';
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  listen(openButton, 'click', openDialog);
  listen(closeButton, 'click', closeDialog);
  listen(dialog, 'close', () => { abortRequest(); if (keyInput) keyInput.value = ''; openButton.focus?.(); });
  listen(dialog, 'cancel', () => { abortRequest(); if (keyInput) keyInput.value = ''; });
  // Modal keyboard input must not trigger conversation paging or Escape layers behind it.
  listen(dialog, 'keydown', (event) => event.stopPropagation());
  listen(form, 'submit', saveSettings);
  listen(addProviderButton, 'click', addProvider);
  listen(addModelButton, 'click', addModel);
  listen(testButton, 'click', testConnection);
  listen(keySave, 'click', event => { void saveCredential(event); });
  listen(keyRemove, 'click', event => { void saveCredential(event, true); });
  listen(jsonApplyButton, 'click', applyJson);

  listen(providerSelect, 'change', () => {
    if (keyInput) keyInput.value = '';
    flushEditor();
    const providerId = providerSelect.value;
    const provider = providersOf(draft?.config)[providerId];
    draft.selection = {
      providerId,
      modelId: String(modelsOf(provider).find((model) => model && model.id != null)?.id ?? ''),
    };
    renderEditor();
  });
  listen(modelSelect, 'change', () => {
    flushEditor();
    draft.selection.modelId = modelSelect.value;
    renderEditor();
  });
  listen(formatSelect, 'change', () => updateProviderField('api', formatSelect.value));
  listen(baseUrlInput, 'input', () => updateProviderField('baseUrl', baseUrlInput.value));
  listen(keyEnvInput, 'input', () => updateProviderField('apiKeyEnv', keyEnvInput.value));
  listen(contextWindowInput, 'input', () => updateModelNumber(contextWindowInput, 'contextWindow'));
  listen(maxTokensInput, 'input', () => updateModelNumber(maxTokensInput, 'maxTokens'));

  const pageWindow = document.defaultView;
  listen(pageWindow, 'pagehide', abortRequest);
  listen(pageWindow, 'beforeunload', abortRequest);

  return () => {
    if (disposed) return;
    disposed = true;
    if (keyInput) keyInput.value = '';
    abortRequest();
    for (const disposeListener of disposers.splice(0)) disposeListener();
    setBusy(false);
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  };
}
