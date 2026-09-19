/** one parsed file action */
export type PatchAction = AddAction | DeleteAction | UpdateAction;

/** an action that creates one file */
export interface AddAction {
	kind: "add";
	path: string;
	content: string;
}

/** an action that deletes one file */
export interface DeleteAction {
	kind: "delete";
	path: string;
}

/** an action that updates and optionally moves one file */
export interface UpdateAction {
	kind: "update";
	path: string;
	moveTo?: string;
	chunks: UpdateChunk[];
}

/** one exact-match update chunk */
export interface UpdateChunk {
	context?: string;
	lines: DiffLine[];
	endOfFile: boolean;
}

/** one line in an update chunk */
export interface DiffLine {
	kind: "context" | "add" | "delete";
	text: string;
}

/** a validated sequence of file actions */
export interface ParsedPatch {
	actions: PatchAction[];
}

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const END_OF_FILE = "*** End of File";

function normalizeInput(input: string): string[] {
	if (typeof input !== "string" || input.trim().length === 0) {
		throw new Error("apply_patch input must be a non-empty string");
	}
	return input.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim().split("\n");
}

function readPath(line: string, marker: string, lineNumber: number): string {
	const path = line.slice(marker.length).trim();
	if (!path) throw new Error(`Patch path is empty on line ${lineNumber}`);
	return path;
}

function isFileHeader(line: string): boolean {
	return line.startsWith(ADD_FILE) || line.startsWith(DELETE_FILE) || line.startsWith(UPDATE_FILE);
}

function parseDiffLine(line: string, lineNumber: number): DiffLine {
	const marker = line[0];
	if (marker === " ") return { kind: "context", text: line.slice(1) };
	if (marker === "+") return { kind: "add", text: line.slice(1) };
	if (marker === "-") return { kind: "delete", text: line.slice(1) };
	throw new Error(`Invalid update line ${lineNumber}: each line must start with ' ', '+', or '-'`);
}

function parseAdd(lines: string[], start: number): { action: AddAction; next: number } {
	const path = readPath(lines[start]!, ADD_FILE, start + 1);
	const content: string[] = [];
	let index = start + 1;
	while (index < lines.length && lines[index] !== END_PATCH && !isFileHeader(lines[index]!)) {
		const line = lines[index]!;
		if (!line.startsWith("+")) {
			throw new Error(`Invalid add line ${index + 1} for ${path}: each line must start with '+'`);
		}
		content.push(line.slice(1));
		index++;
	}
	if (content.length === 0) throw new Error(`Add File action has no content: ${path}`);
	return {
		action: { kind: "add", path, content: `${content.join("\n")}\n` },
		next: index,
	};
}

function parseDelete(lines: string[], start: number): { action: DeleteAction; next: number } {
	return {
		action: { kind: "delete", path: readPath(lines[start]!, DELETE_FILE, start + 1) },
		next: start + 1,
	};
}

function parseChunk(lines: string[], start: number, implicit: boolean): { chunk: UpdateChunk; next: number } {
	let index = start;
	let context: string | undefined;
	if (!implicit) {
		const header = lines[index]!;
		context = header === "@@" ? undefined : header.slice(2).trim();
		index++;
	}

	const diffLines: DiffLine[] = [];
	let endOfFile = false;
	while (index < lines.length) {
		const line = lines[index]!;
		if (line === END_PATCH || isFileHeader(line) || line === "@@" || line.startsWith("@@ ")) break;
		if (line === END_OF_FILE) {
			endOfFile = true;
			index++;
			break;
		}
		diffLines.push(parseDiffLine(line, index + 1));
		index++;
	}

	if (diffLines.length === 0) throw new Error(`Update hunk has no lines near line ${start + 1}`);
	if (!diffLines.some((line) => line.kind !== "context")) {
		throw new Error(`Update hunk has no changes near line ${start + 1}`);
	}
	return { chunk: { context, endOfFile, lines: diffLines }, next: index };
}

function parseUpdate(lines: string[], start: number): { action: UpdateAction; next: number } {
	const path = readPath(lines[start]!, UPDATE_FILE, start + 1);
	let index = start + 1;
	let moveTo: string | undefined;
	if (lines[index]?.startsWith(MOVE_TO)) {
		moveTo = readPath(lines[index]!, MOVE_TO, index + 1);
		index++;
	}

	const chunks: UpdateChunk[] = [];
	while (index < lines.length && lines[index] !== END_PATCH && !isFileHeader(lines[index]!)) {
		const line = lines[index]!;
		if (line.startsWith(MOVE_TO)) throw new Error(`Move target must immediately follow Update File: ${path}`);
		const explicit = line === "@@" || line.startsWith("@@ ");
		if (!explicit && chunks.length > 0) throw new Error(`Expected an update hunk header on line ${index + 1}`);
		const parsed = parseChunk(lines, index, !explicit);
		chunks.push(parsed.chunk);
		index = parsed.next;
	}

	if (chunks.length === 0 && !moveTo) throw new Error(`Update File action has no hunks: ${path}`);
	return { action: { kind: "update", path, moveTo, chunks }, next: index };
}

export function parsePatch(input: string): ParsedPatch {
	const lines = normalizeInput(input);
	if (lines[0]?.trim() !== BEGIN_PATCH) throw new Error(`The first line must be '${BEGIN_PATCH}'`);
	if (lines.at(-1)?.trim() !== END_PATCH) throw new Error(`The last line must be '${END_PATCH}'`);

	const actions: PatchAction[] = [];
	let index = 1;
	while (index < lines.length - 1) {
		const line = lines[index]!;
		let parsed: { action: PatchAction; next: number };
		if (line.startsWith(ADD_FILE)) parsed = parseAdd(lines, index);
		else if (line.startsWith(DELETE_FILE)) parsed = parseDelete(lines, index);
		else if (line.startsWith(UPDATE_FILE)) parsed = parseUpdate(lines, index);
		else throw new Error(`Expected a file action on line ${index + 1}`);
		actions.push(parsed.action);
		index = parsed.next;
	}

	if (actions.length === 0) throw new Error("Patch contains no file actions");
	return { actions };
}

export function summarizeAction(action: PatchAction): string {
	if (action.kind === "add") return `create ${action.path}`;
	if (action.kind === "delete") return `delete ${action.path}`;
	if (action.moveTo) return `update ${action.path} and move to ${action.moveTo}`;
	return `update ${action.path}`;
}
