import { describe, expect, test } from "bun:test";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { applyMcpToggleRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/mcp-runtime";

function stubCustomTool(name: string): CustomTool {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object" },
		async execute() {
			return { content: [{ type: "text", text: "" }] };
		},
	};
}

describe("applyMcpToggleRuntime", () => {
	test("disable disconnects the live manager and refreshes only authorized session tools", async () => {
		const disconnected: string[] = [];
		const refreshed: CustomTool[][] = [];
		const tools = [stubCustomTool("other_tool")];
		await applyMcpToggleRuntime({
			name: "github",
			enabled: false,
			cwd: "/tmp",
			manager: {
				getConnectionStatus: () => "connected",
				getTools: () => tools,
				getToolsForServers: () => tools,
				registerServer: () => {
					throw new Error("disable must not register");
				},
				disconnectServer: async name => {
					disconnected.push(name);
				},
				connectServers: async () => {
					throw new Error("disable must not reconnect");
				},
			},
			session: {
				refreshMCPTools: next => {
					refreshed.push(next);
				},
				activateMCPServers: async () => {
					throw new Error("disable must not activate");
				},
				getActiveMCPServerNames: () => new Set(["other"]),
			},
		});
		expect(disconnected).toEqual(["github"]);
		expect(refreshed).toEqual([tools]);
	});

	test("enable registers and activates a disconnected startup server before refreshing", async () => {
		const registered: string[] = [];
		const activated: string[][] = [];
		const refreshed: CustomTool[][] = [];
		const tools = [stubCustomTool("github_search")];
		await applyMcpToggleRuntime({
			name: "github",
			enabled: true,
			cwd: "/tmp/project",
			loadConfigs: async () => ({
				configs: { github: { command: "github-mcp-server" } },
				sources: {},
				exaApiKeys: [],
			}),
			manager: {
				getConnectionStatus: () => "disconnected",
				getTools: () => tools,
				getToolsForServers: () => tools,
				registerServer: name => {
					registered.push(name);
				},
				disconnectServer: async () => {
					throw new Error("enable must not disconnect");
				},
				connectServers: async () => {
					throw new Error("activation owns startup connection");
				},
			},
			session: {
				refreshMCPTools: next => {
					refreshed.push(next);
				},
				activateMCPServers: async names => {
					activated.push([...names]);
				},
				getActiveMCPServerNames: () => new Set(["github"]),
			},
		});
		expect(registered).toEqual(["github"]);
		expect(activated).toEqual([["github"]]);
		expect(refreshed).toEqual([tools]);
	});

	test("enable leaves an on-demand server dormant", async () => {
		const registered: string[] = [];
		const activated: string[][] = [];
		await applyMcpToggleRuntime({
			name: "lazy",
			enabled: true,
			cwd: "/tmp/project",
			loadConfigs: async () => ({
				configs: { lazy: { command: "lazy-mcp-server", load: "on-demand" } },
				sources: {},
				exaApiKeys: [],
			}),
			manager: {
				getConnectionStatus: () => "dormant",
				getTools: () => [],
				getToolsForServers: () => [],
				registerServer: name => {
					registered.push(name);
				},
				disconnectServer: async () => {},
				connectServers: async () => ({ errors: new Map() }),
			},
			session: {
				refreshMCPTools: () => {},
				activateMCPServers: async names => {
					activated.push([...names]);
				},
				getActiveMCPServerNames: () => new Set(),
			},
		});
		expect(registered).toEqual(["lazy"]);
		expect(activated).toEqual([]);
	});

	test("enable passes startup discovery filters into config load", async () => {
		const loads: Array<{ cwd: string; options: unknown }> = [];
		await applyMcpToggleRuntime({
			name: "project-only",
			enabled: true,
			cwd: "/tmp/project",
			discovery: { enableProjectConfig: false, filterExa: true, filterBrowser: true },
			loadConfigs: async (cwd, options) => {
				loads.push({ cwd, options });
				return { configs: {}, sources: {}, exaApiKeys: [] };
			},
			manager: {
				getConnectionStatus: () => "disconnected",
				getTools: () => [],
				getToolsForServers: () => [],
				registerServer: () => {
					throw new Error("missing config must not register");
				},
				disconnectServer: async () => {
					throw new Error("enable must not disconnect");
				},
				connectServers: async () => ({ errors: new Map() }),
			},
		});
		expect(loads).toEqual([
			{
				cwd: "/tmp/project",
				options: { enableProjectConfig: false, filterExa: true, filterBrowser: true },
			},
		]);
	});
});
