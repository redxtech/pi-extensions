import * as agent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	installToolChromePatch,
	installToolExecutionRendererPatch,
	installWorkingIndicator,
	installWorkingLoaderAlignmentPatch,
	registerToolChromeEvents,
} from "./tool-renderer/chrome.js";
import {
	installAssistantMessageRenderer,
	installCompactionSummaryRenderer,
	installCustomMessageSpacingPatch,
	installMarkdownCodeBlockRenderer,
	installSkillInvocationRenderer,
	installUserMessageRenderer,
} from "./tool-renderer/messages.js";
import { registerMutationResultEnrichment } from "./tool-renderer/enrichment.js";
import { installLiveSettingsRefresh } from "./tool-renderer/live-settings.js";
import { recordProjectTrust, settingBoolean } from "./tool-renderer/settings.js";
import { registerStackEvents } from "./tool-renderer/stack.js";
import { createCompactToolRendererMap } from "./tool-renderer/tools.js";

const INSTALL_SYMBOL = Symbol.for("vstack.pi-tool-renderer.installed");

export default function toolRenderer(pi: ExtensionAPI): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[INSTALL_SYMBOL]) return;
	guard[INSTALL_SYMBOL] = true;
	if (!settingBoolean("enabled", true)) return;
	pi.on("session_start", (_event, ctx) => recordProjectTrust(ctx));

	const renderers = createCompactToolRendererMap(process.cwd());
	registerStackEvents(pi);
	installToolExecutionRendererPatch(pi, renderers);
	registerMutationResultEnrichment(pi);
	installLiveSettingsRefresh(pi);
	installToolChromePatch();
	registerToolChromeEvents(pi);
	installWorkingLoaderAlignmentPatch();
	installWorkingIndicator(pi);
	installMarkdownCodeBlockRenderer(pi);
	installCompactionSummaryRenderer(pi, agent.CompactionSummaryMessageComponent);

	installUserMessageRenderer(pi, agent.UserMessageComponent);
	installAssistantMessageRenderer(pi, agent.AssistantMessageComponent);
	installCustomMessageSpacingPatch(pi, (agent as any).CustomMessageComponent);
	installSkillInvocationRenderer(pi, (agent as any).SkillInvocationMessageComponent);
}
