/**
 * Standalone installation of Joselay/pi-kit extensions/usage.
 * Source: https://github.com/Joselay/pi-kit/tree/main/extensions/usage
 * Upstream commit: 06d95d2562c39cc34392ef1c3e22ce0e67cb994a
 */
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type NotifyLevel = "info" | "warning" | "error";
function notify(ctx: ExtensionContext, message: string, level: NotifyLevel = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

const PROVIDER_ID = "openai-codex";

const CHATGPT_BASE_URL = "https://chatgpt.com/backend-api";
const REQUEST_TIMEOUT_MS = 10_000;

type CodexRequestOptions = {
	userAgent: string;
	signal?: AbortSignal;
	allow404?: boolean;
};

function authClaim(access: string): Record<string, unknown> | undefined {
	try {
		const encoded = access.split(".")[1];
		if (!encoded) return undefined;
		const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
		if (!isRecord(payload)) return undefined;
		const claim = payload["https://api.openai.com/auth"];
		return isRecord(claim) ? claim : undefined;
	} catch {
		return undefined;
	}
}

function accountIdFromAccessToken(access: string): string | undefined {
	const value = authClaim(access)?.chatgpt_account_id;
	return typeof value === "string" && value ? value : undefined;
}

function codexAccount(ctx: ExtensionContext) {
	return {
		async request(path: string, options: CodexRequestOptions): Promise<unknown> {
			const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
			const access = resolved?.auth.apiKey;
			if (!access) {
				const configured = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured;
				throw new Error(configured
					? "Couldn't refresh OpenAI Codex credentials. Try /login again."
					: "Log in to OpenAI Codex with /login first.");
			}

			const accountId = accountIdFromAccessToken(access);
			if (!accountId) throw new Error("OpenAI Codex credentials are invalid. Try /login again.");

			const configuredBase = process.env.PI_CODEX_CHATGPT_BASE_URL?.trim();
			const baseUrl = (configuredBase || resolved.auth.baseUrl || ctx.modelRegistry.getProvider(PROVIDER_ID)?.baseUrl || CHATGPT_BASE_URL)
				.replace(/\/+$/, "")
				.replace(/\/codex(?:\/responses)?$/, "");
			const headers: Record<string, string> = Object.fromEntries(
				Object.entries(resolved.auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			);
			headers.authorization = `Bearer ${access}`;
			headers["chatgpt-account-id"] = accountId;
			headers["user-agent"] = options.userAgent;

			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
			const prefix = baseUrl.includes("/backend-api") ? "/wham" : "/api/codex";
			const response = await fetch(`${baseUrl}${prefix}${path}`, { headers, signal });
			const text = await response.text();
			if (response.status === 404 && options.allow404) return undefined;
			if (!response.ok) {
				const detail = text.replace(/\s+/g, " ").trim().slice(0, 200);
				throw new Error(`GET ${path} failed with status ${response.status}${detail ? `: ${detail}` : ""}`);
			}
			if (!text.trim()) return {};
			try {
				return JSON.parse(text) as unknown;
			} catch {
				throw new Error(`GET ${path} returned invalid JSON`);
			}
		},
	};
}

const USER_AGENT = "pi-usage/0.1.0";

type RateLimitWindow = {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
};
type RateLimitDetails = {
	allowed?: boolean;
	limit_reached?: boolean;
	primary_window?: RateLimitWindow | null;
	secondary_window?: RateLimitWindow | null;
};
type AdditionalRateLimit = {
	limit_id?: string;
	limit_name?: string;
	metered_feature?: string;
	rate_limit?: RateLimitDetails | null;
};
type UsagePayload = {
	email?: string;
	account_id?: string;
	plan_type?: string;
	rate_limit?: RateLimitDetails | null;
	code_review_rate_limit?: RateLimitDetails | null;
	code_review_rate_limits?: RateLimitDetails | null;
	credits?: {
		has_credits?: boolean;
		unlimited?: boolean;
		overage_limit_reached?: boolean;
		balance?: string | Record<string, unknown> | null;
	} | null;
	spend_control?: {
		reached?: boolean;
		individual_limit?: {
			limit?: string;
			used?: string;
			remaining?: string;
			used_percent?: number;
			reset_at?: number;
		} | null;
	} | null;
	additional_rate_limits?: Array<AdditionalRateLimit> | null;
	rate_limit_reached_type?: { type?: string } | null;
	rate_limit_reset_credits?: { available_count?: number } | null;
};

type AccountRecord = {
	id?: string | null;
	account_id?: string | null;
	name?: string | null;
	structure?: string | null;
};
type AccountsPayload = {
	accounts?: Record<string, { account?: AccountRecord | null }> | AccountRecord[] | null;
	account_ordering?: string[] | null;
	default_account_id?: string | null;
};

type Snapshot = { usage: UsagePayload; accounts?: AccountsPayload };

const BAR_CELLS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

function codexPlanLabel(planType: string | undefined): string | undefined {
	if (!planType) return undefined;
	const labels: Record<string, string> = {
		free: "Free",
		go: "Go",
		plus: "Plus",
		pro: "Pro",
		prolite: "Pro Lite",
		team: "Team",
		business: "Business",
		enterprise: "Enterprise",
		edu: "Edu",
		education: "Edu",
		guest: "Guest",
		free_workspace: "Free workspace",
		self_serve_business_usage_based: "Business (usage-based)",
		enterprise_cbp_usage_based: "Enterprise (usage-based)",
		quorum: "Quorum",
		k12: "K-12",
		hc: "Enterprise",
	};
	return labels[planType.toLowerCase()] ?? planType;
}

function bar(ratio: number, width: number, theme: Theme): string {
	const cells = Math.max(1, width);
	const clamped = Math.min(1, Math.max(0, ratio));
	const full = Math.floor(clamped * cells);
	let filled = "█".repeat(full);
	let track = "";
	if (full < cells) {
		const remainder = clamped * cells - full;
		filled += BAR_CELLS[Math.floor(remainder * (BAR_CELLS.length - 1))] ?? " ";
		track = " ".repeat(Math.max(0, cells - full - 1));
	}
	return theme.bg("selectedBg", theme.fg("accent", filled) + track);
}

function lowerMeridiem(text: string): string {
	return text.replace(/ ([AP]M)/i, (_match, meridiem: string) => meridiem.toLowerCase());
}

function formatResetAt(epochSeconds: number, showTime: boolean, alwaysShowDate: boolean, now = Date.now()): string {
	const date = new Date(epochSeconds * 1000);
	const minutes = date.getMinutes();
	const hoursAway = (date.getTime() - now) / 3_600_000;
	const zone = ` (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;

	if (alwaysShowDate || hoursAway > 24) {
		const options: Intl.DateTimeFormatOptions = {
			month: "short",
			day: "numeric",
			hour: showTime ? "numeric" : undefined,
			minute: !showTime || minutes === 0 ? undefined : "2-digit",
			hour12: showTime ? true : undefined,
		};
		if (date.getFullYear() !== new Date(now).getFullYear()) options.year = "numeric";
		return lowerMeridiem(date.toLocaleString("en-US", options)) + zone;
	}

	return (
		lowerMeridiem(date.toLocaleTimeString("en-US", { hour: "numeric", minute: minutes === 0 ? undefined : "2-digit", hour12: true })) +
		zone
	);
}

type Gauge = {
	title: string;
	utilization: number;
	resetsAt?: number;
	showTime?: boolean;
	alwaysShowDate?: boolean;
	extraSubtext?: string;
	subtextOverride?: string;
	trailing?: Array<{ text: string; color?: "error" | "warning" }>;
};

type Header = {
	title: string;
	subtitle?: string;
};
type Section = Header | Gauge;

function isGauge(section: Section): section is Gauge {
	return "utilization" in section;
}

function windowResetAt(window: RateLimitWindow, now = Date.now()): number | undefined {
	if (window.reset_at && window.reset_at > 0) return window.reset_at;
	if (window.reset_after_seconds && window.reset_after_seconds > 0) {
		return Math.floor(now / 1000) + window.reset_after_seconds;
	}
	return undefined;
}

function windowTitle(window: RateLimitWindow): string {
	const seconds = window.limit_window_seconds ?? 0;
	if (seconds >= 7 * 24 * 60 * 60) return "Current week";
	if (seconds >= 24 * 60 * 60) return "Current day";
	return "Current session";
}

function gaugeForWindow(window: RateLimitWindow | null | undefined, scope: string | undefined): Gauge | undefined {
	if (!window || window.used_percent === undefined) return undefined;
	const title = windowTitle(window);
	const suffix = scope && (scope !== "all models" || title !== "Current session") ? ` (${scope})` : "";
	return {
		title: `${title}${suffix}`,
		utilization: window.used_percent,
		resetsAt: windowResetAt(window),
		alwaysShowDate: title !== "Current session",
	};
}

function gaugesForLimit(details: RateLimitDetails | null | undefined, scope: string | undefined): Gauge[] {
	if (!details) return [];
	const gauges = [gaugeForWindow(details.primary_window, scope), gaugeForWindow(details.secondary_window, scope)].filter(
		(gauge): gauge is Gauge => gauge !== undefined,
	);

	if (gauges.length > 0) {
		const last = gauges[gauges.length - 1]!;
		if (details.limit_reached) last.trailing = [{ text: "Limit reached", color: "error" }];
		else if (details.allowed === false) last.trailing = [{ text: "Not allowed right now", color: "warning" }];
	}
	return gauges;
}

function limitScope(limit: AdditionalRateLimit): string {
	const name = limit.limit_name?.trim();
	if (name) return name;
	const identifier = `${limit.limit_id ?? ""} ${limit.metered_feature ?? ""}`.toLowerCase();
	if (identifier.includes("bengalfox") || identifier.includes("spark")) return "Spark";
	return limit.metered_feature?.trim() || "extra";
}

function creditAmount(raw: string | Record<string, unknown> | null | undefined): string | undefined {
	if (typeof raw !== "string") return undefined;
	const value = Number(raw.trim());
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return Math.round(value).toLocaleString("en-US");
}

function creditsText(credits: UsagePayload["credits"]): string | undefined {
	if (!credits) return undefined;
	if (credits.unlimited) return "Unlimited";
	if (!credits.has_credits) return undefined;
	const balance = creditAmount(credits.balance);
	const text = balance ? `${balance} credits` : "Available";
	return credits.overage_limit_reached ? `${text} · overage limit reached` : text;
}

function accountRecords(accounts: AccountsPayload | undefined): AccountRecord[] {
	if (!accounts) return [];
	if (Array.isArray(accounts.accounts)) return accounts.accounts;
	const byId = accounts.accounts ?? {};
	const ordering = (accounts.account_ordering ?? []).filter((id) => id in byId);
	const keys = [...ordering, ...Object.keys(byId).filter((id) => !ordering.includes(id))];
	return keys.map((id) => byId[id]?.account).filter((record): record is AccountRecord => Boolean(record));
}

function accountDescriptor(snapshot: Snapshot): string | undefined {
	const records = accountRecords(snapshot.accounts);
	if (records.length === 0) return undefined;
	const activeId = snapshot.usage.account_id ?? snapshot.accounts?.default_account_id ?? undefined;
	const active = records.find((record) => (record.id ?? record.account_id) === activeId) ?? records[0]!;

	const name = active.name?.trim();
	const structure = active.structure?.trim();
	if (name) return structure ? `${name} (${structure})` : name;
	if (structure) return structure === "personal" ? "Personal" : structure;
	return active.id ?? active.account_id ?? undefined;
}

function accountSectionFor(snapshot: Snapshot): Header {
	const { usage } = snapshot;
	const who = [usage.email?.trim(), accountDescriptor(snapshot), `${codexPlanLabel(usage.plan_type) ?? "unknown"} plan`].filter(
		Boolean,
	);
	return { title: "Account", subtitle: who.join(" · ") };
}

function limitSectionsFor(snapshot: Snapshot): Section[] {
	const { usage } = snapshot;
	const sections: Section[] = [];

	const extra = (usage.additional_rate_limits ?? []).filter((limit) => limit.rate_limit);
	const codeReview = usage.code_review_rate_limit ?? usage.code_review_rate_limits;
	const scoped = extra.length > 0 || Boolean(codeReview);
	const main = gaugesForLimit(usage.rate_limit, scoped ? "all models" : undefined);
	const reached = usage.rate_limit_reached_type?.type?.replace(/_/g, " ").trim();
	const lastMain = main[main.length - 1];
	if (reached && lastMain && !lastMain.trailing) {
		lastMain.trailing = [{ text: reached.charAt(0).toUpperCase() + reached.slice(1), color: "warning" }];
	}
	sections.push(...main);

	for (const limit of extra) sections.push(...gaugesForLimit(limit.rate_limit, limitScope(limit)));
	sections.push(...gaugesForLimit(codeReview, "code review"));

	const spend = usage.spend_control?.individual_limit;
	if (spend?.used_percent !== undefined) {
		const used = creditAmount(spend.used);
		const limit = creditAmount(spend.limit);
		sections.push({
			title: "Monthly credit limit",
			utilization: spend.used_percent,
			resetsAt: spend.reset_at,
			showTime: false,
			alwaysShowDate: true,
			extraSubtext: used && limit ? `${used} of ${limit} credits used` : undefined,
			trailing: usage.spend_control?.reached ? [{ text: "Spend limit reached", color: "error" }] : undefined,
		});
	}

	const credits = creditsText(usage.credits);
	if (credits) sections.push({ title: "Credits", subtitle: credits });

	const resets = usage.rate_limit_reset_credits?.available_count ?? 0;
	if (resets > 0) {
		sections.push({
			title: "Usage limit resets",
			subtitle: `${resets} available · /reset to redeem`,
		});
	}

	return sections;
}

function gaugeSubtext(gauge: Gauge): string | undefined {
	if (gauge.subtextOverride !== undefined) return gauge.subtextOverride;
	const reset = gauge.resetsAt ? `Resets ${formatResetAt(gauge.resetsAt, gauge.showTime !== false, gauge.alwaysShowDate === true)}` : undefined;
	if (gauge.extraSubtext) return reset ? `${gauge.extraSubtext} · ${reset}` : gauge.extraSubtext;
	return reset;
}

function renderGauge(gauge: Gauge, theme: Theme, maxWidth: number): string[] {
	const remainingPercent = Math.max(0, Math.min(100, 100 - gauge.utilization));
	const remaining = `${Math.floor(remainingPercent)}% remaining`;
	const subtext = gaugeSubtext(gauge);
	const trailing = (gauge.trailing ?? []).map((line) =>
		line.color ? theme.fg(line.color, line.text) : theme.fg("dim", line.text),
	);

	if (maxWidth >= 62) {
		return [
			theme.bold(gauge.title),
			`${bar(remainingPercent / 100, 50, theme)} ${remaining}`,
			...(subtext ? [theme.fg("dim", subtext)] : []),
			...trailing,
		];
	}

	return [
		theme.bold(gauge.title) + (subtext ? ` ${theme.fg("dim", `· ${subtext}`)}` : ""),
		...trailing,
		bar(remainingPercent / 100, maxWidth, theme),
		remaining,
	];
}

function renderSection(section: Section, theme: Theme, maxWidth: number): string[] {
	if (isGauge(section)) return renderGauge(section, theme, maxWidth);
	const title = theme.bold(section.title);
	const subtitle = section.subtitle ? theme.fg("dim", section.subtitle) : undefined;
	return [title, ...(subtitle ? [subtitle] : [])];
}

async function loadSnapshot(ctx: ExtensionCommandContext, signal?: AbortSignal): Promise<Snapshot> {
	const account = codexAccount(ctx);
	const optional = (path: string) =>
		account.request(path, { userAgent: USER_AGENT, signal, allow404: true }).catch(() => undefined);
	const [usage, accounts] = await Promise.all([
		account.request("/usage", { userAgent: USER_AGENT, signal }),
		optional("/accounts/check"),
	]);
	return {
		usage: (usage ?? {}) as UsagePayload,
		accounts: accounts as AccountsPayload | undefined,
	};
}

function renderPlainReport(snapshot: Snapshot): string {
	const lines: string[] = [];
	for (const section of [accountSectionFor(snapshot), ...limitSectionsFor(snapshot)]) {
		if (!isGauge(section)) {
			lines.push(section.subtitle ? `${section.title}: ${section.subtitle}` : section.title);
			continue;
		}
		const subtext = gaugeSubtext(section)?.replace(/^Resets /, "resets ");
		const remaining = Math.max(0, Math.min(100, 100 - section.utilization));
		lines.push(`${section.title}: ${Math.floor(remaining)}% remaining${subtext ? ` · ${subtext}` : ""}`);
	}
	return lines.join("\n");
}

class UsageComponent implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly snapshot: Snapshot,
		private readonly theme: Theme,
		private readonly done: (action: "refresh" | "close") => void,
	) {}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done("close");
			return;
		}
		if (data.toLowerCase() === "r") {
			this.done("refresh");
		}
	}

	private hint(): string {
		return this.theme.fg("dim", "r refresh · Esc close");
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

		const maxWidth = Math.max(1, Math.min(width, 80));
		const lines: string[] = [];

		lines.push(...renderSection(accountSectionFor(this.snapshot), this.theme, maxWidth));
		const sections = limitSectionsFor(this.snapshot);
		if (sections.length === 0) {
			lines.push("", this.theme.fg("dim", "No limit data available"));
		}
		for (const section of sections) {
			if (lines.length > 0) lines.push("");
			lines.push(...renderSection(section, this.theme, maxWidth));
		}
		lines.push("", this.hint());

		this.cachedWidth = width;
		this.cachedLines = lines.map((line) => truncateToWidth(line, width));
		return this.cachedLines;
	}
}

export default function usage(pi: ExtensionAPI) {
	let busy = false;

	pi.registerCommand("usage", {
		description: "Show Codex plan limits and credits",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				if (busy) {
					if (ctx.hasUI) notify(ctx, "Already loading usage", "warning");
					return;
				}
				busy = true;
				try {
					const snapshot = await loadSnapshot(ctx);
					const content = renderPlainReport(snapshot);
					pi.sendMessage({ customType: "usage", content, display: true }, { triggerTurn: false });
				} catch (error) {
					const message = `Couldn't load usage: ${errorText(error)}`;
					if (ctx.hasUI) notify(ctx, message, "error");
					else pi.sendMessage({ customType: "usage", content: message, display: true }, { triggerTurn: false });
				} finally {
					busy = false;
				}
				return;
			}

			while (true) {
				let loadError: string | undefined;
				const snapshot = await ctx.ui.custom<Snapshot | null>((tui, theme, _keybindings, done) => {
					const loader = new BorderedLoader(tui, theme, "Loading usage data...");
					let settled = false;
					const finish = (value: Snapshot | null) => {
						if (settled) return;
						settled = true;
						done(value);
					};
					loader.onAbort = () => finish(null);
					void loadSnapshot(ctx, loader.signal)
						.then(finish)
						.catch((error: unknown) => {
							loadError = errorText(error);
							finish(null);
						});
					return loader;
				});

				if (!snapshot) {
					if (!loadError) return;
					const retry = await ctx.ui.confirm("Couldn't load usage", `${loadError}\n\nRetry?`);
					if (!retry) return;
					continue;
				}

				const action = await ctx.ui.custom<"refresh" | "close">((_tui, theme, _keybindings, done) =>
					new UsageComponent(snapshot, theme, done),
				);
				if (action !== "refresh") return;
			}
		},
	});
}
