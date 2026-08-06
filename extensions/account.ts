import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthAuth } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

const PROVIDER = "openai-codex";
const AUTH_PATH = join(getAgentDir(), "auth.json");
const VAULT_PATH = join(getAgentDir(), "codex-accounts.json");
const LEGACY_STATE_PATH = join(getAgentDir(), "account.json");
const REFRESH_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

type Credential = {
	type: "oauth";
	access: string;
	refresh: string;
	expires: number;
	accountId?: string;
};
type Vault = { activeAccountId: string; accounts: Record<string, Credential> };
type Claims = { accountId?: string; email?: string; name?: string; plan?: string };
type UsageWindow = { used_percent?: number; limit_window_seconds?: number };
type Usage = {
	email?: string;
	plan_type?: string;
	rate_limit?: { primary_window?: UsageWindow | null; secondary_window?: UsageWindow | null } | null;
};
type Snapshot = { accountId: string; credential: Credential; usage?: Usage; error?: string };

function isCredential(value: unknown): value is Credential {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return item.type === "oauth" && typeof item.access === "string" && typeof item.refresh === "string" && typeof item.expires === "number";
}

function claims(access: string): Claims {
	try {
		const payload = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
		const profile = payload["https://api.openai.com/profile"] as Record<string, unknown> | undefined;
		const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
		return {
			accountId: typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined,
			email: typeof profile?.email === "string" ? profile.email : undefined,
			name: typeof profile?.name === "string" ? profile.name : undefined,
			plan: typeof auth?.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
		};
	} catch {
		return {};
	}
}

function readCredentialFile(path: string): Credential | undefined {
	try {
		const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return isCredential(json[PROVIDER]) ? json[PROVIDER] : undefined;
	} catch {
		return undefined;
	}
}

function readVault(): Vault | undefined {
	try {
		const value = JSON.parse(readFileSync(VAULT_PATH, "utf8")) as Partial<Vault>;
		if (!value.accounts || typeof value.accounts !== "object") return undefined;
		const accounts = Object.fromEntries(Object.entries(value.accounts).filter((entry): entry is [string, Credential] => isCredential(entry[1])));
		const ids = Object.keys(accounts);
		if (ids.length === 0) return undefined;
		const activeAccountId = typeof value.activeAccountId === "string" && accounts[value.activeAccountId] ? value.activeAccountId : ids[0]!;
		return { activeAccountId, accounts };
	} catch {
		return undefined;
	}
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
	const temp = `${path}.${process.pid}.tmp`;
	await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await chmod(temp, 0o600);
	await rename(temp, path);
}

async function writeActiveCredential(credential: Credential): Promise<void> {
	let auth: Record<string, unknown> = {};
	try {
		const value = JSON.parse(await readFile(AUTH_PATH, "utf8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("auth.json is not an object");
		auth = value as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await atomicJsonWrite(AUTH_PATH, { ...auth, [PROVIDER]: credential });
}

function legacyActiveName(): string | undefined {
	try {
		const value = JSON.parse(readFileSync(LEGACY_STATE_PATH, "utf8")) as { active?: unknown };
		return typeof value.active === "string" ? value.active : undefined;
	} catch {
		return undefined;
	}
}

async function migrateVault(): Promise<Vault> {
	const existing = readVault();
	if (existing) return existing;

	const dir = getAgentDir();
	const files = readdirSync(dir)
		.filter((file) => file === "auth.json" || file.endsWith("-auth.json"))
		.sort((a, b) => (a === "auth.json" ? -1 : b === "auth.json" ? 1 : a.localeCompare(b)));
	const accounts: Record<string, Credential> = {};
	const idsByLegacyName = new Map<string, string>();
	for (const file of files) {
		const credential = readCredentialFile(join(dir, file));
		if (!credential) continue;
		const accountId = claims(credential.access).accountId ?? credential.accountId;
		if (!accountId) continue;
		accounts[accountId] = credential;
		idsByLegacyName.set(file === "auth.json" ? "auth" : file.slice(0, -"-auth.json".length), accountId);
	}
	const ids = Object.keys(accounts);
	if (ids.length === 0) throw new Error("No OpenAI Codex credentials found");
	const activeAccountId = idsByLegacyName.get(legacyActiveName() ?? "auth") ?? idsByLegacyName.get("auth") ?? ids[0]!;
	const vault = { activeAccountId, accounts };
	await atomicJsonWrite(VAULT_PATH, vault);
	if (existsSync(LEGACY_STATE_PATH)) await unlink(LEGACY_STATE_PATH).catch(() => undefined);
	return vault;
}

function planLabel(plan: string | undefined): string {
	if (!plan) return "Unknown plan";
	const labels: Record<string, string> = { plus: "Plus", pro: "Pro", prolite: "Pro Lite", free: "Free", business: "Business", team: "Team" };
	return `${labels[plan.toLowerCase()] ?? plan} plan`;
}

function windowLabel(window: UsageWindow | null | undefined): string | undefined {
	if (window?.used_percent === undefined) return undefined;
	const name = (window.limit_window_seconds ?? 0) >= 24 * 60 * 60 ? "week" : "session";
	return `${name} ${Math.max(0, Math.floor(100 - window.used_percent))}% left`;
}

function snapshotDescription(snapshot: Snapshot): string {
	const token = claims(snapshot.credential.access);
	return [
		planLabel(snapshot.usage?.plan_type ?? token.plan),
		windowLabel(snapshot.usage?.rate_limit?.primary_window),
		windowLabel(snapshot.usage?.rate_limit?.secondary_window),
		snapshot.error,
	].filter(Boolean).join(" · ");
}

export default function accountExtension(pi: ExtensionAPI): void {
	let vault: Vault | undefined = readVault();
	let builtinOAuth: OAuthAuth | undefined;
	let migration: Promise<Vault> | undefined;

	async function ensureVault(): Promise<Vault> {
		if (vault) return vault;
		migration ??= migrateVault();
		vault = await migration;
		return vault;
	}

	async function saveVault(next: Vault): Promise<void> {
		await atomicJsonWrite(VAULT_PATH, next);
		vault = next;
	}

	async function syncCurrentLogin(): Promise<Vault> {
		const current = await ensureVault();
		const credential = readCredentialFile(AUTH_PATH);
		if (!credential) return current;
		const accountId = claims(credential.access).accountId ?? credential.accountId;
		if (!accountId) return current;
		const stored = current.accounts[accountId];
		const latest = stored && stored.expires > credential.expires ? stored : credential;
		if (latest !== credential) await writeActiveCredential(latest);
		const next = { activeAccountId: accountId, accounts: { ...current.accounts, [accountId]: latest } };
		await saveVault(next);
		return next;
	}

	async function ensureFresh(accountId: string, credential: Credential, signal?: AbortSignal): Promise<Credential> {
		const current = await ensureVault();
		const latest = current.accounts[accountId] ?? credential;
		if (latest.expires > Date.now() + REFRESH_MARGIN_MS) return latest;
		const oauth = builtinOAuth;
		if (!oauth) throw new Error("OpenAI Codex OAuth provider unavailable");
		const refreshed = await oauth.refresh(latest, signal) as Credential;
		const newest = await ensureVault();
		await saveVault({ ...newest, accounts: { ...newest.accounts, [accountId]: refreshed } });
		return refreshed;
	}

	async function fetchUsage(accountId: string, credential: Credential, signal?: AbortSignal): Promise<Snapshot> {
		try {
			const fresh = await ensureFresh(accountId, credential, signal);
			const token = claims(fresh.access);
			if (!token.accountId) throw new Error("invalid account token");
			const base = (process.env.PI_CODEX_CHATGPT_BASE_URL?.trim() || "https://chatgpt.com/backend-api")
				.replace(/\/+$/, "").replace(/\/codex(?:\/responses)?$/, "");
			const prefix = base.includes("/backend-api") ? "/wham" : "/api/codex";
			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const response = await fetch(`${base}${prefix}/usage`, {
				headers: { authorization: `Bearer ${fresh.access}`, "chatgpt-account-id": token.accountId, "user-agent": "pi-account/0.2.0" },
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
			if (!response.ok) throw new Error(`usage HTTP ${response.status}`);
			return { accountId, credential: fresh, usage: await response.json() as Usage };
		} catch (error) {
			return { accountId, credential, error: error instanceof Error ? error.message : String(error) };
		}
	}

	async function choose(ctx: ExtensionCommandContext): Promise<string | undefined> {
		const current = await syncCurrentLogin();
		const entries = Object.entries(current.accounts);
		if (ctx.mode !== "tui") return undefined;
		const snapshots = await ctx.ui.custom<Snapshot[] | null>((tui, theme, _keys, done) => {
			const loader = new BorderedLoader(tui, theme, "Loading Codex accounts...");
			loader.onAbort = () => done(null);
			void Promise.all(entries.map(([id, credential]) => fetchUsage(id, credential, loader.signal))).then(done).catch(() => done(null));
			return loader;
		});
		if (!snapshots) return undefined;
		return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
			const items: SelectItem[] = snapshots.map((snapshot) => {
				const email = snapshot.usage?.email ?? claims(snapshot.credential.access).email ?? snapshot.accountId;
				return { value: snapshot.accountId, label: snapshot.accountId === current.activeAccountId ? `${email} (active)` : email, description: snapshotDescription(snapshot) };
			});
			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("Switch Codex account")), 1, 0));
			const list = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			container.addChild(list);
			return { render: (width) => container.render(width), invalidate: () => container.invalidate(), handleInput: (data) => { list.handleInput(data); tui.requestRender(); } };
		});
	}

	async function resolveAccount(query: string): Promise<string> {
		const current = await ensureVault();
		const normalized = query.toLowerCase();
		const matches = Object.entries(current.accounts).filter(([id, credential]) => {
			const email = claims(credential.access).email?.toLowerCase();
			return id === query || id.startsWith(query) || email === normalized;
		});
		if (matches.length !== 1) throw new Error(matches.length === 0 ? `Unknown account "${query}"` : `Ambiguous account "${query}"`);
		return matches[0]![0];
	}

	async function activate(accountId: string, ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle();
		const current = await ensureVault();
		const credential = current.accounts[accountId];
		if (!credential) throw new Error("Unknown Codex account");
		const fresh = await ensureFresh(accountId, credential);
		await writeActiveCredential(fresh);
		await saveVault({ ...(await ensureVault()), activeAccountId: accountId });
		const email = claims(fresh.access).email ?? accountId.slice(0, 8);
		pi.events.emit("codex:account-changed", { accountId, email });
		pi.events.emit("codex:usage-changed", undefined);
		ctx.ui.notify(`Codex account: ${email}`, "info");
	}

	pi.registerCommand("account", {
		description: "Switch OpenAI Codex account",
		getArgumentCompletions: (prefix) => {
			const current = vault;
			if (!current) return null;
			const items = Object.entries(current.accounts).map(([id, credential]) => {
				const email = claims(credential.access).email ?? id;
				return { value: email, label: email, description: planLabel(claims(credential.access).plan) };
			});
			return items.filter((item) => item.value.toLowerCase().startsWith(prefix.toLowerCase()));
		},
		handler: async (args, ctx) => {
			try {
				const query = args.trim();
				await syncCurrentLogin();
				const accountId = query ? await resolveAccount(query) : await choose(ctx);
				if (accountId) await activate(accountId, ctx);
				else if (ctx.mode !== "tui") {
					const current = await ensureVault();
					ctx.ui.notify(`Accounts: ${Object.values(current.accounts).map((credential) => claims(credential.access).email).filter(Boolean).join(", ")}`, "info");
				}
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const builtin = ctx.modelRegistry.getProvider(PROVIDER);
		builtinOAuth = builtin?.auth.oauth;
		await syncCurrentLogin();
	});
}
