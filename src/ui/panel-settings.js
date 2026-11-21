'use strict';
(() => {
    const api = window.electronAPI;
    const $ = id => document.getElementById(id);
    const fields = [...document.querySelectorAll('[data-setting]')];
    const catalogs = [...document.querySelectorAll('[data-model-provider]')];
    let snapshot = {}, loaded = false, busy = false, state, stagedDefault = null, selectedProvider = 'gemini';
    function values() {
        return Object.fromEntries(fields.map(field => [field.id, field.type === 'checkbox' ? field.checked : field.type === 'range' ? Number(field.value) : field.value.trim()]));
    }
    function isDirty() { return JSON.stringify(values()) !== JSON.stringify(snapshot) || Boolean(stagedDefault); }
    function notify(message, error = false) { $('status').textContent = message; $('status').dataset.error = String(error); }
    function updateDirty() {
        $('save').disabled = !loaded || busy || !isDirty();
        $('discard').disabled = !loaded || busy || !isDirty();
        if (loaded && !busy) notify(isDirty() ? 'Unsaved changes' : 'All changes saved');
        voiceView(); preview();
    }
    function voiceView() {
        const provider = $('speechProvider').value;
        document.querySelectorAll('[data-voice-for]').forEach(element => element.hidden = element.dataset.voiceFor !== provider);
        $('voiceDestination').textContent = provider === 'whisper' ? 'Microphone audio is transcribed on this computer. Final transcripts go to your answer provider.' : 'Microphone audio is sent to ' + provider + '. Final transcripts go to your answer provider.';
    }
    function preview() {
        $('opacityValue').textContent = $('panelOpacity').value + '%';
        $('appearancePreview').style.opacity = Number($('panelOpacity').value) / 100;
        $('appearancePreview').style.fontSize = $('panelTextSize').value === 'large' ? '16px' : '14px';
    }
    async function loadSettings() {
        if (loaded && isDirty()) return;
        try {
            const settings = await api.getSettings();
            if (!settings) throw new Error('Settings unavailable.');
            for (const field of fields) {
                const value = settings[field.id] ?? '';
                if (field.type === 'checkbox') field.checked = value !== false;
                else if (field.tagName === 'SELECT') setInlinePickerValue(field, String(value));
                else field.value = value;
            }
            snapshot = values(); stagedDefault = null; loaded = true; updateDirty();
        } catch { notify('Could not load Settings. Reopen this window to try again.', true); }
    }
    function syncCatalogs(next) {
        if (!next) return;
        state = next;
        for (const select of catalogs) {
            const provider = state.chat.find(item => item.id === select.dataset.modelProvider);
            if (!provider) continue;
            const old = select.value;
            const placeholder = new Option(provider.models.length ? 'Choose a model' : 'No models found', '');
            placeholder.disabled = true;
            select.replaceChildren(placeholder, ...provider.models.map(id => new Option(id,id)));
            const selected = provider.id === state.selectedChat ? state.selectedChatModel : old;
            setInlinePickerValue(select, provider.models.includes(selected) ? selected : provider.models[0] || '');
            select.disabled = !provider.models.length;
            syncInlinePickerLabel(select);
            const badge = document.querySelector('[data-provider-badge="' + provider.id + '"]');
            badge.textContent = provider.id === state.selectedChat ? 'Default' : provider.configured ? 'Key saved' : 'Not configured';
            document.querySelector('[data-provider-dot="' + provider.id + '"]').dataset.configured = String(provider.configured);
        }
        const answer = state.chat.find(item => item.id === state.selectedChat);
        $('dataFlow').textContent = 'Messages, screenshots and finalized transcripts → ' + (answer?.label || state.selectedChat) + ' / ' + state.selectedChatModel + '. Voice → ' + state.selectedVoice + '.';
    }
    for (const button of document.querySelectorAll('[data-page]')) {
        button.onclick = () => {
            document.querySelectorAll('[data-page]').forEach(item => item.removeAttribute('aria-current'));
            button.setAttribute('aria-current','page');
            document.querySelectorAll('[data-settings-page]').forEach(page => page.hidden = page.dataset.settingsPage !== button.dataset.page);
            $('providerForm').scrollTop = 0;
        };
    }
    for (const button of document.querySelectorAll('[data-provider-tab]')) {
        button.onclick = () => {
            selectedProvider = button.dataset.providerTab;
            document.querySelectorAll('[data-provider-tab]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
            document.querySelectorAll('[data-provider-editor]').forEach(editor => editor.hidden = editor.dataset.providerEditor !== selectedProvider);
        };
    }
    for (const field of fields) {
        field.addEventListener('input', updateDirty); field.addEventListener('change', updateDirty);
    }
    document.querySelectorAll('[data-reveal]').forEach(button => button.onclick = () => {
        const input = $(button.dataset.reveal);
        input.type = input.type === 'password' ? 'text' : 'password';
        button.textContent = input.type === 'password' ? 'Show' : 'Hide';
        button.setAttribute('aria-label', button.textContent + ' API key');
    });
    document.querySelectorAll('[data-default]').forEach(button => button.onclick = () => {
        const provider = button.dataset.default, model = $(provider + 'Catalog').value;
        if (!model) return notify('Choose a model first.', true);
        stagedDefault = { chatProvider: provider, chatModel: model };
        updateDirty(); notify('Default staged. Save changes to use ' + model + '.');
    });
    $('providerForm').onsubmit = async event => {
        event.preventDefault();
        if (!loaded || busy || !isDirty()) return;
        busy = true; updateDirty(); notify('Saving changes…');
        try {
            const current = values();
            const changed = Object.fromEntries(Object.entries(current).filter(([key,value]) => value !== snapshot[key]));
            const result = await api.saveSettings({...changed,...stagedDefault});
            if (!result?.success) throw new Error(result?.error || 'Could not save Settings.');
            snapshot = current; stagedDefault = null;
            syncCatalogs(await api.getPanelState());
            notify('All changes saved');
        } catch (error) { notify(error.message, true); }
        finally { busy = false; $('save').disabled = !isDirty(); $('discard').disabled = !isDirty(); if (isDirty() && $('status').dataset.error !== 'true') notify('Unsaved changes'); }
    };
    $('discard').onclick = () => {
        for (const field of fields) {
            if (field.type === 'checkbox') field.checked = snapshot[field.id];
            else if (field.tagName === 'SELECT') setInlinePickerValue(field, snapshot[field.id]);
            else field.value = snapshot[field.id];
        }
        stagedDefault = null; updateDirty();
    };
    async function refresh(button) {
        if (isDirty()) return notify('Save or discard changes before refreshing models.', true);
        const refreshButtons = [...document.querySelectorAll('[data-refresh]')];
        refreshButtons.forEach(item => item.disabled = true);
        $('catalogStatus').textContent = 'Fetching models from configured providers…';
        try {
            const results = await api.refreshPanelModels();
            syncCatalogs(await api.getPanelState());
            $('catalogStatus').textContent = results.filter(item => item.status !== 'unconfigured').map(item => item.id + ': ' + (item.status === 'ready' ? item.count + ' models' : 'unavailable')).join(' · ');
        } catch { $('catalogStatus').textContent = 'Could not refresh the catalogs.'; }
        finally { refreshButtons.forEach(item => item.disabled = false); }
    }
    document.querySelectorAll('[data-refresh]').forEach(button => button.onclick = () => refresh(button));
    async function test(provider, output, button) {
        if (isDirty()) { output.textContent = 'Save or discard changes before testing saved credentials.'; return; }
        const model = $(provider + 'Catalog').value;
        button.disabled = true; output.dataset.error = 'false'; output.dataset.success = 'false';
        output.textContent = 'Sending a short test message…';
        try {
            const result = await api.testPanelProvider(provider, model);
            if (!result?.success) throw new Error(result?.error || 'Connection check failed.');
            output.textContent = ['✓ Network, credentials, model and reply verified.', result.message, result.model].join(String.fromCharCode(10));
            output.dataset.success = 'true';
            const badge = document.querySelector('[data-provider-badge="' + provider + '"]');
            badge.textContent = 'Verified'; badge.dataset.connected = 'true';
        } catch (error) { output.dataset.error = 'true'; output.textContent = error.message; }
        finally { button.disabled = false; }
    }
    document.querySelectorAll('[data-test-provider]').forEach(button => button.onclick = () => test(button.dataset.testProvider,document.querySelector('[data-test-result="' + button.dataset.testProvider + '"]'),button));
    $('runDiagnostics').onclick = () => test($('diagnosticProvider').value,$('diagnosticResult'),$('runDiagnostics'));
    $('testMic').onclick = async () => {
        $('testMic').disabled = true;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({audio:true});
            $('micTestResult').textContent = '✓ Microphone access works. No audio was sent to a provider.';
        } catch { $('micTestResult').textContent = 'Microphone unavailable. Check Windows microphone permission and your input device.'; }
        finally { stream?.getTracks().forEach(track => track.stop()); $('testMic').disabled = false; }
    };
    $('setupWhisper').onclick = async () => {
        $('setupWhisper').disabled = true; $('installStatus').textContent = 'Installing Whisper…';
        try {
            const result = await api.installWhisper();
            if (!result?.ok) throw new Error(result?.message || 'Whisper installation failed.');
            $('whisperCommand').value = result.command; updateDirty();
            $('installStatus').textContent = 'Installed. Save changes to use this command.';
        } catch (error) { $('installStatus').textContent = error.message; }
        finally { $('setupWhisper').disabled = false; }
    };
    api.onInstallProgress(line => $('installStatus').textContent = String(line).slice(-200));
    $('clearHistory').onclick = () => { $('clearPrompt').hidden = false; $('cancelClear').focus(); };
    $('cancelClear').onclick = () => { $('clearPrompt').hidden = true; $('clearHistory').focus(); };
    $('confirmClear').onclick = async () => {
        $('confirmClear').disabled = true;
        try { await api.clearSessionMemory(); $('clearPrompt').hidden = true; notify('Conversation and saved history cleared.'); }
        catch { notify('Could not clear the conversation.',true); }
        finally { $('confirmClear').disabled = false; }
    };
    document.addEventListener('keydown',event => { if (event.key === 'Escape' && !$('clearPrompt').hidden) $('cancelClear').click(); });
    $('close').onclick = () => api.closeWindow();
    $('quit').onclick = () => api.quitFromSettings();
    api.onPanelState(syncCatalogs);
    api.onProviderSettingsShown(() => { void loadSettings(); api.getPanelState().then(syncCatalogs).catch(() => {}); });
    api.getPanelState().then(syncCatalogs).catch(() => {});
    void loadSettings();
})();
