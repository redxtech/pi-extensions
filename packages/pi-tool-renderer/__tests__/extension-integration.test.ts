import { describe, expect, test } from "bun:test";

import toolRenderer from "../index.js";

describe("local extension integration", () => {
	test("registers only the new tool_batch tool", async () => {
		const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
		const registeredTools: string[] = [];
		const pi = {
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

		await toolRenderer(pi as any);
		expect(registeredTools).toEqual(["tool_batch"]);

		for (const handler of handlers.get("session_shutdown") ?? []) {
			await handler({ reason: "quit" }, { hasUI: false });
		}
	});
});
