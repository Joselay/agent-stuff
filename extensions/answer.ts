import { parseJsonWithRepair, type AssistantMessage, type UserMessage } from "@earendil-works/pi-ai";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const DICTATE_EDITOR_BRIDGE = Symbol.for("pi.dictate.editorBridge");
type DictateEditorBridge = {
	decorate<T extends { insertTextAtCursor?(text: string): void }>(editor: T, tui: TUI): T;
};

interface ExtractedQuestion {
	question: string;
	context?: string;
}

interface ExtractionResult {
	questions: ExtractedQuestion[];
}

type TaskResult<T> =
	| { status: "ok"; value: T }
	| { status: "cancelled" }
	| { status: "failed"; message: string };

const SYSTEM_PROMPT = `Extract every question requiring user input from the conversation text.
Return only JSON in this shape:
{"questions":[{"question":"Question text","context":"Optional essential context"}]}
Keep questions concise and in source order. Omit context unless essential. Return {"questions":[]} when none exist.`;
const EXTRACTION_PROVIDER = "openai-codex";
const EXTRACTION_MODEL = "gpt-5.6-luna";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function runWithLoader<T>(
	ctx: ExtensionContext,
	label: string,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<TaskResult<T>> {
	let settled = false;
	return ctx.ui.custom<TaskResult<T>>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, label);
		const finish = (result: TaskResult<T>) => {
			if (settled) return;
			settled = true;
			done(result);
		};

		loader.onAbort = () => finish({ status: "cancelled" });
	work(loader.signal).then(
			(value) => finish({ status: "ok", value }),
			(error: unknown) =>
				finish(
					isAbort(error)
						? { status: "cancelled" }
						: { status: "failed", message: errorText(error) },
				),
		);
		return loader;
	});
}

function textContent(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return typeof content === "string" ? content : "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				typeof block === "object" &&
				block !== null &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function assistantContext(ctx: ExtensionContext): { latest: AssistantMessage; text?: string } | undefined {
	let latest: AssistantMessage | undefined;
	let text: string | undefined;
	const branch = ctx.sessionManager.getBranch();

	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		latest ??= entry.message;
		text ||= textContent(entry.message).trim() || undefined;
		if (text) break;
	}

	return latest ? { latest, text } : undefined;
}

function parseQuestion(value: unknown): ExtractedQuestion | undefined {
	if (typeof value !== "object" || value === null) return;
	const { question, context } = value as Record<string, unknown>;
	if (typeof question !== "string" || (context != null && typeof context !== "string")) return;
	return typeof context === "string" && context ? { question, context } : { question };
}

function parseExtractionResult(text: string): ExtractionResult | undefined {
	const trimmed = text.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1]?.trim();
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	const sliced = firstBrace >= 0 && lastBrace > firstBrace ? trimmed.slice(firstBrace, lastBrace + 1) : undefined;

	for (const candidate of new Set([fenced, trimmed, sliced])) {
		if (!candidate) continue;
		try {
			const value = parseJsonWithRepair<unknown>(candidate) as { questions?: unknown };
			if (!Array.isArray(value?.questions)) continue;
			const questions = value.questions.map(parseQuestion);
			if (questions.every((question): question is ExtractedQuestion => question !== undefined)) {
				return { questions };
			}
		} catch {
		}
	}
}

async function extractQuestions(
	ctx: ExtensionContext,
	text: string,
): Promise<TaskResult<ExtractionResult>> {
	const model = ctx.modelRegistry.find(EXTRACTION_PROVIDER, EXTRACTION_MODEL);
	if (!model) return { status: "failed", message: `${EXTRACTION_MODEL} is not available` };

	return runWithLoader(ctx, `Extracting questions using ${model.id}...`, async (signal) => {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) throw new Error(auth.error);

		const provider = ctx.modelRegistry.getProvider(model.provider);
		if (!provider) throw new Error(`provider ${model.provider} is not available`);

		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		};
		const response = await provider
			.stream(
				model,
				{ systemPrompt: SYSTEM_PROMPT, messages: [message] },
				{ apiKey: auth.apiKey, headers: auth.headers, signal },
			)
			.result();

		if (response.stopReason === "aborted") {
			const error = new Error("question extraction aborted");
			error.name = "AbortError";
			throw error;
		}
		if (response.stopReason === "error") {
			throw new Error(response.errorMessage ?? "question extraction failed");
		}

		const result = parseExtractionResult(textContent(response));
		if (!result) throw new Error("question extraction returned invalid JSON");
		return result;
	});
}

export class QnAComponent implements Component, Focusable {
	private readonly answers: string[];
	private readonly editor: Editor & { disposeDictation?: () => void };
	private currentIndex = 0;
	private confirming = false;

	private readonly dim = (text: string) => this.theme.fg("dim", text);
	private readonly bold = (text: string) => this.theme.bold(text);
	private readonly accent = (text: string) => this.theme.fg("accent", text);
	private readonly success = (text: string) => this.theme.fg("success", text);
	private readonly warning = (text: string) => this.theme.fg("warning", text);
	private readonly muted = (text: string) => this.theme.fg("muted", text);

	constructor(
		private readonly questions: ExtractedQuestion[],
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly onDone: (result: string | null) => void,
	) {
		this.answers = questions.map(() => "");
		const editorTheme: EditorTheme = {
			borderColor: this.dim,
			selectList: {
				selectedPrefix: this.accent,
				selectedText: (text) => `\x1b[44m${text}\x1b[0m`,
				description: this.muted,
				scrollInfo: this.dim,
				noMatch: this.warning,
			},
		};
		const baseEditor = new Editor(tui, editorTheme);
		const bridge = (globalThis as unknown as Record<PropertyKey, unknown>)[DICTATE_EDITOR_BRIDGE] as
			| DictateEditorBridge
			| undefined;
		this.editor = (bridge?.decorate(baseEditor, tui) ?? baseEditor) as Editor & {
			disposeDictation?: () => void;
		};
		this.editor.disableSubmit = true;
		this.editor.onChange = () => this.refresh();
	}

	get focused(): boolean {
		return this.editor.focused;
	}

	set focused(value: boolean) {
		this.editor.focused = value;
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private save(): void {
		this.answers[this.currentIndex] = this.editor.getText();
	}

	private move(offset: number): void {
		const next = this.currentIndex + offset;
		if (next < 0 || next >= this.questions.length) return;
		this.save();
		this.currentIndex = next;
		this.editor.setText(this.answers[next] ?? "");
		this.refresh();
	}

	private submit(): void {
		this.save();
		const result = this.questions
			.map((question, index) =>
				[
					`Q: ${question.question}`,
					...(question.context ? [`> ${question.context}`] : []),
					`A: ${this.answers[index]?.trim() || "(no answer)"}`,
				].join("\n"),
			)
			.join("\n\n");
		this.finish(result);
	}

	private finish(result: string | null): void {
		this.editor.disposeDictation?.();
		this.onDone(result);
	}

	handleInput(data: string): void {
		if (this.confirming) {
			if (matchesKey(data, Key.enter) || data.toLowerCase() === "y") return this.submit();
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "n") {
				this.confirming = false;
				this.refresh();
			}
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return this.finish(null);
		if (matchesKey(data, Key.tab)) return this.move(1);
		if (matchesKey(data, Key.shift("tab"))) return this.move(-1);

		const empty = this.editor.getText() === "";
		if (empty && matchesKey(data, Key.up)) return this.move(-1);
		if (empty && matchesKey(data, Key.down)) return this.move(1);

		if (matchesKey(data, Key.enter) && !matchesKey(data, Key.shift("enter"))) {
			if (this.currentIndex < this.questions.length - 1) this.move(1);
			else {
				this.save();
				this.confirming = true;
				this.refresh();
			}
			return;
		}

		this.editor.handleInput(data);
		this.refresh();
	}

	render(width: number): string[] {
		if (width < 16) {
			return width > 0 ? [truncateToWidth("Widen terminal to answer questions", width, "")] : [];
		}

		const boxWidth = Math.min(width - 4, 120);
		const contentWidth = boxWidth - 4;
		const horizontal = () => "─".repeat(boxWidth - 2);
		const fit = (line: string) => {
			const fitted = truncateToWidth(line, width, "");
			return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
		};
		const box = (content = "", leftPad = 2) => {
			const available = Math.max(0, boxWidth - leftPad - 2);
			const padded = " ".repeat(leftPad) + truncateToWidth(content, available, "");
			return this.dim("│") + padded + " ".repeat(Math.max(0, boxWidth - visibleWidth(padded) - 2)) + this.dim("│");
		};
		const rule = () => this.dim(`├${horizontal()}┤`);
		const lines: string[] = [
			this.dim(`╭${horizontal()}╮`),
			box(`${this.bold(this.accent("Questions"))} ${this.dim(`(${this.currentIndex + 1}/${this.questions.length})`)}`),
			rule(),
			box(
				this.questions
					.map((_, index) =>
						index === this.currentIndex
							? this.accent("●")
							: this.answers[index]?.trim()
								? this.success("●")
								: this.dim("○"),
					)
					.join(" "),
			),
			box(),
		];

		const question = this.questions[this.currentIndex];
		for (const line of wrapTextWithAnsi(`${this.bold("Q:")} ${question.question}`, contentWidth)) lines.push(box(line));
		if (question.context) {
			lines.push(box());
			for (const line of wrapTextWithAnsi(this.muted(`> ${question.context}`), contentWidth - 2)) lines.push(box(line));
		}
		lines.push(box());

		const editorLines = this.editor.render(contentWidth - 7);
		for (let index = 1; index < editorLines.length - 1; index++) {
			lines.push(box(index === 1 ? this.bold("A: ") + editorLines[index] : "   " + editorLines[index]));
		}
		lines.push(box(), rule());

		const footer = this.confirming
			? `${this.warning("Submit all answers?")} ${this.dim("(Enter/y to confirm, Esc/n to cancel)")}`
			: `${this.dim("Tab/Enter")} next · ${this.dim("Shift+Tab")} prev · ${this.dim("Shift+Enter")} newline · ${this.dim("Esc")} cancel`;
		lines.push(box(footer), this.dim(`╰${horizontal()}╯`));
		return lines.map(fit);
	}
}

export default function (pi: ExtensionAPI) {
	const answer = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return ctx.ui.notify("answer requires interactive mode", "error");

		const assistant = assistantContext(ctx);
		if (!assistant) return ctx.ui.notify("No assistant messages found", "error");
		if (assistant.latest.stopReason !== "stop") {
			return ctx.ui.notify(`Last assistant message incomplete (${assistant.latest.stopReason})`, "error");
		}
		if (!assistant.text) return ctx.ui.notify("No assistant text found", "error");

		const outcome = await extractQuestions(ctx, assistant.text);
		if (outcome.status === "failed") {
			return ctx.ui.notify(`Question extraction failed: ${outcome.message}`, "error");
		}
		if (outcome.status === "cancelled") return ctx.ui.notify("Cancelled", "info");
		if (outcome.value.questions.length === 0) return ctx.ui.notify("No questions found in the last message", "info");

		const answers = await ctx.ui.custom<string | null>(
			(tui, theme, _keybindings, done) => new QnAComponent(outcome.value.questions, tui, theme, done),
		);
		if (answers === null) return ctx.ui.notify("Cancelled", "info");

		pi.sendMessage(
			{
				customType: "answers",
				content: `I answered your questions in the following way:\n\n${answers}`,
				display: true,
			},
			{ triggerTurn: true },
		);
	};

	pi.registerCommand("answer", {
		description: "Extract questions from last assistant message into interactive Q&A",
		handler: (_args, ctx) => answer(ctx),
	});
	pi.registerShortcut("ctrl+.", {
		description: "Extract and answer questions",
		handler: answer,
	});
}
