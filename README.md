# OpenCluely

OpenCluely is a Windows desktop AI assistant with a draggable, translucent chat panel. Ask a question, attach screenshots or images, or turn on the microphone to add live speech to the conversation. Use it for coding practice, technical problem solving, and conversations where AI assistance is permitted.

## Download for Windows x64

| Download | When to use it |
| --- | --- |
| [Windows installer](https://github.com/ankur0x/OpenCluely/releases/download/verified-v1.0.5/OpenCluely-Setup-1.0.5.exe) | Install OpenCluely and add a Start menu shortcut. |
| [Portable EXE](https://github.com/ankur0x/OpenCluely/releases/download/verified-v1.0.5/OpenCluely-Portable-1.0.5-x64.exe) | Run OpenCluely directly without an installer. |
| [SHA-256 checksums](https://github.com/ankur0x/OpenCluely/releases/download/verified-v1.0.5/SHA256SUMS.txt) | Verify the downloaded file. |

[Release notes](https://github.com/ankur0x/OpenCluely/releases/tag/verified-v1.0.5). Both Windows executables are unsigned.

## Getting started

1. Launch OpenCluely and open **Settings** to add an API key or connect to an Ollama instance running on your computer.
2. Pick an answer provider and model ID in the panel. Model lists refresh at startup and after saving a key. **Refresh model lists** in Settings checks again on demand.
3. Type a question or attach up to eight PNG or JPEG images. Paste or drop image files, or press **Ctrl+Shift+S** to add a screenshot of the current display. Remove draft images with their **×** buttons and click sent thumbnails to enlarge them.
4. Choose a transcription provider if you want to use the microphone. Finalized speech appears in chat and is sent automatically to the selected answer model. **Hide** collapses the panel to its draggable toolbar. **Stop Session** stops recording and cancels active replies.

## Providers

| Use | Options |
| --- | --- |
| AI answers | Gemini, Groq, OpenAI, Claude, OpenRouter Free, and local Ollama |
| Speech to text | Local Whisper, Groq, Gemini, and Azure Speech |

Choose an image-capable answer model for screenshots and image attachments. OpenRouter lists free variants. Other cloud providers apply their own quotas or charges.

## Privacy and storage

Chat history and image attachments are stored locally. **Clear history** removes saved messages and images and resets the model's conversation context. A cloud answer provider receives the messages and images used in the request. A cloud transcription provider also receives microphone audio while recording. Use Ollama and local Whisper for on-device processing.

OpenCluely uses Electron's Windows capture protection for compatible capture paths. Test the receiving view with your screen-sharing or screenshot tool before relying on it.

## Run from source

With Git and Node.js 20 or newer installed, open PowerShell and run:

```powershell
git clone https://github.com/ankur0x/OpenCluely.git
cd OpenCluely
npm.cmd ci
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
.\node_modules\.bin\electron.cmd .
```

The application uses Electron, with its provider integrations in the main process and a separate renderer for the floating panel and Settings.

## Attribution

Based on [TechyCSR/OpenCluely](https://github.com/TechyCSR/OpenCluely). See [LICENSE](LICENSE) for the Apache 2.0 license included with this project.
