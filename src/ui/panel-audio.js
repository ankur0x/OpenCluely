'use strict';

function createPanelAudio(api, onError) {
    let generation = 0;
    let microphone;
    let context;
    let processor;

    function stop() {
        generation++;
        if (processor) {
            processor.onaudioprocess = null;
            processor.disconnect();
            processor = null;
        }
        microphone?.getTracks().forEach(track => track.stop());
        microphone = null;
        context?.close().catch(() => {});
        context = null;
    }

    async function start(provider) {
        const platform = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
        if (!['whisper', 'groq', 'gemini'].includes(provider) || !(platform.includes('win') || platform.includes('mac'))) return;
        stop();
        const capture = generation;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: { ideal: 16000 } }
            });
            if (capture !== generation) {
                stream.getTracks().forEach(track => track.stop());
                return;
            }
            microphone = stream;
            context = new AudioContext({ sampleRate: 16000 });
            const source = context.createMediaStreamSource(stream);
            processor = context.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = event => {
                if (capture !== generation) return;
                const samples = event.inputBuffer.getChannelData(0);
                const pcm = new Int16Array(samples.length);
                for (let index = 0; index < samples.length; index++) {
                    const value = Math.max(-1, Math.min(1, samples[index]));
                    pcm[index] = value * (value < 0 ? 32768 : 32767);
                }
                api.sendAudioChunk(pcm.buffer);
            };
            source.connect(processor);
            processor.connect(context.destination);
            await context.resume();
        } catch {
            if (capture !== generation) return;
            stop();
            await api.stopSpeechRecognition().catch(() => {});
            onError('Could not open the microphone. Check Windows microphone permissions.');
        }
    }

    window.addEventListener('pagehide', stop);
    return { start, stop };
}
