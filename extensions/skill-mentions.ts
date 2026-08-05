import {
	CustomEditor,
	stripFrontmatter,
	type ExtensionAPI,
	type ExtensionContext,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type EditorComponent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const SKILL_PREFIX = "skill:";

const SKILL_COLORS: ThemeColor[] = [
	"accent",
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxType",
	"success",
	"syntaxNumber",
	"error",
	"thinkingMax",
];

// Additional distinct colors from sdras/night-owl-vscode-theme's original
// dark token palette. These are used only after the active theme's unique
// colors are occupied.
const NIGHT_OWL_SKILL_COLORS = [
	"#a2bffc",
	"#ecc48d",
	"#c5e478",
	"#f78c6c",
	"#82aaff",
	"#5ca7e4",
	"#c792ea",
	"#7fdbca",
	"#ff5874",
	"#57eaf1",
	"#ffeb95",
	"#41eec6",
	"#7986e7",
	"#c789d6",
	"#ff869a",
] as const;

type SkillColor = {
	id: string;
	paint: (text: string) => string;
};

type SkillMeta = {
	description: string;
	filePath: string;
	baseDir: string;
};

type SkillIndex = {
	byName: Map<string, SkillMeta>;
	reserved: Set<string>;
	names: string[];
	/** Precompiled once per index: the editor re-renders on every frame. */
	pattern?: RegExp;
};

type SkillToken = {
	prefix: string;
	query: string;
};

/**
 * Capabilities pi's Editor exposes but the EditorComponent contract does not
 * require, so every use is feature-checked before calling.
 */
type SkillAwareEditor = EditorComponent & {
	focused?: boolean;
	getCursor?: () => { line: number; col: number };
	getLines?: () => string[];
	isShowingAutocomplete?: () => boolean;
};

function loadSkillIndex(pi: ExtensionAPI): SkillIndex {
	const byName = new Map<string, SkillMeta>();
	const commands = pi.getCommands();

	// Every command that is not a skill reserves its own name. Two passes,
	// because a name is reserved regardless of where it appears in the list —
	// this used to be a hand-written set of 27 builtins, which the host will
	// simply tell us, and which said nothing about the user's own commands.
	const reserved = new Set<string>(
		commands.filter((command) => command.source !== "skill").map((command) => command.name),
	);

	for (const command of commands) {
		if (command.source !== "skill") continue;
		const name = command.name.startsWith(SKILL_PREFIX)
			? command.name.slice(SKILL_PREFIX.length)
			: command.name;
		if (!name || reserved.has(name)) continue;
		if (byName.has(name)) continue;
		const filePath = command.sourceInfo?.path ?? "";
		const baseDir = filePath ? dirname(filePath) : "";
		byName.set(name, { description: command.description ?? "", filePath, baseDir });
	}

	const names = [...byName.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
	const pattern =
		names.length > 0
			? new RegExp(
					`(^|[\\s([{])(\\/(?:skill:)?(?:${names.map(escapeRegExp).join("|")}))(?=[\\s/]|$)`,
					"g",
				)
			: undefined;
	return { byName, reserved, names, pattern };
}

/**
 * Rendering and keystroke handling both need the index, so rebuilding it per
 * frame would mean re-walking every command, re-sorting, and recompiling the
 * highlight pattern dozens of times a second. Skills only change on reload,
 * which restarts the extension; the TTL just bounds staleness for commands
 * other extensions register after us.
 */
export function createIndexCache(pi: ExtensionAPI, ttlMs = 2000): { get: () => SkillIndex; invalidate: () => void } {
	let cached: SkillIndex | undefined;
	let loadedAt = 0;

	return {
		get: () => {
			const now = Date.now();
			if (!cached || now - loadedAt > ttlMs) {
				cached = loadSkillIndex(pi);
				loadedAt = now;
			}
			return cached;
		},
		invalidate: () => {
			cached = undefined;
		},
	};
}

/**
 * A whole message that is just a skill command, in pi's short form.
 *
 * pi expands `/skill:name args` itself (AgentSession._expandSkillCommand, which
 * runs after this hook) by *replacing* the message with the skill block, so the
 * model never sees the command. Short-form `/name` is this extension's sugar and
 * pi does not know it, so it has to expand the same way — prepending a block and
 * leaving the command in place would both leak `/name` into the prompt and, for
 * the long form, stop the text from starting with `/skill:` and suppress pi's
 * own expansion.
 */
export function splitSkillCommand(
	text: string,
	index: SkillIndex,
): { name: string; args: string } | undefined {
	const match = text.match(/^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/);
	const name = match?.[1];
	if (!name || !index.byName.has(name)) return undefined;
	return { name, args: (match[2] ?? "").trim() };
}

function findSkillMentions(text: string, index: SkillIndex): string[] {
	const re = /(?:^|[\s([{])\/(?:skill:)?([a-z0-9]+(?:-[a-z0-9]+)*)/g;
	const found: string[] = [];
	for (const match of text.matchAll(re)) {
		const name = match[1];
		if (name && index.byName.has(name) && !found.includes(name)) found.push(name);
	}
	return found;
}

function buildSkillBlock(name: string, meta: SkillMeta): string | undefined {
	if (!meta.filePath) return undefined;
	try {
		const body = stripFrontmatter(readFileSync(meta.filePath, "utf-8")).trim();
		return `<skill name="${name}" location="${meta.filePath}">\nReferences are relative to ${meta.baseDir}.\n\n${body}\n</skill>`;
	} catch {
		return undefined;
	}
}

function colorForSkill(
	name: string,
	assigned: Map<string, SkillColor>,
	theme: ExtensionContext["ui"]["theme"],
): SkillColor {
	const existing = assigned.get(name);
	if (existing) return existing;

	const themeCandidates: SkillColor[] = SKILL_COLORS.map((color) => ({
		id: theme.getFgAnsi(color),
		paint: (text) => theme.fg(color, text),
	}));
	const nightOwlCandidates: SkillColor[] = [];
	for (const hex of NIGHT_OWL_SKILL_COLORS) {
		const ansi = hexToForegroundAnsi(hex);
		nightOwlCandidates.push({ id: ansi, paint: (text) => `${ansi}${text}\x1b[39m` });
	}

	let hash = 0;
	for (let i = 0; i < name.length; i++) hash = (hash * 33 + name.charCodeAt(i)) >>> 0;
	// Different semantic tokens can resolve to the same actual color in a
	// theme (for example warning and syntaxType). Compare their ANSI values,
	// not merely their token names.
	const used = new Set([...assigned.values()].map((color) => color.id));
	for (const candidates of [themeCandidates, nightOwlCandidates]) {
		const preferred = hash % candidates.length;
		for (let offset = 0; offset < candidates.length; offset++) {
			const color = candidates[(preferred + offset) % candidates.length]!;
			if (!used.has(color.id)) {
				assigned.set(name, color);
				return color;
			}
		}
	}

	// More visible skills than palette entries: reuse the deterministic color.
	const color = nightOwlCandidates[hash % nightOwlCandidates.length]!;
	assigned.set(name, color);
	return color;
}

function hexToForegroundAnsi(hex: `#${string}`): string {
	const value = Number.parseInt(hex.slice(1), 16);
	return `\x1b[38;2;${(value >> 16) & 0xff};${(value >> 8) & 0xff};${value & 0xff}m`;
}

function extractSkillToken(beforeCursor: string): SkillToken | undefined {
	const match = beforeCursor.match(/(?:^|[\s([{])(\/(?:skill:)?([a-z0-9]*(-[a-z0-9]*)*))$/);
	if (!match?.[1]) return undefined;
	return { prefix: match[1], query: match[2] ?? "" };
}

function beforeCursorText(editor: SkillAwareEditor): string {
	if (editor.getCursor && editor.getLines) {
		const cursor = editor.getCursor();
		return (editor.getLines()[cursor.line] ?? "").slice(0, cursor.col);
	}
	return editor.getText();
}

function needsSpacer(editor: SkillAwareEditor): boolean {
	if (!editor.getCursor || !editor.getLines) return true;
	const cursor = editor.getCursor();
	const after = (editor.getLines()[cursor.line] ?? "").slice(cursor.col);
	return !after.startsWith(" ");
}

/**
 * pi's slash palette, mirroring Editor.isSlashMenuAllowed/isInSlashCommandContext:
 * the first line, starting with a slash. That palette is pi's to own — it lists
 * every command including `skill:` entries — so inline suggestions stay out of
 * it and only cover mid-prompt mentions, where pi offers no dropdown at all.
 */
export function inSlashPalette(cursorLine: number, beforeCursor: string): boolean {
	return cursorLine === 0 && beforeCursor.trimStart().startsWith("/");
}

/** Skill names that extend the typed query, best (shortest, then alphabetical) first. */
export function ghostCandidates(index: SkillIndex, query: string): string[] {
	if (!query) return [];
	return index.names
		.filter((name) => name.length > query.length && name.startsWith(query))
		.sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** The text an inline suggestion would append at the cursor, if any. */
function ghostSuffix(editor: SkillAwareEditor, index: SkillIndex): string | undefined {
	if (editor.getCursor && editor.getLines) {
		const cursor = editor.getCursor();
		const line = editor.getLines()[cursor.line] ?? "";
		if (inSlashPalette(cursor.line, line.slice(0, cursor.col))) return undefined;
		// Only when the cursor sits at the end of the token — completing into the
		// middle of a word would splice the suggestion around the existing tail.
		const after = line.slice(cursor.col);
		if (after !== "" && !after.startsWith(" ")) return undefined;
	}

	const token = extractSkillToken(beforeCursorText(editor));
	if (!token) return undefined;
	const best = ghostCandidates(index, token.query)[0];
	return best?.slice(token.query.length);
}

/**
 * pi-tui draws the editor cursor as one reverse-video grapheme (SGR 7, reset by
 * SGR 0). pi 0.83 has no inline-suggestion API, so decorating that cell is how
 * an extension puts a suggestion inside the input — the same rendered-line
 * decoration that docs/tui.md Pattern 7 uses for its mode indicator. Every
 * lookup below is checked, so an unrecognised render simply gets no suggestion.
 */
const CURSOR_CELL_START = "\x1b[7m";
const CURSOR_CELL_END = "\x1b[0m";

/**
 * Paint the suggestion starting in the cursor's own cell, borrowing columns
 * from the line's trailing padding so the editor keeps its width.
 *
 * The cursor cell is what makes the preview line up: the suggestion has to
 * start *under* the cursor rather than after it, otherwise it previews one
 * column right of where accepting it puts the text, and the token appears to
 * jump left on Tab.
 */
export function injectGhost(
	lines: string[],
	ghost: string,
	theme: ExtensionContext["ui"]["theme"],
): string[] {
	const lineIndex = lines.findIndex((line) => line.includes(CURSOR_CELL_START));
	if (lineIndex === -1) return lines;

	const line = lines[lineIndex]!;
	const cellStart = line.indexOf(CURSOR_CELL_START);
	const graphemeStart = cellStart + CURSOR_CELL_START.length;
	const cellEnd = line.indexOf(CURSOR_CELL_END, graphemeStart);
	if (cellEnd === -1) return lines;

	const cursorGrapheme = line.slice(graphemeStart, cellEnd);
	const after = line.slice(cellEnd + CURSOR_CELL_END.length);
	const trailing = after.trimEnd();
	const padding = visibleWidth(after) - visibleWidth(trailing);

	// Nothing but padding behind a blank cursor cell means the cell is the
	// editor's synthetic end-of-text space, so the suggestion may overwrite it
	// and gain a column. Otherwise the cell holds real text, which shifts right.
	const cursorAtLineEnd = cursorGrapheme === " " && trailing === "";
	const budget = cursorAtLineEnd ? padding + 1 : padding;

	const graphemes = [...ghost];
	const head = graphemes[0];
	if (!head || budget < 1) return lines;
	const text = graphemes.slice(0, budget).join("");
	const tail = text.slice(head.length);

	const painted =
		line.slice(0, cellStart) +
		CURSOR_CELL_START +
		head +
		CURSOR_CELL_END +
		(tail ? theme.fg("dim", tail) : "") +
		(cursorAtLineEnd ? "" : cursorGrapheme) +
		after;

	const next = [...lines];
	// Give back exactly what was borrowed: same visible width as pi rendered.
	next[lineIndex] = truncateToWidth(painted, visibleWidth(line), "");
	return next;
}

function highlightSkillTokens(
	line: string,
	index: SkillIndex,
	theme: ExtensionContext["ui"]["theme"],
	assignedColors: Map<string, SkillColor>,
): string {
	if (!index.pattern || !line.includes("/")) return line;

	return line.replace(index.pattern, (_match, boundary: string, token: string) => {
		const name = token.startsWith("/skill:") ? token.slice("/skill:".length) : token.slice(1);
		if (!index.byName.has(name)) return `${boundary}${token}`;
		return `${boundary}${colorForSkill(name, assignedColors, theme).paint(token)}`;
	});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Suggestions themselves are left entirely to pi: the slash palette keeps
 * listing skills the way it ships. This layer only declines path completion for
 * a mid-prompt skill mention, which the inline suggestion handles instead.
 */
function createSkillAutocompleteProvider(
	current: AutocompleteProvider,
	getIndex: () => SkillIndex,
): AutocompleteProvider {
	return {
		triggerCharacters: current.triggerCharacters,

		getSuggestions(lines, cursorLine, cursorCol, options) {
			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			try {
				const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
				const token = extractSkillToken(beforeCursor);
				if (
					token &&
					!inSlashPalette(cursorLine, beforeCursor) &&
					ghostCandidates(getIndex(), token.query).length > 0
				) {
					return false;
				}
			} catch {
			}
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

/**
 * Decorates whichever editor is configured, rather than subclassing
 * CustomEditor: other editor extensions may already be installed, and only the
 * documented previous-factory composition keeps all of them working.
 */
function installEditor(ctx: ExtensionContext, getIndex: () => SkillIndex): void {
	const previousEditor = ctx.ui.getEditorComponent();

	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = (previousEditor?.(tui, theme, keybindings) ??
			new CustomEditor(tui, theme, keybindings)) as SkillAwareEditor;

		const render = editor.render.bind(editor);
		editor.render = (width: number): string[] => {
			const base = render(width);
			try {
				const index = getIndex();
				// Resolve colors across the whole visible editor so distinct skills
				// cannot collide while palette entries remain available.
				const assignedColors = new Map<string, SkillColor>();
				const lines = base.map((line) =>
					highlightSkillTokens(line, index, ctx.ui.theme, assignedColors),
				);
				if (editor.focused === false || editor.isShowingAutocomplete?.()) return lines;
				const ghost = ghostSuffix(editor, index);
				return ghost ? injectGhost(lines, ghost, ctx.ui.theme) : lines;
			} catch {
				return base;
			}
		};

		const handleInput = editor.handleInput.bind(editor);
		editor.handleInput = (data: string) => {
			try {
				if (
					typeof editor.insertTextAtCursor === "function" &&
					!editor.isShowingAutocomplete?.() &&
					keybindings.matches(data, "tui.input.tab")
				) {
					const ghost = ghostSuffix(editor, getIndex());
					if (ghost) {
						editor.insertTextAtCursor(`${ghost}${needsSpacer(editor) ? " " : ""}`);
						return;
					}
				}
			} catch {
			}

			handleInput(data);
		};

		return editor;
	});
}

export default function skillsExtension(pi: ExtensionAPI) {
	const cache = createIndexCache(pi);
	const getIndex = cache.get;

	pi.on("session_start", (_event, ctx) => {
		cache.invalidate();
		if (ctx.mode !== "tui") return;

		installEditor(ctx, getIndex);
		ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, getIndex));
	});

	pi.on("input", async (event) => {
		if (event.source === "extension") return;

		// pi expands its own `/skill:name` command right after this hook.
		if (event.text.startsWith(`/${SKILL_PREFIX}`)) return;

		try {
			const index = getIndex();

			// A message that is only a skill command expands like pi's does: the
			// command is replaced, never sent alongside the skill.
			const command = splitSkillCommand(event.text, index);
			if (command) {
				const block = buildSkillBlock(command.name, index.byName.get(command.name)!);
				if (!block) return;
				return {
					action: "transform",
					text: command.args ? `${block}\n\n${command.args}` : block,
				};
			}

			const mentions = findSkillMentions(event.text, index);
			if (mentions.length === 0) return;

			const blocks: string[] = [];
			for (const name of mentions) {
				const block = buildSkillBlock(name, index.byName.get(name)!);
				if (block) blocks.push(block);
			}
			if (blocks.length === 0) return;

			return {
				action: "transform",
				text: `${blocks.join("\n\n")}\n\n${event.text}`,
			};
		} catch {
			return;
		}
	});
}
