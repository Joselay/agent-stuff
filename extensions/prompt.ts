import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SESSION_ACCENT = "borderAccent" as const;
const BASH_TEXT = "bashMode" as const;
const RIGHT_INSET = 1;
const HISTORY_LIMIT = 100;
const HISTORY_FILE = "history.json";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const BORDER_DECORATIONS = /[─↑↓\d\s.…]+/g;

type Theme = ExtensionContext["ui"]["theme"];
type Paint = (text: string) => string;
type Store = Record<string, string[]>;

function statePath(name: string): string {
	const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	const directory = join(cacheRoot, "pi", "prompt");
	mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
	return join(directory, name);
}

function readState<T>(name: string, parse: (value: unknown) => T | undefined): T | undefined {
	try {
		return parse(JSON.parse(readFileSync(statePath(name), "utf8")));
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

function plainText(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function isBorderLine(line: string): boolean {
	const text = plainText(line);
	return text.includes("─") && text.replace(BORDER_DECORATIONS, "").length === 0;
}

function paintBorder(line: string, paint: Paint): string {
	return isBorderLine(line) ? paint(plainText(line)) : line.replace(/─+/g, paint);
}

function bottomBorderIndex(lines: string[]): number {
	for (let index = lines.length - 1; index > 0; index--) {
		if (isBorderLine(lines[index]!)) return index;
	}
	return lines.length - 1;
}

function badge(theme: Theme, text: string): string {
	const background = theme.getFgAnsi(SESSION_ACCENT).replace("[38;", "[48;");
	return `${background}\x1b[30m ${text} \x1b[39m\x1b[49m`;
}

function fitLabels(left: string, right: string, width: number, paint: Paint): string {
	if (width <= 0) return "";
	if (width === 1) return paint("─");
	const available = width - 2;
	const fittedRight = truncateToWidth(right, available, "");
	const fittedLeft = truncateToWidth(left, Math.max(0, available - visibleWidth(fittedRight)), "");
	const gap = Math.max(0, available - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
	return `${paint("─")}${fittedLeft}${paint("─".repeat(gap))}${fittedRight}${paint("─")}`;
}

function addRightLabel(line: string, label: string, width: number, paint: Paint): string {
	if (width <= 0) return "";
	if (width === 1) return paint("─");
	const fittedLabel = truncateToWidth(label, width - 1, "");
	const labelWidth = visibleWidth(fittedLabel);
	const left = truncateToWidth(line, Math.max(0, width - labelWidth - 4), "");
	const gap = Math.max(0, width - visibleWidth(left) - labelWidth - 1);
	return `${left}${paint("─".repeat(gap))}${fittedLabel}${paint("─")}`;
}

function addHistoryLabel(line: string, position: number, total: number, width: number, paint: Paint, theme: Theme): string {
	const border = "─── ";
	const counter = `History ${total - position + 1}/${total} `;
	const labelWidth = visibleWidth(border + counter);
	if (labelWidth > width || visibleWidth(line) < labelWidth) return line;
	return paint(border) + theme.fg("dim", counter) + truncateToWidth(line, width - labelWidth, "");
}

type EditorState = {
	history: string[];
	getPosition: () => number;
	setPosition: (position: number) => void;
	getTotal: () => number;
	setRender: (render: () => void) => void;
};

function installEditor(pi: ExtensionAPI, ctx: ExtensionContext, state: EditorState): void {
	const previous = ctx.ui.getEditorComponent();
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		state.setRender(() => tui.requestRender());
		const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
		for (const prompt of state.history) editor.addToHistory?.(prompt);

		const render = editor.render.bind(editor);
		editor.render = (width: number): string[] => {
			const lines = [...render(width)];
			if (!lines.length) return lines;

			const currentTheme = ctx.ui.theme;
			const normalBorder = editor.borderColor ?? ((text: string) => text);
			const position = state.getPosition();
			if (position) {
				lines[0] = addHistoryLabel(lines[0]!, position, state.getTotal(), width, normalBorder, currentTheme);
			}

			const name = pi.getSessionName()?.trim();
			const bashMode = editor.getText().trimStart().startsWith("!");
			if (!name && !bashMode) return lines;

			const sessionBorder = (text: string) => currentTheme.fg(SESSION_ACCENT, text);
			if (name) {
				const bottom = bottomBorderIndex(lines);
				lines[0] = paintBorder(lines[0]!, sessionBorder);
				lines[bottom] = paintBorder(lines[bottom]!, sessionBorder);
			}

			const right = name
				? `${badge(currentTheme, name)}${sessionBorder("─".repeat(RIGHT_INSET))}`
				: "";
			if (bashMode) {
				const left = currentTheme.fg(BASH_TEXT, " bash ");
				lines[0] = fitLabels(left, right, width, name ? sessionBorder : normalBorder);
			} else if (name) {
				lines[0] = position
					? addRightLabel(lines[0]!, right, width, sessionBorder)
					: fitLabels("", right, width, sessionBorder);
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
			if (up) state.setPosition(Math.min(state.getTotal(), state.getPosition() + 1));
			else if (down) state.setPosition(Math.max(0, state.getPosition() - 1));
			else state.setPosition(0);
		};

		return editor;
	});
}

export default function promptExtension(pi: ExtensionAPI): void {
	const historyEnabled = process.env.PI_SUBAGENT !== "1";
	let root = "";
	let browsePosition = 0;
	let historyTotal = 0;
	let requestRender: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		browsePosition = 0;
		if (historyEnabled) root = projectRoot(ctx.cwd);
		if (ctx.mode !== "tui") return;

		let history: string[] = [];
		if (historyEnabled) {
			const sessionPrompts = ctx.sessionManager
				.buildContextEntries()
				.map(userPrompt)
				.filter((prompt): prompt is string => !!prompt);
			const currentPrompts = new Set(sessionPrompts);
			history = (readStore()[root] ?? []).filter((prompt) => !currentPrompts.has(prompt));
			const sessionHistory = sessionPrompts.filter((prompt, index) => prompt !== sessionPrompts[index - 1]);
			historyTotal = Math.min(HISTORY_LIMIT, history.length + sessionHistory.length);
		}

		installEditor(pi, ctx, {
			history,
			getPosition: () => browsePosition,
			setPosition: (position) => {
				browsePosition = position;
			},
			getTotal: () => historyTotal,
			setRender: (render) => {
				requestRender = render;
			},
		});
	});

	pi.on("input", (event, ctx) => {
		if (!historyEnabled) return;
		browsePosition = 0;
		try {
			const store = readStore();
			const history = store[root] ?? [];
			const existed = history.includes(event.text.trim());
			if (!addPrompt(history, event.text)) return;
			store[root] = history;
			writeState(HISTORY_FILE, store);
			if (ctx.mode === "tui" && !existed) historyTotal = Math.min(HISTORY_LIMIT, historyTotal + 1);
		} catch (error) {
			if (ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not save prompt history: ${message}`, "warning");
			}
		}
	});

	pi.on("session_info_changed", () => requestRender?.());
	pi.on("session_shutdown", () => {
		requestRender = undefined;
	});
}
