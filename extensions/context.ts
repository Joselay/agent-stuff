// Standalone adaptation of Joselay/pi-kit extensions/context
// Source: https://github.com/Joselay/pi-kit/tree/main/extensions/context
// Upstream commit: 3b44674f70e071f3eebda04e88d6d75060231d1a

import {
	type BuildSystemPromptOptions,
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	type ExtensionAPI,
	type ExtensionCommandContext,
	formatSkillsForPrompt,
	getAgentDir,
	getLastAssistantUsage,
	sessionEntryToContextMessages,
	SettingsManager,
	shouldCompact,
	type Skill,
	type SourceInfo,
	type Theme,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

function formatTokensCompact(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Where the context window went.
 *
 * Totals come from the host (`getContextUsage` / provider usage). Parts are
 * attributed with the same estimators pi uses elsewhere — never a local
 * chars/4 or hand-rolled tool counter:
 *
 * | what            | pi API / source                                              |
 * |-----------------|--------------------------------------------------------------|
 * | any text        | `estimateTokens` (user-message shape)                        |
 * | whole prompt    | `estimateTokens` over `ctx.getSystemPrompt()`                |
 * | skills markup   | `formatSkillsForPrompt` (exported), sliced from real prompt  |
 * | context files   | `<project_context>` as `buildSystemPrompt` writes it         |
 * | tool schemas    | JSON of `{name,description,parameters}` — pi-ai wire `Tool`  |
 * | messages        | `estimateTokens` per context message, or remainder of total  |
 * | compact trigger | `shouldCompact` + `SettingsManager.getCompactionSettings()`  |
 */

/** pi's `estimateTokens` over plain text (same chars/4 path compaction uses). */
function tokensOf(text: string): number {
	return estimateTokens({ role: "user", content: text, timestamp: 0 });
}

function safeJsonStringify(value: unknown): string {
	try {
		// Match pi-ai's estimator fallbacks.
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

type SegmentId =
	| "system"
	| "append"
	| "contextFiles"
	| "skills"
	| "builtinTools"
	| "extensionTools"
	| "messages"
	| "reserved"
	| "free";

type ItemScope = "global" | "project" | "package" | "session";

type BreakdownItem = { label: string; tokens: number; scope?: ItemScope };

type Segment = {
	id: SegmentId;
	label: string;
	tokens: number;
	note?: string;
	items: BreakdownItem[];
};

type ContextBreakdown = {
	contextWindow: number;
	used: number;
	free: number;
	measured: boolean;
	willCompact: boolean;
	unattributed: SegmentId[];
	segments: Segment[];
};

type ContextInput = {
	contextWindow: number;
	cwd: string;
	/** `ctx.getSystemPrompt()` — prompt actually in effect. */
	systemPrompt: string;
	/** `ctx.getSystemPromptOptions()` — base inputs behind that prompt. */
	promptOptions: Pick<
		BuildSystemPromptOptions,
		"appendSystemPrompt" | "contextFiles" | "skills" | "customPrompt"
	>;
	/** Host `formatSkillsForPrompt`. */
	formatSkills: (skills: Skill[]) => string;
	tools: readonly ToolInfo[];
	activeTools: readonly string[];
	/**
	 * Message-side estimate from the host when no provider total exists
	 * (`getContextUsage().tokens` while still unmeasured, else sum of
	 * `estimateTokens` over `buildContextEntries` messages).
	 */
	messageTokens: number;
	/**
	 * Provider-backed total from `getContextUsage().tokens` once an assistant
	 * has answered (system + tools + messages + trailing). null otherwise.
	 */
	reportedTokens: number | null;
	compaction: Required<CompactionSettings>;
};

/** One file block inside `<project_context>` — matches `buildSystemPrompt`. */
function contextFileBlock(file: { path: string; content: string }): string {
	return `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
}

/** Full context-files section — matches `buildSystemPrompt` byte-for-byte. */
function contextFilesSection(files: readonly { path: string; content: string }[]): string {
	if (files.length === 0) return "";
	return (
		`\n\n<project_context>\n\n` +
		`Project-specific instructions and guidelines:\n\n` +
		files.map(contextFileBlock).join("") +
		`</project_context>\n`
	);
}

/** Skills fence markers from `formatSkillsForPrompt`. */
const SKILLS_SECTION_RE =
	/\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;

const CONTEXT_FILES_SECTION_RE = /\n\n<project_context>\n\n[\s\S]*?<\/project_context>\n/;

/**
 * Preamble length of `formatSkills`, measured not copied:
 * `2·f(S) − f(S+S) = header`.
 */
function skillsHeaderChars(skills: readonly Skill[], formatSkills: (skills: Skill[]) => string): number {
	if (skills.length === 0) return 0;
	const once = formatSkills([...skills]).length;
	const twice = formatSkills([...skills, ...skills]).length;
	return Math.max(0, 2 * once - twice);
}

/**
 * One skill's own share of the formatted list, via the same difference, then
 * sized with `estimateTokens` (not a local chars/4).
 */
function skillItemTokens(skill: Skill, formatSkills: (skills: Skill[]) => string): number {
	const chars = formatSkills([skill, skill]).length - formatSkills([skill]).length;
	return tokensOf(" ".repeat(Math.max(0, chars)));
}

function scopeOf(sourceInfo: SourceInfo): ItemScope {
	if (sourceInfo.origin === "package") return "package";
	if (sourceInfo.scope === "project") return "project";
	return sourceInfo.scope === "temporary" ? "session" : "global";
}

function scopeOfPath(path: string, cwd: string): ItemScope {
	const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
	return path === cwd || path.startsWith(root) ? "project" : "global";
}

/**
 * pi-ai `Tool` on the wire: `{ name, description, parameters }`.
 * pi-ai sizes tools as `estimateTextTokens(JSON.stringify(tools))`.
 */
function wireTool(tool: ToolInfo): { name: string; description: string; parameters: unknown } {
	return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** Same as pi-ai `estimateToolsTokens` for a tool list. */
function estimateToolsTokens(tools: readonly ToolInfo[]): number {
	if (tools.length === 0) return 0;
	return tokensOf(safeJsonStringify(tools.map(wireTool)));
}

function toolItems(tools: readonly ToolInfo[]): BreakdownItem[] {
	return tools
		.map((tool) => ({
			label: tool.name,
			tokens: tokensOf(safeJsonStringify(wireTool(tool))),
			scope: tool.sourceInfo.source === "builtin" ? undefined : scopeOf(tool.sourceInfo),
		}))
		.sort((a, b) => b.tokens - a.tokens);
}

/**
 * Split one whole-array tool estimate across builtin / extension groups by
 * each group's per-tool share, so the two legend rows sum to the single
 * pi-ai-style total (two separate `JSON.stringify`s would double-count brackets).
 */
function splitToolSegments(activeTools: readonly ToolInfo[]): { builtin: Segment; extension: Segment } {
	const builtinTools = activeTools.filter((tool) => tool.sourceInfo.source === "builtin");
	const extensionTools = activeTools.filter((tool) => tool.sourceInfo.source !== "builtin");
	const builtinItems = toolItems(builtinTools);
	const extensionItems = toolItems(extensionTools);

	const builtinWeight = builtinItems.reduce((sum, item) => sum + item.tokens, 0);
	const extensionWeight = extensionItems.reduce((sum, item) => sum + item.tokens, 0);
	const weight = builtinWeight + extensionWeight;
	const total = estimateToolsTokens(activeTools);

	let builtinTokens = 0;
	let extensionTokens = 0;
	if (weight > 0 && total > 0) {
		builtinTokens = Math.round((builtinWeight / weight) * total);
		extensionTokens = total - builtinTokens;
	} else if (total > 0) {
		// No per-tool weights (empty schemas) — split by count.
		builtinTokens = Math.round((builtinTools.length / activeTools.length) * total);
		extensionTokens = total - builtinTokens;
	}

	return {
		builtin: {
			id: "builtinTools",
			label: "Built-in tools",
			tokens: builtinTokens,
			note: builtinTools.length === 1 ? "1 tool" : `${builtinTools.length} tools`,
			items: builtinItems,
		},
		extension: {
			id: "extensionTools",
			label: "Extension tools",
			tokens: extensionTokens,
			note: extensionTools.length === 1 ? "1 tool" : `${extensionTools.length} tools`,
			items: extensionItems,
		},
	};
}

function findSection(
	prompt: string,
	exact: string,
	fallbackRe: RegExp | undefined,
): { text: string; found: boolean } {
	if (exact.length > 0 && prompt.includes(exact)) {
		return { text: exact, found: true };
	}
	if (fallbackRe) {
		const match = prompt.match(fallbackRe);
		if (match?.[0]) return { text: match[0], found: true };
	}
	return { text: "", found: exact.length === 0 };
}

function buildBreakdown(input: ContextInput): ContextBreakdown {
	const { systemPrompt, promptOptions, formatSkills } = input;
	const unattributed: SegmentId[] = [];

	let base = systemPrompt;
	const take = (id: SegmentId, section: string, expected: boolean): string => {
		if (section.length === 0) {
			if (expected) unattributed.push(id);
			return "";
		}
		if (!base.includes(section)) {
			unattributed.push(id);
			return "";
		}
		base = base.replace(section, "");
		return section;
	};

	// `buildSystemPrompt`: append when truthy, no trim.
	const appendExact = promptOptions.appendSystemPrompt ? `\n\n${promptOptions.appendSystemPrompt}` : "";
	const appendText = take("append", appendExact, false);

	const files = promptOptions.contextFiles ?? [];
	const filesFound = findSection(
		base,
		contextFilesSection(files),
		files.length > 0 ? CONTEXT_FILES_SECTION_RE : undefined,
	);
	const filesText = take("contextFiles", filesFound.text, files.length > 0 && !filesFound.found);

	const skills = (promptOptions.skills ?? []).filter((skill) => formatSkills([skill]).length > 0);
	const skillsExact = formatSkills([...skills]);
	const skillsFound = findSection(base, skillsExact, skills.length > 0 ? SKILLS_SECTION_RE : undefined);
	const skillsText = take("skills", skillsFound.text, skills.length > 0 && !skillsFound.found);
	const skillsHeader = skillsText.length > 0 ? skillsHeaderChars(skills, formatSkills) : 0;

	const active = new Set(input.activeTools);
	const activeTools = input.tools.filter((tool) => active.has(tool.name));
	const { builtin, extension } = splitToolSegments(activeTools);

	const systemLabel = promptOptions.customPrompt ? "Custom system prompt" : "System prompt";
	const promptTexts = [base, appendText, filesText, skillsText];
	// Pi estimates the complete system prompt once. Allocate that authoritative
	// whole-prompt estimate across its slices; estimating each slice separately
	// can overcount by one token per ceil() boundary.
	const promptTokenParts = allocateCells(
		promptTexts.map((text) => text.length),
		tokensOf(systemPrompt),
	);

	const segments: Segment[] = [
		{ id: "system", label: systemLabel, tokens: promptTokenParts[0]!, items: [] },
		{ id: "append", label: "Appended prompt", tokens: promptTokenParts[1]!, items: [] },
		{
			id: "contextFiles",
			label: "Context files",
			tokens: promptTokenParts[2]!,
			note: filesText.length === 0 ? undefined : files.length === 1 ? "1 file" : `${files.length} files`,
			items:
				filesText.length === 0
					? []
					: files.map((file) => ({
							label: file.path,
							tokens: tokensOf(contextFileBlock(file)),
							scope: scopeOfPath(file.path, input.cwd),
						})),
		},
		{
			id: "skills",
			label: "Skills",
			tokens: promptTokenParts[3]!,
			note: skillsText.length === 0 ? undefined : skills.length === 1 ? "1 skill" : `${skills.length} skills`,
			items:
				skillsText.length === 0
					? []
					: skills
							.map((skill) => ({
								label: skill.name,
								// Prefer delta against the real section when exact; header cancel still holds.
								tokens:
									skillsHeader > 0
										? skillItemTokens(skill, formatSkills)
										: tokensOf(" ".repeat(Math.max(0, formatSkills([skill]).length))),
								scope: scopeOf(skill.sourceInfo),
							}))
							.sort((a, b) => b.tokens - a.tokens),
		},
		builtin,
		extension,
	];

	/**
	 * Non-message prefix the way pi-ai estimates a full `Context` when no usage
	 * exists: whole system prompt + whole tools array — not the sum of rounded
	 * parts (which can drift a token per slice).
	 */
	const promptTokens = tokensOf(systemPrompt);
	const toolsTokens = estimateToolsTokens(activeTools);
	const prefixTokens = promptTokens + toolsTokens;

	const measured = input.reportedTokens !== null;
	const reported = input.reportedTokens ?? 0;
	// Provider usage is authoritative. Pi's chars/4 prefix estimate is
	// conservative and can exceed a provider's measured total (especially for
	// repetitive text). In that case, fit the attributed prefix into the
	// measured total rather than rendering parts that sum past the headline.
	const attributedPrefixTokens = measured ? Math.min(prefixTokens, reported) : prefixTokens;
	if (attributedPrefixTokens < prefixTokens) {
		const fitted = allocateCells(
			segments.map((segment) => segment.tokens),
			attributedPrefixTokens,
		);
		segments.forEach((segment, index) => {
			segment.tokens = fitted[index]!;
		});
	}
	const messageTokens = measured ? reported - attributedPrefixTokens : input.messageTokens;
	const used = measured ? reported : prefixTokens + input.messageTokens;

	segments.push({ id: "messages", label: "Messages", tokens: messageTokens, items: [] });

	const { compaction } = input;
	const reserved = compaction.enabled
		? Math.max(0, Math.min(compaction.reserveTokens, input.contextWindow - used))
		: 0;
	const free = Math.max(0, input.contextWindow - used - reserved);
	segments.push({ id: "free", label: "Free space", tokens: free, items: [] });
	// The reserve marks the far-end threshold of the context window, not space
	// immediately following current usage. Keep it last so the grid reads:
	// used → usable free space → autocompact threshold.
	if (reserved > 0) {
		segments.push({ id: "reserved", label: "Autocompact buffer", tokens: reserved, items: [] });
	}

	return {
		contextWindow: input.contextWindow,
		used,
		free,
		measured,
		willCompact: shouldCompact(used, input.contextWindow, compaction),
		unattributed,
		segments: segments.filter(
			(segment) => segment.tokens > 0 || segment.id === "messages" || segment.id === "free",
		),
	};
}

/**
 * Largest-remainder allocation so the grid holds exactly `cells` cells.
 * Segments too small for a cell get none (legend still shows the number).
 */
function allocateCells(tokens: readonly number[], cells: number): number[] {
	const counts = tokens.map(() => 0);
	const total = tokens.reduce((sum, value) => sum + value, 0);
	if (total <= 0 || cells <= 0) return counts;

	const exact = tokens.map((value) => (value / total) * cells);
	exact.forEach((value, index) => {
		counts[index] = Math.floor(value);
	});

	let spare = cells - counts.reduce((sum, value) => sum + value, 0);
	const byRemainder = exact
		.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
		.sort((a, b) => b.remainder - a.remainder);
	for (const { index } of byRemainder) {
		if (spare <= 0) break;
		counts[index]! += 1;
		spare -= 1;
	}
	return counts;
}

/** The themed context breakdown rendered into the transcript. */

const GRID_COLUMNS = 10;
const GRID_ROWS = 10;
const CELLS = GRID_COLUMNS * GRID_ROWS;
const GUTTER = "   ";
const INDENT = "  ";

/**
 * Draughts pieces, one space apart.
 *
 * The glyphs sit in an East Asian Ambiguous width class, so terminals disagree
 * about whether they are one cell or two. The separating space is what keeps
 * the grid legible either way — packed together they smear into a bar.
 */
const CELL_SEPARATOR = " ";
/** Heavy slice of what is used (≥ light threshold). */
const HEAVY_GLYPH = "⛁";
/**
 * Light slice — hollow means "not bloated".
 * Used for spent segments under {@link LIGHT_SHARE} of `used`, and for the
 * autocompact reserve (claimed, not conversation bulk).
 */
const LIGHT_GLYPH = "⛀";
/** Free capacity in the window. */
const EMPTY_GLYPH = "⛶";

/**
 * Share of `breakdown.used` below which a spent segment paints hollow.
 * 10%: the big buckets (messages, fat system prompt) read solid; small
 * overhead (a context file, a thin tool group) reads hollow at a glance.
 */
const LIGHT_SHARE = 0.1;

/**
 * The lists hang off their heading as a tree. `└` closes each one, so where a
 * list ends is visible without counting rows against the legend's count.
 */
const TREE_BRANCH = "├";
const TREE_END = "└";

/**
 * Glyph for a segment:
 * - ⛶ free window
 * - ⛀ light / reserve (not much of the used total)
 * - ⛁ heavy (a real chunk of what is used)
 */
function glyphFor(segment: Pick<Segment, "id" | "tokens">, used: number): string {
	if (segment.id === "free") return EMPTY_GLYPH;
	if (segment.id === "reserved") return LIGHT_GLYPH;
	if (used <= 0 || segment.tokens <= 0) return LIGHT_GLYPH;
	return segment.tokens / used < LIGHT_SHARE ? LIGHT_GLYPH : HEAVY_GLYPH;
}

/**
 * Fixed truecolor palette — not theme tokens.
 *
 * Theme roles collide (nightowl: `warning` and `syntaxType` are both yellow, so
 * context files and extension tools looked identical). Each segment needs a hue
 * you can spot in the grid without reading the legend.
 */
type Paint = (text: string) => string;

const RESET = "\x1b[0m";

function hexColor(hex: string): Paint {
	const red = Number.parseInt(hex.slice(1, 3), 16);
	const green = Number.parseInt(hex.slice(3, 5), 16);
	const blue = Number.parseInt(hex.slice(5, 7), 16);
	const ansi = `\x1b[38;2;${red};${green};${blue}m`;
	return (text) => `${ansi}${text}${RESET}`;
}

const SEGMENT_PAINT: Record<SegmentId, Paint> = {
	system: hexColor("#22d3ee"), // cyan
	append: hexColor("#ff79c6"), // pink
	contextFiles: hexColor("#ffb86c"), // amber
	skills: hexColor("#c792ea"), // purple
	builtinTools: hexColor("#82aaff"), // blue
	extensionTools: hexColor("#ff5370"), // rose
	messages: hexColor("#22da6e"), // green
	reserved: hexColor("#6272a4"), // slate
	free: hexColor("#4b5263"), // charcoal
};

function paintSegment(id: SegmentId, text: string): string {
	return SEGMENT_PAINT[id](text);
}

function percentOf(tokens: number, window: number): string {
	if (window <= 0) return "—";
	const percent = (tokens / window) * 100;
	if (percent > 0 && percent < 0.1) return "<0.1%";
	return `${percent.toFixed(1)}%`;
}

/**
 * Cells for the grid: the whole context window.
 *
 * Proportional to tokens so a 0.7%-full session looks almost empty, not painted
 * solid. A pure largest-remainder pass would still hide every sub-1% segment
 * (system prompt, skills, tools on a fresh session) — those get a one-cell
 * floor stolen from free space so the legend's colours still appear, without
 * pretending the window is full.
 */
function gridCells(breakdown: ContextBreakdown): SegmentId[] {
	const segments = breakdown.segments;
	const counts = allocateCells(
		segments.map((segment) => segment.tokens),
		CELLS,
	);

	// Floor: every non-empty spent segment keeps at least one cell, taken from
	// free (then reserved). Never invent cells past CELLS; never steal from
	// other spent segments.
	const freeIndex = segments.findIndex((segment) => segment.id === "free");
	const reservedIndex = segments.findIndex((segment) => segment.id === "reserved");
	const donors = [freeIndex, reservedIndex].filter((index) => index >= 0);

	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index]!;
		if (segment.id === "free" || segment.id === "reserved") continue;
		if (segment.tokens <= 0 || counts[index]! > 0) continue;

		const donor = donors.find((d) => counts[d]! > 0);
		if (donor === undefined) break;
		counts[donor]! -= 1;
		counts[index]! += 1;
	}

	const cells: SegmentId[] = [];
	segments.forEach((segment, index) => {
		for (let i = 0; i < counts[index]!; i++) cells.push(segment.id);
	});
	while (cells.length < CELLS) cells.push("free");
	return cells.slice(0, CELLS);
}

function legendRow(segment: Segment, breakdown: ContextBreakdown, theme: Theme, labelWidth: number): string {
	const swatch = paintSegment(segment.id, glyphFor(segment, breakdown.used));
	const label = theme.fg("text", `${segment.label}:`.padEnd(labelWidth));
	const tokens = theme.fg("text", `${formatTokensCompact(segment.tokens)} tokens`.padStart(14));
	const percent = theme.fg("muted", `(${percentOf(segment.tokens, breakdown.contextWindow)})`.padStart(9));
	const note = segment.note ? theme.fg("dim", `  ${segment.note}`) : "";
	return `${swatch} ${label}${tokens}${percent}${note}`;
}

type RenderOptions = {
	/** Model line above the grid, e.g. "openai-codex/gpt-5.6-sol". */
	model: string;
};

function renderContext(breakdown: ContextBreakdown, theme: Theme, options: RenderOptions): string[] {
	const lines: string[] = [];
	const used = `${formatTokensCompact(breakdown.used)}/${formatTokensCompact(breakdown.contextWindow)} tokens`;
	lines.push(
		`${theme.fg("accent", theme.bold("Context"))} ${theme.fg("dim", "·")} ${theme.fg("text", options.model)} ${theme.fg("dim", "·")} ${theme.fg("text", used)} ${theme.fg("muted", `(${percentOf(breakdown.used, breakdown.contextWindow)})`)}`,
		"",
	);

	const cells = gridCells(breakdown);
	const byId = new Map(breakdown.segments.map((segment) => [segment.id, segment]));
	// +1 for trailing ":", +1 breathing room before the token column.
	const labelWidth = Math.max(...breakdown.segments.map((segment) => segment.label.length)) + 2;
	for (let row = 0; row < GRID_ROWS; row++) {
		const painted = cells
			.slice(row * GRID_COLUMNS, (row + 1) * GRID_COLUMNS)
			.map((id) => {
				const segment = byId.get(id) ?? { id, tokens: 0 };
				return paintSegment(id, glyphFor(segment, breakdown.used));
			})
			.join(CELL_SEPARATOR);
		const segment = breakdown.segments[row];
		lines.push(segment ? `${INDENT}${painted}${GUTTER}${legendRow(segment, breakdown, theme, labelWidth)}` : `${INDENT}${painted}`);
	}
	// More segments than grid rows: the rest continue under the grid.
	const overflowIndent = `${INDENT}${" ".repeat(GRID_COLUMNS * (1 + CELL_SEPARATOR.length) - CELL_SEPARATOR.length)}${GUTTER}`;
	for (const segment of breakdown.segments.slice(GRID_ROWS)) {
		lines.push(`${overflowIndent}${legendRow(segment, breakdown, theme, labelWidth)}`);
	}

	const listed = breakdown.segments.filter((segment) => segment.items.length > 0);
	// One label column across every list, so a skill and a tool of the same
	// size line up their numbers and can be compared by eye.
	const itemWidth = Math.max(
		// +1 for trailing ":" on each item label.
		...listed.flatMap((segment) => segment.items.map((item) => item.label.length + 1)),
		0,
	);
	for (const segment of listed) {
		lines.push("", `${INDENT}${paintSegment(segment.id, `${segment.label}:`)}`);
		segment.items.forEach((item, index) => {
			const last = index === segment.items.length - 1;
			const branch = theme.fg("dim", `${last ? TREE_END : TREE_BRANCH} `);
			const label = theme.fg("text", `${item.label}:`.padEnd(itemWidth));
			const tokens = theme.fg("muted", `${formatTokensCompact(item.tokens)} tokens`.padStart(15));
			const scope = item.scope ? theme.fg("dim", `  ${item.scope}`) : "";
			lines.push(`${INDENT}  ${branch}${label}${tokens}${scope}`);
		});
	}

	return lines;
}

/**
 * `/context` — what fills the context window.
 *
 * Snapshot is written as a custom session entry (`appendEntry`) so it shows in
 * the transcript via `registerEntryRenderer` but never enters LLM context.
 * Do not use `sendMessage` here — that would burn tokens on a diagnostic.
 *
 * Numbers come from host APIs (see breakdown.ts):
 * - `ctx.getContextUsage()` — footer total / window (provider usage + trailing)
 * - `ctx.getSystemPrompt()` / `ctx.getSystemPromptOptions()`
 * - `formatSkillsForPrompt`
 * - `pi.getAllTools()` / `pi.getActiveTools()`
 * - `sessionManager.buildContextEntries` + `sessionEntryToContextMessages` + `estimateTokens`
 * - `getLastAssistantUsage` — distinguishes measured total vs messages-only estimate
 * - `SettingsManager.getCompactionSettings` + `shouldCompact`
 */

const ENTRY_TYPE = "context";

type ContextEntryData = {
	model: string;
	breakdown: ContextBreakdown;
};

function compactionSettings(ctx: ExtensionCommandContext): Required<CompactionSettings> {
	try {
		return SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionSettings();
	} catch {
		return DEFAULT_COMPACTION_SETTINGS;
	}
}

/**
 * Message tokens via pi's own path: context entries → messages → `estimateTokens`.
 * Used only when `getContextUsage()` cannot supply a messages-side figure
 * (e.g. right after compaction, `tokens: null`).
 */
function estimateMessageTokens(ctx: ExtensionCommandContext): number {
	return ctx.sessionManager
		.buildContextEntries()
		.flatMap((entry) => sessionEntryToContextMessages(entry))
		.reduce((sum, message) => sum + estimateTokens(message), 0);
}

/**
 * Split host `getContextUsage()` into:
 * - `reported` — provider-backed full-request total (null if not yet measured)
 * - `messages` — messages-only estimate for the unmeasured case
 *
 * `getContextUsage` already runs pi's `estimateContextTokens` on session
 * messages (last assistant usage + trailing `estimateTokens`). Before any
 * assistant reply that figure is messages-only; after one it includes system +
 * tools. `getLastAssistantUsage` is how we tell which case we are in — same
 * helper compaction uses.
 */
function usageParts(ctx: ExtensionCommandContext): { reported: number | null; messages: number } {
	const usage = ctx.getContextUsage();
	const entries = ctx.sessionManager.buildContextEntries();
	const hasAssistantUsage = getLastAssistantUsage(entries) !== undefined;

	if (hasAssistantUsage && usage?.tokens != null) {
		return { reported: usage.tokens, messages: 0 };
	}

	// Unmeasured: prefer the host's messages estimate when it has one.
	if (usage?.tokens != null) {
		return { reported: null, messages: usage.tokens };
	}

	return { reported: null, messages: estimateMessageTokens(ctx) };
}

function modelLabel(ctx: ExtensionCommandContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model";
}

function snapshot(pi: ExtensionAPI, ctx: ExtensionCommandContext): ContextBreakdown | undefined {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (contextWindow <= 0) return undefined;

	const { reported, messages } = usageParts(ctx);

	return buildBreakdown({
		contextWindow,
		cwd: ctx.cwd,
		systemPrompt: ctx.getSystemPrompt(),
		promptOptions: ctx.getSystemPromptOptions(),
		formatSkills: formatSkillsForPrompt,
		tools: pi.getAllTools(),
		activeTools: pi.getActiveTools(),
		messageTokens: messages,
		reportedTokens: reported,
		compaction: compactionSettings(ctx),
	});
}

export default function context(pi: ExtensionAPI) {
	pi.registerEntryRenderer<ContextEntryData>(ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data?.breakdown) return undefined;
		const lines = renderContext(data.breakdown, theme, { model: data.model });
		return new Text(lines.join("\n"), 0, 0);
	});

	pi.registerCommand("context", {
		description: "Show what fills the context window: prompt, files, skills, tools, messages",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const breakdown = snapshot(pi, ctx);
			if (!breakdown) {
				if (ctx.hasUI) ctx.ui.notify("No model selected, so there is no context window to report on.", "warning");
				return;
			}

			pi.appendEntry<ContextEntryData>(ENTRY_TYPE, {
				model: modelLabel(ctx),
				breakdown,
			});
		},
	});
}
