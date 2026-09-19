import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stripAnsi } from "../tool-renderer/ansi.js";
import { registerMutationResultEnrichment } from "../tool-renderer/enrichment.js";
import { recordProjectTrust } from "../tool-renderer/settings.js";
import { createCompactToolRendererMap } from "../tool-renderer/tools.js";

const createdDirs: string[] = [];

afterEach(() => {
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempCwd(renderMutationTools = true): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-tool-renderer-enrichment-"));
	createdDirs.push(cwd);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
		vstack: { extensionManager: { config: { "@gabedunn/pi-tool-renderer": { renderMutationTools } } } },
	}));
	recordProjectTrust({ cwd, isProjectTrusted: () => true });
	return cwd;
}

function writeRenderer(cwd: string): any {
	return createCompactToolRendererMap(cwd).write;
}

function enrichmentHarness() {
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	registerMutationResultEnrichment({
		on(event: string, handler: (event: any, ctx: any) => any) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
	} as any);
	return {
		async emit(event: string, value: any, ctx: any = {}) {
			let result;
			for (const handler of handlers.get(event) ?? []) result = await handler(value, ctx);
			return result;
		},
	};
}

describe("mutation result enrichment", () => {
	test("persists a write diff without replacing the write tool", async () => {
		const cwd = tempCwd();
		writeFileSync(join(cwd, "example.txt"), "before\n");
		const harness = enrichmentHarness();
		const input = { path: "example.txt", content: "after\n" };

		await harness.emit("tool_call", { toolCallId: "write-1", toolName: "write", input }, { cwd });
		const patch = await harness.emit("tool_result", {
			toolCallId: "write-1",
			toolName: "write",
			input,
			details: { original: true },
			isError: false,
		});

		expect(patch.details.original).toBe(true);
		expect(patch.details.vstackDiff.path).toBe("example.txt");
		expect(patch.details.vstackDiff.additions).toBe(1);
		expect(patch.details.vstackDiff.removals).toBe(1);
		expect(patch.details.vstackDiffWasNewFile).toBe(false);

		const component = writeRenderer(cwd).renderResult(
			{ content: [{ type: "text", text: "Wrote example.txt" }], details: patch.details },
			{ expanded: true, isPartial: false },
			{ bg: (_token: string, text: string) => text, bold: (text: string) => text, fg: (_token: string, text: string) => text },
			{ args: input, cwd, isError: false, state: {} },
		);
		const restored = component.render(160).map(stripAnsi).join("\n");
		expect(restored).toContain("before");
		expect(restored).toContain("after");
	});

	test("marks a new empty file as durable renderer metadata", async () => {
		const cwd = tempCwd();
		const harness = enrichmentHarness();
		const input = { path: "empty.txt", content: "" };

		await harness.emit("tool_call", { toolCallId: "write-2", toolName: "write", input }, { cwd });
		const patch = await harness.emit("tool_result", {
			toolCallId: "write-2",
			toolName: "write",
			input,
			isError: false,
		});

		expect(patch.details.vstackDiffWasNewFile).toBe(true);
		expect(patch.details.vstackDiff.additions).toBe(0);
		expect(patch.details.vstackDiff.removals).toBe(0);
	});

	test("persists the observed edit result", async () => {
		const cwd = tempCwd();
		const path = join(cwd, "example.txt");
		writeFileSync(path, "before\n");
		const harness = enrichmentHarness();
		const input = { path: "example.txt", edits: [{ oldText: "before", newText: "after" }] };

		await harness.emit("tool_call", { toolCallId: "edit-1", toolName: "edit", input }, { cwd });
		writeFileSync(path, "after\n");
		const patch = await harness.emit("tool_result", {
			toolCallId: "edit-1",
			toolName: "edit",
			input,
			details: { diff: "built-in diff" },
			isError: false,
		});

		expect(patch.details.diff).toBe("built-in diff");
		expect(patch.details.vstackDiff.additions).toBe(1);
		expect(patch.details.vstackDiff.removals).toBe(1);
	});

	test("skips ambiguous concurrent mutations of the same path", async () => {
		const cwd = tempCwd();
		writeFileSync(join(cwd, "example.txt"), "before\n");
		const harness = enrichmentHarness();
		const first = { path: "example.txt", content: "first\n" };
		const second = { path: "example.txt", content: "second\n" };

		await harness.emit("tool_call", { toolCallId: "write-3a", toolName: "write", input: first }, { cwd });
		await harness.emit("tool_call", { toolCallId: "write-3b", toolName: "write", input: second }, { cwd });
		expect(await harness.emit("tool_result", {
			toolCallId: "write-3a",
			toolName: "write",
			input: first,
			isError: false,
		})).toBeUndefined();
		expect(await harness.emit("tool_result", {
			toolCallId: "write-3b",
			toolName: "write",
			input: second,
			isError: false,
		})).toBeUndefined();
	});

	test("does not enrich failed or disabled mutations", async () => {
		const cwd = tempCwd(false);
		writeFileSync(join(cwd, "example.txt"), "before\n");
		const harness = enrichmentHarness();
		const input = { path: "example.txt", content: "after\n" };

		await harness.emit("tool_call", { toolCallId: "write-3", toolName: "write", input }, { cwd });
		expect(await harness.emit("tool_result", {
			toolCallId: "write-3",
			toolName: "write",
			input,
			isError: false,
		})).toBeUndefined();
	});
});
