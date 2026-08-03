import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const HISTORY_LIMIT = 100;
const HISTORY_FILE = "history.json";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
type Store = Record<string, string[]>;

function isSubagentProcess(): boolean {
	return process.env.PI_SUBAGENT === "1";
}

function statePath(name: string): string {
	const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	const directory = join(cacheRoot, "pi", "recall");
	mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
	return join(directory, name);
}

function readState<T>(name: string, parse: (value: unknown) => T | undefined): T | undefined {
	let raw: string;
	try {
		raw = readFileSync(statePath(name), "utf8");
	} catch {
		return undefined;
	}

	try {
		return parse(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

function writeState(name: string, value: unknown): void {
	const target = statePath(name);
	const temporary = `${target}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
		renameSync(temporary, target);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {}
		throw error;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	return (
		readState(HISTORY_FILE, (value) => {
			if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

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
		}) ?? {}
	);
}

function writeStore(store: Store): void {
	writeState(HISTORY_FILE, store);
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

export default function recall(pi: ExtensionAPI) {
	if (isSubagentProcess()) return;

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
		const previousEditor = ctx.ui.getEditorComponent();

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previousEditor?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			for (const prompt of history) editor.addToHistory?.(prompt);

			const render = editor.render.bind(editor);
			editor.render = (width: number): string[] => {
				const lines = [...render(width)];
				if (!browsePosition || !lines.length) return lines;

				const border = "─── ";
				const counter = `History ${historyTotal - browsePosition + 1}/${historyTotal} `;
				const labelWidth = visibleWidth(border + counter);
				if (labelWidth <= width && visibleWidth(lines[0]!) >= labelWidth) {
					const borderColor = editor.borderColor ?? ((text: string) => text);
					lines[0] =
						borderColor(border) +
						ctx.ui.theme.fg("dim", counter) +
						truncateToWidth(lines[0]!, width - labelWidth, "");
				}
				return lines;
			};

			const handleInput = editor.handleInput.bind(editor);
			editor.handleInput = (data: string): void => {
				const before = editor.getText();
				const up = keybindings.matches(data, "tui.editor.cursorUp");
				const down = keybindings.matches(data, "tui.editor.cursorDown");
				handleInput(data);
				if (editor.getText() === before) return;
				if (up) browsePosition = Math.min(historyTotal, browsePosition + 1);
				else if (down) browsePosition = Math.max(0, browsePosition - 1);
				else browsePosition = 0;
			};

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
			if (ctx.hasUI) ctx.ui.notify(`Could not save prompt history: ${errorText(error)}`, "warning");
		}
	});
}
