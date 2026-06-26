import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import { CODEX_FAST_STATUS_KEY, modelSupportsCodexFastMode } from "./fast";

function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

function lastPathSegment(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function fg(hex: string, text: string): string {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

const footerColors = {
	project: "#89B4FA", // Catppuccin blue
	branch: "#F9E2AF", // Catppuccin yellow
	sessionName: "#F5C2E7", // Catppuccin pink
	provider: "#BAC2DE", // Catppuccin subtext1
	model: "#FAB387", // Catppuccin peach
	fast: "#74C7EC", // Catppuccin sapphire
	thinking: "#CBA6F7", // Catppuccin mauve
	context: "#94E2D5", // Catppuccin teal
	codexSession: "#A6E3A1", // Catppuccin green
	codexWeekly: "#F38BA8", // Catppuccin red
	codexSpark: "#A6E3A1", // Catppuccin green (same as normal Codex usage)
} as const;

const CODEX_SPARK_MODEL_ID = "gpt-5.3-codex-spark";

type Model = ExtensionContext["model"];
type CodexBucket = { usedPercent?: number; resetsAt?: number | null; windowDurationMins?: number | null };
type CodexLimit = {
	limitId?: string | null;
	limitName?: string | null;
	primary?: CodexBucket | null;
	secondary?: CodexBucket | null;
};
type CodexRateLimitsPayload = {
	rateLimits?: CodexLimit | null;
	rateLimitsByLimitId?: Record<string, CodexLimit | null> | null;
};
type CodexUsagePart = { label: string; remaining: number; resetEpoch?: number; color: string };
type CodexUsageKind = "codex" | "spark" | "other";
type CodexUsageGroup = { kind: CodexUsageKind; label: string; parts: CodexUsagePart[]; color: string };
type CodexUsage = { groups: CodexUsageGroup[] };
type AppServerMessage = { id?: number; method: string; params?: unknown };

function remainingPercent(used: number): number {
	return Math.max(0, Math.min(100, 100 - used));
}

function formatResetCountdown(epoch: number | undefined, now = Date.now()): string | undefined {
	if (!epoch || epoch <= 0) return undefined;

	const remainingMs = epoch * 1000 - now;
	if (remainingMs <= 0) return "now";

	const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000));
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;

	if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

function formatWindowLabel(durationMins: number | null | undefined, fallback: string): string {
	if (!durationMins || durationMins <= 0) return fallback;
	if (durationMins === 300) return "session";
	if (durationMins === 10080) return "weekly";
	if (durationMins % 10080 === 0) return `${durationMins / 10080}w`;
	if (durationMins % 1440 === 0) return `${durationMins / 1440}d`;
	if (durationMins % 60 === 0) return `${durationMins / 60}h`;
	return `${durationMins}m`;
}

function formatCodexUsagePart(part: CodexUsagePart, now = Date.now()): string {
	const resetCountdown = formatResetCountdown(part.resetEpoch, now);
	const resetText = resetCountdown ? ` ${resetCountdown}` : "";

	return `${part.label} ${part.remaining}%${resetText}`;
}

function codexLimitKind(limit: CodexLimit, fallbackId: string): CodexUsageKind {
	const label = limit.limitName?.trim().toLowerCase();
	const limitId = (limit.limitId ?? fallbackId).toLowerCase();
	if (label?.includes("spark")) return "spark";
	if (limitId === "codex") return "codex";
	return "other";
}

function codexLimitLabel(limit: CodexLimit, fallbackId: string, kind: CodexUsageKind): string {
	const label = limit.limitName?.trim();
	if (kind === "spark") return "spark";
	if (kind === "codex") return "codex";
	if (label) return label.replace(/^gpt-/i, "");
	return (limit.limitId ?? fallbackId).replace(/^codex_/, "");
}

function parseCodexLimit(limit: CodexLimit, fallbackId: string): CodexUsageGroup | undefined {
	const parts: CodexUsagePart[] = [];
	const kind = codexLimitKind(limit, fallbackId);
	const label = codexLimitLabel(limit, fallbackId, kind);
	const groupColor = kind === "spark" ? footerColors.codexSpark : footerColors.codexSession;
	if (limit?.primary?.usedPercent !== undefined) {
		const remaining = remainingPercent(limit.primary.usedPercent);
		parts.push({
			label: formatWindowLabel(limit.primary.windowDurationMins, "session"),
			remaining,
			resetEpoch: limit.primary.resetsAt ?? undefined,
			color: groupColor,
		});
	}

	if (limit?.secondary?.usedPercent !== undefined) {
		const remaining = remainingPercent(limit.secondary.usedPercent);
		parts.push({
			label: formatWindowLabel(limit.secondary.windowDurationMins, "weekly"),
			remaining,
			resetEpoch: limit.secondary.resetsAt ?? undefined,
			color: footerColors.codexWeekly,
		});
	}

	return parts.length > 0 ? { kind, label, parts, color: groupColor } : undefined;
}

function parseCodexUsage(payload: any): CodexUsage | undefined {
	const data = payload as CodexRateLimitsPayload | undefined;
	const byLimitId = data?.rateLimitsByLimitId;
	const limits = new Map<string, CodexLimit>();

	if (data?.rateLimits) {
		limits.set(data.rateLimits.limitId ?? "codex", data.rateLimits);
	}
	if (byLimitId) {
		for (const [limitId, limit] of Object.entries(byLimitId)) {
			if (limit) limits.set(limitId, limit);
		}
	}

	const groups = Array.from(limits.entries())
		.sort(([a], [b]) => {
			if (a === "codex") return -1;
			if (b === "codex") return 1;
			return a.localeCompare(b);
		})
		.map(([limitId, limit]) => parseCodexLimit(limit, limitId))
		.filter((group): group is CodexUsageGroup => Boolean(group));

	return groups.length > 0 ? { groups } : undefined;
}

function modelUsesSparkLimit(model: Model | undefined): boolean {
	return model?.provider === "openai-codex" && model.id.toLowerCase() === CODEX_SPARK_MODEL_ID;
}

function isCodexModel(model: Model | undefined): boolean {
	return model?.provider === "openai-codex";
}

function visibleCodexUsageGroups(usage: CodexUsage | undefined, model: Model | undefined): CodexUsageGroup[] {
	if (!usage || model?.provider !== "openai-codex") return [];
	const targetKind: CodexUsageKind = modelUsesSparkLimit(model) ? "spark" : "codex";
	return usage.groups.filter((group) => group.kind === targetKind);
}

class CodexUsageClient {
	private child: ChildProcess | undefined;
	private buffer = "";
	private nextId = 1;
	private initializeId: number | undefined;

	constructor(
		private readonly onUsage: (usage: CodexUsage) => void,
		private readonly onStop: (client: CodexUsageClient) => void,
	) {}

	start(): void {
		if (this.child) return;

		const codexBinary = process.env.PEEK_CODEX_BIN?.trim() || "codex";
		const child: ChildProcess = spawn(codexBinary, ["app-server", "--listen", "stdio://"], {
			stdio: ["pipe", "pipe", "ignore"],
		});
		this.child = child;

		const childEvents = child as ChildProcess & EventEmitter;
		childEvents.on("error", () => this.stop());
		childEvents.on("close", () => this.stop());
		child.stdout?.on("data", (chunk) => this.handleData(chunk.toString("utf8")));

		this.initializeId = this.nextId++;
		this.send({
			id: this.initializeId,
			method: "initialize",
			params: {
				clientInfo: { name: "pi-footer", title: "Pi Footer", version: "0.1.0" },
				capabilities: {},
			},
		});

	}

	stop(): void {
		if (!this.child && !this.buffer) return;

		const child = this.child;
		this.child = undefined;
		this.initializeId = undefined;
		this.buffer = "";
		if (child && !child.killed) child.kill();
		this.onStop(this);
	}

	private handleData(data: string): void {
		this.buffer += data;
		let newlineIndex: number;
		while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, newlineIndex).trim();
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (!line) continue;
			this.handleEnvelope(line);
		}
	}

	private handleEnvelope(line: string): void {
		let envelope: any;
		try {
			envelope = JSON.parse(line);
		} catch {
			return;
		}

		if (envelope.id === this.initializeId) {
			if (!envelope.error) {
				this.send({ method: "initialized", params: {} });
				this.requestRateLimits();
			}
			return;
		}

		const usage = envelope.result
			? parseCodexUsage(envelope.result)
			: envelope.method === "account/rateLimits/updated"
				? parseCodexUsage(envelope.params)
				: undefined;

		if (usage) {
			this.onUsage(usage);
		}
	}

	private requestRateLimits(): void {
		this.send({ id: this.nextId++, method: "account/rateLimits/read" });
	}

	private send(message: AppServerMessage): void {
		this.child?.stdin?.write(JSON.stringify(message) + "\n");
	}
}

export default function (pi: ExtensionAPI) {
	let activeModel: Model;
	let requestFooterRender: (() => void) | undefined;
	let codexUsage: CodexUsage | undefined;
	let codexClient: CodexUsageClient | undefined;
	let codexCountdownTimer: NodeJS.Timeout | undefined;
	let footerActive = false;

	function stopCodexUsageClient() {
		const client = codexClient;
		codexClient = undefined;
		client?.stop();
		codexUsage = undefined;
		if (codexCountdownTimer) clearInterval(codexCountdownTimer);
		codexCountdownTimer = undefined;
		requestFooterRender?.();
	}

	function refreshCodexUsageClient() {
		if (!footerActive || !isCodexModel(activeModel)) {
			stopCodexUsageClient();
			return;
		}

		if (codexClient) return;
		codexClient = new CodexUsageClient(
			(usage) => {
				codexUsage = usage;
				requestFooterRender?.();
			},
			(client) => {
				if (codexClient === client) {
					codexClient = undefined;
					codexUsage = undefined;
					if (codexCountdownTimer) clearInterval(codexCountdownTimer);
					codexCountdownTimer = undefined;
					requestFooterRender?.();
				}
			},
		);
		codexClient.start();

		if (!codexCountdownTimer) {
			codexCountdownTimer = setInterval(() => requestFooterRender?.(), 60 * 1000);
		}
	}

	function installFooter(ctx: ExtensionContext) {
		activeModel = ctx.model;

		if (!ctx.hasUI) return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			footerActive = true;
			requestFooterRender = () => tui.requestRender();
			refreshCodexUsageClient();
			const unsubscribeBranch = footerData.onBranchChange(requestFooterRender);

			return {
				dispose() {
					unsubscribeBranch();
					footerActive = false;
					requestFooterRender = undefined;
					stopCodexUsageClient();
				},
				invalidate() {},
				render(width: number): string[] {
					const model = activeModel ?? ctx.model;

					const projectName = lastPathSegment(ctx.sessionManager.getCwd());

					let projectText = projectName;
					let projectLine = fg(footerColors.project, projectText);
					const branch = footerData.getGitBranch();
					if (branch) {
						projectText += ` • ${branch}`;
						projectLine += theme.fg("dim", " • ") + fg(footerColors.branch, branch);
					}
					const sessionName = ctx.sessionManager.getSessionName();
					if (sessionName) {
						projectText += ` • ${sessionName}`;
						projectLine += theme.fg("dim", " • ") + fg(footerColors.sessionName, sessionName);
					}

					const contextUsage = ctx.getContextUsage();
					const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
					const contextPercentValue = contextUsage?.percent ?? 0;
					const contextTokens = contextUsage?.tokens;
					const contextUsed = contextTokens === null || contextTokens === undefined ? undefined : contextTokens;
					const contextLeft = contextUsed === undefined ? undefined : Math.max(0, contextWindow - contextUsed);
					const contextLeftText = contextLeft === undefined ? "?" : formatTokens(contextLeft);
					const contextPercentText = contextUsage?.percent === null || contextUsage?.percent === undefined ? "?" : `${contextUsage.percent.toFixed(1)}%`;
					const contextText = `${contextPercentText} (${contextLeftText} left)`;
					const contextColor = contextPercentValue > 90 ? "#cc6666" : contextPercentValue > 70 ? "#ffff00" : footerColors.context;

					const modelName = model?.id || "no-model";
					const extensionStatuses = footerData.getExtensionStatuses();
					const fastStatus = sanitizeStatusText(extensionStatuses.get(CODEX_FAST_STATUS_KEY) ?? "");
					const fastText = fastStatus === "fast:on" && modelSupportsCodexFastMode(model) ? "fast" : undefined;
					let rightSideWithoutProvider = fastText ? `${modelName} • ${fastText}` : modelName;
					const thinkingLevel = pi.getThinkingLevel();
					if (model?.reasoning) {
						rightSideWithoutProvider += thinkingLevel === "off" ? " • thinking off" : ` • ${thinkingLevel}`;
					}

					let rightSide = rightSideWithoutProvider;
					let includesProvider = false;
					if (footerData.getAvailableProviderCount() > 1 && model) {
						rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
						includesProvider = true;
						if (visibleWidth(projectText) + 3 + visibleWidth(rightSide) > width) {
							rightSide = rightSideWithoutProvider;
							includesProvider = false;
						}
					}

					const visibleCodexGroups = visibleCodexUsageGroups(codexUsage, model);
					// Keep model close to project/branch, left aligned on the same footer row.
					const codexSegment = visibleCodexGroups.length > 0
						? theme.fg("dim", " • ") +
							visibleCodexGroups
								.map(
									(group) =>
										group.parts.map((part) => fg(part.color, formatCodexUsagePart(part))).join(theme.fg("dim", " • ")),
								)
								.join(theme.fg("dim", " • "))
						: "";
					const headerLine = truncateToWidth(
						projectLine +
							theme.fg("dim", " • ") +
							styleRight(theme, rightSide, modelName, fastText, thinkingLevel, includesProvider) +
							theme.fg("dim", " • ") +
							fg(contextColor, contextText) +
							codexSegment,
						width,
						theme.fg("dim", "..."),
					);
					const lines = [headerLine];

					const visibleExtensionStatuses = Array.from(extensionStatuses.entries()).filter(
						([key]) => key !== CODEX_FAST_STATUS_KEY,
					);
					if (visibleExtensionStatuses.length > 0) {
						const statusColors: ThemeColor[] = ["success", "warning", "accent", "mdCode", "syntaxNumber", "syntaxString"];
						const statusLine = visibleExtensionStatuses
							.sort(([a], [b]) => a.localeCompare(b))
							.map(([, text], index) => theme.fg(statusColors[index % statusColors.length]!, sanitizeStatusText(text)))
							.join(theme.fg("dim", " "));
						lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
					}

					return lines;
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		installFooter(ctx);
	});

	pi.on("session_shutdown", async () => {
		footerActive = false;
		requestFooterRender = undefined;
		stopCodexUsageClient();
	});

	pi.on("model_select", async (event) => {
		activeModel = event.model;
		refreshCodexUsageClient();
		requestFooterRender?.();
	});

	pi.on("thinking_level_select", async () => {
		requestFooterRender?.();
	});

	pi.on("message_end", async () => {
		requestFooterRender?.();
	});

	pi.on("session_compact", async () => {
		requestFooterRender?.();
	});
}

function styleRight(
	theme: ExtensionContext["ui"]["theme"],
	rightSide: string,
	modelName: string,
	fastText: string | undefined,
	thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>,
	includesProvider: boolean,
): string {
	let rest = rightSide;
	let styled = "";

	if (includesProvider) {
		const providerEnd = rest.indexOf(") ");
		if (providerEnd >= 0) {
			styled += fg(footerColors.provider, rest.slice(0, providerEnd + 2));
			rest = rest.slice(providerEnd + 2);
		}
	}

	if (!rest.startsWith(modelName)) return styled + fg(footerColors.model, rest);

	styled += fg(footerColors.model, modelName);
	rest = rest.slice(modelName.length);

	if (fastText && rest.startsWith(` • ${fastText}`)) {
		styled += theme.fg("dim", " • ") + fg(footerColors.fast, fastText);
		rest = rest.slice(` • ${fastText}`.length);
	}

	if (!rest) return styled;

	const thinkingText = rest.replace(/^ • /, "");
	return styled + theme.fg("dim", " • ") + fg(footerColors.thinking, thinkingText);
}
