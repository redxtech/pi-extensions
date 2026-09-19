import { type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyPatch } from "./apply.ts";
import { loadConfig } from "./config.ts";

/** public tool input */
export interface ApplyPatchInput {
	input: string;
}

const parameters = Type.Object(
	{
		input: Type.String({
			description: "Codex apply_patch text beginning with *** Begin Patch and ending with *** End Patch.",
		}),
	},
	{ additionalProperties: false },
);

function isOpenAiLikeModel(model: ExtensionContext["model"]): boolean {
	const provider = (model?.provider ?? "").toLowerCase();
	const id = (model?.id ?? model?.name ?? "").toLowerCase();
	return provider === "openai"
		|| provider === "openai-codex"
		|| provider === "opencode"
		|| provider.startsWith("openai-")
		|| provider.endsWith("-openai")
		|| provider.endsWith("-codex")
		|| /^gpt[-_\d]/.test(id)
		|| /^o\d/.test(id)
		|| id.includes("codex");
}

function syncActivation(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const active = pi.getActiveTools();
	const enabled = isOpenAiLikeModel(ctx.model);
	const hasTool = active.includes("apply_patch");
	if (enabled && !hasTool) pi.setActiveTools([...active, "apply_patch"]);
	if (!enabled && hasTool) pi.setActiveTools(active.filter((name) => name !== "apply_patch"));
}

export default function applyPatchExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "apply_patch",
		label: "Apply Patch",
		description: "Apply a strict Codex-style patch locally. Supports add, update, delete, and move actions. Relative paths must stay in the workspace. Absolute paths require explicit configuration.",
		promptSnippet: "Apply strict Codex-style multi-file patches through the input argument.",
		promptGuidelines: [
			"Use apply_patch for concise multi-file edits when a Codex-style patch is clearer than separate edit or write calls.",
			"Use exact, unambiguous context in apply_patch update hunks.",
		],
		parameters,
		async execute(_toolCallId, params: ApplyPatchInput, signal, _onUpdate, ctx) {
			const config = await loadConfig(ctx);
			const result = await applyPatch(params.input, {
				cwd: ctx.cwd,
				allowAbsolutePaths: config.allowAbsolutePaths,
				signal,
				queueMutation: withFileMutationQueue,
			});
			return {
				content: [{ type: "text", text: `${result.summary}\nFiles changed: ${result.files.length}` }],
				details: result,
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => syncActivation(pi, ctx));
	pi.on("model_select", async (_event, ctx) => syncActivation(pi, ctx));
}
