'use strict';

const { providerRequest, connectionDetail } = require('./provider-request');

const providers = {
    gemini: { label: 'Gemini', key: 'GEMINI_API_KEY', models: 'GEMINI_MODEL', defaults: ['gemini-3.1-flash-lite'] },
    openrouter: { label: 'OpenRouter Free', key: 'OPENROUTER_API_KEY', defaults: ['openrouter/free'], url: 'https://openrouter.ai/api/v1/chat/completions' },
    groq: { label: 'Groq', key: 'GROQ_API_KEY', models: 'GROQ_MODELS', defaults: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'], url: 'https://api.groq.com/openai/v1/chat/completions' },
    ollama: { label: 'Ollama', models: 'OLLAMA_MODEL', defaults: [], url: 'http://127.0.0.1:11434/api/chat' },
    openai: { label: 'OpenAI (ChatGPT)', key: 'OPENAI_API_KEY', models: 'OPENAI_MODELS', defaults: ['gpt-4.1-mini', 'gpt-4o-mini'], url: 'https://api.openai.com/v1/chat/completions' },
    claude: { label: 'Claude', key: 'ANTHROPIC_API_KEY', models: 'CLAUDE_MODELS', defaults: ['claude-haiku-5-5', 'claude-sonnet-5-5'], url: 'https://api.anthropic.com/v1/messages' }
};
const geminiBase = 'https://generativelanguage.googleapis.com/v1beta/models/';
const whisperModels = ['tiny', 'base', 'small', 'medium', 'large', 'turbo'];
const generalPrompt = 'You are a helpful conversational assistant. Respond naturally to greetings and answer the user’s actual question. Use a programming language or give code only when relevant. For an attached screenshot, answer the user’s question or briefly describe the relevant content if they wrote nothing.';

function hasKey(value) {
    return Boolean(value?.trim()) && !/^your[_-]/i.test(value);
}

const catalogs = new Map();

function configuredModels(id, config, env) {
    const configured = config.models && env[config.models];
    const manual = configured ? configured.split(/[\s,]+/).filter(Boolean) : [];
    const catalog = catalogs.get(id);
    const fetched = catalog && catalog.key === (config.key ? env[config.key] : '') ? catalog.models : undefined;
    const models = [...manual, ...(id === 'openrouter' ? config.defaults : []), ...(fetched || (manual.length ? [] : config.defaults))];
    return [...new Set(models)].filter(model => id !== 'ollama' || !/(?:-cloud|:cloud)$/i.test(model));
}

function readCatalogPage(id, data) {
    if (id === 'gemini') return (data.models || [])
        .filter(model => model.supportedGenerationMethods?.includes('generateContent') &&
            !/(?:embedding|tts|image-generation|imagen|native-audio|realtime|robotics)/i.test(model.name))
        .map(model => model.name.replace(/^models\//, ''));
    if (id === 'ollama') return (data.models || []).filter(model => !model.remote_host &&
        !/(?:embed|(?:-cloud|:cloud)$)/i.test(model.name)).map(model => model.name);
    if (id === 'openrouter') return (data.data || [])
        .filter(model => model.id?.endsWith(':free') && model.architecture?.input_modalities?.includes('text') &&
            model.architecture?.output_modalities?.includes('text') && Number(model.pricing?.prompt) === 0 &&
            Number(model.pricing?.completion) === 0)
        .map(model => model.id);
    return (data.data || []).filter(model => model.active !== false && model.lifecycle !== 'retired' &&
        !/(?:whisper|orpheus|moderation|embed|realtime|transcrib|image-gen|(?:^|[-/])tts|audio-preview|safeguard|prompt-guard|rerank|dall-e|(?:^|-)codex)/i.test(model.id) &&
        (id !== 'openai' || /^(?:gpt-|o[1-9](?:-|$)|ft:gpt-)/i.test(model.id)))
        .map(model => model.id);
}

const modelListUrls = {
    gemini: geminiBase.slice(0, -1) + '?pageSize=1000',
    ollama: 'http://127.0.0.1:11434/api/tags',
    openrouter: 'https://openrouter.ai/api/v1/models',
    groq: 'https://api.groq.com/openai/v1/models',
    openai: 'https://api.openai.com/v1/models',
    claude: 'https://api.anthropic.com/v1/models?limit=100'
};

async function fetchProviderModels() {
    return Promise.all(Object.entries(providers).map(async ([id, config]) => {
        const key = config.key ? process.env[config.key] : '';
        if (config.key && !hasKey(key)) return { id, status: 'unconfigured' };
        const cached = catalogs.get(id);
        if (cached?.key === key && cached.pending) return cached.pending;
        const headers = id === 'gemini' ? { 'x-goog-api-key': key } :
            id === 'claude' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } :
                key ? { Authorization: 'Bearer ' + key } : {};
        const entry = { key, models: cached?.key === key ? cached.models : undefined };
        entry.pending = (async () => {
            try {
                const models = new Set();
                const url = new URL(modelListUrls[id]);
                const signal = AbortSignal.timeout(12000);
                for (let page = 0; page < 10; page++) {
                    const response = await providerRequest(url, { headers, redirect: 'error', signal });
                    if (!response.ok) throw new Error('HTTP ' + response.status);
                    const data = await response.json();
                    for (const model of readCatalogPage(id, data)) if (typeof model === 'string') models.add(model);
                    if (id === 'gemini' && data.nextPageToken) url.searchParams.set('pageToken', data.nextPageToken);
                    else if (id === 'claude' && data.has_more && data.last_id) url.searchParams.set('after_id', data.last_id);
                    else break;
                }
                entry.models = [...models];
                return { id, status: 'ready', count: models.size };
            } catch (error) {
                const reason = error.cause?.code || error.code || error.message;
                return { id, status: 'unavailable', reason };
            } finally {
                entry.pending = null;
            }
        })();
        catalogs.set(id, entry);
        return entry.pending;
    }));
}

function getPanelModels(env = process.env) {
    const chat = Object.entries(providers).map(([id, config]) => {
        const models = configuredModels(id, config, env);
        return { id, label: config.label, models, configured: models.length > 0 && (!config.key || hasKey(env[config.key])) };
    });
    const defaults = [...new Set([...whisperModels, env.WHISPER_MODEL].filter(Boolean))];
    const voice = defaults.map(model => ({ id: 'whisper:' + model, label: 'Whisper · ' + model }));
    if (hasKey(env.GROQ_API_KEY)) {
        for (const model of ['whisper-large-v3-turbo', 'whisper-large-v3']) voice.push({ id: 'groq:' + model, label: 'Groq · ' + model });
    }
    if (hasKey(env.GEMINI_API_KEY)) {
        const model = env.GEMINI_VOICE_MODEL || 'gemini-3.1-flash-lite';
        voice.push({ id: 'gemini:' + model, label: 'Gemini · ' + model });
    }
    if (env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION) voice.push({ id: 'azure', label: 'Azure Speech' });

    const selectedChat = chat.find(model => model.id === env.CHAT_PROVIDER && model.configured)
        || chat.find(model => model.configured) || chat[0];
    const selectedChatModel = selectedChat.models.includes(env.CHAT_MODEL) ? env.CHAT_MODEL : selectedChat.models[0];
    const voiceByProvider = {
        azure: 'azure',
        groq: 'groq:' + (env.GROQ_VOICE_MODEL || 'whisper-large-v3-turbo'),
        gemini: 'gemini:' + (env.GEMINI_VOICE_MODEL || 'gemini-3.1-flash-lite')
    };
    const candidate = voiceByProvider[env.SPEECH_PROVIDER];
    const selectedVoice = voice.some(model => model.id === candidate) ? candidate : 'whisper:' + (env.WHISPER_MODEL || 'small');
    return { chat, voice, selectedChat: selectedChat.id, selectedChatModel, selectedVoice };
}

function buildRequest(provider, model, text, images, history) {
    const config = providers[provider];
    const headers = { 'Content-Type': 'application/json' };
    const key = config.key && process.env[config.key];
    const messages = history.filter(item => ['user', 'assistant', 'model'].includes(item.role) && typeof item.content === 'string' && item.content.trim())
        .map(item => ({ role: item.role === 'model' ? 'assistant' : item.role, content: item.content }));
    const question = text || 'Review the attached images.';
    const media = images.map(image => ({ data: image.imageBuffer.toString('base64'), mime: image.mimeType }));
    if (provider === 'gemini') {
        headers['x-goog-api-key'] = key;
        const contents = messages.map(item => ({ role: item.role === 'assistant' ? 'model' : 'user', parts: [{ text: item.content }] }));
        contents.push({ role: 'user', parts: [{ text: question }, ...media.map(({ data, mime }) => ({ inlineData: { data, mimeType: mime } }))] });
        return {
            headers, url: geminiBase + encodeURIComponent(model) + ':streamGenerateContent?alt=sse',
            body: { systemInstruction: { parts: [{ text: generalPrompt }] }, contents }
        };
    }
    const input = { role: 'user', content: question };
    if (provider === 'claude') {
        headers['x-api-key'] = key;
        headers['anthropic-version'] = '2023-06-01';
        if (media.length) input.content = [
            ...media.map(({ data, mime }) => ({ type: 'image', source: { type: 'base64', media_type: mime, data } })),
            { type: 'text', text: question }
        ];
        messages.push(input);
        return { headers, url: config.url, body: { model, messages, system: generalPrompt, stream: true, max_tokens: 4096 } };
    }
    if (key) headers.Authorization = 'Bearer ' + key;
    if (media.length && provider === 'ollama') input.images = media.map(item => item.data);
    else if (media.length) input.content = [
        { type: 'text', text: question },
        ...media.map(({ data, mime }) => ({ type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + data } }))
    ];
    messages.unshift({ role: 'system', content: generalPrompt });
    messages.push(input);
    return { headers, url: config.url, body: { model, messages, stream: true } };
}

async function streamChat({ provider, model, text, images = [], history, onDelta, signal }) {
    const option = getPanelModels().chat.find(item => item.id === provider);
    if (!option?.configured || !option.models.includes(model)) throw new Error('Configure an answer model in Settings.');
    const { label } = option;
    const { url, headers, body } = buildRequest(provider, model, text, images, history);
    const local = provider === 'ollama';
    let result;
    try {
        result = await providerRequest(url, {
            method: 'POST', headers, redirect: 'error',
            body: JSON.stringify(body),
            signal: AbortSignal.any([signal, AbortSignal.timeout(120000)])
        });
    } catch (error) {
        if (signal.aborted) throw error;
        throw new Error((local ? 'Could not reach local Ollama. ' : 'Could not connect to ' + label + '. ') + connectionDetail(error));
    }
    if (!result.ok) {
        if (result.status === 429) throw new Error(label + ' rate limit reached. Try again or select another model.');
        if (local && result.status === 404) throw new Error('Ollama could not find this model. Install it locally or update Settings.');
        if (images.length && [400, 413, 422].includes(result.status)) throw new Error('The provider rejected the images. Try fewer images or an image-capable model.');
        throw new Error(label + ' returned HTTP ' + result.status + '. Check the model ID and credentials in Settings.');
    }

    let answer = '';
    let finished = false;
    function readLine(line) {
        line = line.trim();
        if (!local) {
            if (!line.startsWith('data:')) return;
            line = line.slice(5).trim();
            if (line === '[DONE]') { finished = true; return; }
        }
        if (!line) return;
        const event = JSON.parse(line);
        if (event.error || event.type === 'error') throw new Error(label + ' could not finish the response.');
        let delta;
        if (local) {
            delta = event.message?.content;
            finished ||= Boolean(event.done);
        } else if (provider === 'claude') {
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') delta = event.delta.text;
            finished ||= event.type === 'message_stop';
        } else if (provider === 'gemini') {
            const choice = event.candidates?.[0];
            delta = choice?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('');
            finished ||= ['STOP', 'MAX_TOKENS'].includes(choice?.finishReason);
        } else {
            delta = event.choices?.[0]?.delta?.content;
        }
        if (typeof delta === 'string' && delta) {
            answer += delta;
            onDelta(delta);
        }
    }

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of result.body) {
        buffer += decoder.decode(bytes, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) readLine(line);
    }
    readLine(buffer + decoder.decode());
    if (!finished || !answer.trim()) throw new Error(label + ' did not return a complete answer.');
    return { response: answer.trim() };
}

async function transcribeCloud(provider, wav, signal = undefined) {
    const isGroq = provider === 'groq';
    const key = process.env[isGroq ? 'GROQ_API_KEY' : 'GEMINI_API_KEY'];
    if (!hasKey(key)) throw new Error('Add the speech provider API key in Settings.');
    const model = isGroq ? process.env.GROQ_VOICE_MODEL || 'whisper-large-v3-turbo'
        : process.env.GEMINI_VOICE_MODEL || 'gemini-3.1-flash-lite';
    let url;
    let headers;
    let body;
    if (isGroq) {
        url = 'https://api.groq.com/openai/v1/audio/transcriptions';
        headers = { Authorization: 'Bearer ' + key };
        body = new FormData();
        body.set('model', model);
        body.set('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
    } else {
        url = geminiBase + encodeURIComponent(model) + ':generateContent';
        headers = { 'x-goog-api-key': key, 'Content-Type': 'application/json' };
        body = JSON.stringify({ contents: [{ role: 'user', parts: [
            { text: 'Transcribe the spoken words verbatim. Return only the transcript in the spoken language. If no one speaks, return <silence>.' },
            { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
        ] }] });
    }
    const timeout = AbortSignal.timeout(45000);
    const result = await providerRequest(url, { method: 'POST', headers, body, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!result.ok) throw new Error(providers[provider].label + ' speech returned HTTP ' + result.status + '. Check its key, quota, and model in Settings.');
    const payload = await result.json();
    const text = isGroq ? payload.text : payload.candidates?.[0]?.content?.parts?.filter(part => !part.thought).map(part => part.text || '').join('');
    return typeof text === 'string' && text.trim().toLowerCase() !== '<silence>' ? text.trim() : '';
}

module.exports = { getPanelModels, streamChat, transcribeCloud, hasKey, fetchProviderModels };
