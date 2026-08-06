import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  copyToClipboard,
  DynamicBorder,
  generateDiffString,
  getLanguageFromPath,
  highlightCode,
  keyHint,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type Focusable,
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  type SelectListLayoutOptions,
  Spacer,
  Text,
  truncateToWidth,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";


type GitOptions = { cwd?: string };
type GitOutput =
  { ok: true; text: string } | { ok: false; code: number; stderr: string };
type GitStatusEntry = { code: string; path: string; from?: string };
type GitExec = (
  args: string[],
  options: GitOptions,
) => Promise<{ stdout: string; stderr?: string; code: number }>;

type Git = {
  run(args: string[], options?: GitOptions): Promise<GitOutput>;
  lines(args: string[], options?: GitOptions): Promise<string[]>;
  isRepository(options?: GitOptions): Promise<boolean>;
  root(options?: GitOptions): Promise<string | undefined>;
  status(options?: GitOptions): Promise<GitStatusEntry[] | undefined>;
};

function gitFor(pi: ExtensionAPI): Git {
  const exec: GitExec = (args, options) =>
    pi.exec("git", args, options.cwd ? { cwd: options.cwd } : undefined);

  async function run(
    args: string[],
    options: GitOptions = {},
  ): Promise<GitOutput> {
    try {
      const result = await exec(args, options);
      if (result.code === 0) return { ok: true, text: result.stdout };
      return {
        ok: false,
        code: result.code,
        stderr: result.stderr?.trim() ?? "",
      };
    } catch (error) {
      return { ok: false, code: -1, stderr: errorText(error) };
    }
  }

  async function lines(
    args: string[],
    options: GitOptions = {},
  ): Promise<string[]> {
    const result = await run(args, options);
    if (!result.ok) return [];
    return result.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async function isRepository(options: GitOptions = {}): Promise<boolean> {
    return (await run(["rev-parse", "--git-dir"], options)).ok;
  }

  async function root(options: GitOptions = {}): Promise<string | undefined> {
    const result = await run(["rev-parse", "--show-toplevel"], options);
    return result.ok ? result.text.trim() || undefined : undefined;
  }

  async function status(
    options: GitOptions = {},
  ): Promise<GitStatusEntry[] | undefined> {
    const result = await run(
      ["status", "--porcelain=1", "-z", "-uall"],
      options,
    );
    return result.ok
      ? parseStatusEntries(result.text.split("\0").filter(Boolean))
      : undefined;
  }

  return { run, lines, isRepository, root, status };
}

function parseStatusEntries(entries: string[]): GitStatusEntry[] {
  const parsed: GitStatusEntry[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) continue;
    if ((code.startsWith("R") || code.startsWith("C")) && entries[index + 1]) {
      parsed.push({ code, path, from: entries[index + 1] });
      index += 1;
    } else {
      parsed.push({ code, path });
    }
  }
  return parsed;
}

function isUntracked(entry: GitStatusEntry): boolean {
  return entry.code.startsWith("?");
}


type NotifyLevel = "info" | "warning" | "error";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: NotifyLevel = "info",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function selectListTheme(theme: Theme) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}


const COMMIT_LIMIT = 50;

const MAX_DIFF_LINES = 4000;

const MAX_FILE_BYTES = 1_500_000;

type GitScope =
  { kind: "uncommitted" } | { kind: "commit"; sha: string; title: string };

type ChangedFile = {
  path: string;
  from?: string;
  status: string;
};

type CommitInfo = {
  sha: string;
  shortSha: string;
  title: string;
  author: string;
  date: string;
  body: string;
};

type FileDiff =
  | {
      kind: "text";
      diff: string;
      firstChangedLine?: number;
      firstChangeIndex?: number;
      truncated: boolean;
      additions: number;
      deletions: number;
    }
  | { kind: "binary"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string };

function scopeLabel(scope: GitScope): string {
  switch (scope.kind) {
    case "uncommitted":
      return "Uncommitted";
    case "commit":
      return `${scope.sha.slice(0, 7)} ${scope.title}`;
  }
}

function scopeIsLive(scope: GitScope): boolean {
  return scope.kind === "uncommitted";
}

function shortStatus(status: string): string {
  const letter = status.trim().slice(0, 1) || "?";
  return letter.toUpperCase();
}

function statusColor(
  status: string,
): "success" | "error" | "warning" | "accent" | "muted" {
  switch (shortStatus(status)) {
    case "A":
    case "?":
      return "success";
    case "D":
      return "error";
    case "M":
    case "T":
      return "warning";
    case "R":
    case "C":
      return "accent";
    default:
      return "muted";
  }
}

function parseNameStatus(payload: string): ChangedFile[] {
  const parts = payload.split("\0").filter((part) => part.length > 0);
  const files: ChangedFile[] = [];

  for (let i = 0; i < parts.length; i += 1) {
    const statusToken = parts[i];
    if (!statusToken) continue;

    const status =
      statusToken.replace(/[0-9]+$/u, "").trim() || statusToken.trim();
    const letter = shortStatus(status);

    if (letter === "R" || letter === "C") {
      const from = parts[i + 1];
      const to = parts[i + 2];
      if (!from || !to) break;
      files.push({ path: to, from, status: letter });
      i += 2;
      continue;
    }

    const filePath = parts[i + 1];
    if (!filePath) break;
    files.push({ path: filePath, status: letter });
    i += 1;
  }

  return files;
}

function statusLetterFromPorcelain(entry: GitStatusEntry): string | undefined {
  if (isUntracked(entry)) return "?";

  const index = entry.code[0] ?? " ";
  const work = entry.code[1] ?? " ";

  if (work !== " " && work !== "?") return work;
  if (index !== " " && index !== "?") return index;
  return "?";
}

async function listChangedFiles(
  git: Git,
  scope: GitScope,
  options: GitOptions = {},
): Promise<ChangedFile[]> {
  switch (scope.kind) {
    case "uncommitted":
      return await listUncommitted(git, options);
    case "commit": {
      const parents = await git.lines(
        ["rev-list", "--parents", "-n", "1", scope.sha],
        options,
      );
      const bits = parents[0]?.split(/\s+/).filter(Boolean) ?? [];
      const sha = bits[0] ?? scope.sha;
      const parent = bits[1];

      const result = parent
        ? await git.run(["diff", "--name-status", "-z", parent, sha], options)
        : await git.run(
            [
              "diff-tree",
              "--no-commit-id",
              "--name-status",
              "-r",
              "-z",
              "--root",
              sha,
            ],
            options,
          );

      if (!result.ok) {
        throw new Error(
          result.stderr || `Could not list files for ${scope.sha.slice(0, 7)}`,
        );
      }
      return sortFiles(uniqueFiles(parseNameStatus(result.text)));
    }
  }
}

async function listUncommitted(
  git: Git,
  options: GitOptions,
): Promise<ChangedFile[]> {
  const entries = await git.status(options);
  if (!entries) {
    throw new Error("Could not read git status");
  }

  const files: ChangedFile[] = [];
  for (const entry of entries) {
    const letter = statusLetterFromPorcelain(entry);
    if (!letter) continue;
    files.push({
      path: entry.path,
      from: entry.from,
      status: letter,
    });
  }
  return sortFiles(uniqueFiles(files));
}

function uniqueFiles(files: ChangedFile[]): ChangedFile[] {
  const seen = new Set<string>();
  const out: ChangedFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    out.push(file);
  }
  return out;
}

function sortFiles(files: ChangedFile[]): ChangedFile[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path));
}

type FileTreeRow =
  | {
      kind: "dir";
      name: string;
      depth: number;
      isLast: boolean;
      guides: boolean[];
    }
  | {
      kind: "file";
      name: string;
      depth: number;
      isLast: boolean;
      guides: boolean[];
      fileIndex: number;
      file: ChangedFile;
    };

type TreeNode = {
  name: string;
  children: Map<string, TreeNode>;
  fileIndex?: number;
  file?: ChangedFile;
};

function buildFileTree(files: ChangedFile[]): FileTreeRow[] {
  const root: TreeNode = { name: "", children: new Map() };

  files.forEach((file, index) => {
    const parts = file.path.split("/").filter(Boolean);
    if (parts.length === 0) return;
    let node = root;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      const isLeaf = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, children: new Map() };
        node.children.set(part, child);
      }
      if (isLeaf) {
        child.file = file;
        child.fileIndex = index;
      } else {
        node = child;
      }
    }
  });

  const rows: FileTreeRow[] = [];

  const sortedChildren = (node: TreeNode): TreeNode[] =>
    [...node.children.values()].sort((a, b) => {
      const aDir = a.children.size > 0;
      const bDir = b.children.size > 0;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  const collapse = (node: TreeNode): { node: TreeNode; label: string } => {
    let label = node.name;
    let current = node;
    while (current.file === undefined && current.children.size === 1) {
      const only = current.children.values().next().value as
        TreeNode | undefined;
      if (!only || only.children.size === 0) break;
      label = `${label}/${only.name}`;
      current = only;
    }
    return { node: current, label };
  };

  const walk = (node: TreeNode, depth: number, guides: boolean[]) => {
    const children = sortedChildren(node);
    children.forEach((raw, index) => {
      const isLast = index === children.length - 1;

      if (raw.children.size > 0) {
        const { node: dir, label } =
          raw.file === undefined
            ? collapse(raw)
            : { node: raw, label: raw.name };
        rows.push({
          kind: "dir",
          name: label,
          depth,
          isLast: isLast && raw.file === undefined,
          guides,
        });
        walk(dir, depth + 1, [...guides, !(isLast && raw.file === undefined)]);
      }

      if (raw.file !== undefined && raw.fileIndex !== undefined) {
        rows.push({
          kind: "file",
          name: raw.name,
          depth,
          isLast,
          guides,
          fileIndex: raw.fileIndex,
          file: raw.file,
        });
      }
    });
  };

  walk(root, 0, []);
  return rows;
}

function treeRowPrefix(row: Pick<FileTreeRow, "guides" | "isLast">): string {
  let out = "";
  for (const cont of row.guides) {
    out += cont ? "│  " : "   ";
  }
  out += row.isLast ? "└─ " : "├─ ";
  return out;
}

async function loadCommitInfo(
  git: Git,
  sha: string,
  options: GitOptions = {},
): Promise<CommitInfo | undefined> {
  const result = await git.run(
    ["show", "-s", "--format=%H%n%h%n%s%n%an%n%ad%n%b", "--date=relative", sha],
    options,
  );
  if (!result.ok) return undefined;
  const lines = result.text.split("\n");
  const [full, short, title, author, date, ...bodyLines] = lines;
  if (!full || !short || title === undefined) return undefined;
  return {
    sha: full.trim(),
    shortSha: short.trim(),
    title: title.trim(),
    author: (author ?? "").trim(),
    date: (date ?? "").trim(),
    body: bodyLines.join("\n").trim(),
  };
}

async function loadRecentCommits(
  git: Git,
  limit = COMMIT_LIMIT,
  options: GitOptions = {},
): Promise<
  {
    sha: string;
    shortSha: string;
    title: string;
    author: string;
    date: string;
  }[]
> {
  const result = await git.run(
    [
      "log",
      `--max-count=${limit}`,
      "--format=%H\t%h\t%ad\t%an\t%s",
      "--date=relative",
    ],
    options,
  );
  if (!result.ok) return [];
  return result.text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, shortSha, date, author, ...rest] = line.split("\t");
      return {
        sha: sha ?? "",
        shortSha: shortSha ?? (sha ?? "").slice(0, 7),
        date: date ?? "",
        author: author ?? "",
        title: rest.join("\t"),
      };
    })
    .filter((entry) => entry.sha.length > 0);
}

async function loadFileDiff(
  git: Git,
  scope: GitScope,
  file: ChangedFile,
  options: GitOptions & { root?: string } = {},
): Promise<FileDiff> {
  try {
    const sides = await resolveSides(git, scope, file, options);
    if (sides.kind === "binary") return sides;
    if (sides.kind === "error") return sides;

    if (sides.oldText === sides.newText) {
      return { kind: "empty", message: "No textual changes." };
    }

    if (isProbablyBinary(sides.oldText) || isProbablyBinary(sides.newText)) {
      return { kind: "binary", message: "Binary file differs." };
    }

    if (
      byteLength(sides.oldText) > MAX_FILE_BYTES ||
      byteLength(sides.newText) > MAX_FILE_BYTES
    ) {
      return { kind: "binary", message: "File too large to diff in the TUI." };
    }

    const { diff, firstChangedLine } = generateDiffString(
      sides.oldText,
      sides.newText,
    );
    const lines = diff.split("\n");
    const truncated = lines.length > MAX_DIFF_LINES;
    const clipped = truncated
      ? lines.slice(0, MAX_DIFF_LINES).join("\n")
      : diff;
    const { additions, deletions } = countDiffStats(clipped);
    const firstChangeIndex = findFirstChangeIndex(clipped);

    return {
      kind: "text",
      diff: clipped,
      firstChangedLine,
      firstChangeIndex,
      truncated,
      additions,
      deletions,
    };
  } catch (error) {
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function findFirstChangeIndex(diff: string): number | undefined {
  if (!diff) return undefined;
  const lines = diff.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.startsWith("+") || line.startsWith("-")) return i;
  }
  return undefined;
}

type Sides =
  | { kind: "text"; oldText: string; newText: string }
  | { kind: "binary"; message: string }
  | { kind: "error"; message: string };

type BlobRead =
  | { kind: "text"; text: string }
  | { kind: "missing" }
  | { kind: "too_large" }
  | { kind: "error"; message: string };

async function resolveSides(
  git: Git,
  scope: GitScope,
  file: ChangedFile,
  options: GitOptions & { root?: string },
): Promise<Sides> {
  const rel = file.path;
  const from = file.from ?? rel;

  let oldBlob: BlobRead;
  let newBlob: BlobRead;

  switch (scope.kind) {
    case "uncommitted": {
      oldBlob = await readRevision(git, "HEAD", from, options);
      newBlob =
        file.status === "D"
          ? { kind: "missing" }
          : readWorktree(rel, options.root);
      break;
    }
    case "commit": {
      const parents = await git.lines(
        ["rev-list", "--parents", "-n", "1", scope.sha],
        options,
      );
      const bits = parents[0]?.split(/\s+/).filter(Boolean) ?? [scope.sha];
      const parent = bits[1];
      oldBlob = parent
        ? await readRevision(git, parent, from, options)
        : { kind: "missing" };
      newBlob = await readRevision(git, scope.sha, rel, options);
      break;
    }
  }

  if (oldBlob.kind === "too_large" || newBlob.kind === "too_large") {
    return { kind: "binary", message: "File too large to diff in the TUI." };
  }
  if (oldBlob.kind === "error")
    return { kind: "error", message: oldBlob.message };
  if (newBlob.kind === "error")
    return { kind: "error", message: newBlob.message };

  const oldText = oldBlob.kind === "text" ? oldBlob.text : "";
  const newText = newBlob.kind === "text" ? newBlob.text : "";
  return { kind: "text", oldText, newText };
}

async function readRevision(
  git: Git,
  revision: string,
  relativePath: string,
  options: GitOptions,
): Promise<BlobRead> {
  return await readBlob(git, `${revision}:${relativePath}`, options);
}

async function readBlob(
  git: Git,
  spec: string,
  options: GitOptions,
): Promise<BlobRead> {
  const sizeResult = await git.run(["cat-file", "-s", spec], options);
  if (!sizeResult.ok) return { kind: "missing" };

  const size = Number.parseInt(sizeResult.text.trim(), 10);
  if (Number.isFinite(size) && size > MAX_FILE_BYTES)
    return { kind: "too_large" };

  const result = await git.run(["show", spec], options);
  if (!result.ok) return { kind: "missing" };
  return { kind: "text", text: result.text };
}

function readWorktree(relativePath: string, root?: string): BlobRead {
  if (!root) return { kind: "error", message: "Repository root unknown." };
  const absolute = path.join(root, relativePath);
  try {
    const stat = statSync(absolute);
    if (!stat.isFile()) return { kind: "missing" };
    if (stat.size > MAX_FILE_BYTES) return { kind: "too_large" };
    return { kind: "text", text: readFileSync(absolute, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return { kind: "missing" };
    return {
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function isProbablyBinary(text: string): boolean {
  if (!text) return false;
  if (text.includes("\0")) return true;
  const sample = text.slice(0, 8000);
  let weird = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 0x7f) weird += 1;
  }
  return weird / Math.max(sample.length, 1) > 0.1;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function countDiffStats(diff: string): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

type DiffBackground = "added" | "removed";
type ColoredDiffLine = {
  text: string;
  background?: DiffBackground;
};

const NIGHT_OWL_DIFF_BACKGROUND = {
  added: "\x1b[48;2;26;54;42m",
  removed: "\x1b[48;2;61;31;45m",
  reset: "\x1b[49m",
} as const;

type ParsedRow = { prefix: "+" | "-" | " "; lineNum: string; content: string };
const DIFF_ROW = /^([+\- ])(\s*\d*) (.*)$/;

function parseRow(line: string): ParsedRow | undefined {
  const match = DIFF_ROW.exec(line);
  if (!match) return undefined;
  return {
    prefix: match[1] as ParsedRow["prefix"],
    lineNum: match[2] ?? "",
    content: (match[3] ?? "").replace(/\t/g, "   "),
  };
}

function renderDiffColored(
  theme: Theme,
  diff: string,
  filePath: string,
): ColoredDiffLine[] {
  const language = getLanguageFromPath(filePath);
  const paintCode = (content: string): string => {
    if (!language || !content.trim()) return theme.fg("text", content);
    return highlightCode(content, language).join("");
  };

  return diff.split("\n").map((line) => {
    const row = parseRow(line);
    if (!row || (row.prefix === " " && !/\d/.test(row.lineNum))) {
      return { text: theme.fg("dim", line) };
    }
    if (row.prefix === " ") {
      return {
        text:
          theme.fg("toolDiffContext", ` ${row.lineNum} `) +
          paintCode(row.content),
      };
    }
    const added = row.prefix === "+";
    return {
      text:
        theme.fg(added ? "success" : "error", `${row.prefix}${row.lineNum} `) +
        paintCode(row.content),
      background: added ? "added" : "removed",
    };
  });
}

function diffScrollbar(
  total: number,
  visible: number,
  offset: number,
  height: number,
): string[] {
  if (height <= 0) return [];
  if (total <= 0 || total <= visible)
    return new Array<string>(height).fill(" ");

  const thumb = Math.max(
    1,
    Math.min(height, Math.round((visible / total) * height)),
  );
  const maxOffset = Math.max(1, total - visible);
  const clamped = Math.max(0, Math.min(offset, maxOffset));
  const maxTop = height - thumb;
  const top = Math.round((clamped / maxOffset) * maxTop);

  const out: string[] = [];
  for (let i = 0; i < height; i += 1) {
    out.push(i >= top && i < top + thumb ? "┃" : "│");
  }
  return out;
}

function paintStatus(theme: Theme, status: string): string {
  const letter = shortStatus(status);
  return theme.fg(statusColor(status), letter.padEnd(1));
}


const COMMIT_BODY_MAX_LINES = 5;

type Pane = "files" | "diff";

type GitViewerOptions = {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  git: Git;
  root: string;
  scope: GitScope;
  files: ChangedFile[];
  commit?: CommitInfo;
  done: () => void;
};

class GitViewer implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly git: Git;
  private readonly root: string;
  private readonly scope: GitScope;
  private files: ChangedFile[];
  private treeRows: FileTreeRow[] = [];
  private readonly commit: CommitInfo | undefined;
  private readonly done: () => void;

  private pane: Pane = "files";
  private fileIndex = 0;
  private fileWindow = 0;
  private diffScroll = 0;
  private diffLines: ColoredDiffLine[] = [];
  private diffMeta: FileDiff | undefined;
  private loading = false;
  private refreshing = false;
  private loadToken = 0;
  private cache = new Map<string, FileDiff>();
  private renderedCache = new Map<string, ColoredDiffLine[]>();
  private cachedWidth?: number;
  private cachedRows?: number;
  private cachedLines?: string[];
  private rowCache = new Map<number, string>();
  private rowCacheWidth = -1;
  private bodyHeight = 10;
  private split = true;
  private flash?: { text: string; until: number };
  private flashTimer?: ReturnType<typeof setTimeout>;

  constructor(options: GitViewerOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.git = options.git;
    this.root = options.root;
    this.scope = options.scope;
    this.files = options.files;
    this.treeRows = buildFileTree(this.files);
    this.commit = options.commit;
    this.done = options.done;
    if (this.files.length > 0) void this.loadSelected(true);
  }

  private invalidateRender(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
    this.cachedLines = undefined;
    this.rowCache.clear();
    this.rowCacheWidth = -1;
  }

  invalidate(): void {
    this.invalidateRender();
    this.renderedCache.clear();
    const file = this.files[this.fileIndex];
    const cached = file ? this.cache.get(file.path) : undefined;
    if (file && cached) this.applyDiff(cached, file.path, false);
  }

  dispose(): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = undefined;
    this.loadToken += 1;
  }

  handleInput(data: string): void {
    const kb = this.keybindings;

    if (
      kb.matches(data, "tui.select.cancel") ||
      matchesKey(data, Key.ctrl("c"))
    ) {
      this.dispose();
      this.done();
      return;
    }

    if (data === "y") {
      void this.copySelectedPath();
      return;
    }
    if (data === "Y") {
      void this.copyCommitSha();
      return;
    }
    if (data === "r") {
      void this.refresh();
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.pane = this.pane === "files" ? "diff" : "files";
      this.redraw();
      return;
    }

    if (this.split && (matchesKey(data, Key.left) || data === "h")) {
      this.pane = "files";
      this.redraw();
      return;
    }
    if (this.split && (matchesKey(data, Key.right) || data === "l")) {
      this.pane = "diff";
      this.redraw();
      return;
    }

    if (this.pane === "files") {
      this.handleFilesInput(data);
      return;
    }
    this.handleDiffInput(data);
  }

  render(width: number): string[] {
    const rows = this.tui.terminal.rows || 24;
    if (
      this.cachedWidth === width &&
      this.cachedRows === rows &&
      this.cachedLines
    )
      return this.cachedLines;
    if (width <= 0) return [];
    if (width < 4) return [truncateToWidth(this.titleLine(width), width, "")];

    if (rows <= 2) return [truncateToWidth(this.titleLine(width), width)];

    const maxHeight = Math.max(1, Math.min(rows - 2, Math.floor(rows * 0.92)));
    this.split = width >= 100;

    const innerWidth = Math.max(1, width - 2);
    const allCommitHeader = this.commit
      ? this.commitHeaderLines(innerWidth)
      : [];
    const commitHeader = allCommitHeader.slice(0, Math.max(0, maxHeight - 5));

    if (maxHeight < 5) {
      const compact = [padTo(this.titleLine(innerWidth), innerWidth)];
      if (maxHeight > 2)
        compact.push(padTo(this.metaLine(innerWidth), innerWidth));
      while (compact.length < maxHeight - 1)
        compact.push(" ".repeat(innerWidth));
      if (maxHeight > 1)
        compact.push(padTo(this.footerLine(innerWidth), innerWidth));
      return this.frame(compact, width);
    }

    const chrome = 2 + commitHeader.length + 3;
    this.bodyHeight = Math.max(0, maxHeight - chrome);

    const lines: string[] = [];
    lines.push(padTo(this.titleLine(innerWidth), innerWidth));
    for (const line of commitHeader) lines.push(padTo(line, innerWidth));
    lines.push(padTo(this.metaLine(innerWidth), innerWidth));
    lines.push(this.theme.fg("borderMuted", "─".repeat(innerWidth)));

    if (this.bodyHeight === 0) {
    } else if (this.files.length === 0) {
      lines.push(
        padTo(this.theme.fg("warning", "  No changed files."), innerWidth),
      );
    } else if (this.split) {
      lines.push(...this.renderSplit(innerWidth, this.bodyHeight));
    } else if (this.pane === "files") {
      lines.push(...this.renderFilePane(innerWidth, this.bodyHeight, true));
    } else {
      lines.push(...this.renderDiffPane(innerWidth, this.bodyHeight, true));
    }

    while (lines.length < maxHeight - 2) lines.push(" ".repeat(innerWidth));
    lines.push(this.theme.fg("borderMuted", "─".repeat(innerWidth)));
    lines.push(padTo(this.footerLine(innerWidth), innerWidth));

    const framed = this.frame(lines, width);
    this.cachedWidth = width;
    this.cachedRows = rows;
    this.cachedLines = framed;
    return framed;
  }

  private handleFilesInput(data: string): void {
    const kb = this.keybindings;
    if (this.files.length === 0) return;

    if (kb.matches(data, "tui.select.up") || data === "k") {
      this.moveFile(-1);
      return;
    }
    if (kb.matches(data, "tui.select.down") || data === "j") {
      this.moveFile(1);
      return;
    }
    if (
      kb.matches(data, "tui.select.pageUp") ||
      matchesKey(data, Key.pageUp) ||
      (!this.split && matchesKey(data, Key.left))
    ) {
      this.moveFile(-Math.max(1, this.paneInnerHeight() - 1));
      return;
    }
    if (
      kb.matches(data, "tui.select.pageDown") ||
      matchesKey(data, Key.pageDown) ||
      data === " " ||
      (!this.split && matchesKey(data, Key.right))
    ) {
      this.moveFile(Math.max(1, this.paneInnerHeight() - 1));
      return;
    }
    if (matchesKey(data, Key.home) || data === "g") {
      this.fileIndex = 0;
      this.ensureFileVisible();
      void this.loadSelected();
      return;
    }
    if (matchesKey(data, Key.end) || data === "G") {
      this.fileIndex = this.files.length - 1;
      this.ensureFileVisible();
      void this.loadSelected();
      return;
    }
    if (kb.matches(data, "tui.select.confirm") || data === "o") {
      this.pane = "diff";
      this.redraw();
    }
  }

  private handleDiffInput(data: string): void {
    const kb = this.keybindings;
    if (kb.matches(data, "tui.select.up") || data === "k") {
      this.scrollDiff(-1);
      return;
    }
    if (kb.matches(data, "tui.select.down") || data === "j") {
      this.scrollDiff(1);
      return;
    }
    if (
      kb.matches(data, "tui.select.pageUp") ||
      matchesKey(data, Key.pageUp) ||
      matchesKey(data, Key.left)
    ) {
      this.scrollDiff(-Math.max(1, this.paneInnerHeight() - 1));
      return;
    }
    if (
      kb.matches(data, "tui.select.pageDown") ||
      matchesKey(data, Key.pageDown) ||
      matchesKey(data, Key.right) ||
      data === " "
    ) {
      this.scrollDiff(Math.max(1, this.paneInnerHeight() - 1));
      return;
    }
    if (matchesKey(data, Key.home) || data === "g") {
      this.diffScroll = 0;
      this.redraw();
      return;
    }
    if (matchesKey(data, Key.end) || data === "G") {
      this.diffScroll = Math.max(
        0,
        this.diffLines.length - this.paneInnerHeight(),
      );
      this.redraw();
      return;
    }
    if (data === "[" || data === "p") {
      this.moveFile(-1);
      return;
    }
    if (data === "]" || data === "n") {
      this.moveFile(1);
    }
  }

  private moveFile(delta: number): void {
    if (this.files.length === 0) return;
    const next = Math.max(
      0,
      Math.min(this.files.length - 1, this.fileIndex + delta),
    );
    if (next === this.fileIndex && delta !== 0) return;
    this.fileIndex = next;
    this.ensureFileVisible();
    void this.loadSelected();
  }

  private paneInnerHeight(): number {
    return Math.max(1, this.bodyHeight - 2);
  }

  private ensureFileVisible(visibleRows = this.paneInnerHeight()): void {
    const visible = Math.max(1, visibleRows);
    const rowIndex = this.treeRows.findIndex(
      (row) => row.kind === "file" && row.fileIndex === this.fileIndex,
    );
    if (rowIndex < 0) return;
    if (rowIndex < this.fileWindow) this.fileWindow = rowIndex;
    if (rowIndex >= this.fileWindow + visible)
      this.fileWindow = rowIndex - visible + 1;
    const maxWindow = Math.max(0, this.treeRows.length - visible);
    this.fileWindow = Math.max(0, Math.min(this.fileWindow, maxWindow));
  }

  private scrollDiff(delta: number): void {
    const maxScroll = Math.max(
      0,
      this.diffLines.length - this.paneInnerHeight(),
    );
    this.diffScroll = Math.max(0, Math.min(maxScroll, this.diffScroll + delta));
    this.redraw();
  }

  private async loadSelected(initial = false): Promise<void> {
    const file = this.files[this.fileIndex];
    if (!file) {
      this.diffLines = [{ text: this.theme.fg("dim", "No file selected.") }];
      this.rowCache.clear();
      this.diffMeta = undefined;
      this.redraw();
      return;
    }

    const cached = this.cache.get(file.path);
    if (cached) {
      this.loadToken += 1;
      this.loading = false;
      this.applyDiff(cached, file.path);
      this.redraw();
      void this.prefetchNeighbors();
      return;
    }

    const token = ++this.loadToken;
    this.loading = true;
    if (!initial) this.redraw();

    const result = await loadFileDiff(this.git, this.scope, file, {
      root: this.root,
    });
    if (token !== this.loadToken) return;

    this.cache.set(file.path, result);
    this.loading = false;
    this.applyDiff(result, file.path);
    this.redraw();
    void this.prefetchNeighbors();
  }

  private async prefetchNeighbors(): Promise<void> {
    const token = this.loadToken;
    const indices = [this.fileIndex - 1, this.fileIndex + 1];
    for (const index of indices) {
      const file = this.files[index];
      if (!file || this.cache.has(file.path)) continue;
      const result = await loadFileDiff(this.git, this.scope, file, {
        root: this.root,
      });
      if (token !== this.loadToken) return;
      if (!this.cache.has(file.path)) this.cache.set(file.path, result);
      if (result.kind === "text" && !this.renderedCache.has(file.path)) {
        this.renderedCache.set(
          file.path,
          renderDiffColored(this.theme, result.diff, file.path),
        );
      }
    }
  }

  private applyDiff(
    result: FileDiff,
    filePath: string,
    resetScroll = true,
  ): void {
    this.diffMeta = result;
    this.rowCache.clear();

    if (result.kind === "text") {
      let colored = this.renderedCache.get(filePath);
      if (!colored) {
        colored = renderDiffColored(this.theme, result.diff, filePath);
        this.renderedCache.set(filePath, colored);
      }
      const lines = [...colored];
      if (result.truncated) {
        lines.push({
          text: this.theme.fg(
            "warning",
            `… truncated after ${result.diff.split("\n").length} lines`,
          ),
        });
      }
      this.diffLines = lines;
      const listHeight = this.paneInnerHeight();
      const maxScroll = Math.max(0, this.diffLines.length - listHeight);
      const target = resetScroll
        ? (result.firstChangeIndex ?? 0)
        : this.diffScroll;
      this.diffScroll = Math.max(0, Math.min(maxScroll, target));
      return;
    }

    if (resetScroll) this.diffScroll = 0;
    this.diffLines = [
      {
        text: this.theme.fg(
          result.kind === "error" ? "error" : "dim",
          result.message,
        ),
      },
    ];
  }

  private async refresh(): Promise<void> {
    if (!scopeIsLive(this.scope)) {
      this.showFlash("history is fixed · nothing to refresh");
      return;
    }
    if (this.refreshing) return;

    this.refreshing = true;
    this.showFlash("refreshing…");

    try {
      const previousPath = this.files[this.fileIndex]?.path;
      const files = await listChangedFiles(this.git, this.scope, {
        cwd: this.root,
      });
      this.files = files;
      this.treeRows = buildFileTree(files);
      this.cache.clear();
      this.renderedCache.clear();
      this.loadToken += 1;

      if (files.length === 0) {
        this.fileIndex = 0;
        this.fileWindow = 0;
        this.treeRows = [];
        this.diffMeta = undefined;
        this.diffLines = [{ text: this.theme.fg("dim", "No changed files.") }];
        this.rowCache.clear();
        this.diffScroll = 0;
        this.showFlash("refreshed · clean");
        return;
      }

      const kept = previousPath
        ? files.findIndex((file) => file.path === previousPath)
        : -1;
      this.fileIndex = kept >= 0 ? kept : 0;
      this.ensureFileVisible();
      this.showFlash(
        `refreshed · ${files.length} file${files.length === 1 ? "" : "s"}`,
      );
      await this.loadSelected();
    } catch (error) {
      this.showFlash(error instanceof Error ? error.message : String(error));
    } finally {
      this.refreshing = false;
      this.redraw();
    }
  }

  private async copySelectedPath(): Promise<void> {
    const file = this.files[this.fileIndex];
    if (!file) {
      this.showFlash("no file to copy");
      return;
    }
    const absolute = path.join(this.root, file.path);
    try {
      await copyToClipboard(absolute);
      this.showFlash(`copied ${file.path}`);
    } catch (error) {
      this.showFlash(error instanceof Error ? error.message : "copy failed");
    }
  }

  private async copyCommitSha(): Promise<void> {
    const sha = this.commit?.sha;
    if (!sha) {
      const file = this.files[this.fileIndex];
      if (!file) {
        this.showFlash("no sha to copy");
        return;
      }
      try {
        await copyToClipboard(file.path);
        this.showFlash(`copied ${file.path}`);
      } catch (error) {
        this.showFlash(error instanceof Error ? error.message : "copy failed");
      }
      return;
    }
    try {
      await copyToClipboard(sha);
      this.showFlash(`copied ${sha.slice(0, 7)}`);
    } catch (error) {
      this.showFlash(error instanceof Error ? error.message : "copy failed");
    }
  }

  private showFlash(text: string): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flash = { text, until: Date.now() + 2200 };
    this.redraw();
    this.flashTimer = setTimeout(() => {
      this.flash = undefined;
      this.redraw();
    }, 2200);
  }

  private redraw(): void {
    this.invalidateRender();
    this.tui.requestRender();
  }

  private titleLine(width: number): string {
    const label = this.commit ? this.commit.shortSha : scopeLabel(this.scope);
    const count = `${this.files.length} file${this.files.length === 1 ? "" : "s"}`;
    const text = ` Git · ${label} · ${count} `;
    return truncateToWidth(
      this.theme.fg("accent", this.theme.bold(text.trim())),
      width,
    );
  }

  private metaLine(width: number): string {
    const file = this.files[this.fileIndex];
    if (!file) return this.theme.fg("dim", "No files");

    const status = paintStatus(this.theme, file.status);
    const pathText = file.from ? `${file.from} → ${file.path}` : file.path;
    const stats =
      this.diffMeta?.kind === "text"
        ? this.theme.fg("success", `+${this.diffMeta.additions}`) +
          this.theme.fg("muted", "/") +
          this.theme.fg("error", `-${this.diffMeta.deletions}`)
        : this.loading
          ? this.theme.fg("dim", "loading…")
          : "";

    const left = `${status} ${this.theme.fg("text", pathText)}`;
    const line = stats ? `${left}  ${stats}` : left;
    return truncateToWidth(line, width);
  }

  private commitHeaderLines(width: number): string[] {
    const c = this.commit!;
    const lines: string[] = [];

    const meta =
      this.theme.fg("text", c.author) +
      this.theme.fg("dim", " · ") +
      this.theme.fg("dim", c.date);
    lines.push(truncateToWidth(meta, width));

    const subject = wrapTextWithAnsi(c.title, width).slice(0, 2);
    for (const line of subject) {
      lines.push(this.theme.fg("text", this.theme.bold(line)));
    }

    const body = c.body.trim();
    if (!body) return lines;

    const wrapped = wrapTextWithAnsi(body, width);
    const shown = wrapped.slice(0, COMMIT_BODY_MAX_LINES);
    if (wrapped.length > COMMIT_BODY_MAX_LINES) {
      const last = shown.length - 1;
      shown[last] =
        truncateToWidth(shown[last] ?? "", Math.max(1, width - 1), "") + "…";
    }
    for (const line of shown) {
      lines.push(this.theme.fg("muted", line));
    }
    return lines;
  }

  private footerLine(width: number): string {
    if (this.flash && Date.now() < this.flash.until) {
      return truncateToWidth(
        this.theme.fg("accent", ` ${this.flash.text}`),
        width,
      );
    }

    const chips =
      this.tabChip("files", this.pane === "files") +
      this.theme.fg("dim", " ") +
      this.tabChip("diff", this.pane === "diff");

    let tail = "";
    if (this.files.length > 0) {
      tail += ` · ${this.fileIndex + 1}/${this.files.length}`;
    }
    if (this.diffLines.length > this.paneInnerHeight()) {
      const start = Math.min(this.diffLines.length, this.diffScroll + 1);
      const end = Math.min(
        this.diffLines.length,
        this.diffScroll + this.paneInnerHeight(),
      );
      tail += ` · lines ${start}-${end}/${this.diffLines.length}`;
    }

    const budget = width - visibleWidth(chips) - visibleWidth(tail);
    const hintTiers = [
      ` · tab pane · ${keyHint("tui.select.up", "up")}/${keyHint("tui.select.down", "down")}/jk · ←→/hl · [/] file · y path · Y sha · r refresh · ${keyHint("tui.select.cancel", "back")}`,
      ` · tab pane · ↑↓/jk · [/] file · ${keyHint("tui.select.cancel", "back")}`,
      ` · ${keyHint("tui.select.cancel", "back")}`,
      "",
    ];
    const hints = hintTiers.find((tier) => visibleWidth(tier) <= budget) ?? "";
    return truncateToWidth(chips + this.theme.fg("dim", hints + tail), width);
  }

  private tabChip(label: string, active: boolean): string {
    if (active) {
      return (
        this.theme.fg("borderAccent", "[") +
        this.theme.fg("accent", this.theme.bold(` ${label} `)) +
        this.theme.fg("borderAccent", "]")
      );
    }
    return this.theme.fg("dim", `  ${label}  `);
  }

  private renderSplit(width: number, height: number): string[] {
    const gap = 1;
    const leftWidth = Math.max(24, Math.min(42, Math.floor(width * 0.34)));
    const rightWidth = Math.max(20, width - leftWidth - gap);
    const left = this.renderFilePane(leftWidth, height, this.pane === "files");
    const right = this.renderDiffPane(rightWidth, height, this.pane === "diff");

    const lines: string[] = [];
    for (let i = 0; i < height; i += 1) {
      const l = left[i] ?? " ".repeat(leftWidth);
      const r = right[i] ?? " ".repeat(rightWidth);
      lines.push(l + " ".repeat(gap) + r);
    }
    return lines;
  }

  private renderFilePane(
    width: number,
    height: number,
    focused: boolean,
  ): string[] {
    const innerW = Math.max(1, width - 2);
    const listHeight = Math.max(1, height - 2);
    this.ensureFileVisible(listHeight);
    const start = this.fileWindow;
    const end = Math.min(this.treeRows.length, start + listHeight);

    const body: string[] = [];
    for (let i = start; i < end; i += 1) {
      const row = this.treeRows[i]!;
      const branch = treeRowPrefix(row);
      if (row.kind === "dir") {
        const label = this.theme.fg("dim", `${branch}${row.name}/`);
        body.push(truncateToWidth(`  ${label}`, innerW));
        continue;
      }
      const selected = row.fileIndex === this.fileIndex;
      const mark = selected ? this.theme.fg("accent", "→ ") : "  ";
      const status = paintStatus(this.theme, row.file.status);
      const name = selected
        ? this.theme.fg("accent", this.theme.bold(row.name))
        : this.theme.fg("text", row.name);
      const tree = this.theme.fg("dim", branch);
      body.push(truncateToWidth(`${mark}${tree}${status} ${name}`, innerW));
    }
    return this.framePane(width, height, focused, "Files", "", body);
  }

  private renderDiffPane(
    width: number,
    height: number,
    focused: boolean,
  ): string[] {
    const innerW = Math.max(1, width - 2);
    const listHeight = Math.max(1, height - 2);
    const maxScroll = Math.max(0, this.diffLines.length - listHeight);
    this.diffScroll = Math.max(0, Math.min(this.diffScroll, maxScroll));
    const slice = this.diffLines.slice(
      this.diffScroll,
      this.diffScroll + listHeight,
    );

    const file = this.files[this.fileIndex];
    const name = file
      ? this.theme.fg(
          "dim",
          truncateToWidth(path.basename(file.path), Math.max(6, innerW - 24)),
        )
      : "";
    const stats =
      this.diffMeta?.kind === "text"
        ? this.theme.fg(
            "dim",
            ` ${shortStatus(file?.status ?? "M")} +${this.diffMeta.additions}/-${this.diffMeta.deletions}`,
          )
        : this.loading
          ? this.theme.fg("dim", " …")
          : "";

    if (this.rowCacheWidth !== innerW) {
      this.rowCache.clear();
      this.rowCacheWidth = innerW;
    }
    const body: string[] = [];
    for (let i = 0; i < slice.length; i += 1) {
      const index = this.diffScroll + i;
      let row = this.rowCache.get(index);
      if (row === undefined) {
        const line = slice[i];
        row = padVisible(line?.text ?? "", innerW);
        if (line?.background) {
          row =
            NIGHT_OWL_DIFF_BACKGROUND[line.background] +
            row +
            NIGHT_OWL_DIFF_BACKGROUND.reset;
        }
        this.rowCache.set(index, row);
      }
      body.push(row);
    }
    const scrollbar =
      this.diffLines.length > listHeight
        ? diffScrollbar(
            this.diffLines.length,
            listHeight,
            this.diffScroll,
            listHeight,
          )
        : undefined;
    return this.framePane(
      width,
      height,
      focused,
      "Diff",
      name + stats,
      body,
      scrollbar,
      true,
    );
  }

  private framePane(
    width: number,
    height: number,
    focused: boolean,
    label: string,
    extraHeader: string,
    body: string[],
    rightEdge?: string[],
    prePadded = false,
  ): string[] {
    const edge = (text: string) =>
      this.theme.fg(focused ? "borderAccent" : "borderMuted", text);
    const innerW = Math.max(1, width - 2);
    const innerH = Math.max(0, height - 2);

    const title = focused
      ? this.theme.fg("accent", this.theme.bold(` ${label} `))
      : this.theme.fg("dim", ` ${label} `);
    const head = title + extraHeader;
    const fill = Math.max(0, innerW - visibleWidth(head));
    const top = edge("┌") + head + edge("─".repeat(fill)) + edge("┐");

    const lines: string[] = [truncateToWidth(top, width)];
    for (let i = 0; i < innerH; i += 1) {
      const row = prePadded
        ? (body[i] ?? " ".repeat(innerW))
        : padVisible(body[i] ?? "", innerW);
      lines.push(edge("│") + row + edge(rightEdge?.[i] ?? "│"));
    }
    if (height >= 2) {
      lines.push(edge("└" + "─".repeat(innerW) + "┘"));
    }
    return lines.slice(0, height);
  }

  private frame(lines: string[], width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const color = (text: string) => this.theme.fg("borderMuted", text);
    const top = color(`┌${"─".repeat(innerWidth)}┐`);
    const bottom = color(`└${"─".repeat(innerWidth)}┘`);
    return [
      top,
      ...lines.map((line) => color("│") + line + color("│")),
      bottom,
    ];
  }
}

function padVisible(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  const pad = Math.max(0, width - visibleWidth(truncated));
  return truncated + " ".repeat(pad);
}

function padTo(text: string, width: number): string {
  const fitted = truncateToWidth(text, width, "");
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}


type GitStart = { kind: "menu" } | { kind: "uncommitted" } | { kind: "commit" };

type CommitRow = {
  sha: string;
  shortSha: string;
  title: string;
  author: string;
  date: string;
};

const COMMIT_ROW_MAX_WIDTH = 100;

function formatCommitRow(commit: CommitRow, maxWidth: number): string {
  const width = Math.min(maxWidth, COMMIT_ROW_MAX_WIDTH);
  const left = `${commit.shortSha}  `;
  const leftW = visibleWidth(left);
  if (width <= leftW) return truncateToWidth(commit.shortSha, width, "…");

  const titleBudgetFloor = 10;
  const fullMeta = `${commit.date} · ${commit.author}`;
  const authorOnly = commit.author;
  const sepW = 2;

  const pack = (titleBudget: number, meta: string): string => {
    const title = truncateToWidth(commit.title, Math.max(0, titleBudget), "…");
    const titleW = visibleWidth(title);
    const metaW = visibleWidth(meta);
    const pad = Math.max(sepW, width - leftW - titleW - metaW);
    return left + title + " ".repeat(pad) + meta;
  };

  for (const meta of [fullMeta, authorOnly]) {
    const metaW = visibleWidth(meta);
    if (metaW === 0) continue;
    const titleBudget = width - leftW - sepW - metaW;
    if (titleBudget >= titleBudgetFloor) return pack(titleBudget, meta);
  }

  return truncateToWidth(left + commit.title, width, "…");
}

class GitApp implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly git: Git;
  private readonly cwd: string;
  private readonly exit: () => void;

  private stack: Screen[] = [];
  private root?: string;

  private commits: CommitRow[] = [];
  private commitsLoaded = false;

  private content: Component = new Text("");
  private viewer: GitViewer | undefined;
  private closed = false;
  private _focused = false;

  constructor(options: {
    tui: TUI;
    theme: Theme;
    keybindings: KeybindingsManager;
    git: Git;
    cwd: string;
    start: GitStart;
    done: () => void;
  }) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.keybindings = options.keybindings;
    this.git = options.git;
    this.cwd = options.cwd;
    this.exit = options.done;
    void this.boot(options.start);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    const content = this.content as Component & Partial<Focusable>;
    if ("focused" in content) content.focused = value;
  }

  private focusContent(): void {
    const content = this.content as Component & Partial<Focusable>;
    if ("focused" in content) content.focused = this._focused;
  }

  invalidate(): void {
    this.content.invalidate();
    this.viewer?.invalidate();
  }

  render(width: number): string[] {
    if (this.viewer) return this.viewer.render(width);
    return this.content.render(width);
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.viewer) {
      this.viewer.handleInput(data);
      return;
    }
    this.content.handleInput?.(data);
  }

  private async boot(start: GitStart): Promise<void> {
    this.showLoading("Opening git…");
    try {
      if (this.closed) return;
      if (!(await this.git.isRepository({ cwd: this.cwd }))) {
        this.failAndExit("Not a git repository");
        return;
      }
      this.root = (await this.git.root({ cwd: this.cwd })) ?? this.cwd;
      await this.enterStart(start);
    } catch (error) {
      this.failAndExit(errorText(error));
    }
  }

  private async enterStart(start: GitStart): Promise<void> {
    switch (start.kind) {
      case "menu":
        this.push({ type: "menu" });
        return;
      case "uncommitted":
        await this.openViewer({ kind: "uncommitted" });
        return;
      case "commit":
        await this.openCommits();
        return;
    }
  }

  private push(screen: Screen): void {
    this.teardownViewer();
    this.stack.push(screen);
    this.paint(screen);
  }

  private replaceTop(screen: Screen): void {
    this.teardownViewer();
    if (this.stack.length === 0) this.stack.push(screen);
    else this.stack[this.stack.length - 1] = screen;
    this.paint(screen);
  }

  private pop(): void {
    if (this.closed) return;
    this.teardownViewer();
    this.stack.pop();
    const top = this.stack[this.stack.length - 1];
    if (!top) {
      this.close();
      return;
    }
    this.paint(top);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardownViewer();
    this.exit();
  }

  private failAndExit(message: string): void {
    this.teardownViewer();
    this.stack = [];
    const body = this.messageScreen(
      " Git",
      message,
      "error",
      keyHint("tui.select.cancel", "close"),
    );
    this.content = {
      render: (width) => body.render(width),
      invalidate: () => body.invalidate(),
      handleInput: (data: string) => {
        if (this.keybindings.matches(data, "tui.select.cancel")) this.close();
      },
    };
    this.focusContent();
    this.tui.requestRender();
  }

  private paint(screen: Screen): void {
    switch (screen.type) {
      case "menu":
        this.content = this.buildMenu();
        break;
      case "commits":
        this.content = this.buildCommitList(screen.selected);
        break;
      case "loading":
        this.content = this.messageScreen(" Git", screen.label, "dim");
        break;
      case "message":
        this.content = this.messageScreen(" Git", screen.text, screen.level);
        break;
      case "viewer":
        break;
    }
    this.focusContent();
    this.tui.requestRender();
  }

  private showLoading(label: string): void {
    this.teardownViewer();
    this.content = this.messageScreen(" Git", label, "dim");
    this.focusContent();
    this.tui.requestRender();
  }

  private messageScreen(
    title: string,
    body: string,
    level: "dim" | "error" | "warning" | "text",
    hint = keyHint("tui.select.cancel", "back"),
  ): Component {
    const container = new Container();
    container.addChild(
      new DynamicBorder((text) => this.theme.fg("accent", text)),
    );
    const titleText = new Text(this.theme.fg("accent", this.theme.bold(title)));
    container.addChild(titleText);
    container.addChild(new Spacer(1));
    const bodyText = new Text(
      this.theme.fg(level === "text" ? "text" : level, `  ${body}`),
    );
    container.addChild(bodyText);
    container.addChild(new Spacer(1));
    const hintText = new Text(this.theme.fg("dim", hint));
    container.addChild(hintText);
    container.addChild(
      new DynamicBorder((text) => this.theme.fg("accent", text)),
    );
    const component = {
      render: (width: number) => container.render(width),
      invalidate: () => {
        titleText.setText(this.theme.fg("accent", this.theme.bold(title)));
        bodyText.setText(
          this.theme.fg(level === "text" ? "text" : level, `  ${body}`),
        );
        hintText.setText(this.theme.fg("dim", hint));
        container.invalidate();
      },
      handleInput: (data: string) => {
        if (this.keybindings.matches(data, "tui.select.cancel"))
          this.popOrCloseFromMessage();
      },
    };
    return component;
  }

  private popOrCloseFromMessage(): void {
    if (this.stack.length > 0) this.pop();
    else this.close();
  }


  private buildMenu(): Component {
    const items: SelectItem[] = [
      {
        value: "uncommitted",
        label: "Uncommitted changes",
        description: "local diff · HEAD vs worktree",
      },
      {
        value: "commit",
        label: "Commit history",
        description: "browse commits and their diffs",
      },
    ];
    return this.buildList({
      title: " Git",
      items,
      hint: `${keyHint("tui.select.confirm", "open")} · ${keyHint("tui.select.cancel", "cancel")}`,
      filter: false,
      maxRows: 4,
      onSelect: (value) => {
        void this.onMenuSelect(value);
      },
      onCancel: () => this.close(),
    });
  }

  private async onMenuSelect(value: string): Promise<void> {
    switch (value) {
      case "uncommitted":
        await this.openViewer({ kind: "uncommitted" });
        return;
      case "commit":
        await this.openCommits();
        return;
    }
  }


  private async openCommits(selected?: string): Promise<void> {
    if (!this.commitsLoaded) {
      this.showLoading("Loading commits…");
      try {
        this.commits = await loadRecentCommits(this.git, COMMIT_LIMIT, {
          cwd: this.root,
        });
        if (this.closed) return;
        this.commitsLoaded = true;
      } catch (error) {
        if (this.closed) return;
        this.push({ type: "message", text: errorText(error), level: "error" });
        return;
      }
    }

    if (this.closed) return;
    if (this.commits.length === 0) {
      this.push({
        type: "message",
        text: "No commits found",
        level: "warning",
      });
      return;
    }

    const top = this.stack[this.stack.length - 1];
    if (top?.type === "commits") {
      this.replaceTop({ type: "commits", selected: selected ?? top.selected });
    } else {
      this.push({ type: "commits", selected });
    }
  }

  private buildCommitList(selected?: string): Component {
    const bySha = new Map(this.commits.map((commit) => [commit.sha, commit]));
    const items: SelectItem[] = this.commits.map((commit) => ({
      value: commit.sha,
      label: `${commit.shortSha}  ${commit.title}  ${commit.date} · ${commit.author}`,
    }));
    return this.buildList({
      title: ` Commits (last ${this.commits.length})`,
      items,
      selected,
      hint: `Type to filter · ${keyHint("tui.select.confirm", "open")} · ${keyHint("tui.select.cancel", "back")}`,
      filter: true,
      maxRows: 14,
      layout: {
        minPrimaryColumnWidth: 20,
        maxPrimaryColumnWidth: COMMIT_ROW_MAX_WIDTH,
        truncatePrimary: ({ item, maxWidth }) => {
          const commit = bySha.get(item.value);
          return commit
            ? formatCommitRow(commit, maxWidth)
            : truncateToWidth(item.label, maxWidth, "…");
        },
      },
      emptyText: "  No matching commits",
      onSelect: (sha) => {
        const commit = this.commits.find((entry) => entry.sha === sha);
        if (!commit) return;
        const top = this.stack[this.stack.length - 1];
        if (top?.type === "commits") top.selected = sha;
        void this.openViewer({
          kind: "commit",
          sha: commit.sha,
          title: commit.title,
        });
      },
      onCancel: () => this.pop(),
    });
  }


  private async openViewer(scope: GitScope): Promise<void> {
    this.showLoading(`Loading ${scopeLabel(scope)}…`);
    try {
      const root = this.root ?? this.cwd;
      const files = await listChangedFiles(this.git, scope, { cwd: root });
      if (this.closed) return;
      const commit =
        scope.kind === "commit"
          ? await loadCommitInfo(this.git, scope.sha, { cwd: root })
          : undefined;
      if (this.closed) return;

      if (files.length === 0 && scope.kind !== "commit") {
        this.push({
          type: "message",
          text: `No changes · ${scopeLabel(scope)}`,
          level: "warning",
        });
        return;
      }

      this.teardownViewer();
      this.stack.push({ type: "viewer", scope });
      this.viewer = new GitViewer({
        tui: this.tui,
        theme: this.theme,
        keybindings: this.keybindings,
        git: this.git,
        root,
        scope,
        files,
        commit,
        done: () => this.pop(),
      });
      this.tui.requestRender();
    } catch (error) {
      this.push({ type: "message", text: errorText(error), level: "error" });
    }
  }

  private teardownViewer(): void {
    this.viewer?.dispose?.();
    this.viewer = undefined;
  }


  private buildList(options: {
    title: string;
    items: SelectItem[];
    hint: string;
    filter?: boolean;
    selected?: string;
    maxRows?: number;
    emptyText?: string;
    layout?: SelectListLayoutOptions;
    onSelect: (value: string) => void;
    onCancel: () => void;
  }): Component {
    const theme = this.theme;
    const keybindings = this.keybindings;
    const maxRows = options.maxRows ?? 10;
    const emptyText = options.emptyText ?? "  No matches";

    const container = new Container();
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    const title = new Text(theme.fg("accent", theme.bold(options.title)));
    container.addChild(title);

    const search = options.filter ? new Input() : undefined;
    if (search) {
      container.addChild(search);
      container.addChild(new Spacer(1));
    }

    const listContainer = new Container();
    container.addChild(listContainer);
    const hint = new Text(theme.fg("dim", options.hint));
    container.addChild(hint);
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

    let list: SelectList | null = null;
    let filtered = options.items;

    const updateList = () => {
      listContainer.clear();
      if (filtered.length === 0) {
        listContainer.addChild(new Text(theme.fg("warning", emptyText)));
        list = null;
        return;
      }
      list = new SelectList(
        filtered,
        Math.min(filtered.length, maxRows),
        selectListTheme(theme),
        options.layout,
      );
      if (options.selected) {
        const index = filtered.findIndex(
          (item) => item.value === options.selected,
        );
        if (index >= 0) list.setSelectedIndex(index);
      }
      list.onSelect = (item) => options.onSelect(item.value);
      list.onCancel = () => options.onCancel();
      listContainer.addChild(list);
    };

    const applyFilter = () => {
      const query = search?.getValue() ?? "";
      filtered = query
        ? fuzzyFilter(
            options.items,
            query,
            (item) => `${item.label} ${item.value} ${item.description ?? ""}`,
          )
        : options.items;
      updateList();
    };

    applyFilter();

    const component = {
      render: (width: number) => container.render(width),
      invalidate: () => {
        title.setText(theme.fg("accent", theme.bold(options.title)));
        hint.setText(theme.fg("dim", options.hint));
        applyFilter();
        container.invalidate();
      },
      handleInput: (data: string) => {
        const navigating =
          keybindings.matches(data, "tui.select.up") ||
          keybindings.matches(data, "tui.select.down") ||
          keybindings.matches(data, "tui.select.confirm") ||
          keybindings.matches(data, "tui.select.cancel");

        if (!search || navigating) {
          if (list) list.handleInput(data);
          else if (keybindings.matches(data, "tui.select.cancel"))
            options.onCancel();
          this.tui.requestRender();
          return;
        }

        search.handleInput(data);
        applyFilter();
        this.tui.requestRender();
      },
    };
    Object.defineProperty(component, "focused", {
      get: () => search?.focused ?? false,
      set: (value: boolean) => {
        if (search) search.focused = value;
      },
      enumerable: true,
    });
    return component as Component & Focusable;
  }
}

type Screen =
  | { type: "menu" }
  | { type: "commits"; selected?: string }
  | { type: "viewer"; scope: GitScope }
  | { type: "loading"; label: string }
  | { type: "message"; text: string; level: "error" | "warning" | "text" };



function usage(): string {
  return [
    "Usage: /git [uncommitted|commit]",
    "  (none) menu · u uncommitted · c history",
  ].join("\n");
}

function parseStart(args: string): GitStart | "help" {
  const raw = args.trim();
  if (!raw) return { kind: "menu" };

  const head = raw.split(/\s+/).filter(Boolean)[0]?.toLowerCase() ?? "";
  if (head === "help" || head === "-h" || head === "--help") return "help";
  if (head === "uncommitted" || head === "all" || head === "u")
    return { kind: "uncommitted" };
  if (head === "commit" || head === "log" || head === "history" || head === "c")
    return { kind: "commit" };
  return "help";
}

async function runGit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext | ExtensionContext,
  args = "",
): Promise<void> {
  if (!ctx.hasUI) {
    notify(ctx, "Git viewer needs interactive mode", "error");
    return;
  }

  const start = parseStart(args);
  if (start === "help") {
    notify(ctx, usage(), "info");
    return;
  }

  if (ctx.mode !== "tui") {
    const git = gitFor(pi);
    if (!(await git.isRepository({ cwd: ctx.cwd }))) {
      notify(ctx, "Not a git repository", "error");
      return;
    }
    notify(ctx, usage(), "info");
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new GitApp({
        tui,
        theme,
        keybindings,
        git: gitFor(pi),
        cwd: ctx.cwd,
        start,
        done: () => done(),
      }),
  );
}

export default function gitExtension(pi: ExtensionAPI): void {
  pi.registerCommand("git", {
    description: "Browse uncommitted diffs and commit history",
    handler: async (args, ctx) => {
      await runGit(pi, ctx, args);
    },
  });

  pi.registerShortcut("ctrl+shift+g", {
    description: "Open uncommitted diffs and commit history",
    handler: async (ctx) => {
      await runGit(pi, ctx);
    },
  });
}
