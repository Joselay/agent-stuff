import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CustomEditor, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorComponent } from "@earendil-works/pi-tui";

const HISTORY_LIMIT = 100;
const HISTORY_FILE = "history.json";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const CHROME = Symbol.for("pi.prompt.chrome.v1");
const HISTORY_ACTIVE = "recall.active";

type Store = Record<string, string[]>;
type RenderState = Map<string, unknown>;
type ChromeRenderContext = {
	editor: EditorComponent;
	lines: string[];
	width: number;
	state: RenderState;
};
type ChromeInputContext = {
	editor: EditorComponent;
	data: string;
	before: string;
};
type ChromeLayer = {
	id: string;
	order: number;
	setup?: (editor: EditorComponent) => void;
	render?: (context: ChromeRenderContext) => void;
	afterInput?: (context: ChromeInputContext) => void;
};
type ChromeCoordinator = {
	layers: Map<string, ChromeLayer>;
	initialized: Set<string>;
};
type CoordinatedEditor = EditorComponent & Record<symbol, ChromeCoordinator | undefined>;

function orderedLayers(coordinator: ChromeCoordinator): ChromeLayer[] {
	return [...coordinator.layers.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function addChromeLayer(editor: EditorComponent, layer: ChromeLayer): void {
	const coordinated = editor as CoordinatedEditor;
	let coordinator = coordinated[CHROME];
	if (!coordinator) {
		coordinator = { layers: new Map(), initialized: new Set() };
		coordinated[CHROME] = coordinator;

		const render = editor.render.bind(editor);
		editor.render = (width: number): string[] => {
			const lines = [...render(width)];
			const state: RenderState = new Map();
			for (const current of orderedLayers(coordinator!)) current.render?.({ editor, lines, width, state });
			return lines;
		};

		const handleInput = editor.handleInput.bind(editor);
		editor.handleInput = (data: string): void => {
			const before = editor.getText();
			handleInput(data);
			for (const current of orderedLayers(coordinator!)) current.afterInput?.({ editor, data, before });
		};
	}

	coordinator.layers.set(layer.id, layer);
	if (layer.setup && !coordinator.initialized.has(layer.id)) {
		coordinator.initialized.add(layer.id);
		layer.setup(editor);
	}
}

function statePath(): string {
	const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	const directory = join(cacheRoot, "pi", "recall");
	mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
	return join(directory, HISTORY_FILE);
}

function addPrompt(history: string[], text: string): boolean {
	const prompt = text.trim();
	if (!prompt || history.at(-1) === prompt) return false;
	const duplicate = history.indexOf(prompt);
	if (duplicate !== -1) history.splice(duplicate, 1);
	history.push(prompt);
	if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
	return true;
}

function readStore(): Store {
	try {
		const value: unknown = JSON.parse(readFileSync(statePath(), "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return {};
		const store: Store = {};
		for (const [root, prompts] of Object.entries(value)) {
			if (!Array.isArray(prompts)) continue;
			const history: string[] = [];
			for (const prompt of prompts) {
				if (typeof prompt === "string") addPrompt(history, prompt);
			}
			store[root] = history;
		}
		return store;
	} catch {
		return {};
	}
}

function writeStore(store: Store): void {
	const target = statePath();
	const temporary = `${target}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: FILE_MODE });
		renameSync(temporary, target);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

function projectRoot(directory: string): string {
	const start = resolve(directory);
	let current = start;
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

function userPrompt(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;
	const { content } = entry.message;
	const text =
		typeof content === "string"
			? content
			: content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
	return text.trim() || undefined;
}

export default function recall(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT === "1") return;

	let root = "";
	let browsePosition = 0;
	let historyTotal = 0;

	pi.on("session_start", (_event, ctx) => {
		root = projectRoot(ctx.cwd);
		browsePosition = 0;
		if (ctx.mode !== "tui") return;

		const sessionPrompts = ctx.sessionManager
			.buildContextEntries()
			.map(userPrompt)
			.filter((prompt): prompt is string => !!prompt);
		const currentPrompts = new Set(sessionPrompts);
		const history = (readStore()[root] ?? []).filter((prompt) => !currentPrompts.has(prompt));
		const sessionHistory = sessionPrompts.filter((prompt, index) => prompt !== sessionPrompts[index - 1]);
		historyTotal = Math.min(HISTORY_LIMIT, history.length + sessionHistory.length);
		const previous = ctx.ui.getEditorComponent();

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			addChromeLayer(editor, {
				id: "recall",
				order: 10,
				setup: (editor) => {
					for (const prompt of history) editor.addToHistory?.(prompt);
				},
				render: ({ editor, lines, width, state }) => {
					if (!browsePosition || !lines.length) return;
					state.set(HISTORY_ACTIVE, true);
					const border = "─── ";
					const counter = `History ${historyTotal - browsePosition + 1}/${historyTotal} `;
					const labelWidth = visibleWidth(border + counter);
					if (labelWidth > width || visibleWidth(lines[0]!) < labelWidth) return;
					const paint = editor.borderColor ?? ((text: string) => text);
					lines[0] =
						paint(border) +
						ctx.ui.theme.fg("dim", counter) +
						truncateToWidth(lines[0]!, width - labelWidth, "");
				},
				afterInput: ({ editor, data, before }) => {
					if (editor.getText() === before) return;
					if (keybindings.matches(data, "tui.editor.cursorUp")) {
						browsePosition = Math.min(historyTotal, browsePosition + 1);
					} else if (keybindings.matches(data, "tui.editor.cursorDown")) {
						browsePosition = Math.max(0, browsePosition - 1);
					} else {
						browsePosition = 0;
					}
				},
			});
			return editor;
		});
	});

	pi.on("input", (event, ctx) => {
		browsePosition = 0;
		try {
			const store = readStore();
			const history = store[root] ?? [];
			const existed = history.includes(event.text.trim());
			if (!addPrompt(history, event.text)) return;
			store[root] = history;
			writeStore(store);
			if (ctx.mode === "tui" && !existed) historyTotal = Math.min(HISTORY_LIMIT, historyTotal + 1);
		} catch (error) {
			if (!ctx.hasUI) return;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not save prompt history: ${message}`, "warning");
		}
	});
}
