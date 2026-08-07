import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage, AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type ToolDefinition,
	CONFIG_DIR_NAME,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	buildSessionContext,
	createAgentSession,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	Editor,
	Input,
	isKeyRelease,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type KeyId,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";


// ============================================================================
// Subagent UI (inlined — pi-subagents style widget / fleet / viewer)
// ============================================================================

// ---- UI: types.ts ----


/** Normalized status labels used by the UI layer. */
type UiAgentStatus =
	| "pending_init"
	| "running"
	| "interrupted"
	| "completed"
	| "errored"
	| "shutdown";

/** Live activity tracked while an agent streams. */
interface AgentActivity {
	activeTools: Map<string, string>;
	toolUses: number;
	responseText: string;
	session?: AgentSession;
	turnCount: number;
	/** Lifetime token total when available (input+output+cacheWrite). */
	totalTokens: number;
	/** Context window utilization 0–100, or null if unknown. */
	contextPercent: number | null;
	/** UI-only task summary. */
	description?: string;
	/** UI-only completion timestamp. */
	completedAt?: number;
}

/** Snapshot of an agent for widget / fleet / viewer. */
interface UiAgentRecord {
	/** Canonical task path, e.g. `/root/task_3`. */
	id: string;
	nickname: string;
	role: string;
	/** Short task summary shown in the UI. */
	description: string;
	status: UiAgentStatus;
	error?: string;
	startedAt: number;
	completedAt?: number;
	toolUses: number;
	turnCount: number;
	modelId?: string;
	session?: AgentSession;
	parentPath: string | null;
	lastText?: string;
	busy: boolean;
	totalTokens: number;
	contextPercent: number | null;
}

/** Metadata attached to tool results for custom rendering. */
interface AgentDetails {
	displayName: string;
	description: string;
	role: string;
	toolUses: number;
	tokens?: string;
	durationMs: number;
	status: UiAgentStatus | "background";
	activity?: string;
	spinnerFrame?: number;
	modelName?: string;
	tags?: string[];
	turnCount?: number;
	agentId?: string;
	error?: string;
	nickname?: string;
}

/** Details for styled completion notifications. */
interface NotificationDetails {
	id: string;
	description: string;
	nickname?: string;
	role?: string;
	status: UiAgentStatus | string;
	toolUses: number;
	turnCount: number;
	totalTokens: number;
	durationMs: number;
	error?: string;
	resultPreview: string;
	others?: NotificationDetails[];
}

type Theme = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

type UICtx = {
	setStatus(key: string, text: string | undefined): void;
	setWidget(
		key: string,
		content: undefined | ((tui: any, theme: Theme) => { render(width?: number): string[]; invalidate(): void; dispose?(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
};

type FleetUICtx = {
	setWidget(
		key: string,
		content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	getEditorText(): string;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	custom<T>(
		factory: (
			tui: any,
			theme: Theme,
			keybindings: any,
			done: (result: T) => void,
		) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
		options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
	): Promise<T>;
};

/** Provider the control plane implements so UI never mutates agent maps directly. */
interface AgentUiSource {
	listAgents(): UiAgentRecord[];
	getActivity(id: string): AgentActivity | undefined;
	/** Interrupt a running agent (viewer stop key). Returns true if interrupted. */
	interrupt(id: string): Promise<boolean> | boolean;
	/** Steer a running agent with a follow-up message. */
	steer(id: string, message: string): void;
}



// ---- UI: format.ts ----

/** Braille spinner frames for animated running indicator. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Statuses that indicate an error/non-success outcome. */
const ERROR_STATUSES = new Set(["errored", "interrupted", "error", "aborted", "steered", "stopped"]);

/** Tool name → human-readable action for activity descriptions. */
const TOOL_DISPLAY: Record<string, string> = {
	read: "reading",
	bash: "running command",
	edit: "editing",
	write: "writing",
	grep: "searching",
	find: "finding files",
	ls: "listing",
	spawn_agent: "spawning agent",
	send_message: "messaging agent",
	followup_task: "follow-up task",
	wait_agent: "waiting",
	list_agents: "listing agents",
	interrupt_agent: "interrupting",
};

/** Apply foreground styling while restoring it after nested foreground/full ANSI resets. */
function fgPreservingNestedStyles(theme: Theme, color: string, text: string): string {
	const styledEmpty = theme.fg(color, "");
	const styleStart = styledEmpty.replace(/\u001b\[(?:0|39)m/g, "");
	return theme.fg(color, text.replace(/\u001b\[(?:0|39)m/g, (reset) => `${reset}${styleStart}`));
}

/** Format a token count compactly: "33.8k token", "1.2M token". */
function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M token`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k token`;
	return `${count} token`;
}

/**
 * Token count with optional context-fill % annotation.
 * Thresholds: <70% dim, 70–85% warning, ≥85% error.
 */
function formatSessionTokens(tokens: number, percent: number | null, theme: Theme): string {
	const tokenStr = formatTokens(tokens);
	if (percent === null) return tokenStr;
	const color = percent >= 85 ? "error" : percent >= 70 ? "warning" : "dim";
	return `${tokenStr} (${theme.fg(color, `${Math.round(percent)}%`)})`;
}

/** Format turn count with optional max limit: "↻5≤30" or "↻5". */
function formatTurns(turnCount: number, maxTurns?: number | null): string {
	return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}

/** Format milliseconds as human-readable duration. */
function formatMs(ms: number): string {
	if (ms >= 60_000) {
		const m = Math.floor(ms / 60_000);
		const s = Math.floor((ms % 60_000) / 1000);
		return `${m}m${s.toString().padStart(2, "0")}s`;
	}
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Format duration from start/completed timestamps. */
function formatDuration(startedAt: number, completedAt?: number): string {
	if (completedAt) return formatMs(completedAt - startedAt);
	return `${formatMs(Date.now() - startedAt)} (running)`;
}

/** Truncate text to a single line, max `len` chars. */
function truncateLine(text: string, len = 60): string {
	const line = text.split("\n").find((l) => l.trim())?.trim() ?? "";
	if (line.length <= len) return line;
	return `${line.slice(0, len)}…`;
}

/** Build a human-readable activity string from currently-running tools or response text. */
function describeActivity(activeTools: Map<string, string>, responseText?: string): string {
	if (activeTools.size > 0) {
		const groups = new Map<string, number>();
		for (const toolName of activeTools.values()) {
			const action = TOOL_DISPLAY[toolName] ?? toolName;
			groups.set(action, (groups.get(action) ?? 0) + 1);
		}

		const parts: string[] = [];
		for (const [action, count] of groups) {
			if (count > 1) {
				parts.push(`${action} ${count} ${action === "searching" ? "patterns" : "files"}`);
			} else {
				parts.push(action);
			}
		}
		return `${parts.join(", ")}…`;
	}

	if (responseText && responseText.trim().length > 0) {
		return truncateLine(responseText);
	}

	return "thinking…";
}

/** Short model id (last path segment). */
function shortModelName(modelId?: string): string | undefined {
	if (!modelId) return undefined;
	const slash = modelId.lastIndexOf("/");
	return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

/** One row in a parent/child agent tree used by widget + fleet. */
interface AgentTreeEntry {
	record: UiAgentRecord;
	/** Nesting depth among the visible set (0 = top-level under /root). */
	depth: number;
	/** Whether this node is the last sibling under its visible parent. */
	isLast: boolean;
	/** For each ancestor level, true if that ancestor has more siblings below (draw │). */
	ancestorContinues: boolean[];
}

/** Climb parentPath until a visible ancestor is found; null = top-level under Agents. */
function visibleParentId(agent: UiAgentRecord, visibleIds: Set<string>): string | null {
	let p: string | null = agent.parentPath;
	while (p && p !== "/root") {
		if (visibleIds.has(p)) return p;
		const cut = p.lastIndexOf("/");
		if (cut <= 0) return null;
		p = p.slice(0, cut);
		if (!p || p === "/") return null;
	}
	return null;
}

/**
 * Order agents as a forest under /root using parentPath.
 * If a parent is missing from `agents`, children promote to the nearest visible ancestor
 * (or top-level) so a still-running nested child remains visible after its parent lingers out.
 */
function buildAgentTree(agents: UiAgentRecord[]): AgentTreeEntry[] {
	if (agents.length === 0) return [];
	const visibleIds = new Set(agents.map((a) => a.id));
	const children = new Map<string | null, UiAgentRecord[]>();

	for (const agent of agents) {
		const parent = visibleParentId(agent, visibleIds);
		const list = children.get(parent);
		if (list) list.push(agent);
		else children.set(parent, [agent]);
	}

	for (const kids of children.values()) {
		kids.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
	}

	const out: AgentTreeEntry[] = [];
	const walk = (parent: string | null, ancestorContinues: boolean[]) => {
		const kids = children.get(parent) ?? [];
		kids.forEach((record, index) => {
			const isLast = index === kids.length - 1;
			out.push({
				record,
				depth: ancestorContinues.length,
				isLast,
				ancestorContinues: ancestorContinues.slice(),
			});
			walk(record.id, [...ancestorContinues, !isLast]);
		});
	};
	walk(null, []);
	return out;
}

/** ASCII/Unicode branch pieces for a tree entry (no theme). */
function treeBranchParts(entry: Pick<AgentTreeEntry, "isLast" | "ancestorContinues">): {
	branch: string;
	guide: string;
} {
	const prefix = entry.ancestorContinues.map((cont) => (cont ? "│  " : "   ")).join("");
	return {
		branch: `${prefix}${entry.isLast ? "└─" : "├─"}`,
		guide: `${prefix}${entry.isLast ? "   " : "│  "}`,
	};
}

/** Extract plain text from message content. */
function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			parts.push(String((part as { text?: string }).text ?? ""));
		}
	}
	return parts.join("");
}



// ---- UI: viewer-keys.ts ----


/** The `tui.select.*` keybinding ids the viewer resolves. */
type ViewerScrollKeybinding =
	| "tui.select.up"
	| "tui.select.down"
	| "tui.select.pageUp"
	| "tui.select.pageDown";

/** Structural subset of pi-tui's `KeybindingsManager` (which satisfies it). */
interface ViewerKeybindings {
	matches(data: string, keybinding: ViewerScrollKeybinding): boolean;
}

interface ViewerKeys {
	scrollUp(data: string): boolean;
	scrollDown(data: string): boolean;
	pageUp(data: string): boolean;
	pageDown(data: string): boolean;
}

function createViewerKeys(keybindings?: ViewerKeybindings): ViewerKeys {
	const matches = (data: string, id: ViewerScrollKeybinding, fallback: KeyId): boolean =>
		keybindings ? keybindings.matches(data, id) : matchesKey(data, fallback);
	return {
		scrollUp: (data) => matches(data, "tui.select.up", "up") || matchesKey(data, "k"),
		scrollDown: (data) => matches(data, "tui.select.down", "down") || matchesKey(data, "j"),
		pageUp: (data) => matches(data, "tui.select.pageUp", "pageUp") || matchesKey(data, "shift+up"),
		pageDown: (data) => matches(data, "tui.select.pageDown", "pageDown") || matchesKey(data, "shift+down"),
	};
}



// ---- UI: render.ts ----


function renderRunningAgentStatus(
	frame: string,
	statsText: string,
	activity: string,
	theme: Pick<Theme, "fg">,
): Container {
	const container = new Container();
	container.addChild(new Text(theme.fg("accent", frame) + (statsText ? ` ${statsText}` : ""), 0, 0));
	container.addChild(new Text(theme.fg("dim", `  ⎿  ${activity}`), 0, 0));
	return container;
}

/** Build "model · ↻5 · 3 tool uses · 33.8k token" stats string. */
function formatAgentStats(d: AgentDetails, theme: Theme): string {
	const parts: string[] = [];
	if (d.modelName) parts.push(d.modelName);
	if (d.tags) parts.push(...d.tags);
	if (d.turnCount != null && d.turnCount > 0) {
		parts.push(formatTurns(d.turnCount));
	}
	if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
	if (d.tokens) parts.push(d.tokens);
	return parts.map((p) => fgPreservingNestedStyles(theme, "dim", p)).join(` ${theme.fg("dim", "·")} `);
}

/** Render spawn_agent / agent tool result Claude Code-style. */
function renderAgentResult(
	result: { content?: Array<{ type?: string; text?: string }>; details?: unknown },
	opts: { expanded?: boolean; isPartial?: boolean },
	theme: Theme,
): Text | Container {
	const details = result.details as AgentDetails | undefined;
	if (!details) {
		const text =
			result.content?.[0] && result.content[0].type === "text" ? (result.content[0].text ?? "") : "";
		return new Text(text, 0, 0);
	}

	const s = formatAgentStats(details, theme);

	if (opts.isPartial || details.status === "running" || details.status === "pending_init") {
		const frame = SPINNER[details.spinnerFrame ?? 0];
		return renderRunningAgentStatus(frame, s, details.activity ?? "thinking…", theme);
	}

	if (details.status === "background") {
		return new Text(
			theme.fg("dim", `  ⎿  Running in background (${details.nickname ?? details.agentId ?? ""})`),
			0,
			0,
		);
	}

	if (details.status === "completed") {
		const duration = formatMs(details.durationMs);
		const icon = theme.fg("success", "✓");
		let line = icon + (s ? ` ${s}` : "");
		line += ` ${theme.fg("dim", "·")} ${theme.fg("dim", duration)}`;

		if (opts.expanded) {
			const resultText =
				result.content?.[0] && result.content[0].type === "text" ? (result.content[0].text ?? "") : "";
			if (resultText) {
				const lines = resultText.split("\n").slice(0, 50);
				for (const l of lines) {
					line += `\n${theme.fg("dim", `  ${l}`)}`;
				}
				if (resultText.split("\n").length > 50) {
					line += `\n${theme.fg("muted", "  ... (expand further or open /agents viewer)")}`;
				}
			}
		} else {
			line += `\n${theme.fg("dim", "  ⎿  Done")}`;
		}
		return new Text(line, 0, 0);
	}

	if (details.status === "interrupted") {
		const line =
			theme.fg("dim", "■") +
			(s ? ` ${s}` : "") +
			`\n${theme.fg("dim", "  ⎿  Interrupted")}`;
		return new Text(line, 0, 0);
	}

	// errored / other
	let line = theme.fg("error", "✗") + (s ? ` ${s}` : "");
	if (details.status === "errored") {
		line += `\n${theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`)}`;
	} else {
		line += `\n${theme.fg("warning", `  ⎿  ${details.status}`)}`;
	}
	return new Text(line, 0, 0);
}

/** Render a styled completion notification (from custom message details). */
function renderNotification(
	d: NotificationDetails,
	expanded: boolean,
	theme: Theme,
): Text {
	function renderOne(n: NotificationDetails): string {
		const isError = n.status === "errored" || n.status === "interrupted" || n.status === "error";
		const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const statusText = isError
			? String(n.status)
			: n.status === "completed"
				? "completed"
				: String(n.status);

		const title = n.nickname ? `${n.nickname}` : n.description;
		let line = `${icon} ${theme.bold(title)} ${theme.fg("dim", statusText)}`;
		if (n.description && n.nickname) {
			line += `\n  ${theme.fg("muted", n.description)}`;
		}

		const parts: string[] = [];
		if (n.turnCount > 0) parts.push(formatTurns(n.turnCount));
		if (n.toolUses > 0) parts.push(`${n.toolUses} tool use${n.toolUses === 1 ? "" : "s"}`);
		if (n.totalTokens > 0) parts.push(formatTokens(n.totalTokens));
		if (n.durationMs > 0) parts.push(formatMs(n.durationMs));
		if (parts.length) {
			line += `\n  ${parts.map((p) => theme.fg("dim", p)).join(` ${theme.fg("dim", "·")} `)}`;
		}

		if (expanded) {
			const lines = n.resultPreview.split("\n").slice(0, 30);
			for (const l of lines) line += `\n${theme.fg("dim", `  ${l}`)}`;
		} else {
			const preview = n.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
			line += `\n  ${theme.fg("dim", `⎿  ${preview}`)}`;
		}

		if (n.error) {
			line += `\n  ${theme.fg("error", n.error.slice(0, 120))}`;
		}

		return line;
	}

	const all = [d, ...(d.others ?? [])];
	return new Text(all.map(renderOne).join("\n"), 0, 0);
}

/** Build AgentDetails for spawn_agent streaming/result. */
function buildSpawnDetails(opts: {
	taskName: string;
	nickname?: string | null;
	role: string;
	status: string;
	description?: string;
	toolUses?: number;
	turnCount?: number;
	totalTokens?: number;
	contextPercent?: number | null;
	durationMs?: number;
	activity?: string;
	spinnerFrame?: number;
	modelId?: string;
	error?: string;
	activeTools?: Map<string, string>;
	responseText?: string;
}): AgentDetails {
	const tokens =
		opts.totalTokens && opts.totalTokens > 0
			? formatSessionTokens(
					opts.totalTokens,
					opts.contextPercent ?? null,
					// formatSessionTokens needs theme for percent color; use plain when no theme
					{ fg: (_c, t) => t, bold: (t) => t },
				)
			: undefined;

	const status = normalizeStatus(opts.status);
	const activity =
		opts.activity ??
		(opts.activeTools
			? describeActivity(opts.activeTools, opts.responseText)
			: status === "running" || status === "pending_init"
				? "thinking…"
				: undefined);

	return {
		displayName: opts.nickname || opts.role,
		description: opts.description || opts.taskName,
		role: opts.role,
		toolUses: opts.toolUses ?? 0,
		tokens,
		durationMs: opts.durationMs ?? 0,
		status,
		activity,
		spinnerFrame: opts.spinnerFrame,
		modelName: opts.modelId?.includes("/") ? opts.modelId.slice(opts.modelId.indexOf("/") + 1) : opts.modelId,
		turnCount: opts.turnCount,
		agentId: opts.taskName,
		error: opts.error,
		nickname: opts.nickname ?? undefined,
	};
}

function normalizeStatus(status: string): AgentDetails["status"] {
	if (
		status === "running" ||
		status === "pending_init" ||
		status === "completed" ||
		status === "errored" ||
		status === "interrupted" ||
		status === "shutdown" ||
		status === "background"
	) {
		return status;
	}
	if (status.startsWith("completed")) return "completed";
	if (status.startsWith("errored")) return "errored";
	return "running";
}



// ---- UI: conversation-viewer.ts ----


/** Base lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES_BASE = 6;
const MIN_VIEWPORT = 3;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
const VIEWPORT_HEIGHT_PCT = 70;

class ConversationViewer implements Component {
	private scrollOffset = 0;
	private autoScroll = true;
	private unsubscribe: (() => void) | undefined;
	private lastInnerW = 0;
	private closed = false;
	/** Two-press confirm guard for the stop key. */
	private stopArmed = false;
	private keys: ViewerKeys;
	/** Steering composer — present while the user is typing a message to the agent. */
	private composer: Input | undefined;

	constructor(
		private tui: TUI,
		private session: AgentSession,
		private record: UiAgentRecord,
		private activity: AgentActivity | undefined,
		private theme: Theme,
		private done: (result: undefined) => void,
		/** Abort the agent shown here. Omitted → no stop affordance. */
		private onStop?: () => void,
		/** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
		keybindings?: ViewerKeybindings,
		/** Send a steering message to the agent. Omitted → no compose affordance. */
		private onSteer?: (message: string) => void,
	) {
		this.keys = createViewerKeys(keybindings);
		this.unsubscribe = session.subscribe(() => {
			if (this.closed) return;
			this.tui.requestRender();
		});
	}

	/** Live-update the record snapshot (status/activity may change while open). */
	updateRecord(record: UiAgentRecord, activity?: AgentActivity) {
		this.record = record;
		this.activity = activity;
		if (!this.closed) this.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.composer) {
			this.composer.handleInput(data);
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.closed = true;
			this.done(undefined);
			return;
		}

		if (matchesKey(data, "enter") && this.canSteer()) {
			this.stopArmed = false;
			this.openComposer();
			return;
		}

		if (matchesKey(data, "x")) {
			if (this.isStoppable()) {
				if (this.stopArmed) {
					this.stopArmed = false;
					this.onStop?.();
				} else {
					this.stopArmed = true;
				}
				this.tui.requestRender();
			}
			return;
		}
		if (this.stopArmed) this.stopArmed = false;

		const totalLines = this.buildContentLines(this.lastInnerW).length;
		const viewportHeight = this.viewportHeight();
		const maxScroll = Math.max(0, totalLines - viewportHeight);

		if (this.keys.scrollUp(data)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (this.keys.scrollDown(data)) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (this.keys.pageUp(data)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
			this.autoScroll = false;
		} else if (this.keys.pageDown(data)) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
			this.autoScroll = this.scrollOffset >= maxScroll;
		} else if (matchesKey(data, "home")) {
			this.scrollOffset = 0;
			this.autoScroll = false;
		} else if (matchesKey(data, "end")) {
			this.scrollOffset = maxScroll;
			this.autoScroll = true;
		}
	}

	render(width: number): string[] {
		if (width < 6) return [];
		const th = this.theme;
		const innerW = width - 4;
		this.lastInnerW = innerW;
		const lines: string[] = [];

		const pad = (s: string, len: number) => {
			const vis = visibleWidth(s);
			return s + " ".repeat(Math.max(0, len - vis));
		};
		const row = (content: string) =>
			th.fg("border", "│") +
			" " +
			truncateToWidth(pad(content, innerW), innerW, "...", true) +
			" " +
			th.fg("border", "│");
		const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
		const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
		const hrMid = row(th.fg("dim", "─".repeat(innerW)));

		// Header
		lines.push(hrTop);
		const name = this.record.nickname || this.record.role || this.record.id;
		const roleTag =
			this.record.role && this.record.role !== "default"
				? ` ${th.fg("dim", `[${this.record.role}]`)}`
				: "";
		const statusIcon =
			this.record.status === "running" || this.record.busy
				? th.fg("accent", "●")
				: this.record.status === "completed"
					? th.fg("success", "✓")
					: this.record.status === "errored"
						? th.fg("error", "✗")
						: this.record.status === "interrupted"
							? th.fg("dim", "■")
							: th.fg("dim", "○");
		const duration = formatDuration(this.record.startedAt, this.record.completedAt);

		const headerParts: string[] = [duration];
		const toolUses = this.activity?.toolUses ?? this.record.toolUses;
		if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
		const turns = this.activity?.turnCount ?? this.record.turnCount;
		if (turns > 0) headerParts.unshift(formatTurns(turns));
		const tokens = this.activity?.totalTokens ?? this.record.totalTokens;
		if (tokens > 0) {
			const percent = this.activity?.contextPercent ?? this.record.contextPercent;
			headerParts.push(formatSessionTokens(tokens, percent, th));
		}
		const model = shortModelName(this.record.modelId);
		if (model) headerParts.unshift(model);

		lines.push(
			row(
				`${statusIcon} ${th.bold(name)}${roleTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`,
			),
		);
		const parentHint =
			this.record.parentPath && this.record.parentPath !== "/root"
				? th.fg("dim", `  ${this.record.id}  ·  under ${this.record.parentPath}`)
				: th.fg("dim", `  ${this.record.id}`);
		lines.push(row(parentHint));
		lines.push(hrMid);

		const contentLines = this.buildContentLines(innerW);
		const viewportHeight = this.viewportHeight();
		const maxScroll = Math.max(0, contentLines.length - viewportHeight);

		if (this.autoScroll) {
			this.scrollOffset = maxScroll;
		}

		const visibleStart = Math.min(this.scrollOffset, maxScroll);
		const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);

		for (let i = 0; i < viewportHeight; i++) {
			lines.push(row(visible[i] ?? ""));
		}

		// Footer
		lines.push(hrMid);
		if (this.composer) {
			lines.push(row(this.composer.render(innerW)[0] ?? ""));
			const composeHint = th.fg("dim", "Enter send · Esc cancel");
			const composeLeft = th.fg("accent", "✎ steer");
			const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
			lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
		} else {
			const sep = th.fg("dim", " · ");
			const actions: string[] = [];
			if (this.canSteer()) actions.push(th.fg("dim", "Enter steer"));
			if (this.isStoppable()) {
				actions.push(this.stopArmed ? th.fg("error", "x again to STOP") : th.fg("dim", "x stop"));
			}
			const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn or Shift+↑↓ · Esc close");

			const scrollPct =
				contentLines.length <= viewportHeight
					? "100%"
					: `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
			const count = th.fg("dim", `${contentLines.length} lines · ${scrollPct}`);
			const withCount = [count, ...actions].join(sep);
			const footerLeft =
				visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
					? withCount
					: actions.join(sep);

			const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
			lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
		}
		lines.push(hrBot);

		return lines;
	}

	private isStoppable(): boolean {
		return (
			!!this.onStop &&
			(this.record.status === "running" ||
				this.record.status === "pending_init" ||
				this.record.busy)
		);
	}

	private canSteer(): boolean {
		return (
			!!this.onSteer &&
			this.record.status !== "shutdown" &&
			this.record.status !== "errored"
		);
	}

	private openComposer(): void {
		const input = new Input();
		input.focused = true;
		input.onSubmit = (value: string) => {
			const message = value.trim();
			this.composer = undefined;
			if (message) this.onSteer?.(message);
			this.tui.requestRender();
		};
		input.onEscape = () => {
			this.composer = undefined;
			this.tui.requestRender();
		};
		this.composer = input;
		this.tui.requestRender();
	}

	invalidate(): void {
		/* no cached state to clear */
	}

	dispose(): void {
		this.closed = true;
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
	}

	private viewportHeight(): number {
		const maxRows = Math.floor((this.tui.terminal.rows * VIEWPORT_HEIGHT_PCT) / 100);
		return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
	}

	private chromeLines(): number {
		// Extra line for the path under the header.
		return CHROME_LINES_BASE + 1 + (this.composer ? 1 : 0);
	}

	private buildContentLines(width: number): string[] {
		if (width <= 0) return [];

		const th = this.theme;
		const messages = this.session.messages;
		const lines: string[] = [];

		if (messages.length === 0) {
			lines.push(th.fg("dim", "(waiting for first message...)"));
			return lines;
		}

		let needsSeparator = false;
		for (const msg of messages) {
			const role = (msg as { role?: string }).role;
			if (role === "user") {
				const text =
					typeof (msg as { content?: unknown }).content === "string"
						? String((msg as { content: string }).content)
						: extractText((msg as { content?: unknown }).content);
				if (!text.trim()) continue;
				if (needsSeparator) lines.push(th.fg("dim", "───"));
				lines.push(th.fg("accent", "[User]"));
				for (const line of wrapTextWithAnsi(text.trim(), width)) {
					lines.push(line);
				}
			} else if (role === "assistant") {
				const textParts: string[] = [];
				const toolCalls: string[] = [];
				const content = (msg as { content?: unknown }).content;
				if (Array.isArray(content)) {
					for (const c of content) {
						if (c && typeof c === "object") {
							const t = (c as { type?: string }).type;
							if (t === "text" && (c as { text?: string }).text) {
								textParts.push(String((c as { text: string }).text));
							} else if (t === "toolCall") {
								toolCalls.push(
									(c as { name?: string; toolName?: string }).name ??
										(c as { toolName?: string }).toolName ??
										"unknown",
								);
							}
						}
					}
				} else if (typeof content === "string") {
					textParts.push(content);
				}
				if (needsSeparator) lines.push(th.fg("dim", "───"));
				lines.push(th.bold("[Assistant]"));
				if (textParts.length > 0) {
					for (const line of wrapTextWithAnsi(textParts.join("\n").trim(), width)) {
						lines.push(line);
					}
				}
				for (const name of toolCalls) {
					lines.push(truncateToWidth(th.fg("muted", `  [Tool: ${name}]`), width));
				}
			} else if (role === "toolResult") {
				const text = extractText((msg as { content?: unknown }).content);
				const truncated = text.length > 500 ? `${text.slice(0, 500)}... (truncated)` : text;
				if (!truncated.trim()) continue;
				if (needsSeparator) lines.push(th.fg("dim", "───"));
				lines.push(th.fg("dim", "[Result]"));
				for (const line of wrapTextWithAnsi(truncated.trim(), width)) {
					lines.push(th.fg("dim", line));
				}
			} else if (role === "bashExecution") {
				const bash = msg as { command?: string; output?: string };
				if (needsSeparator) lines.push(th.fg("dim", "───"));
				lines.push(truncateToWidth(th.fg("muted", `  $ ${bash.command ?? ""}`), width));
				if (bash.output?.trim()) {
					const out =
						bash.output.length > 500 ? `${bash.output.slice(0, 500)}... (truncated)` : bash.output;
					for (const line of wrapTextWithAnsi(out.trim(), width)) {
						lines.push(th.fg("dim", line));
					}
				}
			} else {
				continue;
			}
			needsSeparator = true;
		}

		if ((this.record.status === "running" || this.record.busy) && this.activity) {
			const act = describeActivity(this.activity.activeTools, this.activity.responseText);
			lines.push("");
			lines.push(truncateToWidth(`${th.fg("accent", "⟳ ")}${th.fg("dim", act)}`, width));
		}

		return lines.map((l) => truncateToWidth(l, width));
	}
}



// ---- UI: agent-widget.ts ----


/** Maximum number of rendered lines before overflow collapse kicks in. */
const MAX_WIDGET_LINES = 12;

class AgentWidget {
	private uiCtx: UICtx | undefined;
	private widgetFrame = 0;
	private widgetInterval: ReturnType<typeof setInterval> | undefined;
	/** Tracks how many turns each finished agent has survived. Key: agent ID, Value: turns since finished. */
	private finishedTurnAge = new Map<string, number>();
	/** How many extra turns errors/aborted agents linger (completed agents clear after 1 turn). */
	private static readonly ERROR_LINGER_TURNS = 2;

	/** Whether the widget callback is currently registered with the TUI. */
	private widgetRegistered = false;
	/** Cached TUI reference from widget factory callback, used for requestRender(). */
	private tui: any | undefined;
	/** Last status bar text, used to avoid redundant setStatus calls. */
	private lastStatusText: string | undefined;

	constructor(private source: AgentUiSource) {}

	/** Agents eligible for the widget (all non-root live agents). */
	private widgetAgents(): UiAgentRecord[] {
		return this.source.listAgents().filter((a) => a.id !== "/root" && a.status !== "shutdown");
	}

	/** Set the UI context (grabbed from first tool execution / session_start). */
	setUICtx(ctx: UICtx) {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
			this.lastStatusText = undefined;
		}
	}

	/**
	 * Called on each new parent turn.
	 * Ages finished agents and clears those that have lingered long enough.
	 */
	onTurnStart() {
		for (const [id, age] of this.finishedTurnAge) {
			this.finishedTurnAge.set(id, age + 1);
		}
		this.update();
	}

	/** Ensure the widget update timer is running. */
	ensureTimer() {
		if (!this.widgetInterval) {
			this.widgetInterval = setInterval(() => this.update(), 80);
		}
	}

	/** Check if a finished agent should still be shown in the widget. */
	private shouldShowFinished(agentId: string, status: string): boolean {
		const age = this.finishedTurnAge.get(agentId) ?? 0;
		const maxAge = ERROR_STATUSES.has(status) ? AgentWidget.ERROR_LINGER_TURNS : 1;
		return age < maxAge;
	}

	/** Record an agent as finished (call when agent completes). */
	markFinished(agentId: string) {
		if (!this.finishedTurnAge.has(agentId)) {
			this.finishedTurnAge.set(agentId, 0);
		}
	}

	private displayName(a: UiAgentRecord): string {
		return a.nickname || a.role || a.id;
	}

	/** Render a finished agent line. */
	private renderFinishedLine(a: UiAgentRecord, theme: Theme): string {
		const name = this.displayName(a);
		const duration = formatMs((a.completedAt ?? Date.now()) - a.startedAt);

		let icon: string;
		let statusText: string;
		if (a.status === "completed") {
			icon = theme.fg("success", "✓");
			statusText = "";
		} else if (a.status === "interrupted") {
			icon = theme.fg("dim", "■");
			statusText = theme.fg("dim", " interrupted");
		} else if (a.status === "errored") {
			icon = theme.fg("error", "✗");
			const errMsg = a.error ? `: ${a.error.slice(0, 60)}` : "";
			statusText = theme.fg("error", ` error${errMsg}`);
		} else {
			icon = theme.fg("dim", "○");
			statusText = theme.fg("dim", ` ${a.status}`);
		}

		const parts: string[] = [];
		const activity = this.source.getActivity(a.id);
		const turns = activity?.turnCount ?? a.turnCount;
		if (turns > 0) parts.push(formatTurns(turns));
		const toolUses = activity?.toolUses ?? a.toolUses;
		if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
		parts.push(duration);

		const roleTag = a.role && a.role !== "default" ? ` ${theme.fg("dim", `[${a.role}]`)}` : "";
		return `${icon} ${theme.fg("dim", name)}${roleTag}  ${theme.fg("dim", a.description)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}${statusText}`;
	}

	/** Whether an agent is actively running (not a finished linger row). */
	private isActiveAgent(a: UiAgentRecord): boolean {
		return a.status === "running" || a.busy || a.status === "pending_init";
	}

	/** Agents currently shown in the widget, as a parent/child tree. */
	private visibleTree(): AgentTreeEntry[] {
		const visible = this.widgetAgents().filter(
			(a) => this.isActiveAgent(a) || (!!a.completedAt && this.shouldShowFinished(a.id, a.status)),
		);
		return buildAgentTree(visible);
	}

	/** Render one running agent as [header, activity] lines with tree guides. */
	private renderRunningTreeLines(
		entry: AgentTreeEntry,
		frame: string,
		theme: Theme,
		truncate: (s: string) => string,
		hasChildren: boolean,
	): string[] {
		const a = entry.record;
		const { branch, guide } = treeBranchParts(entry);
		// When children follow, keep a vertical stem so activity sits inside the subtree.
		//   ├─ parent
		//   │  │  ⎿ activity
		//   │  └─ child
		const activityGuide = hasChildren ? `${guide}│  ` : guide;
		const name = this.displayName(a);
		const roleTag = a.role && a.role !== "default" ? ` ${theme.fg("dim", `[${a.role}]`)}` : "";
		const elapsed = formatMs(Date.now() - a.startedAt);

		const bg = this.source.getActivity(a.id);
		const toolUses = bg?.toolUses ?? a.toolUses;
		const tokens = bg?.totalTokens ?? a.totalTokens;
		const contextPercent = bg?.contextPercent ?? a.contextPercent;
		const tokenText = tokens > 0 ? formatSessionTokens(tokens, contextPercent, theme) : "";
		const model = shortModelName(a.modelId);

		const parts: string[] = [];
		const turns = bg?.turnCount ?? a.turnCount;
		if (turns > 0) parts.push(formatTurns(turns));
		if (model) parts.push(model);
		if (toolUses > 0) parts.push(`${toolUses} tool use${toolUses === 1 ? "" : "s"}`);
		if (tokenText) parts.push(tokenText);
		parts.push(elapsed);
		const statsText = parts.join(" · ");
		const activity = bg ? describeActivity(bg.activeTools, bg.responseText) : "thinking…";

		return [
			truncate(
				`${theme.fg("dim", branch)} ${theme.fg("accent", frame)} ${theme.bold(name)}${roleTag}  ${theme.fg("muted", a.description)} ${theme.fg("dim", "·")} ${fgPreservingNestedStyles(theme, "dim", statsText)}`,
			),
			// guide already ends with spacing; only a single pad before the marker.
			truncate(`${theme.fg("dim", activityGuide)}${theme.fg("dim", ` ⎿  ${activity}`)}`),
		];
	}

	/**
	 * Render the widget content. Called from the registered widget's render() callback,
	 * reading live state each time instead of capturing it in a closure.
	 * Agents are laid out as a real parent/child tree from `parentPath`.
	 */
	private renderWidget(tui: any, theme: Theme): string[] {
		const tree = this.visibleTree();
		if (tree.length === 0) return [];

		const hasActive = tree.some((e) => this.isActiveAgent(e.record));
		const w = tui.terminal.columns;
		const truncate = (line: string) => truncateToWidth(line, w);
		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = hasActive ? "●" : "○";
		const frame = SPINNER[this.widgetFrame % SPINNER.length];

		// Pre-render each tree node to 1 (finished) or 2 (running) lines.
		const nodeBlocks: string[][] = tree.map((entry, index) => {
			const hasChildren = tree[index + 1]?.depth === entry.depth + 1;
			if (this.isActiveAgent(entry.record)) {
				return this.renderRunningTreeLines(entry, frame, theme, truncate, hasChildren);
			}
			const { branch } = treeBranchParts(entry);
			return [truncate(`${theme.fg("dim", branch)} ${this.renderFinishedLine(entry.record, theme)}`)];
		});

		const maxBody = MAX_WIDGET_LINES - 1;
		const totalBody = nodeBlocks.reduce((sum, block) => sum + block.length, 0);
		const lines: string[] = [truncate(`${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, "Agents")}`)];

		if (totalBody <= maxBody) {
			for (const block of nodeBlocks) lines.push(...block);
			return lines;
		}

		// Prefer keeping earlier tree rows (parents before deep children) when collapsing.
		let budget = maxBody - 1;
		let hiddenActive = 0;
		let hiddenFinished = 0;
		for (let i = 0; i < nodeBlocks.length; i++) {
			const block = nodeBlocks[i];
			const active = this.isActiveAgent(tree[i].record);
			if (budget >= block.length) {
				lines.push(...block);
				budget -= block.length;
			} else if (active) {
				hiddenActive++;
			} else {
				hiddenFinished++;
			}
		}

		const overflowParts: string[] = [];
		if (hiddenActive > 0) overflowParts.push(`${hiddenActive} running`);
		if (hiddenFinished > 0) overflowParts.push(`${hiddenFinished} finished`);
		const hidden = hiddenActive + hiddenFinished;
		lines.push(
			truncate(
				`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hidden} more (${overflowParts.join(", ")})`)}`,
			),
		);
		return lines;
	}

	/** Force an immediate widget update. */
	update() {
		if (!this.uiCtx) return;
		const allAgents = this.widgetAgents();

		let runningCount = 0;
		let hasFinished = false;
		for (const a of allAgents) {
			if (a.status === "running" || a.busy || a.status === "pending_init") {
				runningCount++;
			} else if (a.completedAt && this.shouldShowFinished(a.id, a.status)) {
				hasFinished = true;
			}
		}
		const hasActive = runningCount > 0;

		if (!hasActive && !hasFinished) {
			if (this.widgetRegistered) {
				this.uiCtx.setWidget("agents", undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			if (this.lastStatusText !== undefined) {
				this.uiCtx.setStatus("subagent", undefined);
				this.lastStatusText = undefined;
			}
			if (this.widgetInterval) {
				clearInterval(this.widgetInterval);
				this.widgetInterval = undefined;
			}
			for (const [id] of this.finishedTurnAge) {
				if (!allAgents.some((a) => a.id === id)) this.finishedTurnAge.delete(id);
			}
			return;
		}

		let newStatusText: string | undefined;
		if (hasActive) {
			const total = allAgents.length;
			newStatusText = `${runningCount} running agent${runningCount === 1 ? "" : "s"}${total !== runningCount ? ` · ${total} live` : ""}`;
		}
		if (newStatusText !== this.lastStatusText) {
			this.uiCtx.setStatus("subagent", newStatusText);
			this.lastStatusText = newStatusText;
		}

		this.widgetFrame++;

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				"agents",
				(tui, theme) => {
					this.tui = tui;
					return {
						render: () => this.renderWidget(tui, theme),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	dispose() {
		if (this.widgetInterval) {
			clearInterval(this.widgetInterval);
			this.widgetInterval = undefined;
		}
		if (this.uiCtx) {
			this.uiCtx.setWidget("agents", undefined);
			this.uiCtx.setStatus("subagent", undefined);
		}
		this.widgetRegistered = false;
		this.tui = undefined;
		this.lastStatusText = undefined;
	}
}



// ---- UI: fleet-list.ts ----


/** Widget key for the below-editor fleet list. */
const FLEET_KEY = "fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 5;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4000;

type MainEntry = { kind: "main" };
type AgentEntry = { kind: "agent"; record: UiAgentRecord };
type FleetEntry = MainEntry | AgentEntry;

/** `11s` — integer seconds. */
function formatFleetElapsed(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** `↓ 13.1k tokens` — down-arrow prefix, compact magnitude. */
function formatFleetTokens(count: number): string {
	let compact: string;
	if (count >= 1_000_000) compact = `${(count / 1_000_000).toFixed(1)}M`;
	else if (count >= 1_000) compact = `${(count / 1_000).toFixed(1)}k`;
	else compact = `${count}`;
	return `↓ ${compact} tokens`;
}

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 */
function rightAlign(left: string, right: string, width: number): string {
	const rightW = visibleWidth(right);
	const maxLeft = Math.max(0, width - rightW - 1);
	const leftClamped = truncateToWidth(left, maxLeft);
	const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
	return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

class FleetList {
	private ui: FleetUICtx | undefined;
	private tui: any | undefined;
	private inputUnsub: (() => void) | undefined;
	private widgetRegistered = false;
	private timer: ReturnType<typeof setInterval> | undefined;

	private enabled = true;
	/** Whether arrow keys currently navigate the list (vs. flow to the editor). */
	private active = false;
	/** 0 = `main`, 1..N = subagents. */
	private selectedIndex = 0;
	/** Set while a conversation overlay is open; calling it closes the overlay. */
	private viewerClose: (() => void) | undefined;
	private viewingAgentId: string | undefined;

	constructor(private source: AgentUiSource) {}

	setEnabled(enabled: boolean): void {
		if (enabled === this.enabled) return;
		this.enabled = enabled;
		if (!enabled) this.active = false;
		this.update();
	}

	/** Capture the UI context and (re)register the global input handler. */
	setUICtx(ui: FleetUICtx): void {
		if (ui === this.ui) return;
		this.inputUnsub?.();
		this.ui = ui;
		this.widgetRegistered = false;
		this.tui = undefined;
		this.inputUnsub = ui.onTerminalInput((data) => this.handleKey(data));
	}

	/** Ensure the re-render timer is running (called when an agent spawns). */
	ensureTimer(): void {
		if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
	}

	/**
	 * Called when an agent finishes. The viewer (if open on it) stays open so the
	 * final output remains readable, and the row lingers in the list — just refresh.
	 */
	onAgentFinished(_id: string): void {
		this.update();
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.inputUnsub?.();
		this.inputUnsub = undefined;
		if (this.viewerClose) {
			this.viewerClose();
			this.viewerClose = undefined;
		}
		this.viewingAgentId = undefined;
		if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.active = false;
		this.ui = undefined;
	}

	/** Re-register/refresh the below-editor widget; clears it when no agents remain. */
	update(): void {
		if (!this.ui) return;
		const hasAgents = this.enabled && this.agentRecords().length > 0;

		if (!hasAgents) {
			if (this.widgetRegistered) {
				this.ui.setWidget(FLEET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			if (this.timer) {
				clearInterval(this.timer);
				this.timer = undefined;
			}
			this.active = false;
			this.selectedIndex = 0;
			return;
		}

		this.clampSelection();
		this.ensureTimer();

		if (!this.widgetRegistered) {
			this.ui.setWidget(
				FLEET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (w: number) => this.renderBar(w, theme),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "belowEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	/**
	 * Agents shown in the list (unordered filter).
	 * Included: running, currently-viewed, and recently-finished.
	 * Pending agents with no session yet are hidden until they start.
	 */
	private agentRecords(): UiAgentRecord[] {
		const now = Date.now();
		return this.source.listAgents().filter(
			(a) =>
				a.id !== "/root" &&
				a.status !== "shutdown" &&
				a.session &&
				(a.status === "running" ||
					a.status === "pending_init" ||
					a.busy ||
					a.id === this.viewingAgentId ||
					(a.completedAt != null && now - a.completedAt < FINISHED_LINGER_MS)),
		);
	}

	/** Fleet rows in parent/child tree order. */
	private agentTree(): AgentTreeEntry[] {
		return buildAgentTree(this.agentRecords());
	}

	private roster(): FleetEntry[] {
		return [
			{ kind: "main" },
			...this.agentTree().map((entry) => ({ kind: "agent" as const, record: entry.record })),
		];
	}

	private clampSelection(): void {
		const max = this.roster().length - 1;
		if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
		if (this.selectedIndex < 0) this.selectedIndex = 0;
	}

	/** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
	handleKey(data: string): { consume?: boolean; data?: string } | undefined {
		if (!this.enabled || !this.ui) return undefined;
		if (isKeyRelease(data)) return undefined;
		if (this.viewerClose) return undefined;
		if (!this.editorHasFocus()) {
			if (this.active) this.deactivate();
			return undefined;
		}

		if (!this.active) {
			const isActivator = matchesKey(data, "down") || matchesKey(data, "left");
			if (isActivator && this.agentRecords().length > 0 && this.ui.getEditorText() === "") {
				this.active = true;
				this.selectedIndex = 0;
				this.update();
				return { consume: true };
			}
			return undefined;
		}

		if (matchesKey(data, "down")) {
			const max = this.roster().length - 1;
			this.selectedIndex = Math.min(max, this.selectedIndex + 1);
			this.update();
			return { consume: true };
		}
		if (matchesKey(data, "up")) {
			if (this.selectedIndex === 0) {
				this.deactivate();
				return { consume: true };
			}
			this.selectedIndex -= 1;
			this.update();
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			this.deactivate();
			return { consume: true };
		}
		if (matchesKey(data, Key.enter)) {
			this.openSelected();
			return { consume: true };
		}

		this.deactivate();
		return undefined;
	}

	private editorHasFocus(): boolean {
		const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		return focused == null || focused instanceof Editor;
	}

	private deactivate(): void {
		this.active = false;
		this.selectedIndex = 0;
		this.update();
	}

	private openSelected(): void {
		const entry = this.roster()[this.selectedIndex];
		if (!entry || entry.kind === "main") {
			this.deactivate();
			return;
		}
		const record = entry.record;
		if (!this.ui) return;
		if (!record.session) {
			this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
			return;
		}
		const session = record.session;
		const activity = this.source.getActivity(record.id);
		this.viewingAgentId = record.id;

		void this.ui
			.custom<undefined>(
				(tui, theme, keybindings, done) => {
					this.viewerClose = () => done(undefined);
					return new ConversationViewer(
						tui,
						session,
						record,
						activity,
						theme,
						done,
						() => {
							void Promise.resolve(this.source.interrupt(record.id)).then((ok) => {
								if (ok) this.ui?.notify(`Stopped "${record.description}".`, "info");
							});
						},
						keybindings,
						(message: string) => this.source.steer(record.id, message),
					);
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "90%",
						maxHeight: `${VIEWPORT_HEIGHT_PCT}%`,
					},
				},
			)
			.then(
				() => this.clearViewer(),
				() => this.clearViewer(),
			);
	}

	/** Open a viewer for a specific agent (used by `/agents` command). */
	async openViewer(record: UiAgentRecord): Promise<void> {
		if (!this.ui) return;
		if (!record.session) {
			this.ui.notify(`Agent is ${record.status} — no session available.`, "info");
			return;
		}
		const session = record.session;
		const activity = this.source.getActivity(record.id);
		this.viewingAgentId = record.id;

		try {
			await this.ui.custom<undefined>(
				(tui, theme, keybindings, done) => {
					this.viewerClose = () => done(undefined);
					return new ConversationViewer(
						tui,
						session,
						record,
						activity,
						theme,
						done,
						() => {
							void Promise.resolve(this.source.interrupt(record.id)).then((ok) => {
								if (ok) this.ui?.notify(`Stopped "${record.description}".`, "info");
							});
						},
						keybindings,
						(message: string) => this.source.steer(record.id, message),
					);
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "90%",
						maxHeight: `${VIEWPORT_HEIGHT_PCT}%`,
					},
				},
			);
		} finally {
			this.clearViewer();
		}
	}

	private clearViewer(): void {
		if (this.viewingAgentId) {
			const idx = this.roster().findIndex(
				(e) => e.kind === "agent" && e.record.id === this.viewingAgentId,
			);
			if (idx >= 0) this.selectedIndex = idx;
		}
		this.viewerClose = undefined;
		this.viewingAgentId = undefined;
		this.update();
	}

	private renderBar(width: number, theme: Theme): string[] {
		const tree = this.agentTree();
		if (tree.length === 0) return [];
		const sel = Math.min(this.selectedIndex, tree.length);

		const hint = this.active
			? "↑↓ select · enter view · esc back"
			: "esc to interrupt · ← for agents · ↓ to manage";
		const lines: string[] = [];
		lines.push(truncateToWidth(`  ${theme.fg("dim", hint)}`, width));
		lines.push("");
		lines.push(truncateToWidth(`  ${this.bullet(0, sel, theme)} main`, width));

		const visible = Math.min(MAX_AGENT_ROWS, tree.length);
		const selAgent = Math.max(0, sel - 1);
		const start = selAgent < visible ? 0 : selAgent - visible + 1;
		const hiddenBelow = tree.length - (start + visible);

		if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
		for (let a = start; a < start + visible; a++) {
			lines.push(this.renderAgentRow(a + 1, sel, tree[a], width, theme));
		}
		if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));

		return lines;
	}

	private bullet(rosterIndex: number, sel: number, theme: Theme): string {
		return rosterIndex === sel ? theme.fg("accent", "●") : theme.fg("dim", "○");
	}

	private renderAgentRow(
		rosterIndex: number,
		sel: number,
		entry: AgentTreeEntry,
		width: number,
		theme: Theme,
	): string {
		const record = entry.record;
		const name = record.nickname || record.role || record.id;
		const { branch } = treeBranchParts(entry);
		// Tree guides on the left; selection bullet sits next to the agent name.
		//   ├─ ○ Turing
		//   │  └─ ○ Feynman
		const left = `  ${theme.fg("dim", branch)} ${this.bullet(rosterIndex, sel, theme)} ${theme.fg("muted", name)}  ${record.description}`;
		const activity = this.source.getActivity(record.id);
		const tokens = activity?.totalTokens ?? record.totalTokens;
		const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt;
		const right = theme.fg(
			"dim",
			`${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}`,
		);
		return rightAlign(left, right, width);
	}
}



// ---- UI: ui.ts ----



class SubagentUI {
	readonly widget: AgentWidget;
	readonly fleet: FleetList;
	private activity = new Map<string, AgentActivity>();
	private spinnerFrame = 0;
	private spinnerTimer: ReturnType<typeof setInterval> | undefined;

	constructor(private source: AgentUiSource) {
		// Activity is owned here; wrap source so widget/fleet read live maps.
		const wrapped: AgentUiSource = {
			listAgents: () => this.source.listAgents(),
			getActivity: (id) => this.activity.get(id) ?? this.source.getActivity(id),
			interrupt: (id) => this.source.interrupt(id),
			steer: (id, message) => this.source.steer(id, message),
		};
		this.widget = new AgentWidget(wrapped);
		this.fleet = new FleetList(wrapped);
	}

	setUICtx(ui: UICtx & Partial<FleetUICtx>) {
		this.widget.setUICtx(ui);
		if (typeof ui.onTerminalInput === "function" && typeof ui.getEditorText === "function" && typeof ui.custom === "function") {
			this.fleet.setUICtx(ui as FleetUICtx);
		}
	}

	/** Ensure activity entry exists for an agent. */
	ensureActivity(id: string, session?: AgentActivity["session"]): AgentActivity {
		let a = this.activity.get(id);
		if (!a) {
			a = {
				activeTools: new Map(),
				toolUses: 0,
				responseText: "",
				session,
				turnCount: 0,
				totalTokens: 0,
				contextPercent: null,
			};
			this.activity.set(id, a);
		} else if (session) {
			a.session = session;
		}
		return a;
	}

	getActivity(id: string): AgentActivity | undefined {
		return this.activity.get(id);
	}

	onToolStart(id: string, toolCallId: string, toolName: string) {
		const a = this.ensureActivity(id);
		a.activeTools.set(toolCallId, toolName);
		a.toolUses += 1;
		a.responseText = "";
		this.bump();
	}

	onToolEnd(id: string, toolCallId: string) {
		const a = this.activity.get(id);
		if (!a) return;
		a.activeTools.delete(toolCallId);
		this.bump();
	}

	onTextDelta(id: string, delta: string) {
		const a = this.ensureActivity(id);
		// Keep a rolling window for activity line.
		a.responseText = (a.responseText + delta).slice(-200);
		this.bump();
	}

	onTurnStart(id: string) {
		const a = this.ensureActivity(id);
		a.turnCount += 1;
		a.responseText = "";
		this.bump();
	}

	onTokens(id: string, totalTokens: number, contextPercent: number | null = null) {
		const a = this.ensureActivity(id);
		a.totalTokens = totalTokens;
		a.contextPercent = contextPercent;
		this.bump();
	}

	/** Parent session started a new user turn — age finished agents in the widget. */
	onParentTurnStart() {
		this.widget.onTurnStart();
	}

	onAgentSpawned(id: string, description?: string) {
		const a = this.ensureActivity(id);
		if (description) a.description = description;
		this.ensureTimer();
		this.widget.ensureTimer();
		this.fleet.ensureTimer();
		this.update();
	}

	/**
	 * Observe child session events for presentation only.
	 * Must not mutate AgentRecord / mailbox / control-plane state.
	 */
	observeSessionEvent(id: string, event: { type: string; [k: string]: unknown }, session?: AgentSession) {
		const a = this.ensureActivity(id, session);
		if (event.type === "turn_start") {
			a.turnCount += 1;
			a.responseText = "";
			this.bump();
			return;
		}
		if (event.type === "tool_execution_start") {
			const e = event as { toolCallId: string; toolName: string };
			a.activeTools.set(e.toolCallId, e.toolName);
			a.toolUses += 1;
			a.responseText = "";
			this.bump();
			return;
		}
		if (event.type === "tool_execution_end") {
			const e = event as { toolCallId: string };
			a.activeTools.delete(e.toolCallId);
			this.bump();
			return;
		}
		if (event.type === "message_update") {
			const e = event as { assistantMessageEvent?: { type?: string; delta?: string } };
			if (e.assistantMessageEvent?.type === "text_delta" && e.assistantMessageEvent.delta) {
				a.responseText = (a.responseText + e.assistantMessageEvent.delta).slice(-200);
				this.bump();
			}
			return;
		}
		if (event.type === "message_end") {
			const msg = event.message as { role?: string; usage?: { input?: number; output?: number; cacheWrite?: number } } | undefined;
			if (msg?.role === "assistant" && msg.usage) {
				const add = (msg.usage.input ?? 0) + (msg.usage.output ?? 0) + (msg.usage.cacheWrite ?? 0);
				if (add > 0) {
					a.totalTokens += add;
					this.bump();
				}
			}
			return;
		}
		if (event.type === "agent_end") {
			a.completedAt = Date.now();
			a.activeTools.clear();
			// Keep activity stats for linger/notification; mark finished for widget.
			this.widget.markFinished(id);
			this.fleet.onAgentFinished(id);
			this.update();
		}
	}

	onAgentFinished(id: string) {
		const a = this.activity.get(id);
		if (a && !a.completedAt) a.completedAt = Date.now();
		// Keep entry briefly so snapshots still show final stats; widget linger handles hide.
		this.widget.markFinished(id);
		this.fleet.onAgentFinished(id);
		this.update();
	}

	update() {
		this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
		this.widget.update();
		this.fleet.update();
	}

	private bump() {
		this.widget.update();
		this.fleet.update();
	}

	private ensureTimer() {
		if (!this.spinnerTimer) {
			this.spinnerTimer = setInterval(() => this.update(), 80);
		}
	}

	currentSpinnerFrame(): number {
		return this.spinnerFrame;
	}

	/** Build details for spawn_agent tool rendering. */
	spawnDetailsFor(record: UiAgentRecord, statusOverride?: string): AgentDetails {
		const act = this.activity.get(record.id);
		return buildSpawnDetails({
			taskName: record.id,
			nickname: record.nickname,
			role: record.role,
			status: statusOverride ?? record.status,
			description: record.description,
			toolUses: act?.toolUses ?? record.toolUses,
			turnCount: act?.turnCount ?? record.turnCount,
			totalTokens: act?.totalTokens ?? record.totalTokens,
			contextPercent: act?.contextPercent ?? record.contextPercent,
			durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
			spinnerFrame: this.spinnerFrame,
			modelId: record.modelId,
			error: record.error,
			activeTools: act?.activeTools,
			responseText: act?.responseText,
		});
	}

	buildNotification(record: UiAgentRecord, resultMaxLen = 500): NotificationDetails {
		const act = this.activity.get(record.id);
		const preview = record.lastText
			? record.lastText.length > resultMaxLen
				? `${record.lastText.slice(0, resultMaxLen)}…`
				: record.lastText
			: "No output.";
		return {
			id: record.id,
			description: record.description,
			nickname: record.nickname,
			role: record.role,
			status: record.status,
			toolUses: act?.toolUses ?? record.toolUses,
			turnCount: act?.turnCount ?? record.turnCount,
			totalTokens: act?.totalTokens ?? record.totalTokens,
			durationMs: record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt,
			error: record.error,
			resultPreview: preview,
		};
	}

	async openViewer(record: UiAgentRecord): Promise<void> {
		await this.fleet.openViewer(record);
	}

	dispose() {
		if (this.spinnerTimer) {
			clearInterval(this.spinnerTimer);
			this.spinnerTimer = undefined;
		}
		this.widget.dispose();
		this.fleet.dispose();
		this.activity.clear();
	}
}


function renderMailboxMessage(
	msg: { content?: unknown; details?: unknown },
	opts: { expanded?: boolean; outputPad?: number },
	theme: Theme,
): Box | Text {
	const details = msg.details as
		| (NotificationDetails & { kind?: string })
		| { kind?: string; taskName?: string; sender?: string }
		| undefined;
	const content = typeof msg.content === "string" ? msg.content : "";

	// Styled completion notification
	if (details && "resultPreview" in details && details.resultPreview !== undefined) {
		return renderNotification(details as NotificationDetails, !!opts.expanded, theme);
	}

	// FINAL_ANSWER / MESSAGE envelope — compact header when collapsed
	const kind =
		(details && "kind" in details && details.kind) ||
		(/^Message Type:\s*(\S+)/m.exec(content)?.[1] ?? "MESSAGE");

	if (kind === "FINAL_ANSWER" || content.includes("<subagent_notification>")) {
		// Try to build a mini notification from envelope text
		const path = (details && "taskName" in details && details.taskName) ||
			(/^Task name:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? "agent");
		const payloadMatch = /Payload:\n([\s\S]*)/.exec(content);
		const payload = payloadMatch?.[1]?.trim() ?? content;
		const isError = /errored|error/i.test(payload.slice(0, 200));
		const notif: NotificationDetails = {
			id: String(path),
			description: String(path),
			status: isError ? "errored" : "completed",
			toolUses: 0,
			turnCount: 0,
			totalTokens: 0,
			durationMs: 0,
			resultPreview: payload.replace(/<\/?subagent_notification>/g, "").trim(),
		};
		return renderNotification(notif, !!opts.expanded, theme);
	}

	const first = content.split("\n")[0] ?? "subagent";
	const body = opts.expanded ? content : first;
	const icon =
		kind === "NEW_TASK"
			? theme.fg("accent", "▶ ")
			: kind === "FINAL_ANSWER"
				? theme.fg("success", "✓ ")
				: theme.fg("accent", "✉ ");
	const themeAny = theme as Theme & { bg?: (color: string, text: string) => string };
	const box = new Box(opts.outputPad ?? 0, 1, (t) => themeAny.bg?.("customMessageBg", t) ?? t);
	const label = theme.fg("dim", String(kind).toLowerCase());
	box.addChild(new Text(`${icon}${label} ${theme.fg("muted", body)}`, 0, 0));
	return box;
}



const ROOT_PATH = "/root";
const CUSTOM_TYPE = "subagent_mailbox";
const STATUS_KEY = "subagent";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MIN_WAIT_TIMEOUT_MS = 10_000;
const MAX_WAIT_TIMEOUT_MS = 3_600_000;
const MAX_CONCURRENT_RUNNING = 4;
const MAX_LIVE_AGENTS = 32;
const MAX_DEPTH = 8;
const FINAL_ANSWER_MAX_CHARS = 48_000;

const TASK_NAME_RE = /^[a-z0-9_]+$/;

const ROOT_USAGE_HINT = `You are \`/root\`, the primary agent in a team of agents collaborating to fulfill the user's goals.

At the start of your turn, you are the active agent.
You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents.
All agents in the team, including the agents that you can assign tasks to, are equally intelligent and capable, and have access to the same set of tools.

You can use \`spawn_agent\` to create a new agent, \`followup_task\` to give an existing agent a new task and trigger a turn, and \`send_message\` to pass a message to a running agent without triggering a turn.
Child agents can also spawn their own sub-agents.
You can decide how much context you want to propagate to your sub-agents with the \`fork_turns\` parameter.

You will receive messages in the form:
Message Type: MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>

All agents share the same directory/filesystem/cwd. Edits by one agent are immediately visible to others.
There are ${MAX_CONCURRENT_RUNNING} available concurrency slots, meaning that up to ${MAX_CONCURRENT_RUNNING} agents can be active at once, including you.
When calling \`wait_agent\`, prefer longer waits (minutes) to avoid busy polling.`;

const SUBAGENT_USAGE_HINT = `You are an agent in a team of agents collaborating to complete a task.

You can spawn sub-agents to handle subtasks, and those sub-agents can spawn their own sub-agents. All agents in the team are equally intelligent and capable, and have access to the same set of tools.

You can use \`spawn_agent\` to create a new agent, \`followup_task\` to give an existing agent a new task and trigger a turn, and \`send_message\` to pass a message to a running agent.
Child agents can also spawn their own sub-agents.

When you provide a final response, that content is immediately delivered back to your parent agent as FINAL_ANSWER.

You will receive messages in the form:
Message Type: NEW_TASK | MESSAGE | FINAL_ANSWER
Task name: <recipient>
Sender: <author>
Payload:
<payload text>

All agents share the same directory/filesystem/cwd.
When calling \`wait_agent\`, prefer longer waits (minutes) to avoid busy polling.`;

const NICKNAMES = [
	"Euclid", "Archimedes", "Ptolemy", "Hypatia", "Avicenna", "Averroes", "Aquinas",
	"Copernicus", "Kepler", "Galileo", "Bacon", "Descartes", "Pascal", "Fermat",
	"Huygens", "Leibniz", "Newton", "Halley", "Euler", "Lagrange", "Laplace", "Volta",
	"Gauss", "Ampere", "Faraday", "Darwin", "Lovelace", "Boole", "Pasteur", "Maxwell",
	"Mendel", "Curie", "Planck", "Tesla", "Noether", "Hilbert", "Einstein", "Bohr",
	"Turing", "Hubble", "Feynman", "Franklin", "Sagan", "Goodall", "Carson", "Carver",
	"Socrates", "Plato", "Aristotle", "Locke", "Hume", "Kant", "Nietzsche", "Russell",
	"Popper", "Arendt", "Godel", "Nash", "Ramanujan", "Dirac", "Heisenberg", "Pauli",
];

type AgentStatus =
	| "pending_init"
	| "running"
	| "interrupted"
	| { completed: string | null }
	| { errored: string }
	| "shutdown";

type MailboxKind = "MESSAGE" | "NEW_TASK" | "FINAL_ANSWER";

interface MailboxItem {
	kind: MailboxKind;
	taskName: string;
	sender: string;
	payload: string;
	at: number;
}

interface AgentRole {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinkingLevel?: ThinkingLevel;
	systemPrompt: string;
	source: "builtin" | "user" | "project";
}

interface AgentRecord {
	path: string;
	parentPath: string | null;
	nickname: string;
	role: string;
	status: AgentStatus;
	depth: number;
	session?: AgentSession;
	unsubscribe?: () => void;
	mailbox: MailboxItem[];
	activityWaiters: Array<(reason: "mailbox" | "steer") => void>;

	busy: boolean;
	modelId?: string;
	createdAt: number;
	lastText?: string;
	errorMessage?: string;
}

interface SpawnDetails {
	taskName: string;
	nickname?: string | null;
	role: string;
	status: string;
}

const BUILTIN_ROLES: AgentRole[] = [
	{
		name: "default",
		description: "General-purpose sub-agent with the same tools as the parent.",
		systemPrompt: "",
		source: "builtin",
	},
	{
		name: "explorer",
		description: "Read-only codebase explorer. Investigates and reports findings; does not edit files.",
		tools: ["read", "grep", "find", "ls", "bash"],
		thinkingLevel: "low",
		systemPrompt: `You are an explorer sub-agent.
Investigate the codebase and return structured, actionable findings.
Do not modify files. Prefer precise file:line references.
When finished, write a clear final answer the parent can act on without re-reading everything.`,
		source: "builtin",
	},
	{
		name: "awaiter",
		description: "Waits for a long-running command/task and reports only when it finishes.",
		tools: ["bash", "read"],
		thinkingLevel: "low",
		systemPrompt: `You are an awaiter.
Await completion of a specific command or task and report status only when finished.

Rules:
1. Execute or poll the given command/task until it reaches a terminal state.
2. Do not modify the task, interpret beyond status, or do unrelated work.
3. Use long timeouts; if multiple awaits are needed, increase yield times.
4. Only stop when the task succeeds, fails, or you are explicitly told to stop.
Be deterministic and conservative.`,
		source: "builtin",
	},
];

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findProjectAgentsDir(cwd: string): string | null {
	let current = cwd;
	while (true) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function loadRolesFromDir(dir: string, source: "user" | "project"): AgentRole[] {
	const roles: AgentRole[] = [];
	if (!fs.existsSync(dir)) return roles;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return roles;
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		const name = (frontmatter.name || entry.name.replace(/\.md$/, "")).trim();
		if (!name) continue;
		const tools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		const thinkingRaw = (frontmatter.thinking || frontmatter.thinkingLevel || "").trim();
		const thinkingLevel = normalizeThinking(thinkingRaw);
		roles.push({
			name,
			description: (frontmatter.description || name).trim(),
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model?.trim() || undefined,
			thinkingLevel,
			systemPrompt: body.trim(),
			source,
		});
	}
	return roles;
}

function discoverRoles(cwd: string): AgentRole[] {
	const map = new Map<string, AgentRole>();
	for (const r of BUILTIN_ROLES) map.set(r.name, r);
	for (const r of loadRolesFromDir(path.join(getAgentDir(), "agents"), "user")) map.set(r.name, r);
	const projectDir = findProjectAgentsDir(cwd);
	if (projectDir) {
		for (const r of loadRolesFromDir(projectDir, "project")) map.set(r.name, r);
	}
	return Array.from(map.values());
}

function formatRoleCatalog(roles: AgentRole[]): string {
	return roles
		.map((r) => {
			const bits = [r.description];
			if (r.tools) bits.push(`tools=${r.tools.join(",")}`);
			if (r.model) bits.push(`model=${r.model}`);
			return `- \`${r.name}\` (${r.source}): ${bits.join(" · ")}`;
		})
		.join("\n");
}

function normalizeThinking(raw?: string): ThinkingLevel | undefined {
	if (!raw) return undefined;
	const v = raw.trim().toLowerCase();
	const map: Record<string, ThinkingLevel> = {
		off: "off",
		none: "off",
		minimal: "minimal",
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	};
	return map[v];
}

function statusLabel(status: AgentStatus): string {
	if (typeof status === "string") return status;
	if ("completed" in status) return status.completed ? "completed" : "completed(empty)";
	if ("errored" in status) return `errored`;
	return "unknown";
}

function statusJson(status: AgentStatus): unknown {
	return status;
}

function isFinalStatus(status: AgentStatus): boolean {
	if (typeof status === "string") return status === "shutdown";
	return "completed" in status || "errored" in status;
}

function validateAgentName(name: string): string | undefined {
	if (!name) return "agent_name must not be empty";
	if (name === "root") return "agent_name `root` is reserved";
	if (name === "." || name === "..") return `agent_name \`${name}\` is reserved`;
	if (name.includes("/")) return "agent_name must not contain `/`";
	if (!TASK_NAME_RE.test(name)) {
		return "agent_name must use only lowercase letters, digits, and underscores";
	}
	return undefined;
}

function validateAbsolutePath(p: string): string | undefined {
	if (p === ROOT_PATH) return undefined;
	if (!p.startsWith("/root/")) {
		return "absolute agent paths must start with `/root`";
	}
	if (p.endsWith("/")) return "absolute agent path must not end with `/`";
	const rest = p.slice("/root/".length);
	for (const segment of rest.split("/")) {
		const err = validateAgentName(segment);
		if (err) return err;
	}
	return undefined;
}

function joinPath(parent: string, name: string): string {
	const err = validateAgentName(name);
	if (err) throw new Error(err);
	return `${parent.replace(/\/$/, "")}/${name}`;
}

function resolvePath(current: string, reference: string): string {
	const ref = reference.trim();
	if (!ref) throw new Error("agent path must not be empty");
	if (ref === ROOT_PATH) return ROOT_PATH;
	if (ref.startsWith("/")) {
		const err = validateAbsolutePath(ref);
		if (err) throw new Error(err);
		return ref;
	}
	if (ref.endsWith("/")) throw new Error("relative agent path must not end with `/`");
	let pathAcc = current;
	for (const segment of ref.split("/")) {
		pathAcc = joinPath(pathAcc, segment);
	}
	return pathAcc;
}

function truncate(text: string, max = FINAL_ANSWER_MAX_CHARS): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n…[truncated ${text.length - max} chars]`;
}

function formatEnvelope(kind: MailboxKind, taskName: string, sender: string, payload: string): string {
	return `Message Type: ${kind}\nTask name: ${taskName}\nSender: ${sender}\nPayload:\n${payload}`;
}

function formatNotification(agentPath: string, status: AgentStatus): string {
	return `<subagent_notification>\n${JSON.stringify({ agent_path: agentPath, status: statusJson(status) }, null, 2)}\n</subagent_notification>`;
}

function extractAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || (msg as { role?: string }).role !== "assistant") continue;
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const parts: string[] = [];
			for (const part of content) {
				if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
					parts.push(String((part as { text?: string }).text ?? ""));
				}
			}
			const text = parts.join("");
			if (text.trim()) return text;
		}
	}
	return "";
}

function lastNTurns(messages: AgentMessage[], n: number): AgentMessage[] {
	if (n <= 0 || messages.length === 0) return [];
	const turnStarts: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const role = (messages[i] as { role?: string }).role;
		if (role === "user") turnStarts.push(i);
	}
	if (turnStarts.length === 0) return messages.slice(-Math.max(1, n * 2));
	const startIdx = turnStarts[Math.max(0, turnStarts.length - n)];
	return messages.slice(startIdx);
}

function branchMessages(ctx: ExtensionContext): AgentMessage[] {
	try {
		const branch = ctx.sessionManager.getBranch() as SessionEntry[];
		return buildSessionContext(branch).messages;
	} catch {
		return [];
	}
}

function textResult(text: string, details?: unknown, isError = false): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text }],
		details: details ?? {},

		...(isError ? ({ isError: true } as object) : {}),
	} as AgentToolResult<unknown>;
}

function jsonResult(value: unknown, details?: unknown, isError = false): AgentToolResult<unknown> {
	return textResult(JSON.stringify(value, null, 2), details ?? value, isError);
}

class AgentControl {
	readonly agents = new Map<string, AgentRecord>();
	private usedNicknames = new Set<string>();
	private nicknameReset = 0;
	private runningCount = 0;
	private runWaiters: Array<() => void> = [];
	private modelRuntime: ModelRuntime | undefined;
	private rootDeliver:
		| ((item: MailboxItem, opts: { triggerTurn: boolean }) => void)
		| undefined;
	private ui:
		| { setStatus?: (key: string, text: string | undefined) => void; notify?: (msg: string, level?: "info" | "warning" | "error") => void }
		| undefined;
	private disposed = false;

	bindRootDelivery(fn: (item: MailboxItem, opts: { triggerTurn: boolean }) => void) {
		this.rootDeliver = fn;
	}

	bindUi(ui: AgentControl["ui"]) {
		this.ui = ui;
	}

	ensureRoot() {
		if (this.agents.has(ROOT_PATH)) return;
		this.agents.set(ROOT_PATH, {
			path: ROOT_PATH,
			parentPath: null,
			nickname: "root",
			role: "root",
			status: "running",
			depth: 0,
			mailbox: [],
			activityWaiters: [],
			busy: false,
			createdAt: Date.now(),
		});
	}

	async getRuntime(): Promise<ModelRuntime> {
		if (!this.modelRuntime) {
			this.modelRuntime = await ModelRuntime.create();
		}
		return this.modelRuntime;
	}

	reserveNickname(): string {
		const pool = NICKNAMES.map((n) => this.formatNickname(n));
		for (const name of shuffle(pool)) {
			if (!this.usedNicknames.has(name)) {
				this.usedNicknames.add(name);
				return name;
			}
		}
		this.usedNicknames.clear();
		this.nicknameReset += 1;
		const name = this.formatNickname(NICKNAMES[0] ?? "Agent");
		this.usedNicknames.add(name);
		return name;
	}

	private formatNickname(base: string): string {
		if (this.nicknameReset === 0) return base;
		const value = this.nicknameReset + 1;
		const mod100 = value % 100;
		const mod10 = value % 10;
		const suffix =
			mod100 >= 11 && mod100 <= 13 ? "th" : mod10 === 1 ? "st" : mod10 === 2 ? "nd" : mod10 === 3 ? "rd" : "th";
		return `${base} the ${value}${suffix}`;
	}

	/** Optional presentation layer (widget/fleet). Never affects control-plane decisions. */
	uiLayer: SubagentUI | undefined;

	bindUiLayer(ui: SubagentUI) {
		this.uiLayer = ui;
	}

	refreshStatusLine() {
		if (!this.ui?.setStatus) {
			this.uiLayer?.update();
			return;
		}
		const live = [...this.agents.values()].filter((a) => a.path !== ROOT_PATH && a.status !== "shutdown");
		if (live.length === 0) {
			this.ui.setStatus(STATUS_KEY, undefined);
			this.uiLayer?.update();
			return;
		}
		const running = live.filter((a) => a.status === "running" || a.busy).length;
		const parts = live.slice(0, 6).map((a) => {
			const icon = a.busy || a.status === "running" ? "⏳" : isFinalStatus(a.status) ? "✓" : "·";
			return `${icon}${a.nickname}`;
		});
		const extra = live.length > 6 ? ` +${live.length - 6}` : "";
		this.ui.setStatus(STATUS_KEY, `agents ${running}/${live.length} ${parts.join(" ")}${extra}`);
		this.uiLayer?.update();
	}

	/** Snapshot for UI only — does not mutate agent records. */
	toUiRecord(a: AgentRecord): UiAgentRecord {
		const st = a.status;
		let status: UiAgentStatus = "running";
		let error: string | undefined = a.errorMessage;
		if (typeof st === "string") {
			if (st === "pending_init" || st === "running" || st === "interrupted" || st === "shutdown") status = st;
		} else if (st && typeof st === "object") {
			if ("completed" in st) status = "completed";
			else if ("errored" in st) {
				status = "errored";
				error = st.errored;
			}
		}
		const act = this.uiLayer?.getActivity(a.path);
		return {
			id: a.path,
			nickname: a.nickname,
			role: a.role,
			description: act?.description || a.lastText?.split("\n").find((l) => l.trim())?.trim()?.slice(0, 60) || a.path,
			status,
			error,
			startedAt: a.createdAt,
			completedAt: act?.completedAt,
			toolUses: act?.toolUses ?? 0,
			turnCount: act?.turnCount ?? 0,
			modelId: a.modelId,
			session: a.session,
			parentPath: a.parentPath,
			lastText: a.lastText,
			busy: a.busy,
			totalTokens: act?.totalTokens ?? 0,
			contextPercent: act?.contextPercent ?? null,
		};
	}

	listUiAgents(): UiAgentRecord[] {
		return [...this.agents.values()].filter((a) => a.status !== "shutdown").map((a) => this.toUiRecord(a));
	}

	resolveTarget(callerPath: string, target: string): AgentRecord | undefined {
		const t = target.trim();
		if (!t) return undefined;
		try {
			const resolved = resolvePath(callerPath, t);
			const hit = this.agents.get(resolved);
			if (hit && hit.status !== "shutdown") return hit;

			if (t.startsWith("/") || t.includes("/")) return undefined;
		} catch {

		}

		const byNick = [...this.agents.values()].filter(
			(a) => a.status !== "shutdown" && a.nickname === t,
		);
		if (byNick.length === 1) return byNick[0];
		return undefined;
	}

	listAgents(callerPath: string, pathPrefix?: string): Array<{ agent_name: string; agent_status: unknown }> {
		let prefix: string | undefined;
		if (pathPrefix?.trim()) {
			try {
				prefix = resolvePath(callerPath, pathPrefix.trim());
			} catch {
				prefix = pathPrefix.trim().replace(/\/+$/, "");
			}
		}

		return [...this.agents.values()]
			.filter((a) => a.status !== "shutdown")
			.filter((a) => !prefix || a.path === prefix || a.path.startsWith(`${prefix}/`))
			.sort((a, b) => a.path.localeCompare(b.path))
			.map((a) => ({
				agent_name: a.path,
				agent_status: statusJson(a.status),
			}));
	}

	enqueueMailbox(agent: AgentRecord, item: MailboxItem, opts: { triggerTurn: boolean; deliverToConversation: boolean }) {
		agent.mailbox.push(item);

		const waiters = agent.activityWaiters.splice(0);
		for (const w of waiters) w("mailbox");

		if (!opts.deliverToConversation) return;

		if (agent.path === ROOT_PATH) {
			this.rootDeliver?.(item, { triggerTurn: opts.triggerTurn });
			return;
		}

		if (!agent.session) return;
		const content = formatEnvelope(item.kind, item.taskName, item.sender, item.payload);
		void this.deliverToChild(agent, content, opts.triggerTurn);
	}

	private async deliverToChild(agent: AgentRecord, content: string, triggerTurn: boolean) {
		const session = agent.session;
		if (!session || this.disposed) return;
		try {
			if (triggerTurn) {
				if (session.isStreaming) {
					await session.followUp(content);
				} else {
					await this.withCapacity(async () => {
						agent.busy = true;
						agent.status = "running";
						this.refreshStatusLine();
						try {
							await session.prompt(content);
						} finally {
							agent.busy = false;
							this.refreshStatusLine();
						}
					});
				}
			} else {

				if (session.isStreaming) {
					await session.sendCustomMessage(
						{ customType: CUSTOM_TYPE, content, display: true },
						{ deliverAs: "followUp" },
					);
				} else {
					await session.sendCustomMessage(
						{ customType: CUSTOM_TYPE, content, display: true },
						{ deliverAs: "nextTurn" },
					);
				}
			}
		} catch (err) {
			agent.errorMessage = err instanceof Error ? err.message : String(err);
		}
	}

	async waitForActivity(agent: AgentRecord, timeoutMs: number, signal?: AbortSignal): Promise<"mailbox" | "steer" | "timeout"> {
		if (agent.mailbox.length > 0) return "mailbox";
		return await new Promise((resolve) => {
			let settled = false;
			const finish = (reason: "mailbox" | "steer" | "timeout") => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				const idx = agent.activityWaiters.indexOf(onActivity);
				if (idx >= 0) agent.activityWaiters.splice(idx, 1);
				resolve(reason);
			};
			const onActivity = (reason: "mailbox" | "steer") => finish(reason);
			const onAbort = () => finish("steer");
			agent.activityWaiters.push(onActivity);
			const timer = setTimeout(() => finish("timeout"), timeoutMs);
			if (signal) {
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}
		});
	}

	async withCapacity<T>(fn: () => Promise<T>): Promise<T> {
		while (this.runningCount >= MAX_CONCURRENT_RUNNING) {
			await new Promise<void>((r) => this.runWaiters.push(r));
		}
		this.runningCount += 1;
		try {
			return await fn();
		} finally {
			this.runningCount -= 1;
			const next = this.runWaiters.shift();
			if (next) next();
		}
	}

	async interrupt(target: AgentRecord): Promise<AgentStatus> {
		const prev = target.status;
		if (target.path === ROOT_PATH) {
			throw new Error("root is not a spawned agent");
		}
		if (target.session?.isStreaming) {
			await target.session.abort();
		}
		target.status = "interrupted";
		target.busy = false;
		this.uiLayer?.onAgentFinished(target.path);
		this.refreshStatusLine();
		return prev;
	}

	notifyParentCompletion(child: AgentRecord) {
		if (!child.parentPath) return;
		const parent = this.agents.get(child.parentPath);
		if (!parent || parent.status === "shutdown") return;

		const payload =
			typeof child.status === "object" && "completed" in child.status
				? child.status.completed ?? ""
				: typeof child.status === "object" && "errored" in child.status
					? `Agent errored: ${child.status.errored}\n\nThis agent's turn failed. If you still need this agent, use followup_task to give it another task.`
					: child.lastText ?? "";

		const item: MailboxItem = {
			kind: "FINAL_ANSWER",
			taskName: child.path,
			sender: child.path,
			payload: truncate(payload),
			at: Date.now(),
		};

		this.enqueueMailbox(parent, item, { triggerTurn: false, deliverToConversation: true });

		if (parent.path === ROOT_PATH) {
			const note: MailboxItem = {
				kind: "MESSAGE",
				taskName: child.path,
				sender: child.path,
				payload: formatNotification(child.path, child.status),
				at: Date.now(),
			};

			parent.mailbox.push(note);
		}
	}

	wireSessionEvents(agent: AgentRecord) {
		const session = agent.session;
		if (!session) return;
		// Control-plane subscription (unchanged behavior).
		const unsubLogic = session.subscribe((event) => {
			if (event.type === "agent_start") {
				agent.status = "running";
				agent.busy = true;
				this.refreshStatusLine();
			}
			if (event.type === "message_end" && (event as { message?: AgentMessage }).message) {
				const msg = (event as { message: AgentMessage }).message;
				if ((msg as { role?: string }).role === "assistant") {
					const text = extractAssistantText([msg]);
					if (text) agent.lastText = text;
				}
			}
			if (event.type === "agent_end") {
				agent.busy = false;
				const text = extractAssistantText(session.messages) || agent.lastText || "";
				agent.lastText = text;
				const err =
					(session as unknown as { agent?: { state?: { errorMessage?: string } } }).agent?.state?.errorMessage ||
					agent.errorMessage;
				if (err) {
					agent.status = { errored: err };
				} else {
					agent.status = { completed: text || null };
				}
				this.refreshStatusLine();
				this.notifyParentCompletion(agent);
			}
		});
		// Presentation-only subscription — observes events, never mutates agent status/mailbox.
		const unsubUi = session.subscribe((event) => {
			this.uiLayer?.observeSessionEvent(agent.path, event, session);
		});
		agent.unsubscribe = () => {
			unsubLogic();
			unsubUi();
		};
	}

	async disposeAll() {
		this.disposed = true;
		for (const agent of this.agents.values()) {
			try {
				agent.unsubscribe?.();
				if (agent.session) {
					if (agent.session.isStreaming) await agent.session.abort();
					agent.session.dispose();
				}
			} catch {

			}
			agent.status = "shutdown";
			agent.activityWaiters.splice(0).forEach((w) => w("steer"));
		}
		this.agents.clear();
		this.ui?.setStatus?.(STATUS_KEY, undefined);
		this.uiLayer?.dispose();
	}
}

function shuffle<T>(arr: T[]): T[] {
	const a = arr.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

const SpawnParams = Type.Object({
	message: Type.String({ description: "Initial plain-text task for the new agent." }),
	task_name: Type.String({
		description: "Task name for the new agent. Use lowercase letters, digits, and underscores.",
	}),
	agent_type: Type.Optional(
		Type.String({
			description:
				"Agent type/role override. Omit unless needed. Built-ins: default, explorer, awaiter. Also loads ~/.pi/agent/agents/*.md and .pi/agents/*.md.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description: "Model override (provider/model or model id). Omit to inherit the parent model.",
		}),
	),
	reasoning_effort: Type.Optional(
		Type.String({
			description: "Thinking/reasoning level override: off|minimal|low|medium|high|xhigh|max. Omit to inherit.",
		}),
	),
	fork_turns: Type.Optional(
		Type.String({
			description:
				'How much parent history to fork. Defaults to "all". Use "none", "all", or a positive integer string such as "3".',
		}),
	),
});

const TargetMessageParams = Type.Object({
	target: Type.String({
		description: "Relative or canonical task name to message (from spawn_agent).",
	}),
	message: Type.String({ description: "Message text to send to the target agent." }),
});

const WaitParams = Type.Object({
	timeout_ms: Type.Optional(
		Type.Number({
			description: `Timeout in milliseconds. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}, min ${MIN_WAIT_TIMEOUT_MS}, max ${MAX_WAIT_TIMEOUT_MS}.`,
		}),
	),
});

const ListParams = Type.Object({
	path_prefix: Type.Optional(
		Type.String({
			description: "Task-path prefix filter without a trailing slash. Omit to list all live agents.",
		}),
	),
});

const InterruptParams = Type.Object({
	target: Type.String({
		description: "Relative or canonical task name to interrupt (from spawn_agent).",
	}),
});

export default function subagentExtension(pi: ExtensionAPI) {
	const control = new AgentControl();
	let lastCtx: ExtensionContext | undefined;
	let modelRuntimeReady: Promise<ModelRuntime> | undefined;

	// Presentation only — never used for control-plane decisions.
	const uiLayer = new SubagentUI({
		listAgents: () => control.listUiAgents(),
		getActivity: (id) => uiLayer.getActivity(id),
		interrupt: async (id) => {
			const agent = control.agents.get(id);
			if (!agent || agent.path === ROOT_PATH) return false;
			await control.interrupt(agent);
			return true;
		},
		steer: (id, message) => {
			// Uses existing mailbox/follow-up path (same as followup_task tool).
			const agent = control.agents.get(id);
			if (!agent || agent.status === "shutdown") return;
			control.enqueueMailbox(
				agent,
				{
					kind: "NEW_TASK",
					taskName: agent.path,
					sender: ROOT_PATH,
					payload: message,
					at: Date.now(),
				},
				{ triggerTurn: true, deliverToConversation: true },
			);
		},
	});
	control.bindUiLayer(uiLayer);

	const ensureRuntime = () => {
		modelRuntimeReady ??= control.getRuntime();
		return modelRuntimeReady;
	};

	const updateUi = (ctx?: ExtensionContext) => {
		if (ctx) lastCtx = ctx;
		const ui = ctx?.ui ?? lastCtx?.ui;
		if (ui) {
			control.bindUi(ui);
			uiLayer.setUICtx(ui as any);
		}
		control.refreshStatusLine();
	};

	control.bindRootDelivery((item, opts) => {
		const content =
			item.kind === "MESSAGE" && item.payload.includes("<subagent_notification>")
				? item.payload
				: formatEnvelope(item.kind, item.taskName, item.sender, item.payload);

		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content,
				display: true,
				details: { kind: item.kind, taskName: item.taskName, sender: item.sender },
			},
			{

				deliverAs: opts.triggerTurn ? "steer" : "steer",
				triggerTurn: opts.triggerTurn,
			},
		);
	});

	let rootHintInjected = false;
	pi.on("session_start", async (_event, ctx) => {
		control.ensureRoot();
		updateUi(ctx);
		rootHintInjected = false;
		void ensureRuntime();
	});

	pi.on("session_shutdown", async () => {
		await control.disposeAll();
	});

	// UI only: age finished agents in the above-editor widget.
	pi.on("turn_start", async (_event, ctx) => {
		updateUi(ctx);
		uiLayer.onParentTurnStart();
	});

	pi.on("input", async (event) => {
		control.ensureRoot();
		const root = control.agents.get(ROOT_PATH);
		if (!root) return;
		if (event.streamingBehavior === "steer" || event.source === "interactive") {

			if (event.streamingBehavior === "steer") {
				const waiters = root.activityWaiters.splice(0);
				for (const w of waiters) w("steer");
			}
		}
	});

	function resolveModel(runtime: ModelRuntime, spec: string | undefined, fallback: Model<any> | undefined): Model<any> | undefined {
		if (!spec) return fallback;
		const trimmed = spec.trim();
		if (!trimmed) return fallback;
		if (trimmed.includes("/")) {
			const idx = trimmed.indexOf("/");
			const provider = trimmed.slice(0, idx);
			const id = trimmed.slice(idx + 1);
			return runtime.getModel(provider, id) ?? fallback;
		}
		const all = runtime.getModels();
		const exact = all.find((m) => m.id === trimmed);
		if (exact) return exact;
		const fuzzy = all.find((m) => m.id.endsWith(trimmed) || m.id.includes(trimmed));
		return fuzzy ?? fallback;
	}

	function parseForkTurns(raw: string | undefined): "none" | "all" | number {
		const v = (raw ?? "all").trim().toLowerCase();
		if (v === "none") return "none";
		if (v === "all" || v === "") return "all";
		const n = Number.parseInt(v, 10);
		if (!Number.isFinite(n) || n <= 0) {
			throw new Error('fork_turns must be "none", "all", or a positive integer string');
		}
		return n;
	}

	async function spawnAgent(
		callerPath: string,
		params: Static<typeof SpawnParams> & Record<string, unknown>,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<AgentToolResult<SpawnDetails>> {
		control.ensureRoot();
		updateUi(ctx);

		if (params.fork_context !== undefined) {
			return textResult("fork_context is not supported; use fork_turns instead", {}, true);
		}
		for (const banned of ["items", "id", "agent_id", "interrupt"] as const) {
			if (params[banned] !== undefined) {
				return textResult(`spawn_agent does not accept '${banned}'.`, {}, true);
			}
		}

		const message = params.message?.trim();
		if (!message) return textResult("Empty message can't be sent to an agent", {}, true);

		const taskName = params.task_name?.trim() ?? "";
		const nameErr = validateAgentName(taskName);
		if (nameErr) {
			return textResult(`Invalid task_name "${params.task_name}": ${nameErr}`, {}, true);
		}

		const caller = control.agents.get(callerPath) ?? control.agents.get(ROOT_PATH)!;
		const childPath = joinPath(callerPath, taskName);
		if (control.agents.has(childPath)) {
			return textResult(`Agent already exists at ${childPath}. Use followup_task or pick another task_name.`, {}, true);
		}

		const depth = caller.depth + 1;
		if (depth > MAX_DEPTH) {
			return textResult(`Cannot spawn: max agent depth (${MAX_DEPTH}) exceeded.`, {}, true);
		}

		const liveCount = [...control.agents.values()].filter((a) => a.path !== ROOT_PATH && a.status !== "shutdown").length;
		if (liveCount >= MAX_LIVE_AGENTS) {
			return textResult(`Cannot spawn: max live agents (${MAX_LIVE_AGENTS}) reached. Interrupt idle agents or reuse via followup_task.`, {}, true);
		}

		const roles = discoverRoles(ctx.cwd);
		const roleName = (params.agent_type?.trim() || "default").toLowerCase();
		const role = roles.find((r) => r.name.toLowerCase() === roleName);
		if (!role) {
			return textResult(`Unknown agent_type '${params.agent_type}'. Available:\n${formatRoleCatalog(roles)}`, {}, true);
		}

		let forkMode: "none" | "all" | number;
		try {
			forkMode = parseForkTurns(params.fork_turns);
		} catch (err) {
			return textResult(err instanceof Error ? err.message : String(err), {}, true);
		}

		const runtime = await ensureRuntime();
		const parentModel = ctx.model;
		const model = resolveModel(runtime, params.model ?? role.model, parentModel);
		if (!model) {
			return textResult("No model available for spawned agent. Select a model in the parent session first.", {}, true);
		}

		const thinking =
			normalizeThinking(params.reasoning_effort) ??
			role.thinkingLevel ??
			ctx.thinkingLevel ??
			"medium";

		const nickname = control.reserveNickname();

		let forkMessages: AgentMessage[] = [];
		if (forkMode !== "none") {
			const sourceMessages =
				callerPath === ROOT_PATH
					? branchMessages(ctx)
					: (caller.session?.messages.slice() ?? []);
			forkMessages = forkMode === "all" ? sourceMessages : lastNTurns(sourceMessages, forkMode);
		}

		const identity = [
			SUBAGENT_USAGE_HINT,
			"",
			`Your canonical task name is: ${childPath}`,
			`Your parent agent is: ${callerPath}`,
			`Your nickname is: ${nickname}`,
			`Role: ${role.name}`,
			"Available collab tools: spawn_agent, send_message, followup_task, wait_agent, list_agents, interrupt_agent.",
		].join("\n");

		const rolePrompt = role.systemPrompt.trim();
		const appendParts = [identity, rolePrompt].filter(Boolean);

		const multiAgentTools = buildToolsFor(childPath);

		const baseToolNames = role.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"];
		const toolAllow = Array.from(new Set([...baseToolNames, ...multiAgentTools.map((t) => t.name)]));

		const loader = new DefaultResourceLoader({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			appendSystemPrompt: appendParts,
		});
		await loader.reload();

		const { session } = await createAgentSession({
			cwd: ctx.cwd,
			agentDir: getAgentDir(),
			model,
			thinkingLevel: thinking,
			tools: toolAllow,
			customTools: multiAgentTools,
			modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(ctx.cwd),
			resourceLoader: loader,
		});

		if (forkMessages.length > 0) {
			try {
				session.agent.state.messages = forkMessages.slice();
			} catch {

			}
		}

		const record: AgentRecord = {
			path: childPath,
			parentPath: callerPath,
			nickname,
			role: role.name,
			status: "pending_init",
			depth,
			session,
			mailbox: [],
			activityWaiters: [],
			busy: false,
			modelId: `${model.provider}/${model.id}`,
			createdAt: Date.now(),
		};
		control.agents.set(childPath, record);
		control.wireSessionEvents(record);
		uiLayer.onAgentSpawned(childPath, message.split("\n").find((l) => l.trim())?.trim()?.slice(0, 60) || childPath);
		control.refreshStatusLine();

		const spawnEnvelope = [
			formatEnvelope("NEW_TASK", childPath, callerPath, message),
			``,
			`(Your canonical task name is ${childPath}. Refer to siblings by relative name when unambiguous; otherwise use canonical paths.)`,
		].join("\n");

		void control
			.withCapacity(async () => {
				if (signal?.aborted) {
					record.status = "interrupted";
					return;
				}
				record.busy = true;
				record.status = "running";
				control.refreshStatusLine();
				try {
					await session.prompt(spawnEnvelope);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					record.errorMessage = msg;
					if (!isFinalStatus(record.status)) {
						record.status = { errored: msg };
						control.notifyParentCompletion(record);
					}
				} finally {
					record.busy = false;
					control.refreshStatusLine();
				}
			})
			.catch(() => {

			});

		const result = {
			task_name: childPath,
			nickname,
		};
		return jsonResult(result, {
			taskName: childPath,
			nickname,
			role: role.name,
			status: "pending_init",
		} satisfies SpawnDetails);
	}

	async function sendToAgent(
		callerPath: string,
		target: string,
		message: string,
		mode: "queue" | "followup",
	): Promise<AgentToolResult<unknown>> {
		control.ensureRoot();
		const text = message?.trim();
		if (!text) return textResult("Empty message can't be sent to an agent", {}, true);

		const agent = control.resolveTarget(callerPath, target);
		if (!agent) {
			return textResult(
				`Unknown target "${target}". Use list_agents to see live agents, or pass a canonical path like /root/task_name.`,
				{},
				true,
			);
		}
		if (agent.path === ROOT_PATH && mode === "followup") {
			return textResult("Follow-up tasks can't target the root agent", {}, true);
		}
		if (agent.status === "shutdown") {
			return textResult(`Target ${agent.path} is shut down.`, {}, true);
		}

		const item: MailboxItem = {
			kind: mode === "followup" ? "NEW_TASK" : "MESSAGE",
			taskName: agent.path,
			sender: callerPath,
			payload: text,
			at: Date.now(),
		};

		control.enqueueMailbox(agent, item, {
			triggerTurn: mode === "followup",
			deliverToConversation: true,
		});

		return textResult("", { target: agent.path, mode });
	}

	async function waitAgent(
		callerPath: string,
		timeoutMs: number | undefined,
		signal: AbortSignal | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> {
		control.ensureRoot();
		updateUi(ctx);
		const agent = control.agents.get(callerPath) ?? control.agents.get(ROOT_PATH)!;

		const requested = timeoutMs;
		let effective = requested ?? DEFAULT_WAIT_TIMEOUT_MS;
		if (requested !== undefined && requested > MAX_WAIT_TIMEOUT_MS) {
			return textResult(`timeout_ms must be at most ${MAX_WAIT_TIMEOUT_MS}`, {}, true);
		}
		if (requested !== undefined) effective = Math.max(requested, MIN_WAIT_TIMEOUT_MS);
		else effective = DEFAULT_WAIT_TIMEOUT_MS;

		const outcome = await control.waitForActivity(agent, effective, signal);

		let message =
			outcome === "mailbox" ? "Wait completed." : outcome === "steer" ? "Wait interrupted by new input." : "Wait timed out.";

		if (requested !== undefined && requested < effective) {
			message += `\n\nRequested timeout of ${requested}ms was clamped to the minimum of ${effective}ms.`;
		}

		return jsonResult({ message, timed_out: outcome === "timeout" }, { message, timed_out: outcome === "timeout" });
	}

	function buildToolsFor(callerPath: string): ToolDefinition[] {

		const exampleChild = `${callerPath.replace(/\/$/, "")}/task_3`;
		const spawnDesc = [
			"Spawns an agent to work on the specified task.",
			`If your current task is \`${callerPath}\` and you spawn_agent with task_name "task_3" the agent will have canonical task name \`${exampleChild}\`.`,
			"You are then able to refer to this agent as `task_3` or the canonical path interchangeably. Cross-branch agents require the canonical path.",
			"The spawned agent will have the same tools as you and the ability to spawn its own subagents.",
			"Only call this tool for a concrete, bounded subtask that can run independently alongside useful local work; otherwise continue locally.",
			"It will be able to send you and other running agents messages, and its final answer will be provided to you when it finishes.",
			"The new agent's canonical task name will be provided to it along with the message.",
			'Note that passing fork_turns="none" will not pass any surrounding context, whereas fork_turns="all" provides full surrounding context.',
		].join(" ");

		const tools: ToolDefinition[] = [
			{
				name: "spawn_agent",
				label: "Spawn agent",
				description: spawnDesc,
				promptSnippet: "spawn_agent: spawn persistent sub-agent by task_name",
				parameters: SpawnParams,
				executionMode: "parallel",
				async execute(_id, params, signal, _onUpdate, ctx) {
					return spawnAgent(callerPath, params, ctx, signal);
				},
				renderCall(args, theme) {
					const displayName = args.agent_type || "Agent";
					const desc = (args.message.split("\n").find((l: string) => l.trim())?.trim() ?? args.message).slice(0, 60);
					return new Text(
						`▸ ${theme.fg("toolTitle", theme.bold(displayName))}  ${theme.fg("muted", desc)}${theme.fg("dim", ` · ${args.task_name}`)}`,
						0,
						0,
					);
				},
				renderResult(result, { expanded, isPartial }, theme) {
					const d = result.details as SpawnDetails | undefined;
					const path = d?.taskName;
					const live = path ? control.agents.get(path) : undefined;
					if (live) {
						const uiRec = control.toUiRecord(live);
						const details = uiLayer.spawnDetailsFor(uiRec, isPartial ? "running" : live.busy || live.status === "running" || live.status === "pending_init" ? "background" : undefined);
						return renderAgentResult({ content: result.content as any, details: { ...details, taskName: path, nickname: live.nickname, role: live.role } }, { expanded, isPartial }, theme);
					}
					if (d) {
						return renderAgentResult(
							{
								content: result.content as any,
								details: {
									displayName: d.nickname || d.role,
									description: d.taskName,
									role: d.role,
									toolUses: 0,
									durationMs: 0,
									status: "background",
									agentId: d.taskName,
									nickname: d.nickname ?? undefined,
								},
							},
							{ expanded, isPartial },
							theme,
						);
					}
					const body =
						typeof result.content?.[0] === "object" && result.content[0] && "text" in result.content[0]
							? String((result.content[0] as { text: string }).text)
							: "";
					return new Text(body, 0, 0);
				},
			},
			{
				name: "send_message",
				label: "Send message",
				description:
					"Send a message to an existing agent. The message will be delivered promptly. Does not trigger a new turn.",
				promptSnippet: "send_message: queue message, no turn trigger",
				parameters: TargetMessageParams,
				executionMode: "parallel",
				async execute(_id, params) {
					return sendToAgent(callerPath, params.target, params.message, "queue");
				},
				renderCall(args, theme) {
					return new Text(
						`${theme.fg("toolName", "send_message")} → ${theme.fg("accent", args.target)}`,
						0,
						0,
					);
				},
			},
			{
				name: "followup_task",
				label: "Follow-up task",
				description:
					"Send a follow-up task to an existing non-root target agent and trigger a turn if it is idle. If the target is already running, deliver the task promptly at message boundaries while sampling, or after the pending tool call completes.",
				promptSnippet: "followup_task: message + trigger turn",
				parameters: TargetMessageParams,
				executionMode: "parallel",
				async execute(_id, params) {
					return sendToAgent(callerPath, params.target, params.message, "followup");
				},
				renderCall(args, theme) {
					return new Text(
						`${theme.fg("toolName", "followup_task")} → ${theme.fg("accent", args.target)}`,
						0,
						0,
					);
				},
			},
			{
				name: "wait_agent",
				label: "Wait agent",
				description:
					"Wait for a mailbox update from any live agent, including queued messages and final-status notifications. The wait also ends early when new user input is steered into the active turn. Does not return the content; returns either a summary of which agents have updates (if any), an interruption summary for steered input, or a timeout summary if no activity arrives before the deadline.",
				promptSnippet: "wait_agent: wait for mailbox activity",
				parameters: WaitParams,
				executionMode: "sequential",
				async execute(_id, params, signal, _onUpdate, ctx) {

					if ((params as { targets?: unknown }).targets !== undefined) {
						return textResult(
							"wait_agent does not accept 'targets'. It waits for any mailbox activity.",
							{},
							true,
						);
					}
					return waitAgent(callerPath, params.timeout_ms, signal, ctx);
				},
				renderCall(args, theme) {
					const t = args.timeout_ms ?? DEFAULT_WAIT_TIMEOUT_MS;
					return new Text(`${theme.fg("toolName", "wait_agent")} ${theme.fg("dim", `${t}ms`)}`, 0, 0);
				},
			},
			{
				name: "list_agents",
				label: "List agents",
				description: "List live agents in the current root thread tree. Optionally filter by task-path prefix.",
				promptSnippet: "list_agents: show live sub-agents and their status",
				parameters: ListParams,
				executionMode: "parallel",
				async execute(_id, params) {
					control.ensureRoot();
					if ((params as { targets?: unknown }).targets !== undefined) {
						return textResult(
							"list_agents does not accept 'targets'. Use path_prefix.",
							{},
							true,
						);
					}
					const agents = control.listAgents(callerPath, params.path_prefix);
					return jsonResult({ agents }, { agents });
				},
				renderCall(args, theme) {
					return new Text(
						`${theme.fg("toolName", "list_agents")}${args.path_prefix ? theme.fg("dim", ` ${args.path_prefix}`) : ""}`,
						0,
						0,
					);
				},
				renderResult(result, { expanded }, theme) {
					const agents =
						(result.details as { agents?: Array<{ agent_name: string; agent_status: unknown }> })?.agents ?? [];
					if (agents.length === 0) return new Text(theme.fg("dim", "no live agents"), 0, 0);
					const lines = agents.map((a) => {
						const st =
							typeof a.agent_status === "string"
								? a.agent_status
								: a.agent_status && typeof a.agent_status === "object" && "completed" in (a.agent_status as object)
									? "completed"
									: a.agent_status && typeof a.agent_status === "object" && "errored" in (a.agent_status as object)
										? "errored"
										: statusLabel(a.agent_status as AgentStatus);
						return `${theme.fg("accent", a.agent_name)} ${theme.fg("dim", st)}`;
					});
					return new Text(expanded ? lines.join("\n") : lines.slice(0, 5).join("\n"), 0, 0);
				},
			},
			{
				name: "interrupt_agent",
				label: "Interrupt agent",
				description:
					"Interrupt an agent's current turn, if any, and return its previous status. The agent remains available for messages and follow-up tasks.",
				promptSnippet: "interrupt_agent: stop turn, keep agent",
				parameters: InterruptParams,
				executionMode: "parallel",
				async execute(_id, params) {
					control.ensureRoot();
					const agent = control.resolveTarget(callerPath, params.target);
					if (!agent) return textResult(`Unknown target "${params.target}".`, {}, true);
					if (agent.path === ROOT_PATH) return textResult("root is not a spawned agent", {}, true);
					if (agent.path === callerPath) {
						return textResult(
							"an agent cannot interrupt itself; return your result and let the parent interrupt you if needed",
							{},
							true,
						);
					}
					try {
						const previous_status = await control.interrupt(agent);
						return jsonResult({ previous_status: statusJson(previous_status) }, { previous_status });
					} catch (err) {
						return textResult(err instanceof Error ? err.message : String(err), {}, true);
					}
				},
				renderCall(args, theme) {
					return new Text(
						`${theme.fg("toolName", "interrupt_agent")} ${theme.fg("warning", args.target)}`,
						0,
						0,
					);
				},
			},
		];

		return tools;
	}

	for (const tool of buildToolsFor(ROOT_PATH)) {
		pi.registerTool(tool);
	}

	pi.on("before_agent_start", async (_event, ctx) => {
		control.ensureRoot();
		updateUi(ctx);
		if (rootHintInjected) return;
		rootHintInjected = true;
		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: ROOT_USAGE_HINT,
				display: false,
				details: { kind: "usage_hint" },
			},
			{ deliverAs: "steer", triggerTurn: false },
		);
	});

	pi.registerMessageRenderer(CUSTOM_TYPE, (msg, { expanded, outputPad }, theme) => {
		// Visual only — does not change what the model receives.
		const details = msg.details as { kind?: string; taskName?: string; sender?: string } | undefined;
		const content = typeof msg.content === "string" ? msg.content : "";
		if (details?.kind === "FINAL_ANSWER" || content.includes("<subagent_notification>")) {
			const taskName = details?.taskName || details?.sender || (/^Task name:\s*(.+)$/m.exec(content)?.[1]?.trim());
			const rec = taskName ? control.agents.get(taskName) : undefined;
			if (rec) {
				const notif = uiLayer.buildNotification(control.toUiRecord(rec));
				if (!rec.lastText) {
					const payloadMatch = /Payload:\n([\s\S]*)/.exec(content);
					if (payloadMatch?.[1]) {
						notif.resultPreview = payloadMatch[1].replace(/<\/?subagent_notification>/g, "").trim().slice(0, 500);
					}
				}
				return renderMailboxMessage({ content, details: notif }, { expanded, outputPad }, theme as any);
			}
		}
		return renderMailboxMessage(msg, { expanded, outputPad }, theme as any);
	});

	pi.registerCommand("agents", {
		description: "Browse live sub-agents (widget · fleet · viewer)",
		handler: async (args, ctx) => {
			control.ensureRoot();
			updateUi(ctx);
			const prefix = args.trim() || undefined;
			const agents = control.listAgents(ROOT_PATH, prefix);
			const live = agents
				.map((a) => control.agents.get(a.agent_name))
				.filter((a): a is AgentRecord => !!a && a.path !== ROOT_PATH);
			const roles = formatRoleCatalog(discoverRoles(ctx.cwd));
			if (live.length === 0) {
				const choice = await ctx.ui.select("Agents", ["No live sub-agents", "Show roles…"]);
				if (choice?.startsWith("Show roles")) ctx.ui.notify(`Roles:\n${roles}`, "info");
				return;
			}
			const liveTree = buildAgentTree(live.map((a) => control.toUiRecord(a)));
			const options = [
				...liveTree.map((entry) => {
					const ui = entry.record;
					const { branch } = treeBranchParts(entry);
					return `${branch} ${ui.nickname} · ${ui.role} · ${ui.status} · ${ui.id}`;
				}),
				"───",
				"Show roles…",
				"Interrupt agent…",
			];
			const choice = await ctx.ui.select(`Agents (${live.length} live)`, options);
			if (!choice || choice === "───") return;
			if (choice.startsWith("Show roles")) {
				ctx.ui.notify(`Roles:\n${roles}`, "info");
				return;
			}
			if (choice.startsWith("Interrupt")) {
				const targets = live.filter((a) => a.status === "running" || a.busy || a.status === "pending_init");
				if (targets.length === 0) {
					ctx.ui.notify("No running agents to interrupt", "info");
					return;
				}
				const pick = await ctx.ui.select(
					"Interrupt which agent?",
					targets.map((a) => `${a.nickname} (${a.path})`),
				);
				if (!pick) return;
				const target = targets.find((a) => pick.startsWith(a.nickname));
				if (!target) return;
				await control.interrupt(target);
				ctx.ui.notify(`Interrupted ${target.path} (${target.nickname})`, "info");
				return;
			}
			const selected = live.find((a) => choice.includes(a.path));
			if (!selected?.session) {
				ctx.ui.notify(selected ? `Agent ${selected.path} has no session yet.` : "Unknown agent", "info");
				return;
			}
			await uiLayer.openViewer(control.toUiRecord(selected));
		},
	});

	pi.registerCommand("interrupt-agent", {
		description: "Interrupt a live sub-agent by task name or path",
		handler: async (args, ctx) => {
			control.ensureRoot();
			const target = args.trim();
			if (!target) {
				ctx.ui.notify("Usage: /interrupt-agent <task_name|path>", "error");
				return;
			}
			const agent = control.resolveTarget(ROOT_PATH, target);
			if (!agent || agent.path === ROOT_PATH) {
				ctx.ui.notify(`Unknown agent: ${target}`, "error");
				return;
			}
			await control.interrupt(agent);
			ctx.ui.notify(`Interrupted ${agent.path} (${agent.nickname})`, "info");
		},
	});
}
