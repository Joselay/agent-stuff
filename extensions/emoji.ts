/**
 * Emoji autocomplete and picker.
 * Adapted from Joselay/pi-kit extensions/emoji (MIT).
 * Dataset generated from github/gemoji and emojilib and stored under ~/.cache/pi.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";

const DATA_PATH = join(homedir(), ".cache", "pi", "emoji", "emoji.json");
const GEMOJI_URL = "https://raw.githubusercontent.com/github/gemoji/master/db/emoji.json";
const EMOJILIB_URL = "https://cdn.jsdelivr.net/npm/emojilib@4/dist/emoji-en-US.json";
const UNICODE_URL = "https://unicode.org/Public/emoji/latest/emoji-test.txt";
const MAX_SUGGESTIONS = 20;

type EmojiEntry = { emoji: string; codes: string[]; keywords: string[] };
type Match = { entry: EmojiEntry; code: string };
type GemojiEntry = {
	emoji?: string;
	description?: string;
	aliases?: string[];
	tags?: string[];
};

let entries: EmojiEntry[] | undefined;

const slug = (value: string): string =>
	value
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");

async function ensureDataset(): Promise<void> {
	if (existsSync(DATA_PATH)) return;

	const [gemojiResponse, emojilibResponse, unicodeResponse] = await Promise.all([
		fetch(GEMOJI_URL),
		fetch(EMOJILIB_URL),
		fetch(UNICODE_URL),
	]);
	if (!gemojiResponse.ok || !emojilibResponse.ok || !unicodeResponse.ok) {
		throw new Error("Could not download emoji dataset sources");
	}

	const gemoji = (await gemojiResponse.json()) as GemojiEntry[];
	const emojilib = (await emojilibResponse.json()) as Record<string, string[]>;
	const unicodeText = await unicodeResponse.text();
	const metadata = new Map(
		gemoji.filter((item) => item.emoji).map((item) => [item.emoji!, item]),
	);
	const generated: EmojiEntry[] = [];

	for (const line of unicodeText.split("\n")) {
		if (!line.includes("; fully-qualified")) continue;
		const match = line.match(/; fully-qualified\s+#\s+(\S+)\s+E[\d.]+\s+(.+)$/);
		if (!match) continue;
		const [, emoji, name] = match;
		const item = metadata.get(emoji) ?? metadata.get(emoji.replaceAll("\uFE0F", ""));
		const generatedCode = slug(name);
		const codes = [...(item?.aliases ?? [])];
		if (!codes.includes(generatedCode)) codes.push(generatedCode);

		const candidates = [
			item?.description?.replaceAll(" ", "_"),
			...(item?.tags ?? []),
			...(emojilib[emoji] ?? emojilib[emoji.replaceAll("\uFE0F", "")] ?? []),
		];
		const seen = new Set(codes);
		const keywords: string[] = [];
		for (const candidate of candidates) {
			if (!candidate) continue;
			const keyword = slug(candidate);
			if (keyword && !seen.has(keyword)) {
				seen.add(keyword);
				keywords.push(keyword);
			}
		}
		generated.push({ emoji, codes, keywords: keywords.slice(0, 8) });
	}

	if (generated.length < 3000) throw new Error(`Emoji dataset is unexpectedly small (${generated.length})`);
	mkdirSync(dirname(DATA_PATH), { recursive: true });
	writeFileSync(DATA_PATH, `${JSON.stringify(generated)}\n`);
}

function loadEntries(): EmojiEntry[] {
	if (!entries) {
		entries = JSON.parse(readFileSync(DATA_PATH, "utf8")) as EmojiEntry[];
	}
	return entries;
}

function matchShortcodes(query: string): Match[] {
	const prefix: Match[] = [];
	const loose: Match[] = [];

	for (const entry of loadEntries()) {
		const prefixCode = entry.codes.find((code) => code.startsWith(query));
		if (prefixCode) {
			prefix.push({ entry, code: prefixCode });
			continue;
		}
		const looseCode = entry.codes.find((code) => code.includes(query));
		if (looseCode) loose.push({ entry, code: looseCode });
		else if (entry.keywords.some((keyword) => keyword.startsWith(query))) {
			loose.push({ entry, code: entry.codes[0] });
		}
	}

	const byCode = (a: Match, b: Match) => a.code.localeCompare(b.code);
	return [...prefix.sort(byCode), ...loose.sort(byCode)].slice(0, MAX_SUGGESTIONS);
}

function registerAutocomplete(ctx: ExtensionContext): void {
	ctx.ui.addAutocompleteProvider((current) => ({
		triggerCharacters: [":"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const match = beforeCursor.match(/(?:^|[\s([{])(:([A-Za-z0-9_+-]{2,}))$/);
			if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const matches = matchShortcodes(match[2].toLowerCase());
			if (matches.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return {
				prefix: match[1],
				items: matches.map(({ entry, code }) => ({
					value: entry.emoji,
					label: `${entry.emoji} :${code}:`,
					description: entry.keywords.slice(0, 4).join(", "),
				})),
			};
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	}));
}

async function showPicker(ctx: ExtensionContext, query: string): Promise<void> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify("Emoji picker requires TUI mode", "error");
		return;
	}

	const items: SelectItem[] = loadEntries().map((entry) => ({
		value: entry.emoji,
		label: `${entry.emoji}  :${entry.codes[0]}:`,
		description: entry.keywords.slice(0, 5).join(", "),
	}));

	const selection = await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
		const container = new Container();
		const input = new Input();
		if (query) input.setValue(query);
		const listContainer = new Container();
		let list: SelectList | undefined;

		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(" Insert emoji")), 0, 0));
		container.addChild(input);
		container.addChild(new Spacer(1));
		container.addChild(listContainer);
		container.addChild(new Text(theme.fg("dim", "Type to filter • enter to insert • esc to cancel"), 0, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		const updateList = () => {
			const value = input.getValue();
			const filtered = value
				? fuzzyFilter(items, value, (item) => `${item.label} ${item.description ?? ""}`)
				: items;
			listContainer.clear();
			if (filtered.length === 0) {
				list = undefined;
				listContainer.addChild(new Text(theme.fg("warning", "  No matching emoji"), 0, 0));
				return;
			}
			list = new SelectList(filtered, Math.min(filtered.length, 12), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			listContainer.addChild(list);
		};
		updateList();

		const component = {
			render: (width: number) => container.render(width),
			invalidate: () => {
				container.invalidate();
				updateList();
			},
			handleInput(data: string) {
				const navigating =
					keybindings.matches(data, "tui.select.up") ||
					keybindings.matches(data, "tui.select.down") ||
					keybindings.matches(data, "tui.select.confirm") ||
					keybindings.matches(data, "tui.select.cancel");
				if (navigating) {
					if (list) list.handleInput(data);
					else if (keybindings.matches(data, "tui.select.cancel")) done(null);
				} else {
					input.handleInput(data);
					updateList();
				}
				tui.requestRender();
			},
			focused: false,
		};
		Object.defineProperty(component, "focused", {
			get: () => input.focused,
			set: (value: boolean) => { input.focused = value; },
		});
		return component as typeof component & Focusable;
	});

	if (selection) ctx.ui.pasteToEditor(selection);
}

export default async function emojiExtension(pi: ExtensionAPI): Promise<void> {
	await ensureDataset();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") registerAutocomplete(ctx);
	});

	pi.registerCommand("emoji", {
		description: "Pick an emoji and insert it into the prompt",
		handler: async (args, ctx) => showPicker(ctx, args.trim().replace(/^:+|:+$/g, "")),
	});
}
