import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";

import toolRenderer from "../index.js";
import manifest from "../package.json";
import { stripAnsi } from "../tool-renderer/ansi.js";

let agentDir: string;
let previousAgentDir: string | undefined;
let handlers: Map<string, Array<(event: any, ctx: any) => any>>;
let registeredTools: string[];

beforeEach(() => {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	agentDir = mkdtempSync(join(tmpdir(), "pi-tool-renderer-integration-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	handlers = new Map();
	registeredTools = [];
});

afterEach(async () => {
	try {
		for (const handler of handlers.get("session_shutdown") ?? []) {
			await handler({ reason: "quit" }, { hasUI: false });
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

function runtime() {
	return {
		events: { on: () => () => {} },
		on(event: string, handler: (event: any, ctx: any) => any) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
		},
		registerTool(definition: { name: string }) {
			registeredTools.push(definition.name);
		},
	};
}

function settings(config: Record<string, unknown>): void {
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		vstack: { extensionManager: { config: { "@gabedunn/pi-tool-renderer": config } } },
	}));
}

describe("local extension integration", () => {
	test.each([
		["default settings", {}],
		["legacy batch settings", { registerBatchTool: true, batchMaxCalls: 8, batchCallTimeoutMs: 1000 }],
	] as const)("installs renderers without registering tools with %s", (_label, config) => {
		settings(config);
		const proto = ToolExecutionComponent.prototype as any;
		const originalGetCallRenderer = proto.getCallRenderer;
		const pi = runtime();

		toolRenderer(pi as any);
		expect(registeredTools).toEqual([]);
		expect(proto.getCallRenderer).not.toBe(originalGetCallRenderer);

		const component = Object.assign(Object.create(proto), { toolName: "read", cwd: agentDir });
		const renderer = component.getResultRenderer();
		const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };
		const rendered = renderer(
			{ content: [{ type: "text", text: "example" }] },
			{ expanded: false, isPartial: false },
			theme,
			{ args: { path: "README.md" }, cwd: agentDir, state: {} },
		).render(80);
		expect(rendered.map(stripAnsi).join("\n")).toContain("README.md");

		const handlerCount = [...handlers.values()].reduce((count, entries) => count + entries.length, 0);
		toolRenderer(pi as any);
		expect([...handlers.values()].reduce((count, entries) => count + entries.length, 0)).toBe(handlerCount);
		expect(registeredTools).toEqual([]);
	});

	test("leaves rendering and tools unchanged when disabled", () => {
		settings({ enabled: false, registerBatchTool: true });
		const originalGetCallRenderer = (ToolExecutionComponent.prototype as any).getCallRenderer;

		toolRenderer(runtime() as any);
		expect(registeredTools).toEqual([]);
		expect(handlers.size).toBe(0);
		expect((ToolExecutionComponent.prototype as any).getCallRenderer).toBe(originalGetCallRenderer);
	});

	test("does not expose batch settings", () => {
		const keys = manifest.vstack.extensionManager.settings.map((setting) => setting.key);

		expect(keys).not.toContain("registerBatchTool");
		expect(keys).not.toContain("batchMaxCalls");
		expect(keys).not.toContain("batchCallTimeoutMs");
		expect(manifest.vstack.extensionManager.settings.some((setting) => setting.category === "Batch Tool")).toBe(false);
	});
});
