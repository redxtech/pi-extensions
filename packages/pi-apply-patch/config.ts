import { CONFIG_DIR_NAME, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** user-configurable path policy */
export interface ApplyPatchConfig {
	allowAbsolutePaths: boolean;
}

const DEFAULT_CONFIG: ApplyPatchConfig = {
	allowAbsolutePaths: false,
};

export const userConfigPath = fileURLToPath(new URL("./config.json", import.meta.url));

function parseConfig(text: string, path: string): Partial<ApplyPatchConfig> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid apply_patch config at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid apply_patch config at ${path}: expected a JSON object`);
	}
	const config = value as Record<string, unknown>;
	if (config.allowAbsolutePaths !== undefined && typeof config.allowAbsolutePaths !== "boolean") {
		throw new Error(`Invalid apply_patch config at ${path}: allowAbsolutePaths must be a boolean`);
	}
	return config.allowAbsolutePaths === undefined
		? {}
		: { allowAbsolutePaths: config.allowAbsolutePaths };
}

async function readConfig(path: string): Promise<Partial<ApplyPatchConfig>> {
	try {
		return parseConfig(await readFile(path, "utf8"), path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
}

export async function loadConfig(ctx: ExtensionContext): Promise<ApplyPatchConfig> {
	const user = await readConfig(userConfigPath);
	let project: Partial<ApplyPatchConfig> = {};
	if (ctx.isProjectTrusted()) {
		project = await readConfig(join(ctx.cwd, CONFIG_DIR_NAME, "apply-patch.json"));
	}
	return { ...DEFAULT_CONFIG, ...user, ...project };
}
