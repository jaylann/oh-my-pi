import type { SourceMeta } from "../../../capability/types";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import { type LoadMCPConfigsOptions, loadAllMCPConfigs } from "../../../mcp/config";
import type { MCPLoadResult } from "../../../mcp/manager";
import type { McpConnectionStatusEvent } from "../../../mcp/startup-events";
import type { MCPServerConfig } from "../../../mcp/types";

/** Manager methods `/extensions` needs to match `/mcp enable` / `/mcp disable`. */
export interface MCPToggleManager {
	getConnectionStatus(name: string): "connected" | "connecting" | "dormant" | "disconnected";
	getToolsForServers(serverNames: ReadonlySet<string>): CustomTool[];
	getTools(): CustomTool[];
	registerServer(name: string, config: MCPServerConfig, source?: SourceMeta): void;
	disconnectServer(name: string): Promise<void>;
	connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		onStatus?: (event: McpConnectionStatusEvent) => void,
	): Promise<Pick<MCPLoadResult, "errors"> | MCPLoadResult>;
}

export interface MCPToggleSession {
	refreshMCPTools(tools: CustomTool[]): Promise<void> | void;
	activateMCPServers(serverNames: readonly string[]): Promise<void>;
	getActiveMCPServerNames(): ReadonlySet<string>;
}

export interface ApplyMcpToggleRuntimeOptions {
	name: string;
	enabled: boolean;
	cwd: string;
	manager?: MCPToggleManager;
	session?: MCPToggleSession;
	/** Same discovery filters as session startup (`sdk.ts` / `/mcp reload`). */
	discovery?: LoadMCPConfigsOptions;
	loadConfigs?: typeof loadAllMCPConfigs;
	onStatus?: (event: McpConnectionStatusEvent) => void;
}

/**
 * After `/extensions` persists an MCP enable/disable, apply the same live
 * connect/disconnect + session tool refresh that `/mcp enable` / `/mcp disable`
 * already do. Config persistence stays in `setMcpServerEnabled`.
 */
export async function applyMcpToggleRuntime(options: ApplyMcpToggleRuntimeOptions): Promise<void> {
	const { name, enabled, cwd, manager, session, discovery, loadConfigs = loadAllMCPConfigs, onStatus } = options;
	if (!manager) return;
	const refreshSessionTools = async () => {
		if (!session) return;
		await session.refreshMCPTools(manager.getToolsForServers(session.getActiveMCPServerNames()));
	};

	if (!enabled) {
		await manager.disconnectServer(name);
		await refreshSessionTools();
		return;
	}

	if (manager.getConnectionStatus(name) !== "disconnected" && manager.getConnectionStatus(name) !== "dormant") {
		await refreshSessionTools();
		return;
	}

	const { configs, sources } = await loadConfigs(cwd, discovery);
	const config = configs[name];
	if (!config) {
		await refreshSessionTools();
		return;
	}
	const source = sources[name];
	manager.registerServer(name, config, source);
	if (config.load !== "on-demand") {
		if (session) await session.activateMCPServers([name]);
		else await manager.connectServers({ [name]: config }, source ? { [name]: source } : {}, onStatus);
	}
	await refreshSessionTools();
}
