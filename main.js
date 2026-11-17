const path = require("path");
const { randomUUID } = require("crypto");
const { getPanelModels, streamChat, fetchProviderModels } = require("./src/services/panel-models");
const fs = require("fs");
const { fileURLToPath } = require("url");
const { app, BrowserWindow, globalShortcut, session, ipcMain, screen, nativeImage } = require("electron");

// ── Resolve a stable .env location ──
// In packaged builds process.cwd() is unstable and frequently read-only
// (NSIS install dir, AppImage mount, .app bundle), so the canonical config
// lives in Electron's userData directory. We still prefer an existing
// project-local .env in development (npm start) so the dev workflow is
// unchanged. Both onboarding (FirstRunManager) and persistEnvUpdates() write
// to this same path so settings survive restarts on every platform.
function resolveEnvPath() {
  try {
    const userDataEnv = path.join(app.getPath("userData"), ".env");
    const projectEnv = path.join(process.cwd(), ".env");
    // Prefer a project .env only when it already exists and userData has none
    // (i.e. a developer running from the repo). Otherwise use userData.
    if (!fs.existsSync(userDataEnv) && fs.existsSync(projectEnv)) {
      return projectEnv;
    }
    return userDataEnv;
  } catch (_) {
    // On packaged macOS builds, process.cwd() may be inside a read-only .app
    // bundle. Fall back to userData so .env writes never fail.
    try {
      return path.join(app.getPath("userData"), ".env");
    } catch (e2) {
      return path.join(process.cwd(), ".env");
    }
  }
}
const ENV_PATH = resolveEnvPath();
require("dotenv").config({ path: ENV_PATH });

// Format a value for a single .env line. Newlines are collapsed to spaces and
// backslashes are kept verbatim (doubling them corrupts Windows paths on the
// next load). Values containing whitespace, a double-quote, or a leading '#'
// are wrapped in single quotes so dotenv parses them as one token — essential
// for Whisper commands like:  "C:\Users\Jane Doe\...\python.exe" -m whisper
function formatEnvValue(raw) {
  const v = String(raw).replace(/[\r\n]+/g, " ").trim();
  if (!/[\s"#]/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  // Rare: value already contains a single quote — fall back to double quotes.
  return `"${v.replace(/"/g, '\\"')}"`;
}

// ── Linux GPU process crash workaround ──
// On many Linux setups (Wayland, X11 without GPU drivers, Docker, headless,
// or systems with broken Mesa/NVIDIA stacks), Chromium's GPU process crashes
// on startup with:
//   FATAL:gpu_data_manager_impl_private.cc(448)] GPU process isn't usable.
// This kills the entire app and can leave orphan helper processes that
// exhaust the X11 client limit, producing "Maximum number of clients reached".
//
// Disabling hardware acceleration and the GPU subprocess forces Chromium to
// render via the CPU (SwiftShader). OpenCluely's UI is light enough that
// this is imperceptible, and it eliminates the GPU crash entirely.
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  // On X11 only; harmless on Wayland. Prevents Chromium from spawning a
  // compositor process that adds another X11 client.
  app.commandLine.appendSwitch("in-process-gpu");
}

// Keep Chromium network noise out of the terminal; app-level logs still go through Winston.
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("no-pings");

const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");
const FirstRunManager = require("./src/core/first-run");

// ── Global crash guard ──
// The speech path spawns external processes (Whisper CLI, and on macOS/Linux
// the sox/rec/arecord recorders via node-record-lpcm16). A missing recorder
// binary makes that library emit an 'error' on its child process with no
// listener, which would otherwise become an uncaughtException and quit the
// entire app the moment the user clicks the mic. We log and stay alive — the
// speech service surfaces a friendly status to the UI instead.
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception (kept alive)", {
    error: err && err.message,
    stack: err && err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection (kept alive)", {
    reason: String((reason && reason.message) || reason),
  });
});

// Services
// Screen capture (image-based)
const captureService = require("./src/services/capture.service");
const speechService = require("./src/services/speech.service");
const llmService = require("./src/services/llm.service");

// Managers
const windowManager = require("./src/managers/window.manager");
const sessionManager = require("./src/managers/session.manager");

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.starting = false;
    this.activeSkill = "dsa";
  // Default to C++ so language is enforced from first run
  this.codingLanguage = "cpp";
    this.speechAvailable = false;

    // Utterance coalescing: VAD emits a transcript per natural pause, but a
    // single spoken question can still arrive as a few fragments (mid-thought
    // pauses). We buffer fragments and debounce so one question yields one LLM
    // call instead of several slow, half-answered ones.
    this._utteranceBuffer = "";
    this.chatGeneration = 0;
    this.panelSessionActive = true;
    this.discardStoppedSpeech = false;
    this.chatRequests = new Set();
    this.pendingImages = new Map();
    this._utteranceTimer = null;
    this._utteranceDispatchInFlight = false;
    this._utteranceCoalesceMs = 800;

    // First-run onboarding: detects missing .env / API key and triggers
    // a settings-window prompt on first launch so users don't have to
    // dig through docs to figure out they need a Gemini API key.
    this.firstRunManager = new FirstRunManager({
      logger: logger,
      // .env and the sentinel both live in userData so they survive cwd
      // changes and read-only install dirs (the app may be launched from
      // any directory). ENV_PATH is the same file dotenv loaded at startup
      // and that persistEnvUpdates() writes to.
      envPath: ENV_PATH,
      sentinelPath: path.join(app.getPath("userData"), ".opencluely-firstrun-completed"),
    });
    // Lazily-initialised in getWhisperInstaller() so tests can mock
    // the constructor without polluting main-process startup.
    this._whisperInstaller = null;
    this.isFirstRun = false;

    // Window configurations for reference
    this.windowConfigs = {
      main: { title: "OpenCluely" },
      chat: { title: "Chat" },
      llmResponse: { title: "AI Response" },
      settings: { title: "Settings" },
    };

    this.setupStealth();
    this.setupEventHandlers();
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Set default stealth app name early
    if (app && typeof app.setName === 'function') {
      app.setName("Terminal ");
    }
    process.title = "Terminal ";

    if (
      process.platform === "darwin" &&
      config.get("stealth.noAttachConsole")
    ) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    app.whenReady().then(() => this.onAppReady());
    app.on("window-all-closed", () => this.onWindowAllClosed());
    app.on("activate", () => this.onActivate());
    app.on("will-quit", () => this.onWillQuit());

    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  handleSecondInstance() {
    logger.info("Second instance launch detected; focusing existing windows");

    const focusExistingWindows = () => {
      try {
        const mainWindow = windowManager.getWindow("chat");
        if (mainWindow) {
          if (mainWindow.isMinimized && mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          windowManager.showAllWindows();
          windowManager.showOnCurrentDesktop(mainWindow);
          mainWindow.focus();
          return;
        }

        if (this.isReady) {
          windowManager.showAllWindows();
        }
      } catch (error) {
        logger.error("Failed to focus existing instance", {
          error: error.message,
        });
      }
    };

    if (app.isReady()) {
      focusExistingWindows();
    } else {
      app.whenReady().then(focusExistingWindows);
    }
  }

  async onAppReady() {
    if (this.starting || this.isReady) {
      logger.debug("onAppReady skipped: already starting or ready");
      return;
    }
    this.starting = true;

    // Force stealth mode IMMEDIATELY when app is ready
    app.setName("Terminal ");
    process.title = "Terminal ";

    logger.info("Application starting", {
      version: config.get("app.version"),
      environment: config.get("app.isDevelopment")
        ? "development"
        : "production",
      platform: process.platform,
    });

    try {
      this.setupPermissions();
      this.setupNetworkConfiguration();

      // Small delay to ensure desktop/space detection is accurate
      await new Promise((resolve) => setTimeout(resolve, 200));

      // First-run onboarding: ensure .env exists and read status once
      // so we can decide whether to defer showing the main overlay.
      let status;
      try {
        this.firstRunManager.ensureEnv();
        status = this.firstRunManager.getStatus();
        this.isFirstRun = status.needsOnboarding && !getPanelModels().chat.some(model => model.configured);
        logger.info("First-run status", status);
      } catch (e) {
        logger.warn("First-run check failed", { error: e.message });
        status = { needsOnboarding: false };
        this.isFirstRun = false;
      }
      await windowManager.initializeWindows();
      this.broadcastPanelState();
      void this.refreshPanelModels();
      this.setupGlobalShortcuts();

      // Initialize default stealth mode with terminal icon
      this.updateAppIcon("terminal");

      this.starting = false;
      this.isReady = true;

      if (this.isFirstRun) windowManager.showSettings();
      this.firstRunManager.markCompleted();

      logger.info("Application initialized successfully", {
        windowCount: Object.keys(windowManager.getWindowStats().windows).length,
        currentDesktop: "detected",
      });

      sessionManager.addEvent("Application started");
    } catch (error) {
      this.starting = false;
      logger.error("Application initialization failed", {
        error: error.message,
      });
      app.quit();
    }
  }

  setupNetworkConfiguration() {
    // Configure session to handle network requests better
    const ses = session.defaultSession;
    
    // Allow HTTPS requests to Google APIs
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.url.includes('generativelanguage.googleapis.com')) {
        const platformUA = process.platform === 'darwin'
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.156 Safari/537.36'
          : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.156 Safari/537.36';
        details.requestHeaders['User-Agent'] = platformUA;
      }
      callback({ requestHeaders: details.requestHeaders });
    });
    
    // Handle certificate errors for Google APIs
    ses.setCertificateVerifyProc((request, callback) => {
      if (request.hostname === 'generativelanguage.googleapis.com') {
        callback(0); // Trust Google's certificates
      } else {
        callback(-2); // Use default verification
      }
    });
    
    logger.debug('Network configuration applied for Gemini API');
  }

  setupPermissions() {
    const appSession = session.defaultSession;
    const isTrustedAppContents = (webContents) => {
      if (!webContents || webContents.isDestroyed()) {
        return false;
      }
      try {
        const pagePath = path.resolve(fileURLToPath(webContents.getURL()));
        const appRoot = path.resolve(__dirname);
        const normalizeForComparison = (value) => process.platform === "win32"
          ? value.toLowerCase()
          : value;
        const page = normalizeForComparison(pagePath);
        const root = normalizeForComparison(appRoot + path.sep);
        return page.startsWith(root);
      } catch (_) {
        return false;
      }
    };

    // Electron exposes camera/microphone access as the single `media`
    // permission. The requested device type is provided separately in details.
    appSession.setPermissionCheckHandler(
      (webContents, permission, _requestingOrigin, details = {}) => {
        if (!isTrustedAppContents(webContents)) {
          return false;
        }
        if (permission === "media") {
          return !details.mediaType || details.mediaType === "audio";
        }
        return permission === "display-capture";
      }
    );

    appSession.setPermissionRequestHandler(
      (webContents, permission, callback, details = {}) => {
        let granted = false;
        if (isTrustedAppContents(webContents)) {
          if (permission === "media") {
            const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
            granted = mediaTypes.length === 0 || mediaTypes.includes("audio");
          } else {
            granted = permission === "display-capture";
          }
        }

        logger.debug("Permission request", {
          permission,
          mediaTypes: details.mediaTypes || [],
          granted
        });
        callback(granted);
      }
    );
  }

  setupGlobalShortcuts() {
    const shortcuts = {
      "CommandOrControl+Shift+S": () => this.triggerScreenshotOCR(),
      "CommandOrControl+Shift+V": () => {
        const visible = windowManager.toggleVisibility();
        if (!visible && speechService.getStatus().isRecording) speechService.stopRecording();
      },
      "CommandOrControl+Shift+I": () => windowManager.toggleInteraction(),
      "CommandOrControl+Shift+C": () => windowManager.switchToWindow("chat"),
      "CommandOrControl+Shift+\\": () => this.clearSessionMemory(),
      "CommandOrControl+,": () => windowManager.showSettings(),
      "Alt+A": () => windowManager.toggleInteraction(),
      "Alt+R": () => this.toggleSpeechRecognition(),
      "CommandOrControl+Shift+T": () => windowManager.forceAlwaysOnTopForAllWindows(),
      "CommandOrControl+Shift+Alt+T": () => {
        const results = windowManager.testAlwaysOnTopForAllWindows();
        logger.info('Always-on-top test triggered via shortcut', results);
      },
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      const success = globalShortcut.register(accelerator, handler);
      logger.debug("Global shortcut registered", { accelerator, success });
    });
  }

  setupServiceEventHandlers() {
    speechService.on("recording-started", () => {
      this.discardStoppedSpeech = false;
      windowManager.handleRecordingStarted(speechService.provider);
    });

    speechService.on("recording-stopped", () => {
      windowManager.handleRecordingStopped();
    });

    speechService.on("transcription", (text) => {
      this.handleTranscriptionFragment(text);
    });

    speechService.on("interim-transcription", (text) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("interim-transcription", { text });
      });
    });

    speechService.on("status", (status) => {
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-status", { status, available: this.speechAvailable });
      });
      // Also broadcast availability specifically
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-availability", { available: this.speechAvailable });
      });
    });

    speechService.on("error", (error) => {
      // In error, still compute availability
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-error", { error, available: this.speechAvailable });
      });
    });
  }

  setupIPCHandlers() {
    ipcMain.handle("take-screenshot", () => this.triggerScreenshotOCR());
    ipcMain.handle("get-panel-state", event => {
      if (this.isPanelOrSettingsSender(event.sender)) return this.getPanelState();
    });
    ipcMain.handle("refresh-panel-models", event => {
      if (this.isPanelOrSettingsSender(event.sender)) return this.refreshPanelModels();
    });
    ipcMain.handle("set-panel-session", (event, active) => {
      if (!this.isChatSender(event.sender) || typeof active !== 'boolean') return { success: false };
      this.panelSessionActive = active;
      if (!active) {
        this.discardStoppedSpeech = true;
        this.cancelChatWork();
        speechService.stopRecording({ discard: true });
      }
      this.broadcastPanelState();
      return { success: true };
    });
    ipcMain.handle("select-panel-model", (event, kind, id, model) => {
      if (!this.isPanelOrSettingsSender(event.sender)) return { success: false };
      return this.selectPanelModel(kind, id, model);
    });
    ipcMain.handle("collapse-panel", (event, collapsed) => {
      if (!this.isChatSender(event.sender) || typeof collapsed !== 'boolean') return { success: false };
      const panel = BrowserWindow.fromWebContents(event.sender);
      const bounds = panel.getBounds();
      const work = screen.getDisplayMatching(bounds).workArea;
      const width = Math.min(work.width, collapsed ? 234 : 480);
      const height = Math.min(work.height, collapsed ? 54 : 495);
      panel.setBounds({
        x: Math.max(work.x, Math.min(Math.round(bounds.x + (bounds.width - width) / 2), work.x + work.width - width)),
        y: Math.max(work.y, Math.min(bounds.y, work.y + work.height - height)),
        width, height
      });
      return { success: true };
    });
    ipcMain.handle("discard-chat-image", (event, id) => {
      return { success: this.isChatSender(event.sender) && this.pendingImages.delete(id) };
    });
    ipcMain.handle("attach-chat-image", (event, bytes) => {
      if (!this.isChatSender(event.sender) || !this.panelSessionActive) return { success: false };
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 12 * 1024 * 1024) {
        return { success: false, error: 'Choose an image under 12 MB.' };
      }
      try {
        return this.stageChatImage(Buffer.from(bytes));
      } catch (error) {
        return { success: false, error: error.message };
      }
    });
  ipcMain.handle("list-displays", () => captureService.listDisplays());
  ipcMain.handle("capture-area", (event, options) => captureService.captureAndProcess(options));
    
    // Provide reliable clipboard write via main process
    ipcMain.handle("copy-to-clipboard", (event, text) => {
      try {
        const { clipboard } = require("electron");
        clipboard.writeText(String(text ?? ""));
        return true;
      } catch (e) {
        logger.error("Failed to write to clipboard", { error: e.message });
        return false;
      }
    });
    
    ipcMain.handle("get-speech-availability", () => {
      return speechService.isAvailable ? speechService.isAvailable() : false;
    });

    ipcMain.handle("start-speech-recognition", () => {
      if (this.panelSessionActive) speechService.startRecording();
      return speechService.getStatus();
    });

    ipcMain.handle("stop-speech-recognition", () => {
      speechService.stopRecording();
      return speechService.getStatus();
    });

    // Raw PCM audio captured by the renderer's Web Audio API (Windows Whisper path)
    ipcMain.on("audio-chunk", (event, data) => {
      if (this.panelSessionActive && this.isChatSender(event.sender) && data && data.buffer) {
        speechService.handleAudioChunkFromRenderer(Buffer.from(data.buffer));
      }
    });

    // Also handle direct send events for fallback
    ipcMain.on("start-speech-recognition", () => {
      if (this.panelSessionActive) speechService.startRecording();
    });

    ipcMain.on("stop-speech-recognition", () => {
      speechService.stopRecording();
    });

    ipcMain.on("chat-window-ready", () => {
      // Send a test message to confirm communication
      setTimeout(() => {
        windowManager.broadcastToAllWindows("transcription-received", {
          text: "Test message from main process - chat window communication is working!",
        });
      }, 1000);
    });

    ipcMain.on("main-window-ready", () => {
      // Re-check availability whenever the main overlay finishes loading;
      // this covers first-run where the window was hidden during onboarding.
      this.speechAvailable = speechService.isAvailable
        ? speechService.isAvailable()
        : false;
      const { BrowserWindow } = require("electron");
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("speech-availability", { available: this.speechAvailable });
        }
      });
    });

    ipcMain.on("test-chat-window", () => {
      windowManager.broadcastToAllWindows("transcription-received", {
        text: "🧪 IMMEDIATE TEST: Chat window IPC communication test successful!",
      });
    });

    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-chat", () => {
      windowManager.switchToWindow("chat");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-skills", () => {
      windowManager.switchToWindow("skills");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("resize-window", (event, { width, height }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        // Enforce horizontal constraints: min ~one icon, max original width
        const minW = 60;
        const maxW = windowManager.windowConfigs?.main?.width || 520;
        const clampedWidth = Math.max(minW, Math.min(maxW, Math.round(width || minW)));
        try {
          // Match content size to the DOM so no extra transparent area remains
          mainWindow.setContentSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        } catch (e) {
          // Fallback in case setContentSize isn’t available on some platform
          mainWindow.setSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        }
        logger.debug("Main window resized (content)", { width: clampedWidth, height });
      }
      return { success: true };
    });

    ipcMain.handle("move-window", (event, { deltaX, deltaY }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [currentX, currentY] = mainWindow.getPosition();
        const newX = currentX + deltaX;
        const newY = currentY + deltaY;
        mainWindow.setPosition(newX, newY);
        logger.debug("Main window moved", {
          deltaX,
          deltaY,
          from: { x: currentX, y: currentY },
          to: { x: newX, y: newY },
        });
      }
      return { success: true };
    });

    ipcMain.handle("get-session-history", () => {
      return sessionManager.getOptimizedHistory();
    });

    ipcMain.handle("clear-session-memory", () => {
      this.clearSessionMemory();
      return { success: true };
    });

    ipcMain.handle("force-always-on-top", () => {
      windowManager.forceAlwaysOnTopForAllWindows();
      return { success: true };
    });

    ipcMain.handle("test-always-on-top", () => {
      const results = windowManager.testAlwaysOnTopForAllWindows();
      return { success: true, results };
    });

    ipcMain.handle("send-chat-message", (event, text, imageIds = []) => {
      if (!this.panelSessionActive || !this.isChatSender(event.sender) || typeof text !== 'string' ||
          !Array.isArray(imageIds) || imageIds.length > 8 || new Set(imageIds).size !== imageIds.length) {
        return { success: false };
      }
      const images = imageIds.map(id => this.pendingImages.get(id));
      if (images.some(image => !image) || (!text.trim() && !images.length)) return { success: false };
      for (const id of imageIds) this.pendingImages.delete(id);
      void this.processChatTurn(text.trim(), { images });
      return { success: true };
    });

    ipcMain.handle("get-skill-prompt", (event, skillName) => {
      try {
        const { promptLoader } = require('./prompt-loader');
        const skillPrompt = promptLoader.getSkillPrompt(skillName);
        return skillPrompt;
      } catch (error) {
        logger.error('Failed to get skill prompt', { skillName, error: error.message });
        return null;
      }
    });

    ipcMain.handle("set-gemini-api-key", (event, apiKey) => {
      llmService.updateApiKey(apiKey);
      return llmService.getStats();
    });

    ipcMain.handle("get-gemini-status", () => {
      return llmService.getStats();
    });

    // Window binding IPC handlers
    ipcMain.handle("set-window-binding", (event, enabled) => {
      return windowManager.setWindowBinding(enabled);
    });

    ipcMain.handle("toggle-window-binding", () => {
      return windowManager.toggleWindowBinding();
    });

    ipcMain.handle("get-window-binding-status", () => {
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("get-window-stats", () => {
      return windowManager.getWindowStats();
    });

    ipcMain.handle("set-window-gap", (event, gap) => {
      return windowManager.setWindowGap(gap);
    });

    ipcMain.handle("move-bound-windows", (event, { deltaX, deltaY }) => {
      windowManager.moveBoundWindows(deltaX, deltaY);
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("test-gemini-connection", async () => {
      return await llmService.testConnection();
    });

    ipcMain.handle("run-gemini-diagnostics", async () => {
      try {
        const connectivity = await llmService.checkNetworkConnectivity();
        const apiTest = await llmService.testConnection();
        
        return {
          success: true,
          connectivity,
          apiTest,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    });

    // Settings handlers
    ipcMain.handle("show-settings", () => {
      windowManager.showSettings();

      // Send current settings to the settings window
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        const currentSettings = this.getSettings();
        setTimeout(() => {
          settingsWindow.webContents.send("load-settings", currentSettings);
        }, 100);
      }

      return { success: true };
    });

    ipcMain.handle("get-settings", event => {
      const settingsWindow = windowManager.getWindow("settings");
      const onboarding = windowManager.getWindow("onboarding");
      if ([settingsWindow, onboarding].some(win => win && !win.isDestroyed() && win.webContents === event.sender)) return this.getSettings();
    });

    // First-run onboarding status — renderer can query to know whether
    // to show the welcome banner / prompt for API-key entry.
    ipcMain.handle("get-first-run-status", () => {
      try {
        return this.firstRunManager.getStatus();
      } catch (e) {
        logger.warn("Failed to get first-run status", { error: e.message });
        return { needsOnboarding: false, error: e.message };
      }
    });

    ipcMain.handle("complete-first-run", async () => {
      try {
        this.firstRunManager.markCompleted();
        this.isFirstRun = false;
        // Reinitialize speech service with the latest persisted settings
        // so the mic button reflects the provider/command set during onboarding.
        speechService.initializeClient();
        this.speechAvailable = speechService.isAvailable
          ? speechService.isAvailable()
          : false;
        // Show the main overlay window now that onboarding is done
        // and API keys are configured.
        await windowManager.showMainWindow();
        // Broadcast speech availability so the mic button appears
        const { BrowserWindow } = require("electron");
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("speech-availability", { available: this.speechAvailable });
          }
        });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Open a URL in the system browser (used by the GitHub star button
    // in onboarding).
    ipcMain.handle("open-external", async (_event, url) => {
      try {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          return { ok: false, error: "Invalid URL" };
        }
        const { shell } = require("electron");
        await shell.openExternal(url);
        return { ok: true };
      } catch (e) {
        logger.warn("Failed to open external URL", { url, error: e.message });
        return { ok: false, error: e.message };
      }
    });

    // Close the onboarding wizard window.
    ipcMain.handle("close-onboarding", () => {
      try {
        windowManager.closeOnboarding();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Detect an installed Whisper CLI across common locations.
    ipcMain.handle("detect-whisper", async () => {
      try {
        const installer = this.getWhisperInstaller();
        return await installer.detect();
      } catch (e) {
        logger.warn("Whisper detection failed", { error: e.message });
        return { found: false, command: null, version: null, error: e.message };
      }
    });

    // Install Whisper. Streams progress lines back via `webContents.send`
    // so the renderer can paint them as they arrive.
    ipcMain.handle("install-whisper", async (event) => {
      try {
        const installer = this.getWhisperInstaller();
        const sender = event.sender;
        const result = await installer.install({
          onProgress: (line) => {
            try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
          },
        });
        return result;
      } catch (e) {
        logger.error("Whisper install failed", { error: e.message });
        return { ok: false, command: null, message: e.message, logs: "" };
      }
    });

    // Download Whisper model. Streams progress lines back via `webContents.send`
    ipcMain.handle("download-whisper-model", async (event, modelName) => {
      try {
        const installer = this.getWhisperInstaller();
        const sender = event.sender;
        const result = await installer.downloadModel(modelName || 'small', {
          onProgress: (line) => {
            try { sender.send("install-progress", line); } catch (_) { /* ignore */ }
          },
        });
        return result;
      } catch (e) {
        logger.error("Whisper model download failed", { error: e.message });
        return { ok: false, message: e.message, path: null };
      }
    });

    ipcMain.handle("save-settings", (event, settings) => {
      return this.saveSettings(settings);
    });

    ipcMain.handle("update-app-icon", (event, iconKey) => {
      return this.updateAppIcon(iconKey);
    });

    ipcMain.handle("update-active-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-changed", { skill });
      return { success: true };
    });

    ipcMain.handle("restart-app-for-stealth", () => {
      // Force restart the app to ensure stealth name changes take effect
      const { app } = require("electron");
      app.relaunch();
      app.exit();
    });

    ipcMain.handle("close-window", (event) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || window.isDestroyed()) return { success: false };
      if (this.isChatSender(event.sender) && speechService.getStatus().isRecording) {
        speechService.stopRecording();
      }
      window.hide();
      return { success: true };
    });

    // LLM window specific handlers
    ipcMain.handle("expand-llm-window", (event, contentMetrics) => {
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("resize-llm-window-for-content", (event, contentMetrics) => {
      // Use the same expansion logic for now, can be enhanced later
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("quit-app", () => {
      logger.info("Quit app requested via IPC");
      try {
        // Force quit the application
        const { app } = require("electron");

        // Close all windows first
        windowManager.destroyAllWindows();

        // Unregister shortcuts
        globalShortcut.unregisterAll();

        // Force quit
        app.quit();

        // If the above doesn't work, force exit
        setTimeout(() => {
          process.exit(0);
        }, 2000);
      } catch (error) {
        logger.error("Error during quit:", error);
        process.exit(1);
      }
    });

    // Handle close settings
    ipcMain.on("close-settings", () => {
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        settingsWindow.hide();
      }
    });

    // Handle save settings (synchronous)
    ipcMain.on("save-settings", (event, settings) => {
      this.saveSettings(settings);
    });

    // Handle update skill
    ipcMain.on("update-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-updated", { skill });
    });

    // Handle quit app (alternative method)
    ipcMain.on("quit-app", () => {
      logger.info("Quit app requested via IPC (on method)");
      try {
        const { app } = require("electron");
        windowManager.destroyAllWindows();
        globalShortcut.unregisterAll();
        app.quit();
        setTimeout(() => process.exit(0), 1000);
      } catch (error) {
        logger.error("Error during quit (on method):", error);
        process.exit(1);
      }
    });
  }

  toggleSpeechRecognition() {
    if (!this.panelSessionActive) return;
    const isAvailable = typeof speechService.isAvailable === 'function' ? speechService.isAvailable() : !!speechService.getStatus?.().isInitialized;
    if (!isAvailable) {
      logger.warn("Speech recognition unavailable; toggle ignored");
      try {
        windowManager.broadcastToAllWindows("speech-status", { status: 'Speech recognition unavailable', available: false });
        windowManager.broadcastToAllWindows("speech-availability", { available: false });
      } catch (e) {}
      return;
    }
    const currentStatus = speechService.getStatus();
    if (currentStatus.isRecording) {
      try {
        speechService.stopRecording();
        logger.info("Speech recognition stopped via global shortcut");
      } catch (error) {
        logger.error("Error stopping speech recognition:", error);
      }
    } else {
      try {
        speechService.startRecording();
        windowManager.showChatWindow();
        logger.info("Speech recognition started via global shortcut");
      } catch (error) {
        logger.error("Error starting speech recognition:", error);
      }
    }
  }

  clearSessionMemory() {
    try {
      this.cancelChatWork();
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      logger.info("Session memory cleared via global shortcut");
    } catch (error) {
      logger.error("Error clearing session memory:", error);
    }
  }

  handleUpArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to previous skill
      this.navigateSkill(-1);
    } else {
      // Non-interactive mode: Move window up
      windowManager.moveBoundWindows(0, -20);
    }
  }

  handleDownArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to next skill
      this.navigateSkill(1);
    } else {
      // Non-interactive mode: Move window down
      windowManager.moveBoundWindows(0, 20);
    }
  }

  handleLeftArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window left
      windowManager.moveBoundWindows(-20, 0);
    }
    // Interactive mode: Left arrow does nothing
  }

  handleRightArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window right
      windowManager.moveBoundWindows(20, 0);
    }
    // Interactive mode: Right arrow does nothing
  }

  navigateSkill(direction) {
    const availableSkills = [
      "dsa",
    ];

    const currentIndex = availableSkills.indexOf(this.activeSkill);
    if (currentIndex === -1) {
      logger.warn("Current skill not found in available skills", {
        currentSkill: this.activeSkill,
        availableSkills,
      });
      return;
    }

    // Calculate new index with wrapping
    let newIndex = currentIndex + direction;
    if (newIndex >= availableSkills.length) {
      newIndex = 0; // Wrap to beginning
    } else if (newIndex < 0) {
      newIndex = availableSkills.length - 1; // Wrap to end
    }

    const newSkill = availableSkills[newIndex];
    this.activeSkill = newSkill;

    // Update session manager with the new skill
    sessionManager.setActiveSkill(newSkill);

    logger.info("Skill navigated via global shortcut", {
      from: availableSkills[currentIndex],
      to: newSkill,
      direction: direction > 0 ? "down" : "up",
    });

    // Broadcast the skill change to all windows
    windowManager.broadcastToAllWindows("skill-updated", { skill: newSkill });
  }

  getPanelState() {
    const speech = speechService.getStatus();
    return { ...getPanelModels(), active: this.panelSessionActive, recording: speech.isRecording, speechAvailable: speechService.isAvailable() };
  }

  broadcastPanelState() {
    const state = this.getPanelState();
    for (const type of ['chat', 'settings']) {
      const window = windowManager.getWindow(type);
      if (window && !window.isDestroyed()) window.webContents.send("panel-state", state);
    }
  }

  async refreshPanelModels() {
    const catalogs = await fetchProviderModels();
    this.broadcastPanelState();
    return catalogs;
  }

  isPanelOrSettingsSender(sender) {
    const settings = windowManager.getWindow("settings");
    return this.isChatSender(sender) || Boolean(settings && !settings.isDestroyed() && settings.webContents === sender);
  }

  selectPanelModel(kind, id, model) {
    const options = getPanelModels();
    const provider = options.chat.find(option => option.id === id && option.configured);
    if (kind === 'chat' && provider && (model === undefined || provider.models.includes(model))) {
      return this.saveSettings({ chatProvider: id, chatModel: model || provider.models[0] });
    }
    if (kind === 'voice' && options.voice.some(option => option.id === id)) {
      if (speechService.getStatus().isRecording || speechService.isProcessingAudio || this._utteranceBuffer) {
        return { success: false, error: 'Turn off the microphone and wait for transcription before switching voice models.' };
      }
      if (id === 'azure') return this.saveSettings({ speechProvider: 'azure' });
      const [speechProvider, voiceModel] = id.split(':');
      const field = { whisper: 'whisperModel', groq: 'groqVoiceModel', gemini: 'geminiVoiceModel' }[speechProvider];
      return this.saveSettings({ speechProvider, [field]: voiceModel });
    }
    return { success: false, error: 'Add this provider and model in Settings first.' };
  }

  cancelChatWork() {
    this.chatGeneration++;
    this.pendingImages.clear();
    this._utteranceBuffer = "";
    clearTimeout(this._utteranceTimer);
    this._utteranceTimer = null;
    for (const request of this.chatRequests) request.abort();
    this.chatRequests.clear();
  }

  isChatSender(sender) {
    const chat = windowManager.getWindow("chat");
    return Boolean(chat && !chat.isDestroyed() && chat.webContents === sender);
  }

  stageChatImage(buffer) {
    if (this.pendingImages.size >= 8) throw new Error('Attach up to eight images per message.');
    let image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) throw new Error('Could not read the image. Use PNG or JPEG.');
    const { width, height } = image.getSize();
    if (Math.max(width, height) > 1920) {
      const dimension = width >= height ? { width: 1920 } : { height: 1920 };
      image = image.resize({ ...dimension, quality: 'good' });
    }
    let imageBuffer = image.toJPEG(87);
    if (imageBuffer.length > 1024 * 1024) imageBuffer = image.toJPEG(62);
    if (imageBuffer.length > 1024 * 1024) throw new Error('The image is too detailed. Crop it and try again.');
    const id = randomUUID();
    const attachment = { id, imageBuffer, mimeType: 'image/jpeg' };
    this.pendingImages.set(id, attachment);
    this.sendToChatWindow("chat-screenshot-ready", this.describeChatImage(attachment));
    return { success: true };
  }

  describeChatImage({ id, imageBuffer, mimeType }) {
    return { id, preview: 'data:' + mimeType + ';base64,' + imageBuffer.toString('base64') };
  }

  async triggerScreenshotOCR() {
    if (!this.isReady || !this.panelSessionActive) return { success: false };
    const generation = this.chatGeneration;
    try {
      const displayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
      const capture = await captureService.captureAndProcess({ displayId });
      if (generation !== this.chatGeneration) return { success: false };
      if (!capture.imageBuffer?.length) throw new Error("No screenshot was captured.");
      this.stageChatImage(capture.imageBuffer);
      windowManager.showChatWindow();
      return { success: true };
    } catch (error) {
      if (generation === this.chatGeneration) {
        this.sendToChatWindow("chat-request-error", { error: error.message });
        windowManager.showChatWindow();
      }
      return { success: false };
    }
  }

  async processChatTurn(text, { images = [], source = 'chat' } = {}) {
    if (!this.panelSessionActive) return;
    const generation = this.chatGeneration;
    const { selectedChat: provider, selectedChatModel: model } = getPanelModels();
    const request = new AbortController();
    this.chatRequests.add(request);
    this._responseSeq = (this._responseSeq || 0) + 1;
    const messageId = `chat-${this._responseSeq}`;
    const publish = (channel, data) => {
      if (generation === this.chatGeneration) this.sendToChatWindow(channel, { messageId, ...data });
    };
    const history = sessionManager.getConversationHistory();
    const type = source === 'speech' ? 'transcription' : 'user';
    publish("chat-user-message", { type, text, images: images.map(image => this.describeChatImage(image)) });
    sessionManager.addUserInput(text || 'Attached ' + images.length + ' image(s)', source);
    publish("transcription-llm-response-start", {});
    try {
      const onDelta = (delta) => publish("transcription-llm-response-chunk", { delta });
      const signal = request.signal;
      const result = await streamChat({ provider, model, text, images, history, onDelta, signal });
      if (generation !== this.chatGeneration) return;
      sessionManager.addModelResponse(result.response, { isImageAnalysis: images.length > 0 });
      publish("transcription-llm-response", { response: result.response });
    } catch (error) {
      if (!request.signal.aborted) {
        logger.warn("Chat request failed", { error: error.message, source });
        publish("chat-request-error", { error: error.message });
      }
    } finally {
      this.chatRequests.delete(request);
    }
  }

  /**
   * Buffer a transcribed fragment and (re)arm the coalesce debounce. Fragments
   * are shown in the UI immediately so speech feels live, but the LLM is only
   * asked once the speaker has actually paused — this is what stops one spoken
   * line from producing two separate, slow answers.
   */
  handleTranscriptionFragment(text) {
    if (!this.panelSessionActive || this.discardStoppedSpeech) return;
    const fragment = (text || "").trim();
    if (!fragment) {
      return;
    }


    this._utteranceBuffer = this._utteranceBuffer
      ? `${this._utteranceBuffer} ${fragment}`
      : fragment;

    if (this._utteranceTimer) {
      clearTimeout(this._utteranceTimer);
      this._utteranceTimer = null;
    }

    // Manual capture emits one complete transcript after the user presses stop,
    // so no debounce/coalescing delay is needed.
    if (speechService.isManualCaptureMode()) {
      this.dispatchCoalescedUtterance();
      return;
    }

    this._utteranceTimer = setTimeout(() => {
      this._utteranceTimer = null;
      this.dispatchCoalescedUtterance();
    }, this._utteranceCoalesceMs);
  }

  /**
   * Send the coalesced utterance to the LLM. If a previous dispatch is still
   * running, leave the buffer intact and let that dispatch's completion pick it
   * up — so we never pile up overlapping requests for the same person talking.
   */
  async dispatchCoalescedUtterance() {
    if (this._utteranceDispatchInFlight) {
      return;
    }
    const combined = this._utteranceBuffer.trim();
    if (!combined) {
      return;
    }
    this._utteranceBuffer = "";
    this._utteranceDispatchInFlight = true;

    try {

      await this.processChatTurn(combined, { source: 'speech' });
    } catch (error) {
      logger.error("Failed to process transcription with LLM", {
        error: error.message,
        text: combined.substring(0, 100)
      });
    } finally {
      this._utteranceDispatchInFlight = false;
      // Anything that arrived while we were busy gets answered now.
      if (this._utteranceBuffer.trim()) {
        this.dispatchCoalescedUtterance();
      }
    }
  }

  broadcastOCRSuccess(ocrResult) {
    windowManager.broadcastToAllWindows("ocr-completed", {
      text: ocrResult.text,
      metadata: ocrResult.metadata,
    });
  }

  broadcastOCRError(errorMessage) {
    windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMSuccess(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill, // Add the current active skill to the top level
    };

    logger.info("Broadcasting LLM success to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      dataKeys: Object.keys(broadcastData),
      responsePreview: llmResult.response.substring(0, 100) + "...",
    });

    windowManager.broadcastToAllWindows("llm-response", broadcastData);
  }

  broadcastLLMError(errorMessage) {
    windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };

    logger.info("Broadcasting transcription LLM response to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      responsePreview: llmResult.response.substring(0, 100) + "..."
    });

    windowManager.broadcastToAllWindows("transcription-llm-response", broadcastData);
  }

  sendToChatWindow(channel, data) {
    const chatWindow = windowManager.getWindow("chat");
    if (!chatWindow || chatWindow.isDestroyed()) {
      logger.warn("Chat window unavailable for speech event", { channel });
      return;
    }
    chatWindow.webContents.send(channel, data);
  }



  onWindowAllClosed() {
    if (process.platform !== "darwin") {
      app.quit();
    }
  }

  onActivate() {
    if (!this.isReady && !this.starting) {
      this.onAppReady();
    } else if (this.isReady) {
      // When app is activated, ensure windows appear on current desktop
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }

      // Also handle other visible windows
      windowManager.windows.forEach((window, type) => {
        if (window.isVisible()) {
          windowManager.showOnCurrentDesktop(window);
        }
      });

      logger.debug("App activated - ensured windows appear on current desktop");
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();
    speechService.shutdown();
    windowManager.destroyAllWindows();

    const sessionStats = sessionManager.getMemoryUsage();
    logger.info("Application shutting down", {
      sessionEvents: sessionStats.eventCount,
      sessionSize: sessionStats.approximateSize,
    });
  }

  getWhisperInstaller() {
    if (!this._whisperInstaller) {
      const WhisperInstaller = require("./src/core/whisper-installer");
      const { app } = require("electron");
      this._whisperInstaller = new WhisperInstaller({
        cwd: process.cwd(),
        dataDir: app.getPath("userData"),
        platform: process.platform,
      });
    }
    return this._whisperInstaller;
  }

  getSettings() {
    // Surface every value the settings UI can edit, reading the live source
    // of truth (process.env) so the UI shows exactly what the running app is
    // using. Empty strings are returned rather than skipped so the UI can
    // distinguish "unset" from "stale value from a previous load".
    return {
      codingLanguage: this.codingLanguage || "cpp",
      activeSkill: this.activeSkill || "dsa",
      appIcon: this.appIcon || "terminal",
      selectedIcon: this.appIcon || "terminal",
      windowGap: windowManager.windowGap,

      speechProvider: speechService.provider || "whisper",
      azureKey: process.env.AZURE_SPEECH_KEY || "",
      azureRegion: process.env.AZURE_SPEECH_REGION || "",
      whisperCommand: process.env.WHISPER_COMMAND || "",
      whisperModel: process.env.WHISPER_MODEL || "small",
      whisperLanguage: process.env.WHISPER_LANGUAGE || "auto",
      whisperDevice: process.env.WHISPER_DEVICE || "auto",
      whisperCaptureMode: process.env.WHISPER_CAPTURE_MODE ||
        (process.env.WHISPER_MANUAL_CAPTURE === "true" ? "manual" : "vad"),
      whisperSegmentMs: process.env.WHISPER_SEGMENT_MS || "4000",
      geminiKey: process.env.GEMINI_API_KEY || "",
      geminiModel: process.env.GEMINI_MODEL || "",
      openRouterKey: process.env.OPENROUTER_API_KEY || "",
      ollamaModel: process.env.OLLAMA_MODEL || "",
      groqKey: process.env.GROQ_API_KEY || "",
      groqModels: process.env.GROQ_MODELS || "",
      openAIKey: process.env.OPENAI_API_KEY || "",
      openAIModels: process.env.OPENAI_MODELS || "",
      claudeKey: process.env.ANTHROPIC_API_KEY || "",
      claudeModels: process.env.CLAUDE_MODELS || "",
      geminiVoiceModel: process.env.GEMINI_VOICE_MODEL || "",
      chatProvider: getPanelModels().selectedChat,

      azureConfigured: !!process.env.AZURE_SPEECH_KEY && !!process.env.AZURE_SPEECH_REGION,
      speechAvailable: this.speechAvailable
    };
  }

  saveSettings(settings) {
    try {
      // ── In-memory updates + window broadcasts ──
      if (settings.codingLanguage) {
        this.codingLanguage = settings.codingLanguage;
        windowManager.broadcastToAllWindows("coding-language-changed", {
          language: settings.codingLanguage,
        });
      }
      if (settings.activeSkill) {
        this.activeSkill = settings.activeSkill;
        windowManager.broadcastToAllWindows("skill-updated", {
          skill: settings.activeSkill,
        });
      }
      if (settings.appIcon) {
        this.appIcon = settings.appIcon;
      }
      if (settings.selectedIcon) {
        this.appIcon = settings.selectedIcon;
        this.updateAppIcon(settings.selectedIcon);
      }
      if (settings.windowGap !== undefined) {
        const gap = Number(settings.windowGap);
        if (Number.isFinite(gap)) windowManager.setWindowGap(gap);
      }

      // ── Persist provider / API-key fields back to .env ──
      // The settings UI is now the source of truth for these values.
      // Writing to .env ensures they survive app restarts and are picked
      // up the next time the app boots.
      const envUpdates = {};
      if (["azure", "whisper", "groq", "gemini"].includes(settings.speechProvider)) {
        envUpdates.SPEECH_PROVIDER = settings.speechProvider;
      }
      if (settings.azureKey !== undefined) {
        envUpdates.AZURE_SPEECH_KEY = settings.azureKey;
      }
      if (settings.azureRegion !== undefined) {
        envUpdates.AZURE_SPEECH_REGION = settings.azureRegion;
      }
      if (settings.whisperCommand !== undefined) {
        envUpdates.WHISPER_COMMAND = settings.whisperCommand;
      }
      if (settings.whisperModel !== undefined) {
        envUpdates.WHISPER_MODEL = settings.whisperModel;
      }
      if (settings.whisperLanguage !== undefined) {
        envUpdates.WHISPER_LANGUAGE = settings.whisperLanguage;
      }
      if (["auto", "cpu", "cuda"].includes(settings.whisperDevice)) {
        envUpdates.WHISPER_DEVICE = settings.whisperDevice;
      }
      if (["manual", "vad"].includes(settings.whisperCaptureMode)) {
        envUpdates.WHISPER_CAPTURE_MODE = settings.whisperCaptureMode;
      }
      if (settings.whisperSegmentMs !== undefined) {
        envUpdates.WHISPER_SEGMENT_MS = String(settings.whisperSegmentMs);
      }
      if (settings.geminiKey !== undefined) {
        envUpdates.GEMINI_API_KEY = settings.geminiKey;
      }

      for (const [field, envKey] of Object.entries({
        geminiModel: 'GEMINI_MODEL', openRouterKey: 'OPENROUTER_API_KEY', ollamaModel: 'OLLAMA_MODEL',
        groqKey: 'GROQ_API_KEY', groqModels: 'GROQ_MODELS', groqVoiceModel: 'GROQ_VOICE_MODEL',
        openAIKey: 'OPENAI_API_KEY', openAIModels: 'OPENAI_MODELS',
        claudeKey: 'ANTHROPIC_API_KEY', claudeModels: 'CLAUDE_MODELS', geminiVoiceModel: 'GEMINI_VOICE_MODEL'
      })) {
        if (typeof settings[field] === 'string') {
          const value = settings[field].trim();
          if (field === 'geminiVoiceModel' && value && !/^[a-zA-Z0-9._-]+$/.test(value)) {
            return { success: false, error: 'Enter one Gemini voice model ID.' };
          }
          envUpdates[envKey] = value;
        }
      }
      if (getPanelModels().chat.some(provider => provider.id === settings.chatProvider)) {
        envUpdates.CHAT_PROVIDER = settings.chatProvider;
        if (settings.chatModel) envUpdates.CHAT_MODEL = settings.chatModel;
      }
      const hasSpeechChanges = ['SPEECH_PROVIDER', 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION', 'WHISPER_COMMAND', 'WHISPER_MODEL', 'WHISPER_DEVICE', 'GROQ_VOICE_MODEL', 'GEMINI_VOICE_MODEL',
        ...(speechService.provider === 'groq' ? ['GROQ_API_KEY'] : []),
        ...(speechService.provider === 'gemini' ? ['GEMINI_API_KEY'] : [])]
        .some(key => Object.hasOwn(envUpdates, key) && String(envUpdates[key]) !== (process.env[key] || ''));
      if (hasSpeechChanges && (speechService.getStatus().isRecording || speechService.isProcessingAudio)) {
        return { success: false, error: 'Turn off the microphone before changing speech settings.' };
      }
      const changedGemini = ['GEMINI_API_KEY', 'GEMINI_MODEL']
        .some(key => Object.hasOwn(envUpdates, key) && String(envUpdates[key]) !== (process.env[key] || ''));
      const catalogChanged = ['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']
        .some(key => Object.hasOwn(envUpdates, key) && String(envUpdates[key]) !== (process.env[key] || ''));
      const persistedKeys = this.persistEnvUpdates(envUpdates);
      if (persistedKeys.length !== Object.keys(envUpdates).length) {
        return { success: false, error: 'Could not save provider settings to disk.' };
      }
      if (changedGemini) llmService.initializeClient();
      if (hasSpeechChanges) {
        speechService.initializeClient();
        this.speechAvailable = speechService.isAvailable();
        windowManager.broadcastToAllWindows("speech-availability", { available: this.speechAvailable });
      }
      this.broadcastPanelState();
      if (catalogChanged) void this.refreshPanelModels();
      logger.info("Settings saved successfully", { persistedEnvKeys: persistedKeys });
      return { success: true, persistedEnvKeys: persistedKeys };
    } catch (error) {
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  persistSettings(settings) {
    // You can extend this to save to a file or database
    // For now, we'll just keep them in memory
    logger.debug("Settings persisted", settings);
  }

  /**
   * Write key=value pairs to the project's .env file. Existing keys are
   * replaced in-place; new keys are appended. Comments and unrelated lines
   * are preserved. Uses an atomic write (temp file + rename) so a crash
   * mid-write cannot corrupt .env.
   *
   * @param {Object<string, string>} updates - keys to upsert
   * @returns {string[]} keys that were actually persisted
   */
  persistEnvUpdates(updates) {
    if (!updates || typeof updates !== "object") return [];
    const keys = Object.keys(updates);
    if (keys.length === 0) return [];

    const fs = require("fs");
    // Single source of truth — the same file dotenv loaded at startup and that
    // FirstRunManager reads/writes (userData in packaged builds, project .env
    // in dev). Writing to process.cwd() here would silently diverge.
    const envPath = ENV_PATH;

    let existing = "";
    try {
      existing = fs.readFileSync(envPath, "utf8");
    } catch (_) {
      // .env doesn't exist yet — we'll create one from scratch
      existing = "";
    }

    const existingLines = existing.length > 0 ? existing.split(/\r?\n/) : [];
    const updated = new Set();
    const outLines = [];

    for (const line of existingLines) {
      // Match "KEY=" (with optional whitespace) but skip comment lines
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
        const key = m[1];
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      } else {
        outLines.push(line);
      }
    }

    // Append any keys that weren't already present
    for (const key of keys) {
      if (!updated.has(key)) {
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      }
    }

    const newContent = outLines.join("\n");
    try {
      const tmpPath = envPath + ".tmp";
      fs.writeFileSync(tmpPath, newContent, "utf8");
      fs.renameSync(tmpPath, envPath);
    } catch (e) {
      logger.error("Failed to persist .env updates", {
        error: e.message,
        keys
      });
      return [];
    }

    for (const key of keys) process.env[key] = String(updates[key]);
    logger.info("Persisted .env updates", { keys: Array.from(updated) });
    return Array.from(updated);
  }

  updateAppIcon(iconKey) {
    try {
      const { app } = require("electron");
      const path = require("path");
      const fs = require("fs");

      // Icon mapping for available icons in assests/icons folder
      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };

      // App name mapping for stealth mode
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];

      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(__dirname, iconPath);

      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", {
          iconKey,
          iconPath: fullIconPath,
        });
        return { success: false, error: "Icon file not found" };
      }

      // Set app icon for dock/taskbar
      if (process.platform === "darwin") {
        // macOS - update dock icon (only if dock is available)
        if (app.dock) {
          app.dock.setIcon(fullIconPath);

          // Force dock refresh with multiple attempts
          const retryDockIcon = () => {
            try { app.dock.setIcon(fullIconPath); } catch (_) { /* dock may not exist */ }
          };
          setTimeout(retryDockIcon, 100);
          setTimeout(retryDockIcon, 500);
        }
      } else {
        // Windows/Linux - update window icons
        windowManager.windows.forEach((window, type) => {
          if (window && !window.isDestroyed()) {
            window.setIcon(fullIconPath);
          }
        });
      }

      // Update app name for stealth mode
      this.updateAppName(appName, iconKey);

      logger.info("App icon and name updated successfully", {
        iconKey,
        appName,
        iconPath: fullIconPath,
        platform: process.platform,
        fileExists: fs.existsSync(fullIconPath),
      });

      this.appIcon = iconKey;
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", {
        error: error.message,
        stack: error.stack,
      });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      const { app } = require("electron");

      // Force update process title for Activity Monitor stealth - CRITICAL
      process.title = appName;

      // Set app name in dock (macOS) - this affects the dock and Activity Monitor
      if (process.platform === "darwin") {
        // Multiple attempts to ensure the name sticks
        app.setName(appName);

        // Clear dock badge and reset
        if (app.dock) {
          app.dock.setBadge("");
          // Force dock refresh
          setTimeout(() => {
            app.dock.setIcon(
              require("path").resolve(__dirname, `assests/icons/${iconKey}.png`)
            );
          }, 50);
        }
      }

      // Set app user model ID for Windows taskbar grouping (Windows only)
      if (process.platform === "win32") {
        app.setAppUserModelId(`${appName.trim()}-${iconKey}`);
      }

      // Update all window titles to match the new app name
      const windows = windowManager.windows;
      windows.forEach((window, type) => {
        if (window && !window.isDestroyed()) {
          // Use stealth name for all windows
          const stealthTitle = appName.trim();
          window.setTitle(stealthTitle);
        }
      });

      // Multiple force refreshes with increasing delays
      const refreshTimes = [50, 100, 200, 500];
      refreshTimes.forEach((delay) => {
        setTimeout(() => {
          process.title = appName;
          if (process.platform === "darwin") {
            app.setName(appName);
            // Force update bundle display name
            if (app.getName() !== appName) {
              app.setName(appName);
            }
          }
        }, delay);
      });

      logger.info("App name updated for stealth mode", {
        appName,
        processTitle: process.title,
        appGetName: app.getName(),
        iconKey,
        platform: process.platform,
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  const controller = new ApplicationController();
  app.on("second-instance", () => controller.handleSecondInstance());
}
