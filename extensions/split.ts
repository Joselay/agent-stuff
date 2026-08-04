import {
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import * as path from "node:path";

type NotifyLevel = "info" | "warning" | "error";

function notify(ctx: ExtensionContext, message: string, level: NotifyLevel = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

const GHOSTTY_SPLIT_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		if (count of windows) > 0 then
			try
				set frontWindow to front window
				set targetTerminal to focused terminal of selected tab of frontWindow
				split targetTerminal direction right with configuration cfg
			on error
				new window with configuration cfg
			end try
		else
			new window with configuration cfg
		end if
		activate
	end tell
end run`;

function shellQuote(value: string): string {
	if (value.length === 0) return "''";
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getPiInvocationParts(): string[] {
	const currentScript = process.argv[1];
	if (currentScript && existsSync(currentScript)) {
		return [process.execPath, currentScript];
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return [process.execPath];
	}

	return ["pi"];
}

function buildPiStartupInput(sessionFile: string | undefined, prompt: string): string {
	const commandParts = [...getPiInvocationParts()];

	if (sessionFile) {
		commandParts.push("--session", sessionFile);
	}

	if (prompt.length > 0) {
		commandParts.push(prompt);
	}

	return `${commandParts.map(shellQuote).join(" ")}\n`;
}

function createSplitSession(ctx: ExtensionContext): string | undefined {
	const sessionFile = ctx.sessionManager.getSessionFile();
	const leafId = ctx.sessionManager.getLeafId();
	if (!sessionFile || !leafId || !existsSync(sessionFile)) return undefined;

	// Use a separate manager: createBranchedSession mutates its receiver.
	const source = SessionManager.open(sessionFile, ctx.sessionManager.getSessionDir(), ctx.cwd);
	return source.createBranchedSession(leafId);
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("split", {
		description: "Duplicate this session into a new Ghostty split, optionally with a prompt",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				notify(ctx, "/split requires interactive TUI mode.", "warning");
				return;
			}

			if (process.platform !== "darwin") {
				notify(ctx, "/split currently requires macOS (Ghostty AppleScript).", "warning");
				return;
			}

			const wasBusy = !ctx.isIdle();
			const prompt = args.trim();
			let splitSessionFile: string | undefined;
			try {
				splitSessionFile = createSplitSession(ctx);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				notify(ctx, `Failed to duplicate session: ${reason}`, "error");
				return;
			}
			const startupInput = buildPiStartupInput(splitSessionFile, prompt);

			const result = await pi.exec("osascript", ["-e", GHOSTTY_SPLIT_SCRIPT, "--", ctx.cwd, startupInput], {
				timeout: 10_000,
			});
			if (result.code !== 0) {
				const reason = result.stderr?.trim() || result.stdout?.trim() || "unknown osascript error";
				notify(ctx, `Failed to launch Ghostty split: ${reason}`, "error");
				if (splitSessionFile) {
					notify(ctx, `Duplicated session was created: ${splitSessionFile}`, "info");
				}
				return;
			}

			if (splitSessionFile) {
				const fileName = path.basename(splitSessionFile);
				const suffix = prompt ? " and sent prompt" : "";
				notify(ctx, `Duplicated to ${fileName} in a new Ghostty split${suffix}.`, "info");
				if (wasBusy) {
					notify(ctx, "Duplicated from current committed state (in-flight turn continues in original session).", "info");
				}
			} else {
				notify(ctx, "Opened a new Ghostty split (no persisted session to duplicate).", "warning");
			}
		},
	});
}
