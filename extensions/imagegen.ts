import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { getAgentDir, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// Pi compatibility shim for upstream Codex image generation. Keep this file mechanical
// and traceable to upstream. The model-facing prompt below is copied verbatim from
// upstream codex-rs/ext/image-generation/imagegen_description.md.

const AUTH_PROVIDER = "openai-codex";
const AUTH_PATH = join(getAgentDir(), "auth.json");
const CODEX_IMAGE_BASE_URL = process.env.PI_CODEX_IMAGE_BASE_URL ?? "https://chatgpt.com/backend-api/codex";
const REFRESH_TOKEN_URL = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE ?? "https://auth.openai.com/oauth/token";
const CODEX_OAUTH_CLIENT_ID = process.env.CODEX_APP_SERVER_LOGIN_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
const IMAGE_MODEL = "gpt-image-2";
const MAX_EDIT_IMAGES = 5;
// Upstream equivalent: codex-rs/utils/image/src/lib.rs::MAX_PROMPT_IMAGE_INPUT_BYTES
const MAX_INPUT_IMAGE_BYTES = 1024 * 1024 * 1024;
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const MAX_IMAGE_GENERATION_OUTPUT_HINT_BYTES = 1024;
const IMAGEGEN_DESCRIPTION = "The `image_gen.imagegen` tool enables image generation from descriptions and editing of existing images based on specific instructions. Use it when:\n\n- The user requests an image based on a scene description, such as a diagram, portrait, comic, meme, or any other visual.\n- The user wants to modify an attached or previously generated image with specific changes, including adding or removing elements, altering colors, improving quality/resolution, or transforming the style (e.g., cartoon, oil painting).\n\nGuidelines:\n- In code mode, pass the result to `generatedImage(result)`.\n- Omit both `referenced_image_paths` and `num_last_images_to_include` when generating a brand new image.\n- For edits, use `referenced_image_paths` when every target image has a local file path.\n- If you have not seen a local image yet, use `view_image` to inspect it before editing.\n- Use `num_last_images_to_include` only when at least one target image has no local file path.\n- Set `num_last_images_to_include` to the smallest number of recent conversation images that includes every target image, up to 5.\n- Never provide both `referenced_image_paths` and `num_last_images_to_include`.\n- If neither mechanism can include every target image, ask the user to attach the missing images again.\n- Directly generate the image without reconfirmation or clarification unless required images must be attached again.\n- After each image generation, do not mention anything related to download. Do not summarize the image. Do not ask followup question. Do not say ANYTHING after you generate an image.\n- Always use this tool for image editing unless the user explicitly requests otherwise. Do not use the `python` tool for image editing unless specifically instructed.\n";

// Direct port of Codex's model-facing imagegen contract:
// codex-rs/ext/image-generation/src/tool.rs::ImagegenArgs
const imagegenParameters = Type.Object(
	{
		prompt: Type.String(),
		referenced_image_paths: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_EDIT_IMAGES })),
		num_last_images_to_include: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_EDIT_IMAGES })),
	},
	{ additionalProperties: false },
);

type ImagegenResultDetails = {
	path?: string;
	relativePath?: string;
	model?: string;
	operation?: "generate" | "edit";
	referencedImageCount?: number;
	size?: string;
	quality?: string;
	background?: string;
	created?: number;
	partial?: boolean;
};

type PiAuthFile = Record<string, unknown>;

type OAuthRecord = {
	type: "oauth";
	access: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
};

type ImageResponse = {
	created?: number;
	background?: string;
	data?: Array<{ b64_json?: string }>;
	quality?: string;
	size?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
		return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

function expiryFromAccessToken(access: string): number | undefined {
	const payload = decodeJwtPayload(access);
	return typeof payload?.exp === "number" ? payload.exp * 1000 : undefined;
}

function accountIdFromAccessToken(access: string): string | undefined {
	const payload = decodeJwtPayload(access);
	const accountId = payload?.chatgpt_account_id ?? payload?.account_id;
	return typeof accountId === "string" ? accountId : undefined;
}

function readAuthFile(): PiAuthFile {
	if (!existsSync(AUTH_PATH)) {
		throw new Error(`Missing ${AUTH_PATH}. Run /login and select OpenAI Codex first.`);
	}
	const parsed = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as unknown;
	if (!isRecord(parsed)) throw new Error(`${AUTH_PATH} is not a JSON object`);
	return parsed;
}

function getOAuthRecord(authFile: PiAuthFile): OAuthRecord {
	const raw = authFile[AUTH_PROVIDER];
	if (!isRecord(raw) || raw.type !== "oauth" || typeof raw.access !== "string") {
		throw new Error(`${AUTH_PATH} does not contain imagegen credentials. Run /login and select OpenAI Codex first.`);
	}
	return {
		type: "oauth",
		access: raw.access,
		refresh: typeof raw.refresh === "string" ? raw.refresh : undefined,
		expires: typeof raw.expires === "number" ? raw.expires : expiryFromAccessToken(raw.access),
		accountId: typeof raw.accountId === "string" ? raw.accountId : accountIdFromAccessToken(raw.access),
	};
}

async function refreshOAuthRecord(record: OAuthRecord): Promise<OAuthRecord> {
	if (!record.refresh) throw new Error("Imagegen access token is expired and no refresh token is available. Run /login again.");

	const response = await fetch(REFRESH_TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			originator: "codex_cli_rs",
			"User-Agent": "pi-imagegen codex_cli_rs-compatible",
		},
		body: JSON.stringify({
			client_id: CODEX_OAUTH_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: record.refresh,
		}),
	});

	if (!response.ok) {
		let message = `${response.status} ${response.statusText}`;
		try {
			const body = (await response.json()) as unknown;
			if (isRecord(body)) {
				const description = body.error_description ?? body.message ?? body.error;
				if (typeof description === "string") message = description;
			}
		} catch {
			// Keep status message. Do not include token-bearing request data.
		}
		throw new Error(`Imagegen credential refresh failed: ${message}. Run /login again if the refresh token expired.`);
	}

	const payload = (await response.json()) as unknown;
	if (!isRecord(payload)) throw new Error("Imagegen credential refresh returned an invalid response");
	const access = typeof payload.access_token === "string" ? payload.access_token : record.access;
	const refresh = typeof payload.refresh_token === "string" ? payload.refresh_token : record.refresh;
	const accountId = accountIdFromAccessToken(access) ?? record.accountId;
	const expires = expiryFromAccessToken(access) ?? Date.now() + 60 * 60 * 1000;
	return { type: "oauth", access, refresh, expires, accountId };
}

async function getFreshOAuthRecord(): Promise<OAuthRecord> {
	const authFile = readAuthFile();
	let record = getOAuthRecord(authFile);
	if (!record.expires || record.expires <= Date.now() + REFRESH_SKEW_MS) {
		record = await refreshOAuthRecord(record);
		authFile[AUTH_PROVIDER] = { ...record };
		writeFileSync(AUTH_PATH, `${JSON.stringify(authFile, null, 2)}\n`, { mode: 0o600 });
	}
	return record;
}

function dataUrlForImageContent(image: { data: string; mimeType: string }): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

// Upstream equivalent: codex-rs/utils/image/src/lib.rs::load_for_prompt_bytes(..., PromptImageMode::Original)
// followed by EncodedImage::into_data_url().  Pi does not expose Codex's Rust image utility here,
// so this shim preserves original bytes with the best MIME equivalent available from the path.
function mimeTypeForPath(path: string): string {
	switch (extname(path).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		case ".png":
		default:
			return "image/png";
	}
}

function mimeTypeForImageBytes(bytes: Buffer, path: string): string {
	// Upstream guesses from bytes via image::guess_format before deciding MIME.
	if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
	if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return mimeTypeForPath(path);
}

async function imageUrlForPath(inputPath: string, cwd: string): Promise<{ image_url: string }> {
	// Upstream equivalent: codex-rs/ext/image-generation/src/tool.rs::image_url
	const cleaned = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
	const absolutePath = isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
	const stat = statSync(absolutePath);
	if (!stat.isFile()) throw new Error(`Referenced image is not a file: ${absolutePath}`);
	if (stat.size > MAX_INPUT_IMAGE_BYTES) throw new Error(`Referenced image is too large (${stat.size} bytes): ${absolutePath}`);
	const bytes = await readFile(absolutePath);
	return { image_url: `data:${mimeTypeForImageBytes(bytes, absolutePath)};base64,${bytes.toString("base64")}` };
}

function recentConversationImageUrls(ctx: ExtensionContext, count: number): { image_url: string }[] {
	// Upstream equivalent: codex-rs/ext/image-generation/src/tool.rs::recent_images.
	// Pi stores conversation images in session message content rather than Codex ResponseItem variants.
	const images: { image_url: string }[] = [];
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "toolResult") continue;
		if (!Array.isArray(message.content)) continue;
		for (const item of [...message.content].reverse()) {
			if (item.type !== "image") continue;
			images.push({ image_url: dataUrlForImageContent(item) });
			if (images.length === count) return images.reverse();
		}
	}
	return images.reverse();
}

async function imageUrlsForParams(
	params: { referenced_image_paths?: string[]; num_last_images_to_include?: number },
	ctx: ExtensionContext,
): Promise<{ image_url: string }[]> {
	// Upstream equivalent: codex-rs/ext/image-generation/src/tool.rs::request_for_call_args
	const referencedPaths = params.referenced_image_paths ?? [];
	const recentCount = params.num_last_images_to_include;
	if (referencedPaths.length > 0 && recentCount !== undefined) {
		throw new Error("provide only one of `referenced_image_paths` or `num_last_images_to_include`");
	}
	if (referencedPaths.length > MAX_EDIT_IMAGES) throw new Error(`\`referenced_image_paths\` must contain at most ${MAX_EDIT_IMAGES} paths`);
	if (referencedPaths.length > 0) return Promise.all(referencedPaths.map((path) => imageUrlForPath(path, ctx.cwd)));
	if (recentCount !== undefined) {
		if (recentCount < 1 || recentCount > MAX_EDIT_IMAGES) throw new Error(`\`num_last_images_to_include\` must be between 1 and ${MAX_EDIT_IMAGES}`);
		const images = recentConversationImageUrls(ctx, recentCount);
		if (images.length !== recentCount) {
			throw new Error(`requested the last ${recentCount} conversation images, but only ${images.length} were available`);
		}
		return images;
	}
	return [];
}

function sanitizeImageArtifactPart(value: string): string {
	const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
	return sanitized.length > 0 ? sanitized : "generated_image";
}

function imageOutputPath(ctx: ExtensionContext, toolCallId: string): string {
	// Upstream equivalent: codex-rs/core/src/stream_events_utils.rs::image_generation_artifact_path
	// Codex passes config.codex_home as the save root; Pi uses the agent dir as
	// the analogous persistent root, with PI_IMAGEGEN_DIR available for tests or overrides.
	const saveRoot = process.env.PI_IMAGEGEN_DIR ?? getAgentDir();
	return join(saveRoot, "generated_images", sanitizeImageArtifactPart(ctx.sessionManager.getSessionId()), `${sanitizeImageArtifactPart(toolCallId)}.png`);
}

function decodeStandardBase64(value: string): Buffer {
	const trimmed = value.trim();
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed) || trimmed.length % 4 === 1) {
		throw new Error("invalid standard base64");
	}
	const decoded = Buffer.from(trimmed, "base64");
	if (decoded.toString("base64").replace(/=+$/, "") !== trimmed.replace(/=+$/, "")) {
		throw new Error("invalid standard base64");
	}
	return decoded;
}

async function saveImage(ctx: ExtensionContext, toolCallId: string, b64: string): Promise<string | undefined> {
	// Upstream behavior: if saving fails, continue returning the image bytes and omit saved_path/output_hint.
	const primary = imageOutputPath(ctx, toolCallId);
	try {
		const bytes = decodeStandardBase64(b64);
		await mkdir(dirname(primary), { recursive: true });
		await writeFile(primary, bytes);
		return primary;
	} catch {
		return undefined;
	}
}

async function postCodexImage(path: "images/generations" | "images/edits", body: unknown, signal: AbortSignal | undefined): Promise<ImageResponse> {
	const auth = await getFreshOAuthRecord();
	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.access}`,
		"Content-Type": "application/json",
		Accept: "application/json",
		originator: "codex_cli_rs",
		"User-Agent": "pi-imagegen codex_cli_rs-compatible",
	};
	if (auth.accountId) headers["ChatGPT-Account-ID"] = auth.accountId;

	const response = await fetch(`${CODEX_IMAGE_BASE_URL.replace(/\/$/, "")}/${path}`, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});

	const text = await response.text();
	let payload: unknown;
	try {
		payload = text ? JSON.parse(text) : undefined;
	} catch {
		payload = undefined;
	}

	if (!response.ok) {
		let message = `${response.status} ${response.statusText}`;
		if (isRecord(payload)) {
			const error = payload.error;
			if (typeof payload.message === "string") message = payload.message;
			else if (typeof error === "string") message = error;
			else if (isRecord(error) && typeof error.message === "string") message = error.message;
		}
		throw new Error(`Codex image request failed: ${message}`);
	}

	if (!isRecord(payload)) throw new Error("Codex image request returned a non-JSON response");
	return payload as ImageResponse;
}

function imageGenerationOutputHint(outputPath: string): string | undefined {
	// Upstream equivalent: codex-rs/core/src/context/image_generation_instructions.rs::extension_image_generation_output_hint
	const outputDir = dirname(outputPath);
	const hint = `Generated images are saved to ${outputDir} as ${outputPath} by default.\nIf you need to use a generated image at another path, copy it and leave the original in place unless the user explicitly asks you to delete it.`;
	return Buffer.byteLength(hint, "utf8") <= MAX_IMAGE_GENERATION_OUTPUT_HINT_BYTES ? hint : undefined;
}

export default function imagegen(pi: ExtensionAPI) {
	pi.registerTool({
		name: "imagegen",
		label: "ImageGen",
		description: IMAGEGEN_DESCRIPTION,
		parameters: imagegenParameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Upstream equivalent: codex-rs/ext/image-generation/src/tool.rs::ImageGenerationTool::handle_call
			onUpdate?.({
				content: [{ type: "text", text: "Generating image…" }],
				details: { partial: true },
			});

			const images = await imageUrlsForParams(params, ctx);
			const operation = images.length > 0 ? "edit" : "generate";
			const body =
				operation === "edit"
					? {
							images,
							prompt: params.prompt,
							background: "auto",
							model: IMAGE_MODEL,
							quality: "auto",
							size: "auto",
						}
					: {
							prompt: params.prompt,
							background: "auto",
							model: IMAGE_MODEL,
							quality: "auto",
							size: "auto",
			};
			let response: ImageResponse;
			try {
				response = await postCodexImage(operation === "edit" ? "images/edits" : "images/generations", body, signal);
			} catch (error) {
				throw new Error(`image generation failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			const b64 = response.data?.[0]?.b64_json;
			if (!b64) throw new Error("image generation returned no image data");

			const path = await saveImage(ctx, toolCallId, b64);
			const relativePath = path ? relative(ctx.cwd, path) : undefined;
			const text = path ? imageGenerationOutputHint(path) : undefined;
			return {
				content: [
					{ type: "image", data: b64, mimeType: "image/png" },
					...(text ? [{ type: "text" as const, text }] : []),
				],
				details: {
					path,
					relativePath: relativePath && !relativePath.startsWith("..") ? relativePath : undefined,
					model: IMAGE_MODEL,
					operation,
					referencedImageCount: images.length,
					size: response.size ?? "auto",
					quality: response.quality ?? "auto",
					background: response.background ?? "auto",
					created: response.created,
				},
				terminate: true,
			} satisfies AgentToolResult<ImagegenResultDetails>;
		},
		renderCall(args, theme) {
			const op = (args.referenced_image_paths?.length ?? 0) > 0 || args.num_last_images_to_include ? "edit" : "generate";
			const prompt = args.prompt ? ` ${theme.fg("dim", JSON.stringify(args.prompt).slice(0, 140))}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("imagegen"))} ${theme.fg("muted", op)}${prompt}`, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			const details = result.details as ImagegenResultDetails | undefined;
			if (isPartial || details?.partial) return new Text(theme.fg("muted", "Generating image…"), 0, 0);
			const path = details?.relativePath ?? details?.path;
			if (!path) return new Text(theme.fg("success", "✓ Generated image"), 0, 0);
			const meta = [details.operation, details.size, details.quality].filter(Boolean).join(" · ");
			return new Text(`${theme.fg("success", "✓ Generated image")} ${theme.fg("muted", path)}${meta ? ` ${theme.fg("dim", `(${meta})`)}` : ""}`, 0, 0);
		},
	});

}
