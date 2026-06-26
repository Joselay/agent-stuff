import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

const UPPER_PIXEL = "▀";
const LOWER_PIXEL = "▄";
const FULL_PIXEL = "█";
const EMPTY_PIXEL = " ";
const RESET_COLOR = "\x1b[0m";

const PALETTE: Record<string, string> = {
	K: "#6C7086", // soft outline
	H: "#F5C2E7", // cotton-candy hair
	D: "#CBA6F7", // hair shadow
	S: "#F2CDCD", // skin
	W: "#F5E0DC", // eye sparkle / collar
	E: "#11111B", // lashes
	B: "#89B4FA", // starry eyes
	R: "#F38BA8", // blush
	M: "#F38BA8", // tiny smile
	P: "#FAB387", // peach dress
	C: "#94E2D5", // mint bow/collar
	Y: "#F9E2AF", // hair bows
	L: "#45475A", // shoes / shadows
};

const KAWAII_GIRL_ROWS = [
	"000000000000000000000000YYKYY0000000000000000000000000",
	"00000000000000000000000YKKHKKY000000000000000000000000",
	"0000000000000000000000KKHHHHHHKK0000000000000000000000",
	"00000000000000000000KHHHHHHHHHHHHK00000000000000000000",
	"000000000000000000KKHHHHDDDDDDHHHHKK000000000000000000",
	"00000000000000000KHHHHDDSSSSSSDDHHHHK00000000000000000",
	"000000000KKK0000KHHHHDSSSSSSSSSDHHHHK0000KKK0000000000",
	"00000000KHHHK000KHHHDSSSSSSSSSSSDHHHK000KHHHK000000000",
	"0000000KHHHHHK00KHHDSSEEEWSSWEEESSDHHK00KHHHHHK0000000",
	"00000KHHDDHHK00KHHDSSEBBEWSSWEBBESSDHHK00KHHDDHHK00000",
	"00000KHHDDHHK00KHHDSSEBBBWSSWBBBESSDHHK00KHHDDHHK00000",
	"000000KHHHHK000KHHDSRRSSSSMMSSSSRRSDHHK000KHHHHK000000",
	"00000000KKKK00000KHHDDSSSSSSSSSSDDHHK00000KKKK00000000",
	"000000000000000000KHHHDDSSSSSSDDHHHK000000000000000000",
	"0000000000000000000KKHHHDDDDDDHHHKK0000000000000000000",
	"000000000000000000000KKKKHHHHKKKK000000000000000000000",
	"0000000000000000000000KPPWWWWPPK0000000000000000000000",
	"00000000000000000000KPPPCPCCPCPPK000000000000000000000",
	"00000000000000000000KPPPPCCCCPPPPK00000000000000000000",
	"0000000000000000000KSSKPPPPPPPPKSSK0000000000000000000",
	"00000000000000000KHHK0KPPPPLLPPPK0KHHK0000000000000000",
	"000000000000000000KK00KLLK00KLLK00KK000000000000000000",
	"0000000000000000000000KKK000KKK00000000000000000000000",
];

function rgb(hex: string): [number, number, number] {
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);

	return [r, g, b];
}

function foreground(hex: string): string {
	const [r, g, b] = rgb(hex);

	return `\x1b[38;2;${r};${g};${b}m`;
}

function background(hex: string): string {
	const [r, g, b] = rgb(hex);

	return `\x1b[48;2;${r};${g};${b}m`;
}

function color(hex: string, text: string): string {
	return `${foreground(hex)}${text}${RESET_COLOR}`;
}

function pixel(top: string, bottom: string): string {
	const topHex = PALETTE[top];
	const bottomHex = PALETTE[bottom];

	if (!topHex && !bottomHex) return EMPTY_PIXEL;
	if (topHex && !bottomHex) return color(topHex, UPPER_PIXEL);
	if (!topHex && bottomHex) return color(bottomHex, LOWER_PIXEL);
	if (topHex === bottomHex) return color(topHex, FULL_PIXEL);

	return `${foreground(topHex ?? "#FFFFFF")}${background(bottomHex ?? "#FFFFFF")}${UPPER_PIXEL}${RESET_COLOR}`;
}

function pixelArt(rows: readonly string[]): string[] {
	const leftTrim = Math.min(...rows.map((row) => row.match(/^0*/)?.[0].length ?? 0));
	const trimmedRows = rows.map((row) => row.slice(leftTrim));
	const renderedRows: string[] = [];

	for (let rowIndex = 0; rowIndex < trimmedRows.length; rowIndex += 2) {
		const top = trimmedRows[rowIndex] ?? "";
		const bottom = trimmedRows[rowIndex + 1] ?? "";
		const width = Math.max(top.length, bottom.length);
		let line = "";

		for (let column = 0; column < width; column++) {
			line += pixel(top[column] ?? "0", bottom[column] ?? "0");
		}

		renderedRows.push(line);
	}

	return renderedRows;
}

const KAWAII_GIRL_ART = pixelArt(KAWAII_GIRL_ROWS);

function renderHeader(width: number): string[] {
	return KAWAII_GIRL_ART.map((line) => truncateToWidth(line, width, ""));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setHeader(() => ({
			render: renderHeader,
			invalidate() {},
		}));
	});
}
