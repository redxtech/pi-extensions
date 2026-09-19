import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { buildStructuredDiff, readTextForDiff } from "./diff.js";
import { settingBoolean } from "./settings.js";

type MutationToolName = "edit" | "write";

interface MutationSnapshotBase {
	absolutePath: string;
	concurrent: boolean;
	cwd: string;
	path: string;
	toolName: MutationToolName;
}

type MutationSnapshot = MutationSnapshotBase & (
	| { before: string; existed: true }
	| { before: undefined; existed: false }
);

function mutationToolName(value: unknown): MutationToolName | undefined {
	return value === "edit" || value === "write" ? value : undefined;
}

function mutationPath(input: any): string | undefined {
	const value = input?.path ?? input?.file_path;
	if (typeof value !== "string" || !value.trim()) return undefined;
	return value.startsWith("@") ? value.slice(1) : value;
}

function snapshotMutation(toolName: MutationToolName, input: any, cwd: string): MutationSnapshot | undefined {
	const path = mutationPath(input);
	if (!path) return undefined;
	const absolutePath = resolve(cwd, path);
	const existed = existsSync(absolutePath);
	const before = readTextForDiff(path, cwd);
	const base = { absolutePath, concurrent: false, cwd, path, toolName };
	if (!existed) return { ...base, before: undefined, existed: false };
	if (before === undefined) return undefined;
	return { ...base, before, existed: true };
}

function mutationAfter(snapshot: MutationSnapshot, input: any): string | undefined {
	if (snapshot.toolName === "write") return typeof input?.content === "string" ? input.content : undefined;
	return readTextForDiff(snapshot.path, snapshot.cwd);
}

function enrichedDetails(snapshot: MutationSnapshot, after: string, details: unknown): Record<string, unknown> | undefined {
	const before = snapshot.before ?? "";
	if (snapshot.existed && before === after) return undefined;
	return {
		...(details && typeof details === "object" && !Array.isArray(details) ? details : {}),
		vstackDiff: { ...buildStructuredDiff(before, after), path: snapshot.path },
		vstackDiffWasNewFile: !snapshot.existed,
	};
}

/** persist renderer diff data on tool results so session restoration can reproduce mutation previews */
export function registerMutationResultEnrichment(pi: ExtensionAPI): void {
	const snapshots = new Map<string, MutationSnapshot>();
	const pendingByPath = new Map<string, Set<string>>();

	// tool_call runs before pi's mutation queue, so overlapping path snapshots are ambiguous
	// skip those diffs instead of persisting incorrect history
	function remember(toolCallId: string, snapshot: MutationSnapshot): void {
		const pending = pendingByPath.get(snapshot.absolutePath) ?? new Set<string>();
		if (pending.size > 0) {
			snapshot.concurrent = true;
			for (const pendingId of pending) {
				const earlier = snapshots.get(pendingId);
				if (earlier) earlier.concurrent = true;
			}
		}
		pending.add(toolCallId);
		pendingByPath.set(snapshot.absolutePath, pending);
		snapshots.set(toolCallId, snapshot);
	}

	function take(toolCallId: string): MutationSnapshot | undefined {
		const snapshot = snapshots.get(toolCallId);
		if (!snapshot) return undefined;
		snapshots.delete(toolCallId);
		const pending = pendingByPath.get(snapshot.absolutePath);
		pending?.delete(toolCallId);
		if (pending?.size === 0) pendingByPath.delete(snapshot.absolutePath);
		return snapshot;
	}

	pi.on("tool_call", (event: any, ctx) => {
		const toolName = mutationToolName(event.toolName);
		if (!toolName || !settingBoolean("renderMutationTools", false, ctx.cwd)) return;
		const snapshot = snapshotMutation(toolName, event.input, ctx.cwd);
		if (snapshot) remember(event.toolCallId, snapshot);
	});

	pi.on("tool_result", (event: any) => {
		const snapshot = take(event.toolCallId);
		if (!snapshot || snapshot.concurrent || event.isError) return;
		const after = mutationAfter(snapshot, event.input);
		if (after === undefined) return;
		const details = enrichedDetails(snapshot, after, event.details);
		return details ? { details } : undefined;
	});

	pi.on("session_shutdown", () => {
		snapshots.clear();
		pendingByPath.clear();
	});
}

export const __test = { enrichedDetails, mutationAfter, mutationPath, snapshotMutation };
