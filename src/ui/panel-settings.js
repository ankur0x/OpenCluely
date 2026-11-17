'use strict';

(() => {
    const api = window.electronAPI;
    const form = document.getElementById('providerForm');
    const status = document.getElementById('status');
    const save = document.getElementById('save');
    const setupWhisper = document.getElementById('setupWhisper');
    const fields = [...form.querySelectorAll('input')];
    const modelLists = [...form.querySelectorAll('[data-model-provider]')];
    const refresh = document.getElementById('refreshModels');
    const catalogStatus = document.getElementById('catalogStatus');
    let loaded = false;
    let currentState;

    function notify(message, error = false) {
        status.textContent = message;
        status.dataset.error = String(error);
    }

    async function loadSettings() {
        try {
            const settings = await api.getSettings();
            if (!settings) return;
            for (const field of fields) {
                const value = settings[field.id] || '';
                field.value = field.id === 'geminiKey' && /^your[_-]/i.test(value) ? '' : value;
            }
            loaded = true;
            save.disabled = false;
        } catch {
            notify('Could not load provider settings.', true);
        }
    }

    async function saveSettings(values) {
        const result = await api.saveSettings(values);
        if (!result?.success) throw new Error(result?.error || 'Could not save settings.');
    }

    function syncModelLists(state) {
        if (!state) return;
        currentState = state;
        for (const select of modelLists) {
            const provider = state.chat.find(option => option.id === select.dataset.modelProvider);
            if (!provider) continue;
            const empty = new Option('Choose ' + provider.label + ' model', '');
            empty.disabled = true;
            select.replaceChildren(empty, ...provider.models.map(id => new Option(id, id)));
            select.disabled = !provider.configured;
            setInlinePickerValue(select, state.selectedChat === provider.id ? state.selectedChatModel || '' : '');
        }
    }

    for (const select of modelLists) {
        select.addEventListener('change', async () => {
            try {
                const result = await api.selectPanelModel('chat', select.dataset.modelProvider, select.value);
                if (!result?.success) throw new Error(result?.error || 'Could not switch models.');
                notify('Answer model selected.');
            } catch (error) {
                notify(error.message, true);
                syncModelLists(currentState);
            }
        });
    }
    async function refreshLists() {
        refresh.disabled = true;
        catalogStatus.textContent = 'Fetching available models...';
        try {
            const results = await api.refreshPanelModels();
            const loaded = results.filter(item => item.status === 'ready').length;
            const failed = results.filter(item => item.status === 'unavailable')
                .map(item => currentState?.chat.find(model => model.id === item.id)?.label || item.id);
            catalogStatus.textContent = 'Refreshed ' + loaded + ' provider list(s).' +
                (failed.length ? ' Unavailable: ' + failed.join(', ') + '.' : '');
        } catch {
            catalogStatus.textContent = 'Could not refresh model lists.';
        } finally {
            refresh.disabled = false;
        }
    }
    refresh.addEventListener('click', refreshLists);

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!loaded || save.disabled) return;
        save.disabled = true;
        try {
            await saveSettings(Object.fromEntries(fields.map(field => [field.id, field.value.trim()])));
            notify('Settings saved. Select a model from the floating panel.');
        } catch (error) {
            notify(error.message, true);
        } finally {
            save.disabled = false;
        }
    });

    setupWhisper.addEventListener('click', async () => {
        setupWhisper.disabled = true;
        notify('Setting up local Whisper. This can take a few minutes.');
        try {
            const result = await api.installWhisper();
            if (!result?.ok) throw new Error(result?.message || 'Whisper setup failed.');
            await saveSettings({ whisperCommand: result.command, speechProvider: 'whisper' });
            document.getElementById('whisperCommand').value = result.command;
            notify('Whisper is ready. Choose its model size from the panel.');
        } catch (error) {
            notify(error.message, true);
        } finally {
            setupWhisper.disabled = false;
        }
    });

    document.getElementById('close').addEventListener('click', () => api.closeWindow());
    document.getElementById('quit').addEventListener('click', () => api.quitFromSettings());
    api.onProviderSettingsShown(() => {
        loadSettings();
        api.getPanelState().then(syncModelLists).catch(() => {});
    });
    api.onPanelState(syncModelLists);
    api.getPanelState().then(syncModelLists).catch(() => {});
    save.disabled = true;
    loadSettings();
})();
