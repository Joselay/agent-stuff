import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const SESSION_ACCENT = "borderAccent" as const;
const RIGHT_INSET = 1;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const BORDER_DECORATIONS = /[─↑↓\d\s.…]+/g;

type Theme = ExtensionContext["ui"]["theme"];
type Paint = (text: string) => string;

function plainText(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function isBorderLine(line: string): boolean {
	const text = plainText(line);
	return text.includes("─") && text.replace(BORDER_DECORATIONS, "").length === 0;
}

function paintBorder(line: string, paint: Paint): string {
	return isBorderLine(line) ? paint(plainText(line)) : line.replace(/─+/g, paint);
}

function bottomBorderIndex(lines: string[]): number {
	for (let index = lines.length - 1; index > 0; index--) {
		if (isBorderLine(lines[index]!)) return index;
	}
	return lines.length - 1;
}

function backgroundFromForeground(ansi: string): string {
	return ansi.replace("[38;", "[48;");
}

function badge(theme: Theme, name: string): string {
	const background = backgroundFromForeground(theme.getFgAnsi(SESSION_ACCENT));
	return `${background}\x1b[30m ${name} \x1b[39m\x1b[49m`;
}

function fitRightLabel(label: string, width: number, paint: Paint): string {
	if (width <= 0) return "";
	if (width === 1) return paint("─");

	const available = Math.max(0, width - 2);
	const fitted = truncateToWidth(label, available, "");
	const gap = Math.max(0, available - visibleWidth(fitted));
	return `${paint("─".repeat(gap + 1))}${fitted}${paint("─")}`;
}

function addLabelToDecoratedBorder(line: string, label: string, width: number, paint: Paint): string {
	if (width <= 0) return "";
	if (width === 1) return paint("─");

	const fittedLabel = truncateToWidth(label, width - 1, "");
	const labelWidth = visibleWidth(fittedLabel);
	const left = truncateToWidth(line, Math.max(0, width - labelWidth - 4), "");
	const gap = Math.max(0, width - visibleWidth(left) - labelWidth - 1);
	return `${left}${paint("─".repeat(gap))}${fittedLabel}${paint("─")}`;
}

function installEditor(pi: ExtensionAPI, ctx: ExtensionContext, onReady: (render: () => void) => void): void {
	const previous = ctx.ui.getEditorComponent();

	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		onReady(() => tui.requestRender());
		const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
		const render = editor.render.bind(editor);

		editor.render = (width: number): string[] => {
			const lines = [...render(width)];
			const name = pi.getSessionName()?.trim();
			if (!name || lines.length < 2) return lines;

			const currentTheme = ctx.ui.theme;
			const paint = (text: string) => currentTheme.fg(SESSION_ACCENT, text);
			const bottom = bottomBorderIndex(lines);
			lines[0] = paintBorder(lines[0]!, paint);
			lines[bottom] = paintBorder(lines[bottom]!, paint);

			const label = `${badge(currentTheme, name)}${paint("─".repeat(RIGHT_INSET))}`;
			lines[0] = /History\s+\d+\/\d+/.test(plainText(lines[0]!))
				? addLabelToDecoratedBorder(lines[0]!, label, width, paint)
				: fitRightLabel(label, width, paint);
			return lines;
		};

		return editor;
	});
}

export default function promptExtension(pi: ExtensionAPI): void {
	let requestRender: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		installEditor(pi, ctx, (render) => {
			requestRender = render;
		});
	});

	pi.on("session_info_changed", () => requestRender?.());
	pi.on("session_shutdown", () => {
		requestRender = undefined;
	});
}
