import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const FAST_REQUEST_SERVICE_TIER = "priority";
const FAST_STATE_PATH = join(getAgentDir(), "fast.json");
export const CODEX_FAST_STATUS_KEY = "codex-fast";

type Model = ExtensionContext["model"];

type NotificationLevel = "info" | "warning" | "error";

// Matches enabled Codex model catalog entries that advertise service_tiers: [{ id: "priority" }].
const CODEX_FAST_MODE_MODEL_IDS = ["gpt-5.5", "gpt-5.4"] as const;
const CODEX_FAST_MODE_MODELS = new Set<string>(CODEX_FAST_MODE_MODEL_IDS);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnabledByEnv(): boolean {
	const value = process.env.PI_CODEX_FAST_MODE?.trim().toLowerCase();
	if (!value) return false;
	return value === "1" || value === "true" || value === "on" || value === "yes";
}

function readPersistedEnabled(): boolean | undefined {
	if (!existsSync(FAST_STATE_PATH)) return undefined;

	try {
		const parsed = JSON.parse(readFileSync(FAST_STATE_PATH, "utf8")) as unknown;
		if (isRecord(parsed) && typeof parsed.enabled === "boolean") return parsed.enabled;
	} catch {
		return undefined;
	}

	return undefined;
}

function initialEnabled(): boolean {
	return readPersistedEnabled() ?? isEnabledByEnv();
}

function writePersistedEnabled(enabled: boolean): void {
	writeFileSync(FAST_STATE_PATH, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
}

export function modelSupportsCodexFastMode(model: Model | undefined): boolean {
	return model?.provider === "openai-codex" && model.api === "openai-codex-responses" && CODEX_FAST_MODE_MODELS.has(model.id);
}

function unsupportedModelMessage(model: Model | undefined): string {
	const modelName = model?.id ?? "current model";
	return `${modelName} does not support fast mode. Switch to a fast-capable enabled model to use /fast.`;
}

export default function fastMode(pi: ExtensionAPI) {
	let enabled = initialEnabled();

	function statusText(): string {
		return enabled ? "fast:on" : "fast:off";
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (ctx.hasUI) ctx.ui.setStatus(CODEX_FAST_STATUS_KEY, statusText());
	}

	function notify(ctx: ExtensionContext, message: string, level: NotificationLevel): void {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	}

	pi.on("session_start", (_event, ctx) => {
		enabled = initialEnabled();
		try {
			writePersistedEnabled(enabled);
		} catch (error) {
			notify(ctx, `Failed to save fast mode state: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		updateStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "openai-codex") return;
		if (ctx.model.api !== "openai-codex-responses") return;
		if (!isRecord(event.payload)) return;

		return {
			...event.payload,
			// Codex uses "default" only as a config/UI sentinel; provider requests omit the field.
			service_tier: enabled && modelSupportsCodexFastMode(ctx.model) ? FAST_REQUEST_SERVICE_TIER : undefined,
		};
	});

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex Fast mode for supported models",
		handler: async (args, ctx) => {
			if (args.trim().length > 0) {
				notify(ctx, "Use /fast with no arguments", "warning");
				return;
			}
			if (!modelSupportsCodexFastMode(ctx.model)) {
				notify(ctx, unsupportedModelMessage(ctx.model), "warning");
				return;
			}

			enabled = !enabled;
			try {
				writePersistedEnabled(enabled);
			} catch (error) {
				notify(ctx, `Fast mode changed but failed to save state: ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
			updateStatus(ctx);
			notify(ctx, enabled ? "Fast mode on" : "Fast mode off", "info");
		},
	});
}
