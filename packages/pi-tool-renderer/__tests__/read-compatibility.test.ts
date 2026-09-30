import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stripAnsi } from "../tool-renderer/ansi.js";
import { __test } from "../tool-renderer/chrome.js";
import { recordProjectTrust } from "../tool-renderer/settings.js";
import { ensureStackItem, registerStackEvents, renderStackItemText, stackBatches, stackItems } from "../tool-renderer/stack.js";
import { createCompactToolRendererMap, renderReadToolResult } from "../tool-renderer/tools.js";
import { parseHashlineReadOutput, readDisplayContent, readResultSummary } from "../tool-renderer/text.js";

const createdDirs: string[] = [];
const theme = {
	bold: (text: string) => text,
	fg: (_token: string, text: string) => text,
};

afterEach(() => {
	for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempCwd(config: Record<string, unknown>): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-tool-renderer-read-compat-"));
	createdDirs.push(cwd);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
		vstack: { extensionManager: { config: { "@gabedunn/pi-tool-renderer": config } } },
	}));
	recordProjectTrust({ cwd, isProjectTrusted: () => true });
	return cwd;
}

describe("custom read compatibility", () => {
	test("recognizes hashline output without counting its snapshot header as a file line", () => {
		const content = "[src/example.ts#1a2b]\n10:const first = true;\n11:const second = true;";

		expect(parseHashlineReadOutput(content)).toEqual({
			content: "10:const first = true;\n11:const second = true;",
			lineCount: 2,
			path: "src/example.ts",
			tag: "1A2B",
		});
		expect(readDisplayContent(content)).toBe("10:const first = true;\n11:const second = true;");
		expect(readResultSummary({ content: [{ type: "text", text: content }] }, {}, theme)).toBe("2 lines · #1A2B");
	});

	test("accepts empty reads and paths containing hash characters", () => {
		expect(parseHashlineReadOutput("[src/generated#part.ts#ABCD]")).toEqual({
			content: "",
			lineCount: 0,
			path: "src/generated#part.ts",
			tag: "ABCD",
		});
	});

	test("recognizes hashline truncation footers even when result metadata is unavailable", () => {
		const content = "[src/example.ts#D00D]\n1:first\n2:second\n\n[Showing lines 1-2 of 5 (2 line limit). Use offset=3 to continue.]";
		const footerOnly = "[src/example.ts#FACE]\n[Showing lines 1-0 of 5 (0 line limit). Use offset=1 to continue.]";
		const limited = "[src/example.ts#CAFE]\n1:first\n2:second\n\n[3 more lines in file. Use offset=3 to continue.]";

		expect(readResultSummary({ content: [{ type: "text", text: content }] }, {}, theme)).toBe("2 lines · truncated · continue offset=3 · #D00D");
		expect(readDisplayContent(content)).toBe("1:first\n2:second");
		expect(readResultSummary({ content: [{ type: "text", text: footerOnly }] }, {}, theme)).toBe("0 lines · truncated · continue offset=1 · #FACE");
		expect(readDisplayContent(footerOnly)).toBe("");
		expect(readResultSummary({ content: [{ type: "text", text: limited }] }, {}, theme)).toBe("2 lines · truncated · continue offset=3 · #CAFE");
		expect(readDisplayContent(limited)).toBe("1:first\n2:second");
	});

	test("summarizes unavailable anchors without leaking the notice into previews", () => {
		const content = "[Line 1 is 50.1KB, exceeds 50.0KB limit. Use bash to inspect a bounded slice.]\n\n[Hashline anchors unavailable: the displayed line is incomplete.]";
		const result = {
			content: [{ type: "text", text: content }],
			details: { truncation: { firstLineExceedsLimit: true, outputLines: 0, totalLines: 1, truncated: true } },
		};

		expect(readDisplayContent(content)).toBe("[Line 1 is 50.1KB, exceeds 50.0KB limit. Use bash to inspect a bounded slice.]");
		expect(readResultSummary(result, {}, theme)).toBe("0/1 lines · truncated · no anchors");
	});

	test("expanded rendering hides the duplicate hashline header but preserves anchors", () => {
		const cwd = tempCwd({ readOutputMode: "preview" });
		const component = renderReadToolResult(
			{ content: [{ type: "text", text: "[src/example.ts#BEEF]\n1:const value = 1;\n2:export { value };" }] },
			{ expanded: true, isPartial: false },
			theme,
			{ args: { path: "src/example.ts" }, cwd, state: {}, invalidate() {}, showImages: false },
			cwd,
		);
		const rendered = component.render(120).map(stripAnsi).join("\n");

		expect(rendered).toContain("2 lines · #BEEF");
		expect(rendered).toContain("1:const value = 1;");
		expect(rendered).not.toContain("[src/example.ts#BEEF]");
	});

	test("legacy stacked rendering also removes the hashline header", () => {
		const cwd = tempCwd({ readPreviewLines: 80 });
		const rendered = stripAnsi(renderStackItemText({
			args: { path: "src/example.ts" },
			batchId: "batch",
			id: "read-1",
			isError: false,
			resultText: "[src/example.ts#CAFE]\n1:one\n2:two",
			status: "done",
			toolName: "read",
			truncated: false,
		}, theme, true, cwd));

		expect(rendered).toContain("2 lines · #CAFE");
		expect(rendered).toContain("1:one");
		expect(rendered).not.toContain("[src/example.ts#CAFE]");
	});

	test("clears stacked tool state when a session shuts down", () => {
		const handlers = new Map<string, () => void>();
		registerStackEvents({ on: (event: string, handler: () => void) => handlers.set(event, handler) } as any);
		ensureStackItem("read", "read-1", { path: "README.md" });

		expect(stackItems.size).toBe(1);
		expect(stackBatches.size).toBe(1);
		handlers.get("session_shutdown")?.();
		expect(stackItems.size).toBe(0);
		expect(stackBatches.size).toBe(0);
	});

	test("builds renderer-only definitions for built-in tool names", () => {
		const cwd = tempCwd({ renderMutationTools: true });
		const renderers = createCompactToolRendererMap(cwd);

		expect(Object.keys(renderers).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
		for (const renderer of Object.values(renderers)) {
			expect(Object.keys(renderer).sort()).toEqual(["renderCall", "renderResult", "renderShell"]);
		}
		expect(__test.compactToolRenderer("read", renderers, cwd)).toBe(renderers.read);
		expect(__test.compactToolRenderer("bash", renderers, cwd)).toBe(renderers.bash);
		expect(__test.compactToolRenderer("question", renderers, cwd)).toBeUndefined();
	});

	test("keeps mutation renderers disabled unless configured", () => {
		const cwd = tempCwd({ renderMutationTools: false });
		const renderers = { edit: { renderShell: "self" as const }, write: { renderShell: "self" as const } };

		expect(__test.compactToolRenderer("edit", renderers, cwd)).toBeUndefined();
		expect(__test.compactToolRenderer("write", renderers, cwd)).toBeUndefined();
	});
});
