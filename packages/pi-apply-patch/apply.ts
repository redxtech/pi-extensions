import { chmod, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import { resolveActions, type ResolvedAction } from "./paths.ts";
import { parsePatch, summarizeAction, type PatchAction, type UpdateChunk } from "./parser.ts";

/** serializes mutations that target the same canonical file */
export type MutationQueue = <T>(path: string, operation: () => Promise<T>) => Promise<T>;

/** controls one patch application */
export interface ApplyPatchOptions {
	cwd: string;
	allowAbsolutePaths: boolean;
	signal?: AbortSignal;
	queueMutation?: MutationQueue;
}

/** describes one applied file action */
export interface AppliedPatchFile {
	kind: PatchAction["kind"];
	path: string;
	absolutePath: string;
	moveTo?: string;
	absoluteMoveTo?: string;
}

/** reports the applied actions */
export interface ApplyPatchResult {
	files: AppliedPatchFile[];
	summary: string;
}

type FileState =
	| { kind: "absent" }
	| { kind: "file"; content: Buffer; mode: number }
	| { kind: "symlink"; target: string }
	| { kind: "other"; type: string };

interface TextFile {
	lines: string[];
	lineEnding: "\n" | "\r\n";
	trailingNewline: boolean;
}

function abortIfNeeded(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("apply_patch was cancelled");
}

async function readState(path: string): Promise<FileState> {
	let stats;
	try {
		stats = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
		throw error;
	}
	if (stats.isFile()) return { kind: "file", content: await readFile(path), mode: stats.mode & 0o777 };
	if (stats.isSymbolicLink()) return { kind: "symlink", target: await readlink(path) };
	return { kind: "other", type: stats.isDirectory() ? "directory" : "special file" };
}

function cloneState(state: FileState): FileState {
	if (state.kind === "file") return { ...state, content: Buffer.from(state.content) };
	return { ...state };
}

function decodeTextFile(state: Extract<FileState, { kind: "file" }>, path: string): TextFile {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(state.content);
	} catch {
		throw new Error(`Cannot update non-UTF-8 file: ${path}`);
	}
	if (/\r(?!\n)/.test(text)) {
		throw new Error(`Cannot update file with unsupported carriage returns: ${path}`);
	}
	const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
	const normalized = text.replaceAll("\r\n", "\n");
	const trailingNewline = normalized.endsWith("\n");
	const lines = normalized.length === 0 ? [] : normalized.split("\n");
	if (trailingNewline) lines.pop();
	return { lineEnding, lines, trailingNewline };
}

function encodeTextFile(file: TextFile): Buffer {
	const body = file.lines.join(file.lineEnding);
	return Buffer.from(file.trailingNewline ? `${body}${file.lineEnding}` : body, "utf8");
}

function findUniqueLine(lines: string[], expected: string, start: number, path: string): number {
	const matches: number[] = [];
	for (let index = start; index < lines.length; index++) {
		if (lines[index] === expected) matches.push(index);
	}
	if (matches.length === 0) throw new Error(`Patch context not found in ${path}: ${expected}`);
	if (matches.length > 1) throw new Error(`Patch context is ambiguous in ${path}: ${expected}`);
	return matches[0]!;
}

function findUniqueSequence(lines: string[], expected: string[], start: number, endOfFile: boolean, path: string): number {
	if (expected.length === 0) return endOfFile ? lines.length : start;
	const lastStart = lines.length - expected.length;
	if (lastStart < start) throw new Error(`Patch context not found in ${path}`);
	const matches: number[] = [];
	for (let index = start; index <= lastStart; index++) {
		if (endOfFile && index !== lastStart) continue;
		if (expected.every((line, offset) => lines[index + offset] === line)) matches.push(index);
	}
	if (matches.length === 0) throw new Error(`Patch context not found in ${path}:\n${expected.join("\n")}`);
	if (matches.length > 1) throw new Error(`Patch context is ambiguous in ${path}:\n${expected.join("\n")}`);
	return matches[0]!;
}

function applyChunk(file: TextFile, chunk: UpdateChunk, cursor: number, path: string): number {
	let searchStart = cursor;
	if (chunk.context !== undefined) searchStart = findUniqueLine(file.lines, chunk.context, cursor, path) + 1;
	const oldLines = chunk.lines.filter((line) => line.kind !== "add").map((line) => line.text);
	const newLines = chunk.lines.filter((line) => line.kind !== "delete").map((line) => line.text);
	const matchStart = oldLines.length === 0
		? chunk.context !== undefined ? searchStart : file.lines.length
		: findUniqueSequence(file.lines, oldLines, searchStart, chunk.endOfFile, path);
	if (chunk.endOfFile && matchStart + oldLines.length !== file.lines.length) {
		throw new Error(`End-of-file hunk does not match the end of ${path}`);
	}
	file.lines.splice(matchStart, oldLines.length, ...newLines);
	return matchStart + newLines.length;
}

function updatedFile(state: Extract<FileState, { kind: "file" }>, action: Extract<PatchAction, { kind: "update" }>): FileState {
	const file = decodeTextFile(state, action.path);
	let cursor = 0;
	for (const chunk of action.chunks) cursor = applyChunk(file, chunk, cursor, action.path);
	return { kind: "file", content: encodeTextFile(file), mode: state.mode };
}

async function loadTouchedStates(actions: ResolvedAction[]): Promise<Map<string, FileState>> {
	const paths = new Set<string>();
	for (const action of actions) {
		paths.add(action.path.absolutePath);
		if (action.moveTo) paths.add(action.moveTo.absolutePath);
	}
	const states = new Map<string, FileState>();
	for (const path of paths) states.set(path, await readState(path));
	return states;
}

function requireState(states: Map<string, FileState>, path: string): FileState {
	const state = states.get(path);
	if (!state) throw new Error(`Internal apply_patch state is missing for ${path}`);
	return state;
}

function simulate(actions: ResolvedAction[], initial: Map<string, FileState>): { final: Map<string, FileState>; files: AppliedPatchFile[] } {
	const final = new Map([...initial].map(([path, state]) => [path, cloneState(state)]));
	const files: AppliedPatchFile[] = [];

	for (const resolvedAction of actions) {
		const { action, path, moveTo } = resolvedAction;
		const current = requireState(final, path.absolutePath);
		if (action.kind === "add") {
			if (current.kind !== "absent") throw new Error(`Cannot add ${action.path}: path already exists`);
			final.set(path.absolutePath, { kind: "file", content: Buffer.from(action.content, "utf8"), mode: 0o644 });
		} else if (action.kind === "delete") {
			if (current.kind === "absent") throw new Error(`Cannot delete ${action.path}: file does not exist`);
			if (current.kind === "other") throw new Error(`Cannot delete ${action.path}: path is a ${current.type}`);
			final.set(path.absolutePath, { kind: "absent" });
		} else {
			if (current.kind === "absent") throw new Error(`Cannot update ${action.path}: file does not exist`);
			if (current.kind === "symlink") throw new Error(`Cannot update ${action.path}: symbolic links are not supported`);
			if (current.kind === "other") throw new Error(`Cannot update ${action.path}: path is a ${current.type}`);
			const next = updatedFile(current, action);
			if (moveTo) {
				const destination = requireState(final, moveTo.absolutePath);
				if (destination.kind !== "absent") throw new Error(`Cannot move to ${action.moveTo}: destination already exists`);
				final.set(path.absolutePath, { kind: "absent" });
				final.set(moveTo.absolutePath, next);
			} else {
				final.set(path.absolutePath, next);
			}
		}
		files.push({
			kind: action.kind,
			path: action.path,
			absolutePath: path.absolutePath,
			moveTo: action.kind === "update" ? action.moveTo : undefined,
			absoluteMoveTo: moveTo?.absolutePath,
		});
	}
	return { final, files };
}

async function atomicWrite(path: string, state: Extract<FileState, { kind: "file" }>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = resolve(dirname(path), `.${basename(path)}.apply-patch-${process.pid}-${randomUUID()}`);
	try {
		await writeFile(temporaryPath, state.content, { flag: "wx", mode: state.mode });
		await chmod(temporaryPath, state.mode);
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

async function restore(initial: Map<string, FileState>): Promise<void> {
	for (const path of [...initial.keys()].reverse()) await rm(path, { force: true });
	for (const [path, state] of initial) {
		if (state.kind === "file") await atomicWrite(path, state);
		else if (state.kind === "symlink") {
			await mkdir(dirname(path), { recursive: true });
			await symlink(state.target, path);
		}
	}
}

async function commit(initial: Map<string, FileState>, final: Map<string, FileState>, signal?: AbortSignal): Promise<void> {
	try {
		for (const [path, state] of final) {
			abortIfNeeded(signal);
			if (state.kind === "file") await atomicWrite(path, state);
		}
		for (const [path, state] of final) {
			abortIfNeeded(signal);
			if (state.kind === "absent") await rm(path, { force: true });
		}
	} catch (error) {
		try {
			await restore(initial);
		} catch (rollbackError) {
			throw new Error(`Patch failed: ${error instanceof Error ? error.message : String(error)}. Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
		}
		throw new Error(`Patch failed and all touched paths were restored: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function withQueues<T>(paths: string[], operation: () => Promise<T>, queueMutation?: MutationQueue): Promise<T> {
	if (!queueMutation) return operation();
	const unique = [...new Set(paths)].sort();
	const lock = (index: number): Promise<T> => {
		if (index === unique.length) return operation();
		return queueMutation(unique[index]!, () => lock(index + 1));
	};
	return lock(0);
}

export async function applyPatch(input: string, options: ApplyPatchOptions): Promise<ApplyPatchResult> {
	abortIfNeeded(options.signal);
	const parsed = parsePatch(input);
	const queuedActions = await resolveActions(parsed.actions, options);
	return withQueues(queuedActions.flatMap((action) => [action.path.queuePath, action.moveTo?.queuePath].filter((path): path is string => Boolean(path))), async () => {
		abortIfNeeded(options.signal);
		const actions = await resolveActions(parsed.actions, options);
		for (let index = 0; index < actions.length; index++) {
			const queued = queuedActions[index]!;
			const verified = actions[index]!;
			if (queued.path.queuePath !== verified.path.queuePath || queued.moveTo?.queuePath !== verified.moveTo?.queuePath) {
				throw new Error("A patch path changed while apply_patch waited for the file mutation queue; retry the patch");
			}
		}
		const initial = await loadTouchedStates(actions);
		const plan = simulate(actions, initial);
		await commit(initial, plan.final, options.signal);
		return {
			files: plan.files,
			summary: `Applied patch: ${parsed.actions.map(summarizeAction).join(", ")}`,
		};
	}, options.queueMutation);
}
