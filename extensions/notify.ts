import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

const SOUND = join(homedir(), ".cache", "pi", "notify", "notification.mp3");

export default function (pi: ExtensionAPI): void {
	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		await pi.exec("/usr/bin/afplay", [SOUND]);
	});
}
