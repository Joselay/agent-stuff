import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorComponent } from "@earendil-works/pi-tui";

const BASH_TEXT = "dim" as const;
const CHROME = Symbol.for("pi.prompt.chrome.v1");
const SESSION_LABEL = "session.label";
const SESSION_PAINT = "session.paint";

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

function fitLabels(left: string, right: string, width: number, paint: Paint): string {
	if (width <= 0) return "";
	if (width === 1) return paint("─");
	const available = width - 2;
	const fittedRight = truncateToWidth(right, available, "");
	const fittedLeft = truncateToWidth(left, Math.max(0, available - visibleWidth(fittedRight)), "");
	const gap = Math.max(0, available - visibleWidth(fittedLeft) - visibleWidth(fittedRight));
	return `${paint("─")}${fittedLeft}${paint("─".repeat(gap))}${fittedRight}${paint("─")}`;
}

/** pi bash prefixes are exactly `!` or `!!` (not `!!!+`). */
function isBashModeText(text: string): boolean {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("!")) return false;
	if (trimmed.startsWith("!!!")) return false;
	return true;
}

export default function bashMode(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			addChromeLayer(editor, {
				id: "bash-mode",
				order: 30,
				afterInput: ({ editor }) => {
					const text = editor.getText();
					const trimmed = text.trimStart();
					// pi core marks any leading `!` as bash; undo that for `!!!+`
					if (!trimmed.startsWith("!") || isBashModeText(text)) return;
					editor.borderColor = ctx.ui.theme.getThinkingBorderColor(pi.getThinkingLevel());
				},
				render: ({ editor, lines, width, state }) => {
					if (!lines.length || !isBashModeText(editor.getText())) return;
					const right = (state.get(SESSION_LABEL) as string | undefined) ?? "";
					const paint =
						(state.get(SESSION_PAINT) as Paint | undefined) ?? editor.borderColor ?? ((text: string) => text);
					lines[0] = fitLabels(ctx.ui.theme.fg(BASH_TEXT, " bash "), right, width, paint);
				},
			});
			return editor;
		});
	});
}
