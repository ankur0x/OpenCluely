(function () {
'use strict';

const api = window.electronAPI;
const elements = Object.fromEntries(
    Array.from(document.querySelectorAll('[id]'), element => [element.id, element])
);
const historyKey = 'opencluely_chat_history_v1';
const authors = { user: 'You', transcription: 'Voice transcript', screenshot: 'Screenshot', assistant: 'Assistant', error: 'Error', system: 'Chat' };
const pendingResponses = new Map();
let history = [];
let recording = false;
let speechAvailable = false;
const attachments = new Map();
let viewerOrigin;
let messageSending = false;
let collapsed = false;
let sessionActive = true;
let speechBusy = false;
let modelState = null;
const panelAudio = createPanelAudio(api, showError);

function saveHistory() {
    try {
        const removed = history.splice(0, Math.max(0, history.length - 500));
        const ids = removed.flatMap(item => item.imageIds || []);
        if (ids.length) chatImageStore.remove(ids).catch(() => {});
        localStorage.setItem(historyKey, JSON.stringify(history));
    } catch (error) {
        showError('Could not save chat history on this device.');
    }
}

function addMessage(type, text = '') {
    const article = document.createElement('article');
    article.className = 'message ' + type;
    const author = document.createElement('div');
    author.className = 'author';
    author.textContent = authors[type] || authors.system;
    const body = document.createElement('div');
    body.className = 'message-body';
    body.textContent = text;
    article.append(author, body);
    elements.emptyState.hidden = true;
    elements.messages.append(article);
    scrollToLatest();
    return body;
}

function scrollToLatest() {
    elements.messages.scrollTop = elements.messages.scrollHeight;
}

function openImageViewer(data, origin) {
    viewerOrigin = origin;
    elements.fullImage.src = data;
    elements.imageViewer.hidden = false;
    elements.closeImageViewer.focus();
}

function closeImageViewer() {
    if (elements.imageViewer.hidden) return;
    elements.imageViewer.hidden = true;
    elements.fullImage.removeAttribute('src');
    if (viewerOrigin?.isConnected) viewerOrigin.focus();
    viewerOrigin = null;
}

function makeImageTile(data, index, remove = null) {
    const tile = document.createElement('div');
    tile.className = 'image-tile';
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'image-preview';
    preview.setAttribute('aria-label', 'View image ' + (index + 1));
    const image = document.createElement('img');
    image.alt = '';
    image.src = data;
    preview.append(image);
    preview.onclick = () => openImageViewer(data, preview);
    tile.append(preview);
    if (remove) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'remove-image';
        button.setAttribute('aria-label', 'Remove image ' + (index + 1));
        button.textContent = '\u00d7';
        button.disabled = messageSending;
        button.onclick = remove;
        tile.append(button);
    }
    return tile;
}

function showMessageImages(body, images) {
    if (!images.length || !body.isConnected) return;
    const grid = document.createElement('div');
    grid.className = 'image-grid message-images';
    images.forEach((data, index) => grid.append(makeImageTile(data, index)));
    body.before(grid);
    scrollToLatest();
}

function appendUserMessage(type, text, images = []) {
    const body = addMessage(type, text);
    showMessageImages(body, images.map(image => image.preview));
    for (const image of images) {
        chatImageStore.put(image.id, image.preview).catch(() => showError('An image could not be saved in local history.'));
    }
    history.push({ kind: 'message', type, text, imageIds: images.map(image => image.id) });
    saveHistory();
}

function appendMarkdown(body, text) {
    if (!text.trim()) return;
    try {
        const template = document.createElement('template');
        template.innerHTML = window.markdown.toHTML(text);
        const tags = new Set(['P', 'BR', 'STRONG', 'EM', 'CODE', 'PRE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'HR']);
        for (const element of template.content.querySelectorAll('*')) {
            if (tags.has(element.tagName)) {
                for (const name of element.getAttributeNames()) element.removeAttribute(name);
            } else {
                element.replaceWith(document.createTextNode(element.textContent));
            }
        }
        body.append(template.content);
    } catch {
        const paragraph = document.createElement('p');
        paragraph.textContent = text;
        body.append(paragraph);
    }
}

function appendCode(body, language, text) {
    const block = document.createElement('div');
    block.className = 'code';
    const header = document.createElement('header');
    const label = document.createElement('span');
    label.textContent = language;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
        try {
            if (await api.copyToClipboard(text)) copy.textContent = 'Copied';
        } catch {
            showError('Could not copy the code.');
        }
    });
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (/^[\w-]+$/.test(language)) code.className = 'language-' + language.toLowerCase();
    code.textContent = text;
    header.append(label, copy);
    pre.append(code);
    block.append(header, pre);
    body.append(block);
    window.Prism?.highlightElement(code);
}

function renderAnswer(body, text) {
    body.replaceChildren();
    body.classList.add('rendered');
    let start = 0;
    for (const match of text.matchAll(/(```|~~~)([^\n]*)\n([\s\S]*?)\1/g)) {
        appendMarkdown(body, text.slice(start, match.index));
        appendCode(body, match[2].trim().split(/\s+/)[0] || 'text', match[3]);
        start = match.index + match[0].length;
    }
    appendMarkdown(body, text.slice(start));
    window.renderMathInElement?.(body);
}

function loadHistory() {
    try {
        const saved = JSON.parse(localStorage.getItem(historyKey) || '[]');
        if (!Array.isArray(saved)) return;
        history = saved.filter(item => item && (item.kind === 'message' || item.kind === 'snippet'));
        for (const item of history) {
            if (item.kind === 'snippet' && typeof item.code === 'string') {
                appendCode(addMessage('assistant'), item.language || 'text', item.code);
            } else if (typeof item.text === 'string') {
                const body = addMessage(Object.hasOwn(authors, item.type) ? item.type : 'system', item.text);
                if (item.type === 'assistant') renderAnswer(body, item.text);
                if (Array.isArray(item.imageIds) && item.imageIds.length) {
                    Promise.all(item.imageIds.map(id => chatImageStore.get(id)))
                        .then(images => showMessageImages(body, images.filter(Boolean))).catch(() => {});
                }
            }
        }
        scrollToLatest();
    } catch {
        showError('Could not load saved chat history.');
    }
}

function showError(message) {
    elements.chatError.textContent = message || 'Something went wrong.';
    elements.chatError.hidden = false;
}

function setRecording(active) {
    recording = active;
    elements.micStatus.textContent = active ? 'Listening' : 'Mic off';
    elements.micIcon.className = active ? 'fas fa-microphone' : 'fas fa-microphone-slash';
    elements.mic.setAttribute('aria-label', active ? 'Turn microphone off' : 'Turn microphone on');
    elements.mic.setAttribute('aria-pressed', String(active));
    if (!active) elements.interim.hidden = true;
    syncControls();
}

function syncControls() {
    elements.mic.disabled = !sessionActive || !speechAvailable || speechBusy;
    elements.draft.disabled = !sessionActive;
    elements.capture.disabled = !sessionActive;
    elements.send.disabled = !sessionActive || messageSending;
    elements.voiceModel.disabled = recording;
    syncInlinePickerLabel(elements.voiceModel);
    elements.session.setAttribute('aria-label', sessionActive ? 'Stop session' : 'Start session');
    elements.sessionIcon.className = sessionActive ? 'fas fa-stop' : 'fas fa-play';
    const selectedVoice = modelState?.selectedVoice || '';
    const cloudVoice = /^(azure$|groq:|gemini:)/.test(selectedVoice);
    elements.sessionNote.textContent = !sessionActive
        ? 'Session stopped. Start it to send messages or use the mic.'
        : cloudVoice ? 'Mic audio goes to the voice provider. Transcripts go to the answer model.'
            : 'Transcripts go to the selected answer model when the mic is on.';
    if (!speechAvailable) elements.micStatus.textContent = 'Mic unavailable';
}

function updateModelOptions(select, options, value) {
    const open = !select.hidden;
    select.replaceChildren(...options.map(model => {
        const option = new Option(model.label, model.id);
        option.disabled = model.configured === false;
        return option;
    }));
    setInlinePickerValue(select, value);
    if (open) select.size = Math.max(2, Math.min(6, select.options.length));
}

function updatePanel(state) {
    if (!state) return;
    modelState = state;
    if (sessionActive && !state.active) {
        resetAttachment();
        for (const response of pendingResponses.values()) {
            response.body.textContent = response.text ? response.text + '\n\nSession stopped.' : 'Session stopped.';
        }
        pendingResponses.clear();
    }
    sessionActive = state.active;
    speechAvailable = state.speechAvailable;
    const answer = state.chat.find(option => option.id === state.selectedChat);
    updateModelOptions(elements.answerProvider, state.chat, state.selectedChat);
    updateModelOptions(elements.answerModel,
        (answer?.models || []).map(id => ({ id, label: id, configured: answer.configured })), state.selectedChatModel);
    updateModelOptions(elements.voiceModel, state.voice, state.selectedVoice);
    setRecording(state.recording);
    updateScreenshotNotice();
}

function updateScreenshotNotice() {
    const selected = modelState?.chat.find(model => model.id === modelState.selectedChat);
    elements.screenshotNotice.textContent = selected?.id === 'ollama'
        ? 'Images go to your local Ollama model.'
        : 'Images will be sent to ' + (selected?.label || 'the selected provider') + '.';
}

async function setCollapsed(value) {
    if (collapsed === value) return;
    const result = await api.collapsePanel(value);
    if (!result?.success) throw new Error('Could not resize the panel.');
    collapsed = value;
    elements.panelBody.hidden = value;
    elements.closeChat.setAttribute('aria-expanded', String(!value));
    elements.hideLabel.textContent = value ? 'Show' : 'Hide';
    elements.hideIcon.className = value ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
}

function renderDraftImages() {
    elements.draftImages.replaceChildren();
    [...attachments.values()].forEach(({ id, preview }, index) => {
        const remove = async () => {
            try {
                const result = await api.discardChatImage(id);
                if (!result?.success) return;
                attachments.delete(id);
                closeImageViewer();
                renderDraftImages();
            } catch {
                showError('Could not remove the image.');
            }
        };
        elements.draftImages.append(makeImageTile(preview, index, remove));
    });
    elements.attachment.hidden = !attachments.size;
}

function resetAttachment() {
    attachments.clear();
    renderDraftImages();
}

function clearConversation() {
    history = [];
    saveHistory();
    chatImageStore.clear().catch(() => showError('Could not clear locally stored images.'));
    pendingResponses.clear();
    elements.messages.querySelectorAll('article').forEach(article => article.remove());
    elements.emptyState.hidden = false;
    elements.clearPrompt.hidden = true;
    elements.clearHistory.setAttribute('aria-expanded', 'false');
    elements.interim.hidden = true;
    closeImageViewer();
    resetAttachment();
}

async function captureScreenshot() {
    elements.chatError.hidden = true;
    elements.capture.disabled = true;
    try {
        await api.takeScreenshot();
    } catch {
        showError('Could not capture the screenshot.');
    } finally {
        elements.capture.disabled = !sessionActive;
    }
}

async function attachFiles(files) {
    if (!sessionActive || messageSending) return;
    elements.chatError.hidden = true;
    for (const file of files) {
        if (!['image/png', 'image/jpeg'].includes(file.type)) {
            showError('Paste or drop PNG and JPEG images.');
            continue;
        }
        if (attachments.size >= 8) {
            showError('Attach up to eight images per message.');
            return;
        }
        if (file.size > 12 * 1024 * 1024) {
            showError('Choose images under 12 MB each.');
            continue;
        }
        try {
            const result = await api.attachChatImage(new Uint8Array(await file.arrayBuffer()));
            if (!result?.success) showError(result?.error || 'Could not attach the image.');
        } catch {
            showError('Could not attach the image.');
        }
    }
}

elements.capture.addEventListener('click', captureScreenshot);
elements.compose.addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    void attachFiles(files);
});
document.addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
});
document.addEventListener('drop', event => {
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    void attachFiles(files);
});
elements.closeImageViewer.addEventListener('click', closeImageViewer);
elements.imageViewer.addEventListener('click', event => {
    if (event.target === elements.imageViewer) closeImageViewer();
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !elements.imageViewer.hidden) closeImageViewer();
});
elements.closeChat.addEventListener('click', async () => {
    elements.closeChat.disabled = true;
    try {
        await setCollapsed(!collapsed);
    } catch (error) {
        showError(error.message);
    } finally {
        elements.closeChat.disabled = false;
    }
});
elements.session.addEventListener('click', async () => {
    elements.session.disabled = true;
    try {
        await api.setPanelSession(!sessionActive);
    } catch {
        showError('Could not change the session state.');
    } finally {
        elements.session.disabled = false;
    }
});
elements.settings.addEventListener('click', () => api.showSettings().catch(() => showError('Could not open Settings.')));
for (const [kind, select] of [
    ['provider', elements.answerProvider], ['model', elements.answerModel], ['voice', elements.voiceModel]
]) {
    select.addEventListener('change', async () => {
        select.disabled = true;
        try {
            const result = kind === 'voice' ? await api.selectPanelModel('voice', select.value)
                : await api.selectPanelModel('chat', elements.answerProvider.value, kind === 'model' ? select.value : undefined);
            if (!result?.success) throw new Error(result?.error || 'Could not switch models.');
            elements.chatError.hidden = true;
        } catch (error) {
            showError(error.message);
        } finally {
            select.disabled = false;
            updatePanel(await api.getPanelState().catch(() => modelState));
        }
    });
}
elements.clearHistory.addEventListener('click', () => {
    elements.clearPrompt.hidden = false;
    elements.clearHistory.setAttribute('aria-expanded', 'true');
    elements.cancelClear.focus();
});
elements.cancelClear.addEventListener('click', () => {
    elements.clearPrompt.hidden = true;
    elements.clearHistory.setAttribute('aria-expanded', 'false');
    elements.clearHistory.focus();
});
elements.confirmClear.addEventListener('click', async () => {
    elements.confirmClear.disabled = true;
    try {
        await api.clearSessionMemory();
        elements.draft.focus();
    } catch {
        showError('Could not clear the conversation.');
    } finally {
        elements.confirmClear.disabled = false;
    }
});
elements.clearPrompt.addEventListener('keydown', event => {
    if (event.key === 'Escape') elements.cancelClear.click();
});
elements.mic.addEventListener('click', async () => {
    speechBusy = true;
    syncControls();
    try {
        const status = await (recording ? api.stopSpeechRecognition() : api.startSpeechRecognition());
        if (status) setRecording(Boolean(status.isRecording));
    } catch {
        showError('Could not change the microphone state.');
    } finally {
        speechBusy = false;
        syncControls();
    }
});
elements.compose.addEventListener('submit', async event => {
    event.preventDefault();
    const text = elements.draft.value.trim();
    const imageIds = [...attachments.keys()];
    if ((!text && !imageIds.length) || elements.send.disabled) return;
    messageSending = true;
    syncControls();
    renderDraftImages();
    elements.chatError.hidden = true;
    try {
        const result = await api.sendChatMessage(text, imageIds);
        if (!result?.success) showError('Could not send the message. Check the image attachments and try again.');
        else {
            elements.draft.value = '';
            for (const id of imageIds) attachments.delete(id);
        }
    } catch {
        showError('Could not send the message.');
    } finally {
        messageSending = false;
        syncControls();
        renderDraftImages();
    }
});
elements.draft.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        elements.compose.requestSubmit();
    }
});

api.onSessionCleared(clearConversation);
api.onPanelState(updatePanel);
api.onRecordingStarted((_event, data) => {
    if (!sessionActive) return;
    setRecording(true);
    panelAudio.start(data?.provider);
});
api.onRecordingStopped(() => {
    panelAudio.stop();
    setRecording(false);
});
api.onSpeechError(() => {
    panelAudio.stop();
    setRecording(false);
    showError('Speech recognition failed. Check your microphone and speech settings.');
});
api.onSpeechAvailability((_event, data) => {
    speechAvailable = Boolean(data?.available);
    setRecording(recording);
});
api.getPanelState().then(updatePanel).catch(() => showError('Could not load provider settings.'));
api.onInterimTranscription((_event, data) => {
    elements.interim.textContent = data?.text || '';
    elements.interim.hidden = !recording || !data?.text;
});
api.onChatScreenshotReady(({ id, preview }) => {
    attachments.set(id, { id, preview });
    renderDraftImages();
    setCollapsed(false).catch(error => showError(error.message));
});
api.onChatUserMessage(({ type, text, images }) => {
    elements.interim.hidden = true;
    appendUserMessage(type, text, images);
});
api.onTranscriptionLlmResponseStart((_event, { messageId }) => {
    pendingResponses.set(messageId, { body: addMessage('assistant', 'Thinking...'), text: '' });
});
api.onTranscriptionLlmResponseChunk((_event, { messageId, delta }) => {
    const response = pendingResponses.get(messageId);
    if (!response) return;
    response.text += delta;
    response.body.textContent = response.text;
    scrollToLatest();
});
api.onTranscriptionLlmResponse((_event, { messageId, response }) => {
    const pending = pendingResponses.get(messageId);
    if (!pending) return;
    pendingResponses.delete(messageId);
    renderAnswer(pending.body, response);
    history.push({ kind: 'message', type: 'assistant', text: response });
    saveHistory();
    scrollToLatest();
});
api.onChatRequestError(({ messageId, error }) => {
    const pending = pendingResponses.get(messageId);
    if (pending) {
        pending.body.textContent = pending.text ? pending.text + '\n\nResponse interrupted.' : 'Response unavailable.';
        pendingResponses.delete(messageId);
    }
    showError(error);
});

if (window.Prism?.plugins?.autoloader) {
    window.Prism.plugins.autoloader.languages_path = './node_modules/prismjs/components/';
}
loadHistory();
})();
