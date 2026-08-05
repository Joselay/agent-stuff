import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorComponent } from "@earendil-works/pi-tui";

const ACCENT = "borderAccent" as const;
const RIGHT_INSET = 1;
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const BORDER_DECORATIONS = /[─↑↓\d\s.…]+/g;
const CHROME = Symbol.for("pi.prompt.chrome.v1");
const HISTORY_ACTIVE = "recall.active";
const SESSION_LABEL = "session.label";
const SESSION_PAINT = "session.paint";

type Theme = ExtensionContext["ui"]["theme"];
type Paint = (text: string) => string;
type RenderState = Map<string, unknown>;
type ChromeRenderContext = {
	editor: EditorComponent;
	lines: string[];
	width: number;
	state: RenderState;
};
type ChromeInputContext = {
	editor: EditorComponent;
	data: string;
	before: string;
};
type ChromeLayer = {
	id: string;
	order: number;
	setup?: (editor: EditorComponent) => void;
	render?: (context: ChromeRenderContext) => void;
	afterInput?: (context: ChromeInputContext) => void;
};
type ChromeCoordinator = {
	layers: Map<string, ChromeLayer>;
	initialized: Set<string>;
};
type CoordinatedEditor = EditorComponent & Record<symbol, ChromeCoordinator | undefined>;

function orderedLayers(coordinator: ChromeCoordinator): ChromeLayer[] {
	return [...coordinator.layers.values()].sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

function addChromeLayer(editor: EditorComponent, layer: ChromeLayer): void {
	const coordinated = editor as CoordinatedEditor;
	let coordinator = coordinated[CHROME];
	if (!coordinator) {
		coordinator = { layers: new Map(), initialized: new Set() };
		coordinated[CHROME] = coordinator;

		const render = editor.render.bind(editor);
		editor.render = (width: number): string[] => {
			const lines = [...render(width)];
			const state: RenderState = new Map();
			for (const current of orderedLayers(coordinator!)) current.render?.({ editor, lines, width, state });
			return lines;
		};

		const handleInput = editor.handleInput.bind(editor);
		editor.handleInput = (data: string): void => {
			const before = editor.getText();
			handleInput(data);
			for (const current of orderedLayers(coordinator!)) current.afterInput?.({ editor, data, before });
		};
	}

	coordinator.layers.set(layer.id, layer);
	if (layer.setup && !coordinator.initialized.has(layer.id)) {
		coordinator.initialized.add(layer.id);
		layer.setup(editor);
	}
}

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

function badge(theme: Theme, name: string): string {
	const background = theme.getFgAnsi(ACCENT).replace("[38;", "[48;");
	return `${background}\x1b[30m ${name} \x1b[39m\x1b[49m`;
}

function fitLabels(left: string, right: string, width: number, paint: Paint): string {
	if (width <= 0) return "";
	if (width === 1) return paint("─");
	const available = width - 2;
	const fittedRight = truncateToWidth(right, available, "");
	const fittedLeft = truncateToWidth(left, Math.max(0, available - visibleWidth(fittedRight)), "");
	const gap = Math.max(0, available - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
	return `${paint("─")}${fittedLeft}${paint("─".repeat(gap))}${fittedRight}${paint("─")}`;
}

function addRightLabel(line: string, label: string, width: number, paint: Paint): string {
	if (width <= 0) return "";
	if (width === 1) return paint("─");
	const fitted = truncateToWidth(label, width - 1, "");
	const left = truncateToWidth(line, Math.max(0, width - visibleWidth(fitted) - 4), "");
	const gap = Math.max(0, width - visibleWidth(left) - visibleWidth(fitted) - 1);
	return `${left}${paint("─".repeat(gap))}${fitted}${paint("─")}`;
}

export default function sessionName(pi: ExtensionAPI): void {
	let requestRender: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			requestRender = () => tui.requestRender();
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			addChromeLayer(editor, {
				id: "session-name",
				order: 20,
				render: ({ lines, width, state }) => {
					const name = pi.getSessionName()?.trim();
					if (!name || !lines.length) return;

					const currentTheme = ctx.ui.theme;
					const paint = (text: string) => currentTheme.fg(ACCENT, text);
					const bottom = bottomBorderIndex(lines);
					lines[0] = paintBorder(lines[0]!, paint);
					lines[bottom] = paintBorder(lines[bottom]!, paint);
					const label = `${badge(currentTheme, name)}${paint("─".repeat(RIGHT_INSET))}`;
					state.set(SESSION_LABEL, label);
					state.set(SESSION_PAINT, paint);
					lines[0] = state.get(HISTORY_ACTIVE)
						? addRightLabel(lines[0]!, label, width, paint)
						: fitLabels("", label, width, paint);
				},
			});
			return editor;
		});
	});

	pi.on("session_info_changed", () => requestRender?.());
	pi.on("session_shutdown", () => {
		requestRender = undefined;
	});
}
