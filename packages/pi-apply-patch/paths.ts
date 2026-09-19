import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { PatchAction } from "./parser.ts";

/** path policy used while resolving patch actions */
export interface PathPolicyOptions {
	cwd: string;
	allowAbsolutePaths: boolean;
	signal?: AbortSignal;
}

/** one resolved patch path and its mutation queue identity */
export interface ResolvedPath {
	input: string;
	absolutePath: string;
	queuePath: string;
}

/** one patch action with resolved source and destination paths */
export interface ResolvedAction {
	action: PatchAction;
	path: ResolvedPath;
	moveTo?: ResolvedPath;
}

function abortIfNeeded(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new Error("apply_patch was cancelled");
}

function cleanPath(path: string): string {
	let cleaned = path.trim();
	if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
		cleaned = cleaned.slice(1, -1);
	}
	if (cleaned.startsWith("@")) cleaned = cleaned.slice(1);
	if (!cleaned || cleaned.includes("\0")) throw new Error(`Invalid patch path: ${path}`);
	return cleaned;
}

function isWithin(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function canonicalizeProspectivePath(path: string): Promise<string> {
	const suffix: string[] = [];
	let current = path;
	while (true) {
		try {
			return resolve(await realpath(current), ...suffix.reverse());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			suffix.push(basename(current));
			current = parent;
		}
	}
}

async function resolvePatchPath(path: string, options: PathPolicyOptions): Promise<ResolvedPath> {
	const cleaned = cleanPath(path);
	const absoluteInput = isAbsolute(cleaned);
	if (absoluteInput && !options.allowAbsolutePaths) {
		throw new Error(`Absolute patch paths are disabled: ${path}`);
	}

	const cwd = resolve(options.cwd);
	const absolutePath = absoluteInput ? resolve(cleaned) : resolve(cwd, cleaned);
	if (!absoluteInput && !isWithin(cwd, absolutePath)) throw new Error(`Patch path escapes the workspace: ${path}`);

	const canonicalPath = await canonicalizeProspectivePath(absolutePath);
	if (!absoluteInput) {
		const canonicalCwd = await realpath(cwd);
		if (!isWithin(canonicalCwd, canonicalPath)) throw new Error(`Patch path escapes the workspace through a symlink: ${path}`);
	}
	return { input: path, absolutePath, queuePath: canonicalPath };
}

export async function resolveActions(actions: PatchAction[], options: PathPolicyOptions): Promise<ResolvedAction[]> {
	const resolved: ResolvedAction[] = [];
	for (const action of actions) {
		abortIfNeeded(options.signal);
		const path = await resolvePatchPath(action.path, options);
		const moveTo = action.kind === "update" && action.moveTo
			? await resolvePatchPath(action.moveTo, options)
			: undefined;
		if (moveTo && moveTo.absolutePath === path.absolutePath) {
			throw new Error(`Move target must differ from the source path: ${action.path}`);
		}
		resolved.push({ action, path, moveTo });
	}
	return resolved;
}
