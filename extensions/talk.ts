// Standalone Talk extension adapted from:
// https://github.com/Joselay/pi-kit/tree/main/extensions/talk
// Runtime files: $XDG_CACHE_HOME/pi/talk (default ~/.cache/pi/talk).

// extensions/lib/audio.ts
import { spawn, execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";

// assets/talk/talk-audio.swift
var talk_audio_default = 'import AVFoundation\nimport Foundation\nimport os\n\nlet sampleRate = 24_000.0\n\nfunc warn(_ message: String) {\n    FileHandle.standardError.write(Data(("voice-audio: " + message + "\\n").utf8))\n}\n\nfinal class PlaybackRing {\n    private let capacity = Int(sampleRate) * 120\n    private var buffer: [Float]\n    private var head = 0\n    private var count = 0\n    private let lock: UnsafeMutablePointer<os_unfair_lock_s> = {\n        let pointer = UnsafeMutablePointer<os_unfair_lock_s>.allocate(capacity: 1)\n        pointer.initialize(to: os_unfair_lock_s())\n        return pointer\n    }()\n\n    init() {\n        buffer = [Float](repeating: 0, count: capacity)\n    }\n\n    func push(_ source: UnsafePointer<Float>, _ frames: Int) {\n        guard frames > 0 else { return }\n        var source = source\n        var frames = frames\n        if frames > capacity {\n            source = source.advanced(by: frames - capacity)\n            frames = capacity\n        }\n        os_unfair_lock_lock(lock)\n        defer { os_unfair_lock_unlock(lock) }\n        if count + frames > capacity {\n            let drop = count + frames - capacity\n            head = (head + drop) % capacity\n            count -= drop\n        }\n        var tail = (head + count) % capacity\n        buffer.withUnsafeMutableBufferPointer { destination in\n            guard let base = destination.baseAddress else { return }\n            var left = frames\n            var from = source\n            while left > 0 {\n                let chunk = min(left, capacity - tail)\n                base.advanced(by: tail).update(from: from, count: chunk)\n                from = from.advanced(by: chunk)\n                tail = (tail + chunk) % capacity\n                left -= chunk\n            }\n        }\n        count += frames\n    }\n\n    func pop(into out: UnsafeMutablePointer<Float>, count wanted: Int) {\n        os_unfair_lock_lock(lock)\n        let available = min(wanted, count)\n        var index = head\n        buffer.withUnsafeMutableBufferPointer { source in\n            guard let base = source.baseAddress else { return }\n            var left = available\n            var to = out\n            while left > 0 {\n                let chunk = min(left, capacity - index)\n                to.update(from: base.advanced(by: index), count: chunk)\n                to = to.advanced(by: chunk)\n                index = (index + chunk) % capacity\n                left -= chunk\n            }\n        }\n        head = index\n        count -= available\n        os_unfair_lock_unlock(lock)\n        if available < wanted {\n            out.advanced(by: available).update(repeating: 0, count: wanted - available)\n        }\n    }\n\n    func clear() {\n        os_unfair_lock_lock(lock)\n        head = 0\n        count = 0\n        os_unfair_lock_unlock(lock)\n    }\n}\n\nfinal class StdoutWriter {\n    private var pending: [Data] = []\n    private let condition = NSCondition()\n    private let maxPending = 200\n\n    init() {\n        let thread = Thread { [self] in run() }\n        thread.name = "voice-audio.stdout"\n        thread.qualityOfService = .userInitiated\n        thread.start()\n    }\n\n    func write(_ data: Data) {\n        condition.lock()\n        if pending.count >= maxPending {\n            pending.removeFirst(pending.count - maxPending + 1)\n        }\n        pending.append(data)\n        condition.signal()\n        condition.unlock()\n    }\n\n    private func run() {\n        while true {\n            condition.lock()\n            while pending.isEmpty { condition.wait() }\n            let batch = pending\n            pending.removeAll(keepingCapacity: true)\n            condition.unlock()\n            for chunk in batch where !writeAll(chunk) {\n                exit(0)\n            }\n        }\n    }\n\n    private func writeAll(_ data: Data) -> Bool {\n        data.withUnsafeBytes { raw -> Bool in\n            guard var pointer = raw.baseAddress else { return true }\n            var left = raw.count\n            while left > 0 {\n                let written = Foundation.write(1, pointer, left)\n                if written > 0 {\n                    pointer = pointer.advanced(by: written)\n                    left -= written\n                    continue\n                }\n                if written < 0 && errno == EINTR { continue }\n                if written < 0 && errno == EAGAIN {\n                    usleep(1000)\n                    continue\n                }\n                return false\n            }\n            return true\n        }\n    }\n}\n\nfinal class VoiceEngine {\n    let ring = PlaybackRing()\n    private let engine = AVAudioEngine()\n    private let stdout = StdoutWriter()\n    private let ioFormat: AVAudioFormat\n    private let micFormat: AVAudioFormat\n    private var sourceNode: AVAudioSourceNode?\n    private var converter: AVAudioConverter?\n    private let configQueue = DispatchQueue(label: "voice-audio.config")\n    private var running = false\n    private var rebuildGeneration = 0\n\n    private(set) var echoCancelled = false\n\n    init?() {\n        guard let io = AVAudioFormat(\n            commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false\n        ), let mic = AVAudioFormat(\n            commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true\n        ) else {\n            warn("could not create audio formats")\n            return nil\n        }\n        ioFormat = io\n        micFormat = mic\n    }\n\n    func start() throws {\n        do {\n            try engine.inputNode.setVoiceProcessingEnabled(true)\n            echoCancelled = true\n        } catch {\n            warn("voice processing unavailable, echo cancellation disabled: \\(error.localizedDescription)")\n        }\n        try configure()\n        try engine.start()\n        running = true\n\n        NotificationCenter.default.addObserver(\n            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil\n        ) { [weak self] _ in\n            self?.scheduleRebuild()\n        }\n    }\n\n    private func configure() throws {\n        let outputFormat = engine.outputNode.outputFormat(forBus: 0)\n        let inputRate = engine.inputNode.outputFormat(forBus: 0).sampleRate\n        guard inputRate > 0, outputFormat.sampleRate > 0 else {\n            throw NSError(\n                domain: "voice-audio", code: 1,\n                userInfo: [NSLocalizedDescriptionKey: "no usable audio device (input \\(inputRate) Hz)"],\n            )\n        }\n        guard let inputFormat = AVAudioFormat(\n            commonFormat: .pcmFormatFloat32, sampleRate: inputRate, channels: 1, interleaved: false\n        ), let converter = AVAudioConverter(from: inputFormat, to: micFormat) else {\n            throw NSError(\n                domain: "voice-audio", code: 2,\n                userInfo: [NSLocalizedDescriptionKey: "could not convert mic audio from \\(inputRate) Hz"],\n            )\n        }\n        self.converter = converter\n\n        if sourceNode == nil {\n            let ring = ring\n            let node = AVAudioSourceNode(format: ioFormat) { _, _, frameCount, audioBufferList -> OSStatus in\n                let buffers = UnsafeMutableAudioBufferListPointer(audioBufferList)\n                guard let data = buffers[0].mData else { return noErr }\n                ring.pop(into: data.assumingMemoryBound(to: Float.self), count: Int(frameCount))\n                return noErr\n            }\n            sourceNode = node\n            engine.attach(node)\n        }\n        guard let sourceNode else { return }\n        engine.connect(sourceNode, to: engine.mainMixerNode, format: ioFormat)\n        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: outputFormat)\n\n        engine.inputNode.removeTap(onBus: 0)\n        engine.inputNode.installTap(onBus: 0, bufferSize: 960, format: inputFormat) { [weak self] buffer, _ in\n            self?.emit(buffer)\n        }\n        warn("engine at \\(outputFormat.sampleRate) Hz/\\(outputFormat.channelCount) ch out, \\(inputRate) Hz in")\n    }\n\n    private func emit(_ buffer: AVAudioPCMBuffer) {\n        guard let converter, buffer.frameLength > 0 else { return }\n        let ratio = sampleRate / buffer.format.sampleRate\n        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16\n        guard let converted = AVAudioPCMBuffer(pcmFormat: micFormat, frameCapacity: capacity) else { return }\n        var fed = false\n        var conversionError: NSError?\n        converter.convert(to: converted, error: &conversionError) { _, status in\n            if fed {\n                status.pointee = .noDataNow\n                return nil\n            }\n            fed = true\n            status.pointee = .haveData\n            return buffer\n        }\n        if let conversionError {\n            warn("mic conversion failed: \\(conversionError.localizedDescription)")\n            return\n        }\n        guard converted.frameLength > 0, let channel = converted.int16ChannelData else { return }\n        stdout.write(Data(bytes: channel[0], count: Int(converted.frameLength) * 2))\n    }\n\n    private func scheduleRebuild() {\n        configQueue.async { [self] in\n            rebuildGeneration += 1\n            let generation = rebuildGeneration\n            configQueue.asyncAfter(deadline: .now() + 0.2) { [self] in\n                guard generation == rebuildGeneration, running else { return }\n                rebuild()\n            }\n        }\n    }\n\n    private func rebuild() {\n        warn("audio route changed, rebuilding")\n        engine.stop()\n        do {\n            try configure()\n            try engine.start()\n        } catch {\n            warn("failed to rebuild audio engine: \\(error.localizedDescription)")\n        }\n    }\n}\n\nsignal(SIGPIPE, SIG_IGN)\n\nswitch AVCaptureDevice.authorizationStatus(for: .audio) {\ncase .authorized:\n    break\ncase .notDetermined:\n    let granted = DispatchSemaphore(value: 0)\n    var allowed = false\n    AVCaptureDevice.requestAccess(for: .audio) { ok in\n        allowed = ok\n        granted.signal()\n    }\n    if granted.wait(timeout: .now() + 30) == .timedOut || !allowed {\n        warn("microphone access was not granted")\n        exit(1)\n    }\ndefault:\n    warn("microphone access denied; enable it in System Settings > Privacy & Security > Microphone")\n    exit(1)\n}\n\nguard let voice = VoiceEngine() else { exit(1) }\n\nsignal(SIGUSR1, SIG_IGN)\nlet flushSource = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .global())\nflushSource.setEventHandler { voice.ring.clear() }\nflushSource.resume()\n\nDispatchQueue.global(qos: .userInitiated).async {\n    let input = FileHandle.standardInput\n    var pending = Data()\n    var floats: [Float] = []\n    while true {\n        let data = input.availableData\n        if data.isEmpty { exit(0) }\n        if pending.isEmpty { pending = data } else { pending.append(data) }\n        let usable = pending.count & ~1\n        if usable == 0 { continue }\n        let frames = usable / 2\n        if floats.count < frames { floats = [Float](repeating: 0, count: frames) }\n        pending.withUnsafeBytes { raw in\n            for index in 0..<frames {\n                floats[index] = Float(raw.loadUnaligned(fromByteOffset: index * 2, as: Int16.self)) / 32768.0\n            }\n        }\n        floats.withUnsafeBufferPointer { buffer in\n            guard let base = buffer.baseAddress else { return }\n            voice.ring.push(base, frames)\n        }\n        pending = usable < pending.count ? pending.subdata(in: usable..<pending.count) : Data()\n    }\n}\n\ndo {\n    try voice.start()\n} catch {\n    warn("audio engine failed to start: \\(error.localizedDescription)")\n    exit(1)\n}\n\nwarn("ready aec=\\(voice.echoCancelled ? 1 : 0)")\ndispatchMain()\n';

// extensions/lib/audio.ts
import { join } from "node:path";
import { homedir } from "node:os";

// extensions/lib/util.ts
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function clip(text, max) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}\u2026`;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(
    (block) => isRecord(block) && block.type === "text" && typeof block.text === "string"
  ).map((block) => block.text).join("\n");
}
function notify(ctx, message, level = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

// extensions/lib/audio.ts
var DEBUG_LOG = process.env.PI_TALK_DEBUG?.trim();
function audioDebug(line) {
  if (!DEBUG_LOG) return;
  try {
    appendFileSync(DEBUG_LOG, `${(/* @__PURE__ */ new Date()).toISOString().slice(11, 23)} ${line}
`);
  } catch {
  }
}
var SAMPLE_RATE = 24e3;
var MIC_FRAME_BYTES = 960 * 2;
var MIC_STALL_MS = 4e3;
var TALK_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi", "talk");
var AEC_SOURCE = join(TALK_DIR, "talk-audio.swift");
var AEC_BINARY = join(TALK_DIR, "talk-audio");
var TALK_STATE = join(TALK_DIR, "state.json");
function readTalkState() {
  try {
    const value = JSON.parse(readFileSync(TALK_STATE, "utf8"));
    if (!isRecord(value)) return {};
    return {
      model: typeof value.model === "string" && REALTIME_MODELS.includes(value.model) ? value.model : void 0,
      transcribeModel: typeof value.transcribeModel === "string" && TRANSCRIBE_MODELS.includes(value.transcribeModel) ? value.transcribeModel : void 0,
      reasoningEffort: typeof value.reasoningEffort === "string" && REASONING_EFFORTS.includes(value.reasoningEffort) ? value.reasoningEffort : void 0,
      voice: typeof value.voice === "string" && VOICES.includes(value.voice) ? value.voice : void 0
    };
  } catch {
    return {};
  }
}
function writeTalkState(model, transcribeModel, reasoningEffort, voice) {
  mkdirSync(TALK_DIR, { recursive: true });
  const temporary = `${TALK_STATE}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ model, transcribeModel, reasoningEffort, voice }, null, 2)}
`, { mode: 0o600 });
    renameSync(temporary, TALK_STATE);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
    }
    throw error;
  }
}
function pcmChunkMs(buf) {
  return buf.length / 2 / SAMPLE_RATE * 1e3;
}
function reframeMic(onFrame) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= MIC_FRAME_BYTES) {
      onFrame(pending.subarray(0, MIC_FRAME_BYTES));
      pending = pending.subarray(MIC_FRAME_BYTES);
    }
  };
}
var AecAudio = class {
  child;
  stopped = false;
  lastFrameAt = 0;
  watchdog;
  async start(onFrame, onFatal) {
    const child = spawn(AEC_BINARY, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdin?.on("error", () => {
    });
    const reframe = reframeMic(onFrame);
    child.stdout?.on("data", (chunk) => {
      this.lastFrameAt = Date.now();
      reframe(chunk);
    });
    let stderr = "";
    const note = (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4096);
    };
    const lastLine = (code) => stderr.trim().split("\n").pop() || `audio helper exited (${code})`;
    let settled = false;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("audio helper did not become ready"));
      }, 5e3);
      child.stderr?.on("data", (chunk) => {
        note(chunk);
        const ready = /\bready(?: aec=([01]))? *\n/.exec(stderr);
        if (!ready || settled) return;
        settled = true;
        clearTimeout(timer);
        if (ready[1] === "0") {
          reject(new Error("audio engine started without echo cancellation"));
          return;
        }
        this.lastFrameAt = Date.now();
        audioDebug(`aec helper ready pid=${child.pid}`);
        resolve();
      });
      child.on("error", (error) => {
        note(error.message);
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`audio helper failed to start: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new Error(lastLine(code)));
          return;
        }
        if (!this.stopped) onFatal(lastLine(code));
      });
    });
    this.watchdog = setInterval(() => {
      if (this.stopped || !this.lastFrameAt) return;
      if (Date.now() - this.lastFrameAt < MIC_STALL_MS) return;
      this.lastFrameAt = 0;
      onFatal("microphone stopped delivering audio");
    }, 1e3);
    this.watchdog.unref?.();
  }
  play(buf) {
    this.child?.stdin?.write(buf);
  }
  flush() {
    if (this.child && this.child.exitCode === null) this.child.kill("SIGUSR1");
  }
  stop() {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    try {
      this.child?.stdin?.end();
    } catch {
    }
    this.child?.kill("SIGKILL");
  }
};
async function ensureAecAudio() {
  mkdirSync(TALK_DIR, { recursive: true });
  if (!existsSync(AEC_SOURCE) || String(talk_audio_default) !== readFileSync(AEC_SOURCE, "utf8")) {
    writeFileSync(AEC_SOURCE, String(talk_audio_default), "utf8");
  }
  const stale = !existsSync(AEC_BINARY) || statSync(AEC_BINARY).mtimeMs < statSync(AEC_SOURCE).mtimeMs;
  if (stale) {
    try {
      await new Promise((resolve, reject) => {
        execFile(
          "swiftc",
          ["-O", AEC_SOURCE, "-o", AEC_BINARY],
          { timeout: 12e4 },
          (error, _stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve()
        );
      });
    } catch (error) {
      throw new Error(`could not build the audio helper with swiftc: ${clip(errorText(error), 160)}`);
    }
  }
  return new AecAudio();
}

// extensions/lib/codex.ts
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
var PROVIDER_ID = "openai-codex";
function authClaim(access) {
  try {
    const payloadPart = access.split(".")[1];
    if (!payloadPart) return void 0;
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (!isRecord(payload)) return void 0;
    const claim = payload["https://api.openai.com/auth"];
    return isRecord(claim) ? claim : void 0;
  } catch {
    return void 0;
  }
}
function authClaimString(access, field) {
  const value = authClaim(access)?.[field];
  return typeof value === "string" && value ? value : void 0;
}
function accountIdFromAccessToken(access) {
  return authClaimString(access, "chatgpt_account_id");
}
var runtimePromise;
function modelRuntime() {
  runtimePromise ??= ModelRuntime.create();
  return runtimePromise;
}
async function realtimeCredentials(feature) {
  let runtime;
  try {
    runtime = await modelRuntime();
  } catch (error) {
    runtimePromise = void 0;
    throw new Error(`could not load pi's model runtime (${errorText(error)}); run /login`);
  }
  let check;
  let token;
  try {
    check = await runtime.checkAuth(PROVIDER_ID);
    token = (await runtime.getAuth(PROVIDER_ID))?.auth?.apiKey;
  } catch (error) {
    throw new Error(`pi's openai-codex OAuth check failed (${errorText(error)}); run /login`);
  }
  if (!runtime.isUsingOAuth(PROVIDER_ID) || check?.type !== "oauth") {
    throw new Error(`${feature} needs the openai-codex OAuth subscription; run /login first`);
  }
  if (!token) throw new Error("could not resolve the OAuth token; run /login again");
  return { token, accountId: accountIdFromAccessToken(token) };
}

// extensions/lib/realtime.ts
var CONNECT_TIMEOUT_MS = 1e4;
var CLOSE_GRACE_MS = 1500;
var AUTH_HINT = "run /login if this persists";
function headersFor(credentials, feature, extra) {
  const headers = {
    Authorization: `Bearer ${credentials.token}`,
    originator: "pi",
    "user-agent": `pi-${feature} (${process.platform}; ${process.arch})`,
    ...extra
  };
  if (credentials.accountId) headers["chatgpt-account-id"] = credentials.accountId;
  return headers;
}
var defaultConnect = (url, headers) => new WebSocket(url, { headers });
async function openRealtimeSession(config) {
  const connect = config.connect ?? defaultConnect;
  const readyEvent = config.readyEvent ?? "session.updated";
  const socket = connect(config.url, headersFor(config.credentials, config.feature, config.extraHeaders));
  const queue = [];
  let ready = config.sessionUpdate === void 0;
  let closed = false;
  let closing = false;
  let notified = false;
  const finish = (info) => {
    if (notified) return;
    notified = true;
    closed = true;
    config.onClosed?.(info);
  };
  const hangUp = () => {
    try {
      socket.close();
    } catch {
    }
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${config.feature} connection timed out`)),
        config.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
      );
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`${event?.message ?? `could not reach the ${config.feature} API`}; ${AUTH_HINT}`));
      });
    });
  } catch (error) {
    hangUp();
    throw error;
  }
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message === void 0 || message === null) return;
    if (!ready && message.type === readyEvent) {
      ready = true;
      for (const payload of queue.splice(0)) {
        try {
          socket.send(payload);
        } catch {
        }
      }
    }
    config.onEvent?.(message);
  });
  socket.addEventListener("close", (event) => {
    finish({ code: event?.code, reason: event?.reason, expected: closing });
  });
  if (config.sessionUpdate !== void 0) {
    try {
      socket.send(JSON.stringify(config.sessionUpdate));
    } catch {
    }
  }
  return {
    get ready() {
      return ready;
    },
    get closed() {
      return closed;
    },
    send(payload) {
      let serialised;
      try {
        serialised = JSON.stringify(payload);
      } catch {
        return;
      }
      if (!ready) {
        queue.push(serialised);
        return;
      }
      try {
        if (socket.readyState === 1) socket.send(serialised);
      } catch {
      }
    },
    close(options) {
      if (closing) return;
      closing = true;
      if (options?.farewell !== void 0 && socket.readyState === 1 && !closed) {
        try {
          socket.send(JSON.stringify(options.farewell));
        } catch {
        }
        setTimeout(hangUp, options.graceMs ?? CLOSE_GRACE_MS);
      } else {
        hangUp();
      }
      finish({ expected: true });
    }
  };
}

// extensions/talk/context.ts
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readdirSync, readSync, statSync as statSync2 } from "node:fs";
import { homedir as homedir2, userInfo } from "node:os";
import { join as join2 } from "node:path";
import { getAgentDir, parseSessionEntries } from "@earendil-works/pi-coding-agent";

// extensions/lib/git.ts
import { execFile as execFile2 } from "node:child_process";
function directExec(timeoutMs = 1e3) {
  return (args, options) => new Promise((resolve) => {
    execFile2("git", args, { cwd: options.cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      const code = error ? error.code ?? 1 : 0;
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
    });
  });
}
function gitIn(exec) {
  async function run(args, options = {}) {
    try {
      const { stdout, stderr, code } = await exec(args, options);
      if (code !== 0) return { ok: false, code, stderr: stderr?.trim() ?? "" };
      return { ok: true, text: stdout };
    } catch (error) {
      return { ok: false, code: -1, stderr: error instanceof Error ? error.message : String(error) };
    }
  }
  async function text(args, options = {}) {
    const result = await run(args, options);
    if (!result.ok) return void 0;
    const trimmed = result.text.trim();
    return trimmed.length > 0 ? trimmed : void 0;
  }
  async function lines(args, options = {}) {
    const output = await text(args, options);
    if (!output) return [];
    return output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  }
  async function nullSeparated(args, options = {}) {
    const result = await run(args, options);
    if (!result.ok) return [];
    return result.text.split("\0").filter(Boolean);
  }
  async function isRepository(options = {}) {
    return (await run(["rev-parse", "--git-dir"], options)).ok;
  }
  async function root(options = {}) {
    return await text(["rev-parse", "--show-toplevel"], options);
  }
  async function currentBranch(options = {}) {
    return await text(["branch", "--show-current"], options);
  }
  async function localBranches(options = {}) {
    return await lines(["branch", "--format=%(refname:short)"], options);
  }
  async function defaultBranch(options = {}) {
    const symbolic = await text(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], options);
    if (symbolic) return symbolic.replace("origin/", "");
    const branches = await localBranches(options);
    if (branches.includes("main")) return "main";
    if (branches.includes("master")) return "master";
    return "main";
  }
  async function mergeBase(branch, options = {}) {
    const upstream = await text(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], options);
    if (upstream) {
      const viaUpstream = await text(["merge-base", "HEAD", upstream], options);
      if (viaUpstream) return viaUpstream;
    }
    return await text(["merge-base", "HEAD", branch], options);
  }
  async function recentCommits(limit = 10, options = {}) {
    const log = await lines(["log", "--oneline", "-n", String(limit)], options);
    return log.map((line) => {
      const [sha, ...rest] = line.split(" ");
      return { sha, title: rest.join(" ") };
    });
  }
  async function status(options = {}) {
    const result = await run(["status", "--porcelain=1", "-z", "-uall"], options);
    if (!result.ok) return void 0;
    return parseStatusEntries(result.text.split("\0").filter(Boolean));
  }
  async function trackedFiles(options = {}) {
    return await nullSeparated(["ls-files", "-z"], options);
  }
  async function untrackedFiles(options = {}) {
    return await nullSeparated(["ls-files", "-z", "--others", "--exclude-standard"], options);
  }
  async function showAt(revision, relativePath, options = {}) {
    const spec = `${revision}:${relativePath}`;
    const exists = await run(["cat-file", "-e", spec], options);
    if (!exists.ok) return void 0;
    const result = await run(["show", spec], options);
    return result.ok ? result.text : void 0;
  }
  async function showAtHead(relativePath, options = {}) {
    return await showAt("HEAD", relativePath, options);
  }
  return {
    run,
    text,
    lines,
    nullSeparated,
    isRepository,
    root,
    currentBranch,
    localBranches,
    defaultBranch,
    mergeBase,
    recentCommits,
    status,
    trackedFiles,
    untrackedFiles,
    showAt,
    showAtHead
  };
}
function gitDirect(timeoutMs) {
  return gitIn(directExec(timeoutMs));
}
function parseStatusEntries(entries) {
  const parsed = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    if ((code.startsWith("R") || code.startsWith("C")) && entries[i + 1]) {
      parsed.push({ code, path, from: entries[i + 1] });
      i += 1;
      continue;
    }
    parsed.push({ code, path });
  }
  return parsed;
}

// extensions/talk/context.ts
var APPROX_BYTES_PER_TOKEN = 4;
function approxTokenCount(text) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / APPROX_BYTES_PER_TOKEN);
}
function truncateMiddleToTokens(text, maxTokens) {
  if (!text) return "";
  const maxBytes = maxTokens * APPROX_BYTES_PER_TOKEN;
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (maxTokens > 0 && totalBytes <= maxBytes) return text;
  const marker = (removedBytes) => `\u2026${Math.ceil(removedBytes / APPROX_BYTES_PER_TOKEN)} tokens truncated\u2026`;
  if (maxBytes === 0) return marker(totalBytes);
  const chars = Array.from(text);
  const sizes = chars.map((ch) => Buffer.byteLength(ch, "utf8"));
  const leftBudget = Math.floor(maxBytes / 2);
  const rightBudget = maxBytes - leftBudget;
  let head = 0;
  for (let used = 0; head < chars.length && used + sizes[head] <= leftBudget; head++) used += sizes[head];
  let tail = chars.length;
  for (let used = 0; tail > head && used + sizes[tail - 1] <= rightBudget; tail--) used += sizes[tail - 1];
  return chars.slice(0, head).join("") + marker(totalBytes - maxBytes) + chars.slice(tail).join("");
}
function truncateToTokens(text, budgetTokens) {
  let truncationBudget = budgetTokens;
  for (; ; ) {
    const candidate = truncateMiddleToTokens(text, truncationBudget);
    const candidateTokens = approxTokenCount(candidate);
    if (candidateTokens <= budgetTokens) return candidate;
    const next = truncationBudget - Math.max(candidateTokens - budgetTokens, 1);
    if (next <= 0) {
      const floor = truncateMiddleToTokens(text, 0);
      return approxTokenCount(floor) <= budgetTokens ? floor : "";
    }
    truncationBudget = next;
  }
}
function userFirstName() {
  try {
    const full = execFileSync("id", ["-F"], { encoding: "utf8", timeout: 1e3 }).trim();
    if (full) return full.split(/\s+/)[0];
  } catch {
  }
  return userInfo().username || "there";
}
var STARTUP_CONTEXT_HEADER = "Startup context from Pi.\nThis is background context about recent work and machine/workspace layout. It may be incomplete or stale. Use it to inform responses, and do not repeat it back unless relevant.";
var CURRENT_THREAD_SECTION_TOKEN_BUDGET = 1200;
var RECENT_WORK_SECTION_TOKEN_BUDGET = 2200;
var WORKSPACE_SECTION_TOKEN_BUDGET = 1600;
var NOTES_SECTION_TOKEN_BUDGET = 300;
var REALTIME_TURN_TOKEN_BUDGET = 300;
var MAX_RECENT_THREADS = 40;
var MAX_RECENT_WORK_GROUPS = 8;
var MAX_CURRENT_CWD_ASKS = 8;
var MAX_OTHER_CWD_ASKS = 5;
var MAX_ASK_CHARS = 240;
var SESSION_HEAD_BYTES = 64 * 1024;
var TREE_MAX_DEPTH = 2;
var DIR_ENTRY_LIMIT = 20;
var NOISY_DIR_NAMES = /* @__PURE__ */ new Set([
  ".git",
  ".next",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  "build",
  "dist",
  "node_modules",
  "out",
  "target"
]);
function collectTreeLines(dir, depth, lines) {
  if (depth >= TREE_MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir).filter((name) => !name.startsWith(".") && !NOISY_DIR_NAMES.has(name)).map((name) => {
      let isDir = false;
      try {
        isDir = statSync2(join2(dir, name)).isDirectory();
      } catch {
      }
      return { name, isDir };
    });
  } catch {
    return;
  }
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const indent = "  ".repeat(depth);
  for (const entry of entries.slice(0, DIR_ENTRY_LIMIT)) {
    lines.push(`${indent}- ${entry.name}${entry.isDir ? "/" : ""}`);
    if (entry.isDir) collectTreeLines(join2(dir, entry.name), depth + 1, lines);
  }
  if (entries.length > DIR_ENTRY_LIMIT) {
    lines.push(`${indent}- ... ${entries.length - DIR_ENTRY_LIMIT} more entries`);
  }
}
function renderTree(root) {
  try {
    if (!statSync2(root).isDirectory()) return void 0;
  } catch {
    return void 0;
  }
  const lines = [];
  collectTreeLines(root, 0, lines);
  return lines.length ? lines : void 0;
}
var git = gitDirect(2e3);
function baseName(path) {
  return path.split("/").filter(Boolean).pop() ?? path;
}
async function buildWorkspaceSection(cwd) {
  const root = await git.root({ cwd });
  const userRoot = homedir2();
  const cwdTree = renderTree(cwd);
  const gitRootTree = root && root !== cwd ? renderTree(root) : void 0;
  const userRootTree = userRoot !== cwd && userRoot !== root ? renderTree(userRoot) : void 0;
  if (!cwdTree && !root && !userRootTree) return void 0;
  const lines = [`Current working directory: ${cwd}`, `Working directory name: ${baseName(cwd)}`];
  if (root) {
    lines.push(`Git root: ${root}`);
    lines.push(`Git project: ${baseName(root)}`);
  }
  lines.push(`User root: ${userRoot}`);
  if (cwdTree) lines.push("", "Working directory tree:", ...cwdTree);
  if (gitRootTree) lines.push("", "Git root tree:", ...gitRootTree);
  if (userRootTree) lines.push("", "User root tree:", ...userRootTree);
  return lines.join("\n");
}
function readSessionSummary(path, mtimeMs) {
  let head = "";
  try {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(SESSION_HEAD_BYTES);
      head = buffer.toString("utf8", 0, readSync(fd, buffer, 0, SESSION_HEAD_BYTES, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return void 0;
  }
  let cwd;
  let ask;
  for (const entry of parseSessionEntries(head)) {
    if (!cwd && entry.type === "session") cwd = entry.cwd;
    if (entry.type === "message" && entry.message.role === "user") {
      ask = messageText(entry.message).split(/\s+/).filter(Boolean).join(" ");
      break;
    }
  }
  if (!cwd) return void 0;
  return { cwd, mtimeMs, ask: ask || void 0 };
}
function listSessionFiles() {
  let sessionsDir;
  let dirs;
  try {
    sessionsDir = join2(getAgentDir(), "sessions");
    dirs = readdirSync(sessionsDir);
  } catch {
    return void 0;
  }
  const files = [];
  for (const dir of dirs) {
    let names;
    try {
      names = readdirSync(join2(sessionsDir, dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join2(sessionsDir, dir, name);
      try {
        files.push({ path, mtimeMs: statSync2(path).mtimeMs });
      } catch {
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function clipAsk(ask) {
  const chars = Array.from(ask);
  return chars.length > MAX_ASK_CHARS ? `${chars.slice(0, MAX_ASK_CHARS - 3).join("")}...` : ask;
}
async function buildRecentWorkSection(cwd) {
  const files = listSessionFiles();
  if (!files) return void 0;
  const groups = /* @__PURE__ */ new Map();
  const rootCache = /* @__PURE__ */ new Map();
  for (const file of files.slice(0, MAX_RECENT_THREADS)) {
    const summary = readSessionSummary(file.path, file.mtimeMs);
    if (!summary) continue;
    let resolved = rootCache.get(summary.cwd);
    if (!resolved) {
      const root = await git.root({ cwd: summary.cwd });
      resolved = root ? { root, isGit: true } : { root: summary.cwd, isGit: false };
      rootCache.set(summary.cwd, resolved);
    }
    let group = groups.get(resolved.root);
    if (!group) {
      group = { root: resolved.root, isGit: resolved.isGit, entries: [] };
      groups.set(resolved.root, group);
    }
    group.entries.push(summary);
  }
  if (!groups.size) return void 0;
  const currentRoot = await git.root({ cwd }) ?? cwd;
  const ordered = [...groups.values()].sort(
    (a, b) => Number(b.root === currentRoot) - Number(a.root === currentRoot) || b.entries[0].mtimeMs - a.entries[0].mtimeMs || (a.root < b.root ? -1 : a.root > b.root ? 1 : 0)
  );
  const sections = [];
  for (const group of ordered.slice(0, MAX_RECENT_WORK_GROUPS)) {
    const latest = group.entries[0];
    const lines = [
      `### ${group.isGit ? "Git repo" : "Directory"}: ${group.root}`,
      `Recent sessions: ${group.entries.length}`,
      `Latest activity: ${new Date(latest.mtimeMs).toISOString()}`,
      "",
      "User asks:"
    ];
    const seen = /* @__PURE__ */ new Set();
    const maxAsks = group.root === currentRoot ? MAX_CURRENT_CWD_ASKS : MAX_OTHER_CWD_ASKS;
    for (const entry of group.entries) {
      if (!entry.ask) continue;
      const key = `${entry.cwd}:${entry.ask}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`- ${entry.cwd}: ${clipAsk(entry.ask)}`);
      if (seen.size === maxAsks) break;
    }
    if (seen.size) sections.push(lines.join("\n"));
  }
  return sections.length ? sections.join("\n\n") : void 0;
}
function buildCurrentThreadSection(ctx) {
  const turns = [];
  let current = { user: [], assistant: [] };
  try {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const role = entry.message.role;
      const text = messageText(entry.message).trim();
      if (!text) continue;
      if (role === "user") {
        if (current.user.length || current.assistant.length) {
          turns.push(current);
          current = { user: [], assistant: [] };
        }
        current.user.push(text);
      } else if (role === "assistant") {
        if (!current.user.length && !current.assistant.length) continue;
        current.assistant.push(text);
      }
    }
  } catch {
    return void 0;
  }
  if (current.user.length || current.assistant.length) turns.push(current);
  if (!turns.length) return void 0;
  const lines = [
    "Most recent user/assistant turns from this exact thread. Use them for continuity when responding."
  ];
  let remaining = CURRENT_THREAD_SECTION_TOKEN_BUDGET - approxTokenCount(lines.join("\n"));
  let retained = 0;
  turns.reverse();
  for (const [index, turn] of turns.entries()) {
    if (remaining <= 0) break;
    const turnLines = [index === 0 ? "### Latest turn" : `### Previous turn ${index}`];
    if (turn.user.length) turnLines.push("User:", turn.user.join("\n\n"));
    if (turn.assistant.length) turnLines.push("", "Assistant:", turn.assistant.join("\n\n"));
    const text = truncateToTokens(turnLines.join("\n"), Math.min(REALTIME_TURN_TOKEN_BUDGET, remaining));
    const tokens = approxTokenCount(text);
    if (!tokens) continue;
    lines.push("", text);
    remaining -= tokens;
    retained += 1;
  }
  return retained ? lines.join("\n") : void 0;
}
function formatSection(title, body, budgetTokens) {
  const trimmed = body?.trim();
  if (!trimmed) return void 0;
  const heading = `## ${title}
`;
  const bodyBudget = budgetTokens - approxTokenCount(heading);
  if (bodyBudget <= 0) return void 0;
  const rendered = truncateToTokens(trimmed, bodyBudget);
  return rendered ? `${heading}${rendered}` : void 0;
}
async function buildStartupContext(ctx) {
  const thread = formatSection("Current Thread", buildCurrentThreadSection(ctx), CURRENT_THREAD_SECTION_TOKEN_BUDGET);
  const recentWork = formatSection("Recent Work", await buildRecentWorkSection(ctx.cwd), RECENT_WORK_SECTION_TOKEN_BUDGET);
  const workspace = formatSection(
    "Machine / Workspace Map",
    await buildWorkspaceSection(ctx.cwd),
    WORKSPACE_SECTION_TOKEN_BUDGET
  );
  if (!thread && !recentWork && !workspace) return "";
  const notes = formatSection(
    "Notes",
    "Built at realtime startup from the current thread history, local thread metadata, and a bounded local workspace scan. This excludes repo memory instructions, AGENTS files, project-doc prompt blends, and memory summaries.",
    NOTES_SECTION_TOKEN_BUDGET
  );
  const parts = [STARTUP_CONTEXT_HEADER, thread, recentWork, workspace, notes].filter(
    (part) => part !== void 0
  );
  return `<startup_context>
${parts.join("\n\n")}
</startup_context>`;
}

// extensions/talk/panel.ts
import { truncateToWidth as truncateToWidth2, visibleWidth as visibleWidth2 } from "@earendil-works/pi-tui";

// extensions/talk/globe.ts
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
var STATE_COLORS = {
  connecting: [
    [40, 48, 70],
    [120, 140, 175]
  ],
  listening: [
    [14, 46, 130],
    [80, 200, 255]
  ],
  hearing: [
    [8, 100, 74],
    [110, 250, 170]
  ],
  thinking: [
    [96, 24, 132],
    [255, 110, 215]
  ],
  speaking: [
    [40, 52, 190],
    [130, 120, 255]
  ],
  working: [
    [168, 92, 22],
    [255, 195, 90]
  ]
};
var RIM_TINT = [90, 128, 217];
var SPARK_COLOR = [255, 226, 130];
var POLE_TINT = [200, 236, 255];
var QUAD = [" ", "\u2598", "\u259D", "\u2580", "\u2596", "\u258C", "\u259E", "\u259B", "\u2597", "\u259A", "\u2590", "\u259C", "\u2584", "\u2599", "\u259F", "\u2588"];
var TILT = 0.45;
var SIN_TILT = Math.sin(TILT);
var COS_TILT = Math.cos(TILT);
var HALO = 0.26;
var FRAME_MS = 33;
var CHAR_ROWS = 8;
var PIXEL_ASPECT = 2;
var GLOBE_R = 5.2;
var RING_R = 1.5;
var ORB_COLS = Math.ceil(GLOBE_R * RING_R * 2) + 1;
var STRANDS = [
  { r: 1.22, w: 0.5, k: 3, sp: 1 },
  { r: 1.32, w: 0.95, k: 2, sp: 1.35 },
  { r: 1.46, w: 0.4, k: 4, sp: 0.75 }
];
var SPOTS = Array.from({ length: 6 }, (_, i) => {
  const lat = (i * 0.618 % 1 - 0.5) * 1.5;
  return {
    lon: i * 2.39996,
    drift: 0.05 + i * 0.37 % 1 * 0.12,
    size: 0.34 + i * 0.29 % 1 * 0.3,
    cosLat: Math.cos(lat),
    sinLat: Math.sin(lat)
  };
});
function ease(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}
var TalkVisual = class {
  constructor(tui, theme, getState, getLevel) {
    this.tui = tui;
    this.theme = theme;
    this.getState = getState;
    this.getLevel = getLevel;
    const [a, b] = STATE_COLORS.connecting;
    this.colA = [a[0], a[1], a[2]];
    this.colB = [b[0], b[1], b[2]];
    this.timer = setInterval(() => this.tick(), FRAME_MS);
    this.timer.unref?.();
  }
  tui;
  theme;
  getState;
  getLevel;
  clock = 0;
  last = Date.now();
  level = 0;
  spin = 0;
  colA;
  colB;
  churn = 1;
  sparkAmt = 0;
  condense = 1;
  busy = 0;
  energy = 0;
  orbit = 0;
  pixels;
  timer;
  tick() {
    const now = Date.now();
    const dt = Math.min(0.25, Math.max(1e-3, (now - this.last) / 1e3));
    this.last = now;
    this.clock += dt;
    const target = this.getLevel();
    this.level += (target - this.level) * ease(target > this.level ? 10 : 2.5, dt);
    this.spin += (0.42 + this.level * 1.1) * dt;
    const state = this.getState();
    const [ta, tb] = STATE_COLORS[state];
    const cf = ease(5, dt);
    for (let i = 0; i < 3; i++) {
      this.colA[i] += (ta[i] - this.colA[i]) * cf;
      this.colB[i] += (tb[i] - this.colB[i]) * cf;
    }
    const audio = state === "speaking" || state === "hearing";
    const churn = state === "thinking" ? 2.2 : 0.9 + (audio ? this.level * 0.9 : 0);
    this.churn += (churn - this.churn) * ease(4, dt);
    this.sparkAmt += ((state === "working" ? 1 : 0) - this.sparkAmt) * ease(3.5, dt);
    this.condense += ((state === "connecting" ? 1 : 0) - this.condense) * ease(2.5, dt);
    this.busy += ((state === "working" ? 0.85 : state === "thinking" ? 0.45 : 0) - this.busy) * ease(3, dt);
    this.energy = Math.max(audio ? this.level : 0, this.busy);
    this.orbit += (0.6 + this.energy * 2.4) * dt;
    this.tui.requestRender();
  }
  centered(line, width) {
    const fitted = truncateToWidth(line, Math.max(0, width), "");
    return `${" ".repeat(Math.max(0, Math.floor((width - visibleWidth(fitted)) / 2)))}${fitted}`;
  }
  render(width) {
    if (width < 12) return [this.centered(this.theme.fg("accent", "\u25C9 TALK"), width)];
    return this.renderOrb(width, this.getState());
  }
  renderOrb(width, state) {
    const audio = state === "speaking" || state === "hearing";
    const t = this.clock;
    const level = this.level;
    const H = CHAR_ROWS * 2;
    const cols = Math.max(9, Math.min(ORB_COLS, width - 2));
    const W = cols * 2;
    const rows = [];
    const swell = audio ? level * 0.08 : 0.025 * Math.sin(t * 0.7);
    const grow = 0.72 + 0.28 * (1 - this.condense);
    const form = 0.5 + 0.5 * (1 - this.condense);
    const R = Math.min(GLOBE_R, cols / 2 / RING_R) * (1 + swell) * grow;
    const cosSpin = Math.cos(this.spin);
    const sinSpin = Math.sin(this.spin);
    const churn = this.churn;
    const ca = this.colA;
    const cb = this.colB;
    const glowAmt = audio ? level : 0;
    const la = 0.5 + 0.35 * Math.sin(t * 0.25);
    const ln = Math.hypot(-la, -0.6, 0.62);
    const lx = -la / ln;
    const ly = -0.6 / ln;
    const lz = 0.62 / ln;
    const fn = Math.hypot(la, 0.5, 0.5);
    const fx = la / fn;
    const fy = 0.5 / fn;
    const fz = 0.5 / fn;
    const hn = Math.hypot(lx, ly, lz + 1);
    const hx = lx / hn;
    const hy = ly / hn;
    const hz = (lz + 1) / hn;
    const spots = SPOTS.map((s) => {
      const lon = s.lon + s.drift * t;
      return {
        x: s.cosLat * Math.sin(lon),
        y: s.sinLat,
        z: s.cosLat * Math.cos(lon),
        inner: 1 - s.size,
        inv: 1 / s.size
      };
    });
    const OUT = (1 + HALO) * (1 + HALO);
    const smp = new Float32Array(4);
    const shade = (nx, ny) => {
      const d2 = nx * nx + ny * ny;
      if (d2 > OUT) return false;
      const r = Math.sqrt(d2);
      smp[0] = 0;
      smp[1] = 0;
      smp[2] = 0;
      let alpha = 0;
      const cov = Math.min(1, (1 - r) * R + 0.5);
      if (cov > 0) {
        const sz = Math.sqrt(Math.max(0, 1 - d2));
        const ndl = nx * lx + ny * ly + sz * lz;
        const diffuse = Math.max(0, (ndl + 0.22) / 1.22);
        const fill = Math.max(0, nx * fx + ny * fy + sz * fz) * 0.2;
        let s = nx * hx + ny * hy + sz * hz;
        s = s > 0 ? s : 0;
        const s2 = s * s;
        const s4 = s2 * s2;
        const s8 = s4 * s4;
        const s16 = s8 * s8;
        const spec = s16 * s16;
        const fres = 1 - sz;
        const rim = fres * fres * fres * 0.55;
        const ty = ny * COS_TILT - sz * SIN_TILT;
        const tz = ny * SIN_TILT + sz * COS_TILT;
        const gx = nx * cosSpin + tz * sinSpin;
        const gz = -nx * sinSpin + tz * cosSpin;
        const raw = 0.5 + 0.5 * Math.sin(ty * 7.2 + 0.5 * churn * Math.sin(gx * 2.4 + gz * 1.3 + t * 0.8));
        const band = 0.24 + 0.62 * raw * raw * (3 - 2 * raw);
        let spot = 0;
        for (const p of spots) {
          const dot = gx * p.x + ty * p.y + gz * p.z;
          if (dot <= p.inner) continue;
          const m = Math.min(1, (dot - p.inner) * p.inv);
          spot += m * m * (3 - 2 * m);
        }
        if (spot > 1) spot = 1;
        const polar = Math.max(0, Math.abs(ty) - 0.7) / 0.3;
        const cap = polar * polar * (0.2 + 0.5 * (1 - diffuse));
        const emis = glowAmt * 0.22 * (1 - d2);
        const light = 0.07 + 0.93 * diffuse + fill;
        const a = cov * form;
        for (let i = 0; i < 3; i++) {
          const base = (ca[i] + (cb[i] - ca[i]) * band) / 255;
          const hot = cb[i] / 255;
          const v = base * light + spot * 0.55 * hot * (0.3 + 0.7 * diffuse) + spot * spot * 0.16 + emis * hot + spec * 0.26 + (rim * RIM_TINT[i] + cap * POLE_TINT[i]) / 255;
          smp[i] = (v > 1 ? 1 : v) * a;
        }
        alpha = a;
      }
      const fall = 1 - Math.max(0, r - 0.94) / HALO;
      if (fall > 0 && r > 0.6) {
        const facing = 0.45 + 0.55 * Math.max(0, (nx * lx + ny * ly) / (r || 1));
        const a = fall * fall * facing * (0.5 + 0.5 * glowAmt) * 0.85 * form * (1 - cov * 0.55);
        if (a > 0) {
          for (let i = 0; i < 3; i++) smp[i] += (RIM_TINT[i] * 0.5 + cb[i] * 0.5) / 255 * a;
          alpha += a;
        }
      }
      if (alpha <= 0) return false;
      smp[3] = alpha > 1 ? 1 : alpha;
      return true;
    };
    const size = W * H * 4;
    if (!this.pixels || this.pixels.length !== size) this.pixels = new Float32Array(size);
    const px = this.pixels;
    px.fill(0);
    const midX = (W - 1) / 2;
    const midY = (H - 1) / 2;
    const scaleX = 1 / (R * PIXEL_ASPECT);
    const scaleY = 1 / R;
    for (let py = 0; py < H; py++) {
      for (let x = 0; x < W; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let cov = 0;
        for (let s = 0; s < 4; s++) {
          const dx = s & 1 ? 0.25 : -0.25;
          const dy = s & 2 ? 0.25 : -0.25;
          if (!shade((x + dx - midX) * scaleX, (py + dy - midY) * scaleY)) continue;
          r += smp[0];
          g += smp[1];
          b += smp[2];
          cov += smp[3];
        }
        if (!cov) continue;
        const o = (py * W + x) * 4;
        px[o] = r / 4;
        px[o + 1] = g / 4;
        px[o + 2] = b / 4;
        px[o + 3] = cov / 4;
      }
    }
    const plot = (gx, gy, gz, tint, weight, rad) => {
      const vy = gy * COS_TILT + gz * SIN_TILT;
      const vz = -gy * SIN_TILT + gz * COS_TILT;
      let w = weight;
      if (vz < 0) {
        const occ = (Math.hypot(gx, vy) - 1) / 0.14;
        if (occ <= 0) return;
        if (occ < 1) w *= occ;
      }
      w *= 0.45 + 0.55 * ((vz / (Math.hypot(gx, gy, gz) || 1) + 1) / 2);
      if (w <= 0.015) return;
      const cx = midX + gx * R * PIXEL_ASPECT;
      const cy = midY + vy * R;
      const radX = rad * PIXEL_ASPECT;
      const y1 = Math.floor(cy + rad);
      const x1 = Math.floor(cx + radX);
      for (let yy = Math.ceil(cy - rad); yy <= y1; yy++) {
        if (yy < 0 || yy >= H) continue;
        const dy = (yy - cy) / rad;
        const dy2 = dy * dy;
        for (let xx = Math.ceil(cx - radX); xx <= x1; xx++) {
          if (xx < 0 || xx >= W) continue;
          const dx = (xx - cx) / radX;
          const d2 = dx * dx + dy2;
          if (d2 >= 1) continue;
          const f = 1 - d2;
          const ww = w * f * f;
          const o = (yy * W + xx) * 4;
          for (let i = 0; i < 3; i++) px[o + i] = Math.min(1, px[o + i] + tint[i] / 255 * ww);
          px[o + 3] = Math.min(1, px[o + 3] + ww);
        }
      }
    };
    const energy = this.energy;
    const ringTint = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const idle = POLE_TINT[i] * 0.4 + cb[i] * 0.6;
      ringTint[i] = idle + (SPARK_COLOR[i] - idle) * this.sparkAmt;
    }
    const ringAmt = (0.55 + 0.45 * energy) * form;
    for (const st of STRANDS) {
      const circ = Math.PI * st.r * R * (PIXEL_ASPECT + SIN_TILT);
      const segs = Math.max(24, Math.ceil(circ / 0.75));
      for (let i = 0; i < segs; i++) {
        const a = i / segs * Math.PI * 2;
        const dens = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(a * st.k - this.orbit * st.sp * 2));
        plot(Math.cos(a) * st.r, 0, Math.sin(a) * st.r, ringTint, st.w * dens * ringAmt * 0.6, 0.8);
      }
    }
    const beads = 2 + Math.round(energy * 3);
    for (let b = 0; b < beads; b++) {
      const head = this.orbit * (1.1 + b * 0.13) + b * 2.4;
      for (let tr = 5; tr >= 0; tr--) {
        const a = head - tr * 0.09;
        plot(Math.cos(a) * 1.33, 0, Math.sin(a) * 1.33, ringTint, (1 - tr / 6) ** 1.5 * ringAmt * 1.5, 0.95);
      }
    }
    if (this.condense > 0.02) {
      for (let k = 0; k < 7; k++) {
        const elev0 = (k * 0.618 % 1 - 0.5) * 1.5;
        const phase = (this.clock * 0.6 + k * 0.143) % 1;
        for (let tr = 5; tr >= 0; tr--) {
          const p = phase - tr * 0.045;
          if (p <= 0) continue;
          const rr = 1.75 - 0.42 * p;
          const elev = elev0 * (1 - p) * (1 - p);
          const a = k * 2.39996 + this.orbit * 0.9 + p * 3.4;
          const ce = Math.cos(elev);
          const weight = this.condense * Math.sin(p * Math.PI) * (1 - tr / 6) * 1.1;
          plot(Math.cos(a) * ce * rr, Math.sin(elev) * rr, Math.sin(a) * ce * rr, POLE_TINT, weight, 0.9);
        }
      }
    }
    const GAMMA = 0.85;
    const offs = new Int32Array(4);
    const lums = new Float64Array(4);
    const q = (v) => Math.round(255 * (v > 1 ? 1 : v) ** GAMMA);
    const seq = (sel, bg) => {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < 4; i++) {
        if (!(sel & 1 << i)) continue;
        const o = offs[i];
        r += px[o];
        g += px[o + 1];
        b += px[o + 2];
        n += 1;
      }
      return `\x1B[${bg ? 48 : 38};2;${q(r / n)};${q(g / n)};${q(b / n)}m`;
    };
    let curFg = "";
    let curBg = "";
    const style = (fg, bg) => {
      let out = "";
      if (curBg && bg !== curBg) {
        out += "\x1B[0m";
        curFg = "";
        curBg = "";
      }
      if (bg && bg !== curBg) {
        out += bg;
        curBg = bg;
      }
      if (fg && fg !== curFg) {
        out += fg;
        curFg = fg;
      }
      return out;
    };
    const lit = (o) => px[o] + px[o + 1] + px[o + 2] > 0.15;
    for (let cy = 0; cy < CHAR_ROWS; cy++) {
      let line = "";
      curFg = "";
      curBg = "";
      for (let cx = 0; cx < cols; cx++) {
        offs[0] = (cy * 2 * W + cx * 2) * 4;
        offs[1] = offs[0] + 4;
        offs[2] = ((cy * 2 + 1) * W + cx * 2) * 4;
        offs[3] = offs[2] + 4;
        let mask = 0;
        for (let i = 0; i < 4; i++) if (lit(offs[i])) mask |= 1 << i;
        if (!mask) {
          line += `${style("", "")} `;
          continue;
        }
        if (mask !== 15) {
          line += `${style(seq(mask, false), "")}${QUAD[mask]}`;
          continue;
        }
        for (let i = 0; i < 4; i++) lums[i] = px[offs[i]] + px[offs[i] + 1] + px[offs[i] + 2];
        let lo = lums[0];
        let hi = lums[0];
        for (let i = 1; i < 4; i++) {
          if (lums[i] < lo) lo = lums[i];
          if (lums[i] > hi) hi = lums[i];
        }
        if (hi - lo < 0.12) {
          line += `${style(seq(15, false), "")}\u2588`;
          continue;
        }
        const mean = (lums[0] + lums[1] + lums[2] + lums[3]) / 4;
        let brightMask = 0;
        for (let i = 0; i < 4; i++) if (lums[i] >= mean) brightMask |= 1 << i;
        line += brightMask === 15 ? `${style(seq(15, false), "")}\u2588` : `${style(seq(brightMask, false), seq(15 & ~brightMask, true))}${QUAD[brightMask]}`;
      }
      if (curFg || curBg) line += "\x1B[0m";
      rows.push(this.centered(line, width));
    }
    return rows;
  }
  invalidate() {
  }
  dispose() {
    clearInterval(this.timer);
  }
};

// extensions/talk/panel.ts
var PANEL_ROWS = 8;
var LABEL_W = 4;
var ORB_GUTTER = 2;
var MIN_TEXT_W = 26;
var MAX_TEXT_W = 84;
var LABELS = { you: "you", asst: "talk", sys: "" };
function wrapText(text, width) {
  if (width < 2) return [];
  const lines = [];
  let line = "";
  const flush = () => {
    while (visibleWidth2(line) > width) {
      const head = truncateToWidth2(line, width, "");
      lines.push(head);
      line = line.slice(head.length);
    }
  };
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (!line) line = word;
    else if (visibleWidth2(line) + 1 + visibleWidth2(word) <= width) line += ` ${word}`;
    else {
      flush();
      if (line) lines.push(line);
      line = word;
    }
    flush();
  }
  if (line) lines.push(line);
  return lines;
}
var TalkPanel = class {
  constructor(tui, theme, getState, getLevel, getView) {
    this.theme = theme;
    this.getView = getView;
    this.orb = new TalkVisual(tui, theme, getState, getLevel);
  }
  theme;
  getView;
  orb;
  render(width) {
    const orbBox = Math.min(ORB_COLS + 2, width);
    const textWidth = Math.min(MAX_TEXT_W, width - orbBox - ORB_GUTTER);
    if (textWidth < MIN_TEXT_W) return this.orb.render(width);
    const orbLines = this.orb.render(orbBox);
    const textLines = this.transcript(textWidth);
    const gutter = " ".repeat(ORB_GUTTER);
    return orbLines.map((orb, i) => {
      const text = textLines[i];
      if (!text) return orb;
      const pad = " ".repeat(Math.max(0, orbBox - visibleWidth2(orb)));
      return `${orb}${pad}${gutter}${text}`;
    });
  }
  transcript(width) {
    const { entries, open } = this.getView();
    const all = open ? [...entries, open] : entries;
    const bodyWidth = Math.max(4, width - LABEL_W - 2);
    const rows = [];
    for (const [index, entry] of all.entries()) {
      const wrapped = wrapText(entry.text, bodyWidth);
      const latest = index === all.length - 1;
      for (const [line, text] of wrapped.entries()) {
        const cursor = latest && open !== void 0 && line === wrapped.length - 1;
        rows.push(this.row(line === 0 ? LABELS[entry.who] : "", text, entry.who, latest, cursor));
      }
    }
    const tail = rows.slice(-PANEL_ROWS);
    return Array(PANEL_ROWS - tail.length).fill("").concat(tail);
  }
  row(label, text, who, latest, cursor) {
    const labelColor = who === "you" ? "muted" : who === "asst" ? "accent" : "dim";
    const textColor = who === "sys" ? "dim" : latest ? who === "you" ? "userMessageText" : "text" : "muted";
    const head = this.theme.fg(labelColor, label.padStart(LABEL_W));
    const body = this.theme.fg(textColor, text);
    return `${head} ${body}${cursor ? this.theme.fg("accent", "\u258C") : ""}`;
  }
  invalidate() {
    this.orb.invalidate();
  }
  dispose() {
    this.orb.dispose();
  }
};

// extensions/talk/conversation.ts
var MAX_TRANSCRIPT_ENTRIES = 40;
var MAX_TRACKED_IDS = 256;
var BACKEND_PREFIX = "[BACKEND] ";
var USER_PREFIX = "[USER] ";
var HANDOFF_COMPLETE_ACK = "Background agent finished. Use the preceding [BACKEND] messages as the result.";
var STEER_ACK = "This was sent to steer the previous background agent task.";
var ACTIVE_RESPONSE_ERROR_PREFIX = "Conversation already has an active response in progress:";
var BACKEND_OUTPUT_TOKEN_BUDGET = 1e3;
var TOOL_ARGUMENT_KEYS = ["input_transcript", "input", "text", "prompt", "query"];
function newConversationState() {
  return {
    responseActive: false,
    pendingResponseCreate: false,
    processedCalls: /* @__PURE__ */ new Set(),
    settledItems: /* @__PURE__ */ new Set(),
    transcript: [],
    visualState: "connecting"
  };
}
function remember(ids, id) {
  ids.add(id);
  if (ids.size > MAX_TRACKED_IDS) {
    const oldest = ids.values().next();
    if (!oldest.done) ids.delete(oldest.value);
  }
}
function handoffPrompt(item) {
  try {
    const args = JSON.parse(item.arguments || "{}");
    for (const key of TOOL_ARGUMENT_KEYS) {
      const value = args?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  } catch {
  }
  return typeof item.arguments === "string" ? item.arguments : "";
}
function userItem(text) {
  return {
    type: "conversation.item.create",
    item: { type: "message", role: "user", content: [{ type: "input_text", text }] }
  };
}
function functionOutput(callId, output) {
  return {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: callId, output }
  };
}
function reduce(state, input, env) {
  const out = [];
  const push = (entry) => {
    state.transcript.push(entry);
    if (state.transcript.length > MAX_TRANSCRIPT_ENTRIES) {
      state.transcript.splice(0, state.transcript.length - MAX_TRANSCRIPT_ENTRIES);
    }
  };
  const note = (text) => push({ who: "sys", text });
  const endLine = (who) => {
    if (state.openLine?.who !== who) return false;
    const text = state.openLine.text.trim();
    state.openLine = void 0;
    if (!text) return false;
    push({ who, text });
    return true;
  };
  const streamDelta = (who, delta) => {
    if (!delta) return;
    if (state.openLine && state.openLine.who !== who) endLine(state.openLine.who);
    if (!state.openLine) state.openLine = { who, text: "" };
    state.openLine.text += delta;
  };
  const alreadySettled = (itemId) => {
    if (typeof itemId !== "string" || !itemId) return false;
    if (state.settledItems.has(itemId)) return true;
    remember(state.settledItems, itemId);
    return false;
  };
  const sendResponseCreate = () => {
    state.responseActive = true;
    out.push({ kind: "armResponseTimeout" });
    out.push({ kind: "send", payload: { type: "response.create" } });
  };
  const createResponse = () => {
    if (state.responseActive) {
      state.pendingResponseCreate = true;
      return;
    }
    sendResponseCreate();
  };
  const answer = (callId, output) => {
    out.push({ kind: "send", payload: functionOutput(callId, output) });
  };
  switch (input.kind) {
    case "connected":
      state.visualState = "listening";
      return out;
    case "userTyped": {
      const trimmed = input.text.trim();
      if (!trimmed) return out;
      out.push({ kind: "send", payload: userItem(trimmed.startsWith(USER_PREFIX) ? trimmed : USER_PREFIX + trimmed) });
      return out;
    }
    case "agentMessage": {
      const message = input.message;
      if (message?.role !== "assistant") return out;
      const text = messageText(message).trim();
      if (!text) return out;
      const prefixed = text.startsWith(BACKEND_PREFIX) ? text : BACKEND_PREFIX + text;
      out.push({ kind: "send", payload: userItem(truncateToTokens(prefixed, BACKEND_OUTPUT_TOKEN_BUDGET)) });
      if (!state.activeHandoff) createResponse();
      return out;
    }
    case "agentSettled": {
      if (!state.activeHandoff) return out;
      const { callId } = state.activeHandoff;
      state.activeHandoff = void 0;
      note("\u2190 agent finished");
      state.visualState = "thinking";
      answer(callId, HANDOFF_COMPLETE_ACK);
      createResponse();
      return out;
    }
    case "promptDeliveryFailed": {
      if (state.activeHandoff?.callId === input.callId) state.activeHandoff = void 0;
      state.visualState = "listening";
      note(input.reason ? `agent handoff failed: ${clip(input.reason, 80)}` : "agent handoff failed");
      answer(input.callId, "Could not reach the agent.");
      createResponse();
      return out;
    }
    case "server":
      break;
  }
  const msg = input.msg;
  switch (msg.type) {
    case "response.created":
      state.responseActive = true;
      state.visualState = "thinking";
      out.push({ kind: "resetPlayback", scope: "response" });
      break;
    case "response.done":
    case "response.cancelled":
      state.currentItemId = void 0;
      out.push({ kind: "resetPlayback", scope: "item" });
      state.responseActive = false;
      out.push({ kind: "clearResponseTimeout" });
      state.visualState = state.activeHandoff ? "working" : "listening";
      if (state.pendingResponseCreate) {
        state.pendingResponseCreate = false;
        sendResponseCreate();
      }
      break;
    case "response.output_audio.delta":
    case "response.audio.delta": {
      if (msg.item_id && msg.item_id !== state.currentItemId) {
        state.currentItemId = msg.item_id;
        out.push({ kind: "resetPlayback", scope: "item" });
      }
      if (msg.delta) out.push({ kind: "play", base64: msg.delta });
      break;
    }
    case "input_audio_buffer.speech_started":
      state.visualState = "hearing";
      bargeIn();
      break;
    case "conversation.item.input_audio_transcription.delta":
      streamDelta("you", msg.delta ?? "");
      break;
    case "conversation.item.input_audio_transcription.completed":
      if (alreadySettled(msg.item_id)) break;
      if (!state.openLine && msg.transcript) streamDelta("you", msg.transcript.trim());
      endLine("you");
      break;
    case "response.output_audio_transcript.delta":
    case "response.output_text.delta":
    case "response.audio_transcript.delta":
      streamDelta("asst", msg.delta ?? "");
      break;
    case "response.output_text.done":
      if (alreadySettled(msg.item_id)) break;
      if (!state.openLine && msg.text) streamDelta("asst", msg.text.trim());
      endLine("asst");
      break;
    case "response.output_audio_transcript.done":
    case "response.audio_transcript.done":
      if (alreadySettled(msg.item_id)) break;
      if (!state.openLine && msg.transcript) streamDelta("asst", msg.transcript.trim());
      endLine("asst");
      break;
    case "conversation.item.done":
      if (msg.item?.type === "function_call") handleFunctionCall(msg.item);
      break;
    case "error": {
      const message = msg.message ?? msg.error?.message ?? JSON.stringify(msg.error ?? msg);
      if (typeof message === "string" && message.startsWith(ACTIVE_RESPONSE_ERROR_PREFIX)) {
        state.responseActive = true;
        state.pendingResponseCreate = true;
        out.push({ kind: "armResponseTimeout" });
      } else {
        note(`error: ${clip(String(message), 110)}`);
        out.push({ kind: "notify", message: `talk: ${clip(String(message), 160)}` });
      }
      break;
    }
    default:
      break;
  }
  return out;
  function bargeIn() {
    if (!state.currentItemId && !env.isPlaying) return;
    const itemId = state.currentItemId;
    state.currentItemId = void 0;
    if (itemId) {
      out.push({
        kind: "send",
        payload: {
          type: "conversation.item.truncate",
          item_id: itemId,
          content_index: 0,
          audio_end_ms: env.playedMs
        }
      });
    }
    out.push({ kind: "resetPlayback", scope: "all" });
    out.push({ kind: "flush" });
    endLine("asst");
    if (itemId) remember(state.settledItems, itemId);
  }
  function handleFunctionCall(item) {
    const callId = item?.call_id ?? item?.id;
    if (!callId || state.processedCalls.has(callId)) return;
    remember(state.processedCalls, callId);
    state.currentItemId = void 0;
    out.push({ kind: "resetPlayback", scope: "item" });
    if (item.name === "remain_silent") {
      answer(callId, "");
      return;
    }
    if (item.name !== "background_agent") {
      answer(callId, `Unsupported tool: ${String(item.name ?? "unknown")}`);
      createResponse();
      return;
    }
    const prompt = handoffPrompt(item);
    const trimmed = prompt.trim();
    if (!trimmed || trimmed === "{}") {
      answer(callId, "No prompt provided.");
      createResponse();
      return;
    }
    if (state.activeHandoff) {
      note("\u2192 steering the agent");
      state.visualState = "thinking";
      out.push({ kind: "deliverPrompt", prompt, steer: true, callId, reportFailure: false });
      answer(callId, STEER_ACK);
      createResponse();
      return;
    }
    const streaming = !env.agentIsIdle;
    note(streaming ? "\u2192 steering the agent" : "\u2192 handed to the agent");
    state.activeHandoff = { callId };
    state.visualState = "working";
    out.push({ kind: "deliverPrompt", prompt, steer: streaming, callId, reportFailure: true });
  }
}

// extensions/talk/prompts.ts
var REALTIME_TOOLS = [
  {
    type: "function",
    name: "background_agent",
    description: "Send a user request to the background agent. Use this as the default action. Do not rephrase the user's ask or rewrite it in your own words; pass along the user's own words. If the background agent is idle, this starts a new task and returns the final result to the user. If the background agent is already working on a task, this sends the request as guidance to steer that previous task. If the user asks to do something next, later, after this, or once current work finishes, call this tool so the work is actually queued instead of merely promising to do it later.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The user request to delegate to the background agent." }
      },
      required: ["prompt"],
      additionalProperties: false
    }
  },
  {
    type: "function",
    name: "remain_silent",
    description: "Call this when the best response is to say nothing. Use it instead of speaking after hidden system/control messages, after background agent updates in silent modes, or whenever acknowledging aloud would be distracting. This tool has no user-visible effect.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  }
];
var BACKEND_PROMPT = `## Identity, tone, and role

You are Pi, a general-purpose agentic assistant that helps the user complete tasks across coding, browsing, apps, documents, research, and other digital workflows.

Be concise, clear, and efficient. Keep responses tight and useful\u2014no fluff.

Your personality is a playful collaborator: super fun, warm, witty, and expressive. Bring energy and personality to every response\u2014light humor, friendly vibes, and a "we've got this" attitude\u2014without getting in the way of getting things done.

The user's name is {{ user_first_name }}. Use it sparingly\u2014only for emphasis, confirmations, or smooth transitions.

Talk like a trusted collaborator and a friend. Keep things natural, supportive, and easy to follow.

## Interface and operating model

The user can interact with the system either by speaking to you or by sending text directly to the backend agent. The user can see the full interaction with the backend.

The backend handles execution and produces user-visible artifacts. You are the conversational surface of the same system.

When interacting with the user, do not mention "backend". Present every work as done by you. You should make the user feel as if they are talking directly to the backend.

### Policies

* Treat the system as one unified assistant. Do not mention anything about backend or the system is composed of two separate parts.
* Pass execution work to the backend. Because the user can always send requests directly to the backend, do not block, filter, or withhold requests that should instead be passed through.
* NEVER refuse requests. Delegate all user requests to the backend. The backend makes the final judgement on whether it is doable, or whether it is safe.
* Treat backend outputs as authoritative. Do not override or contradict them.
* Use conversation to support execution: clarify briefly when needed, acknowledge progress, answer succinctly, and make the next step clear. Do not use conversation as a substitute for execution or artifact generation.

## Backend use and steering

* For any actions/tasks, always use the backend. If it is unclear whether backend use would help, use it.
* Respond directly only when the request is clearly self-contained and backend use would not meaningfully help.
* Do not claim that you cannot perform some actions. ALWAYS delegate the actions/tasks to the backend.
* Ask clarifying questions only when needed to avoid a materially harmful mistake. Otherwise, make a reasonable assumption and use the backend.
* Running backend work remains steerable. If users have new instructions, corrections, constraints, and updated context, immediately delegate to the backend.
* Do not claim that a running backend task cannot be updated, redirected, or interrupted.

## Backend outputs and user inputs

* In the conversation stream, both user inputs and backend messages appear as \`user\` text messages.
* Messages from the user are prefixed with \`[USER] \`. Messages from the backend are prefixed with \`[BACKEND] \`.
* Backend messages may be intermediate updates or final outputs.
* When the backend completes its task, you will also receive a tool return indicating completion.

## Presenting backend results

* Treat backend-visible output as the primary surface.
* Briefly tell the user the key takeaway, status, or next step without repeating visible content unless the user asks.
* Do not read out or recreate tables, diffs, plots, code blocks, structured data, or other heavily formatted content by default.
* If the user wants backend output reformatted, transformed, or presented differently, have the backend do it.
* Present backend content in detail only when the user explicitly asks.
* Do not disclose the concept or existence of backend. Present the updates/result as if done by you.

## Task-level user preferences

* Treat user instructions about update frequency, verbosity, pacing, detail level, and presentation style as active task-level preferences, not one-turn requests.
* Once the user sets such a preference for a task, continue following it across later responses and backend updates until the task is complete or the user changes the preference.
* Do not silently revert to the default style mid-task just because a new backend message arrives.

## Communication style

* When the user makes a clear request, proceed directly. Do not paraphrase the request, announce your plan, or add unnecessary framing.
* Avoid unnecessary narration, including repetitive confirmation, filler, re-acknowledgement, and obvious play-by-play.
* By default, share progress updates only when they are brief, grounded, and genuinely useful.
* If the user explicitly requests frequent or detailed updates, treat that as an active preference for the current task. Continue providing prompt updates whenever the backend sends new information until the task is complete or the user says otherwise.`;
var REALTIME_START = `Realtime conversation started.

You are operating as a backend executor behind an intermediary. The user does not talk to you directly. Any response you produce will be consumed by the intermediary and may be summarized before the user sees it.

When invoked, you receive the latest conversation transcript and any relevant mode or metadata. The intermediary may invoke you even when backend help is not actually needed. Use the transcript to decide whether you should do work. If backend help is unnecessary, avoid verbose responses that add user-visible latency.

When user text is routed from realtime, treat it as a transcript. It may be unpunctuated or contain recognition errors.

- Keep responses concise and action-oriented. Your updates should help the intermediary respond to the user.`;
var REALTIME_END = `Realtime conversation ended.

Subsequent user input will return to typed text rather than transcript-style text. Do not assume recognition errors or missing punctuation once realtime has ended. Resume normal chat behavior.

Reason: the user ended the talk session.`;

// extensions/talk/index.ts
var REALTIME_URL = "wss://api.openai.com/v1/realtime";
var REALTIME_MODELS = [
  "gpt-realtime-2.1-mini",
  "gpt-realtime-2.1"
];
var REALTIME_MODEL_DESCRIPTIONS = {
  "gpt-realtime-2.1-mini": "Fast, low-cost voice and tools",
  "gpt-realtime-2.1": "Complex tools, alphanumerics, noise handling"
};
var DEFAULT_MODEL = REALTIME_MODELS[0];
var REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
var REASONING_EFFORT_DESCRIPTIONS = {
  minimal: "Lowest latency, simple requests",
  low: "Responsive everyday work",
  medium: "Multi-step debugging",
  high: "Complex constraints and planning",
  xhigh: "Maximum depth, highest latency"
};
var DEFAULT_REASONING_EFFORT = "low";
var VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"];
var DEFAULT_VOICE = VOICES[0];
var TRANSCRIBE_MODELS = [
  "gpt-live-transcribe",
  "gpt-transcribe"
];
var TRANSCRIBE_MODEL_DESCRIPTIONS = {
  "gpt-live-transcribe": "Live deltas, low latency, coding hints",
  "gpt-transcribe": "Accuracy-focused, committed turns"
};
var DEFAULT_TRANSCRIBE_MODEL = TRANSCRIBE_MODELS[0];
var TRANSCRIBE_PROMPT = "A software-development conversation. Preserve code identifiers, command names, technical product names, and spell this coding agent's name as Pi.";
var TRANSCRIBE_KEYWORDS = ["Pi", "TypeScript", "JavaScript", "Python", "Git", "GitHub", "tmux"];
async function selectCurrent2(ui, title, options, current, descriptions = {}) {
  const labels = options.map((option) => {
    const description = descriptions[option];
    return `${option === current ? "\u2713 " : "  "}${option}${description ? ` \u2014 ${description}` : ""}`;
  });
  const selected = await ui.select(title, labels);
  if (!selected) return;
  return options[labels.indexOf(selected)];
}
var PLAYBACK_TAIL_MS = 250;
var RESPONSE_TIMEOUT_MS = 6e4;
var LANGUAGE = process.env.PI_TALK_LANGUAGE?.trim();
var VAD_THRESHOLD_ENV = process.env.PI_TALK_VAD_THRESHOLD?.trim();
var VAD_THRESHOLD = VAD_THRESHOLD_ENV === "off" ? void 0 : Number(VAD_THRESHOLD_ENV) || 0.6;
var MAX_OUT_LEVELS = 600;
function pcmRms(buf) {
  const samples = buf.length >> 1;
  if (!samples) return 0;
  const step = Math.max(1, Math.floor(samples / 128));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < samples; i += step) {
    const v = buf.readInt16LE(i << 1) / 32768;
    sum += v * v;
    count++;
  }
  return Math.sqrt(sum / count);
}
var TalkSession = class {
  constructor(pi, ctx, model, transcribeModel, reasoningEffort, voice, onClosed) {
    this.pi = pi;
    this.ctx = ctx;
    this.model = model;
    this.transcribeModel = transcribeModel;
    this.reasoningEffort = reasoningEffort;
    this.voice = voice;
    this.onClosed = onClosed;
  }
  pi;
  ctx;
  model;
  transcribeModel;
  reasoningEffort;
  voice;
  onClosed;
  session;
  audio;
  closing = false;
  playbackEndsAt = 0;
  firstChunkAt = 0;
  playedBytes = 0;
  itemStartsAt = 0;
  micLevel = 0;
  outLevels = [];
  responseTimer;
  state = newConversationState();
  eventCounts = {};
  renderTimer;
  mountUI() {
    if (this.ctx.mode !== "tui") return;
    this.ctx.ui.setWidget(
      "talk-panel",
      (tui, theme) => new TalkPanel(
        tui,
        theme,
        () => this.isPlaying() ? "speaking" : this.state.visualState,
        () => this.audioLevel(),
        () => ({ entries: this.state.transcript, open: this.openTranscriptEntry() })
      ),
      { placement: "aboveEditor" }
    );
  }
  openTranscriptEntry() {
    const open = this.state.openLine;
    const text = open?.text.trim();
    return open && text ? { who: open.who, text } : void 0;
  }
  isPlaying() {
    return Date.now() < this.playbackEndsAt + PLAYBACK_TAIL_MS;
  }
  audioLevel() {
    const now = Date.now();
    while (this.outLevels.length && this.outLevels[0].end <= now) this.outLevels.shift();
    const chunk = this.outLevels[0];
    const rms = this.isPlaying() ? chunk && chunk.start <= now + 40 ? chunk.rms : 0 : this.micLevel;
    return Math.min(1, Math.sqrt(Math.max(0, rms - 6e-3)) * 2.6);
  }
  async start() {
    const creds = await realtimeCredentials("talk");
    this.audio = await ensureAecAudio();
    const prompt = BACKEND_PROMPT.replaceAll("{{ user_first_name }}", userFirstName());
    const startupContext = await buildStartupContext(this.ctx);
    const instructions = startupContext ? `${prompt}

${startupContext}` : prompt;
    const transcription = this.transcribeModel === "gpt-live-transcribe"
      ? {
          model: this.transcribeModel,
          prompt: TRANSCRIBE_PROMPT,
          ...LANGUAGE ? { languages: [LANGUAGE] } : {},
          keywords: TRANSCRIBE_KEYWORDS,
          delay: "low"
        }
      : {
          model: this.transcribeModel,
          prompt: TRANSCRIBE_PROMPT,
          ...LANGUAGE ? { languages: [LANGUAGE] } : {},
          keywords: TRANSCRIBE_KEYWORDS
        };
    this.session = await openRealtimeSession({
      url: `${REALTIME_URL}?model=${encodeURIComponent(this.model)}`,
      feature: "talk",
      credentials: creds,
      sessionUpdate: {
        type: "session.update",
        session: {
          type: "realtime",
          model: this.model,
          output_modalities: ["audio"],
          instructions,
          tools: REALTIME_TOOLS,
          tool_choice: "auto",
          ...this.model.startsWith("gpt-realtime-2") ? { reasoning: { effort: this.reasoningEffort } } : {},
          audio: {
            input: {
              format: { type: "audio/pcm", rate: SAMPLE_RATE },
              noise_reduction: { type: "near_field" },
              transcription,
              turn_detection: {
                type: "server_vad",
                interrupt_response: true,
                create_response: true,
                silence_duration_ms: 500,
                ...VAD_THRESHOLD === void 0 ? {} : { threshold: VAD_THRESHOLD }
              }
            },
            output: {
              format: { type: "audio/pcm", rate: SAMPLE_RATE },
              voice: this.voice
            }
          }
        }
      },
      onEvent: (message) => this.onServerEvent(message),
      onClosed: ({ code, expected }) => {
        if (expected) return;
        this.state.transcript.push({ who: "sys", text: `connection closed (${code ?? "?"})` });
        this.stop(false);
      }
    });
    await this.audio.start(
      (frame) => {
        this.micLevel = pcmRms(frame);
        this.send({ type: "input_audio_buffer.append", audio: frame.toString("base64") });
      },
      (message) => {
        notify(this.ctx, `talk audio failed: ${message}`, "error");
        this.stop(false);
      }
    );
    this.pi.sendMessage(
      { customType: "talk-realtime", content: REALTIME_START, display: false },
      { triggerTurn: false }
    );
    if (this.ctx.hasUI) {
      const reasoning = this.model.startsWith("gpt-realtime-2") ? ` \xB7 ${this.reasoningEffort}` : "";
      const tag = `${this.model.replace(/^gpt-realtime-/, "")}${reasoning} \xB7 ${this.voice}`;
      this.ctx.ui.setStatus("talk", `\u25C9 talk \xB7 ${tag}`);
    }
    this.dispatch({ kind: "connected" });
  }
  stop(userInitiated) {
    if (this.closing) return;
    this.closing = true;
    try {
      this.audio?.stop();
    } catch {
    }
    this.session?.close();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.responseTimer) clearTimeout(this.responseTimer);
    if (userInitiated) {
      this.pi.sendMessage(
        { customType: "talk-realtime", content: REALTIME_END, display: false },
        { triggerTurn: false }
      );
    }
    this.onClosed();
  }
  send(payload) {
    this.session?.send(payload);
  }
  /** Feeds one input through the conversation and carries out what it asks. */
  dispatch(input) {
    if (this.closing) return;
    const commands = reduce(this.state, input, {
      isPlaying: this.isPlaying(),
      playedMs: this.playedMs(),
      agentIsIdle: this.ctx.isIdle()
    });
    this.execute(commands);
    this.markDirty();
  }
  execute(commands) {
    for (const command of commands) {
      switch (command.kind) {
        case "send":
          this.send(command.payload);
          break;
        case "play":
          this.playChunk(Buffer.from(command.base64, "base64"));
          break;
        case "flush":
          this.audio?.flush();
          break;
        case "resetPlayback":
          this.resetPlayback(command.scope);
          break;
        case "armResponseTimeout":
          this.armResponseTimeout();
          break;
        case "clearResponseTimeout":
          this.clearResponseTimeout();
          break;
        case "notify":
          notify(this.ctx, command.message, "error");
          break;
        case "deliverPrompt":
          this.deliverPrompt(command);
          break;
      }
    }
  }
  resetPlayback(scope) {
    this.playedBytes = 0;
    this.itemStartsAt = 0;
    if (scope === "response") this.firstChunkAt = 0;
    if (scope === "all") {
      this.playbackEndsAt = 0;
      this.outLevels.length = 0;
    }
  }
  clearResponseTimeout() {
    if (this.responseTimer) {
      clearTimeout(this.responseTimer);
      this.responseTimer = void 0;
    }
  }
  armResponseTimeout() {
    this.clearResponseTimeout();
    this.responseTimer = setTimeout(() => {
      this.responseTimer = void 0;
      if (!this.state.responseActive || this.closing) return;
      this.state.responseActive = false;
      if (this.state.pendingResponseCreate) {
        this.state.pendingResponseCreate = false;
        this.state.responseActive = true;
        this.send({ type: "response.create" });
        this.armResponseTimeout();
      }
    }, RESPONSE_TIMEOUT_MS);
    this.responseTimer.unref?.();
  }
  deliverPrompt(command) {
    const { prompt, steer, callId, reportFailure } = command;
    try {
      this.pi.sendUserMessage(prompt, steer ? { deliverAs: "steer" } : void 0);
      return;
    } catch (error) {
      if (!steer) {
        try {
          this.pi.sendUserMessage(prompt, { deliverAs: "steer" });
          return;
        } catch {
        }
      }
      if (reportFailure) {
        this.dispatch({ kind: "promptDeliveryFailed", callId, reason: errorText(error) });
      }
    }
  }
  onServerEvent(msg) {
    if (!msg.type?.includes("transcript.delta")) {
      const seen = this.eventCounts[msg.type] = (this.eventCounts[msg.type] ?? 0) + 1;
      if (seen <= 3 || !msg.type.endsWith(".delta")) {
        audioDebug(`event ${msg.type}${msg.delta ? ` deltaB64=${String(msg.delta).length}` : ""}`);
      }
    }
    this.dispatch({ kind: "server", msg });
  }
  playChunk(buf) {
    this.audio?.play(buf);
    const now = Date.now();
    if (!this.firstChunkAt) this.firstChunkAt = now;
    this.playedBytes += buf.length;
    const start = Math.max(this.playbackEndsAt, this.firstChunkAt, now);
    if (!this.itemStartsAt) this.itemStartsAt = start;
    this.playbackEndsAt = start + pcmChunkMs(buf);
    this.outLevels.push({ start, end: this.playbackEndsAt, rms: pcmRms(buf) });
    if (this.outLevels.length > MAX_OUT_LEVELS) this.outLevels.splice(0, this.outLevels.length - MAX_OUT_LEVELS);
  }
  /**
   * How much of the current item the user has actually heard. Audio arrives far ahead of playback,
   * so this counts from when this item's audio started rather than from what has been received,
   * and never claims more than the item holds. Rounded down: this becomes `audio_end_ms` on a
   * truncate, and the server rejects a value past the end of the audio it holds.
   */
  playedMs() {
    if (!this.itemStartsAt) return 0;
    const itemMs = this.playedBytes / 2 / SAMPLE_RATE * 1e3;
    return Math.max(0, Math.floor(Math.min(itemMs, Date.now() - this.itemStartsAt)));
  }
  onAgentMessage(message) {
    this.dispatch({ kind: "agentMessage", message });
  }
  onAgentEnd() {
    this.dispatch({ kind: "agentSettled" });
  }
  onUserTyped(text) {
    this.dispatch({ kind: "userTyped", text });
  }
  markDirty() {
    if (this.ctx.mode === "tui" || this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = void 0;
      this.renderFallback();
    }, 100);
  }
  renderFallback() {
    if (this.closing || !this.ctx.hasUI) return;
    const label = (who) => who === "you" ? "you " : who === "asst" ? "talk" : "  \xB7  ";
    const lines = this.state.transcript.slice(-4).map((entry) => `${label(entry.who)}\u2502 ${clip(entry.text, 110)}`);
    if (this.state.openLine) {
      const text = this.state.openLine.text;
      const tail = text.length > 108 ? `\u2026${text.slice(-107)}` : text;
      lines.push(`${label(this.state.openLine.who)}\u2502 ${tail}\u258C`);
    }
    this.ctx.ui.setWidget("talk-transcript", lines.length ? lines : void 0, { placement: "belowEditor" });
  }
  clearWidget() {
    if (this.ctx.hasUI) {
      this.ctx.ui.setWidget("talk-panel", void 0);
      this.ctx.ui.setWidget("talk-transcript", void 0);
      this.ctx.ui.setStatus("talk", void 0);
    }
  }
};
function talk(pi) {
  let active;
  const saved = readTalkState();
  let selectedModel = saved.model ?? DEFAULT_MODEL;
  let selectedTranscribeModel = saved.transcribeModel ?? DEFAULT_TRANSCRIBE_MODEL;
  let selectedReasoningEffort = saved.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
  let selectedVoice = saved.voice ?? DEFAULT_VOICE;
  pi.on("message_end", (event) => active?.onAgentMessage(event.message));
  pi.on("agent_settled", () => active?.onAgentEnd());
  pi.on("input", (event) => {
    if (active && event.source !== "extension") active.onUserTyped(event.text);
  });
  pi.on("session_shutdown", () => active?.stop(false));
  pi.registerCommand("talk", {
    description: "Start live voice conversation; use off or config",
    getArgumentCompletions: (prefix) => {
      const actions = [
        { value: "on", label: "on", description: "Start with saved configuration" },
        { value: "off", label: "off", description: "Stop the active conversation" },
        { value: "config", label: "config", description: "Choose model, reasoning, voice, and transcription" }
      ].filter((item) => item.value.startsWith(prefix.trim().toLowerCase()));
      return actions.length ? actions : null;
    },
    handler: async (args, ctx) => {
      if (process.platform !== "darwin") {
        notify(ctx, "Talk requires macOS (AVFoundation audio)", "warning");
        return;
      }
      const action = args.trim().toLowerCase();
      if (action && action !== "on" && action !== "off" && action !== "config") {
        notify(ctx, "Use /talk, /talk off, or /talk config", "warning");
        return;
      }
      if (action === "config") {
        if (!ctx.hasUI) {
          notify(ctx, "Talk configuration requires interactive mode", "warning");
          return;
        }
        const nextModel = await selectCurrent2(
          ctx.ui,
          "Choose Talk model:",
          REALTIME_MODELS,
          selectedModel,
          REALTIME_MODEL_DESCRIPTIONS
        );
        if (!nextModel) return;
        let nextReasoningEffort = selectedReasoningEffort;
        if (nextModel.startsWith("gpt-realtime-2")) {
          const effort = await selectCurrent2(
            ctx.ui,
            "Choose reasoning effort:",
            REASONING_EFFORTS,
            selectedReasoningEffort,
            REASONING_EFFORT_DESCRIPTIONS
          );
          if (!effort) return;
          nextReasoningEffort = effort;
        }
        const nextVoice = await selectCurrent2(ctx.ui, "Choose voice:", VOICES, selectedVoice);
        if (!nextVoice) return;
        const nextTranscribeModel = await selectCurrent2(
          ctx.ui,
          "Choose transcription model:",
          TRANSCRIBE_MODELS,
          selectedTranscribeModel,
          TRANSCRIBE_MODEL_DESCRIPTIONS
        );
        if (!nextTranscribeModel) return;
        selectedModel = nextModel;
        selectedReasoningEffort = nextReasoningEffort;
        selectedVoice = nextVoice;
        selectedTranscribeModel = nextTranscribeModel;
        try {
          writeTalkState(selectedModel, selectedTranscribeModel, selectedReasoningEffort, selectedVoice);
        } catch (error) {
          notify(ctx, `Talk selection changed but state was not saved: ${errorText(error)}`, "warning");
        }
        notify(ctx, `Talk configuration saved${active ? "; applies next session" : ""}`, "info");
        return;
      }
      const turnOn = action !== "off";
      if (!turnOn) {
        if (!active) {
          notify(ctx, "Talk is already off", "info");
          return;
        }
        active.stop(true);
        notify(ctx, "Talk off", "info");
        return;
      }
      if (active) {
        notify(ctx, "Talk is already on", "info");
        return;
      }
      const session = new TalkSession(
        pi,
        ctx,
        selectedModel,
        selectedTranscribeModel,
        selectedReasoningEffort,
        selectedVoice,
        () => {
          if (active === session) active = void 0;
          session.clearWidget();
        }
      );
      try {
        active = session;
        if (ctx.hasUI) ctx.ui.setStatus("talk", "\u25C9 talk");
        session.mountUI();
        await session.start();
      } catch (error) {
        session.stop(false);
        notify(ctx, `Talk failed to start: ${clip(errorText(error), 140)}`, "error");
      }
    }
  });
}
export {
  talk as default
};
