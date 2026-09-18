import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkills, resetActiveSkillsForTests } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { SkillProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/skill-protocol";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { createMCPProxyTools } from "@oh-my-pi/pi-coding-agent/task/executor";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "instructions-mcp.ts");

function fixtureConfig(load?: "startup" | "on-demand"): MCPServerConfig {
	return {
		type: "stdio",
		command: process.execPath,
		args: [FIXTURE_PATH],
		...(load ? { load } : {}),
	};
}

const DEFAULT_SKILL_SOURCES_DISABLED = {
	enableCodexUser: false,
	enableClaudeUser: false,
	enableClaudeProject: false,
	enablePiUser: false,
	enablePiProject: false,
	enableAgentsUser: false,
	enableAgentsProject: false,
} as const;

describe("on-demand MCP activation", () => {
	const managers: MCPManager[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		resetActiveSkillsForTests();
		await Promise.all(managers.splice(0).map(manager => manager.disconnectAll()));
		await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
	});

	it("keeps on-demand servers dormant while omitted load retains startup behavior", async () => {
		let cacheReads = 0;
		const cache = {
			async get() {
				cacheReads++;
				return null;
			},
			async set() {},
		} as unknown as MCPToolCache;
		const manager = new MCPManager(process.cwd(), cache, async () => ({
			configs: {
				eager: fixtureConfig(),
				lazy: fixtureConfig("on-demand"),
			},
			sources: {},
			exaApiKeys: [],
		}));
		managers.push(manager);

		await manager.discoverAndConnect();

		expect(manager.getConnectionStatus("eager")).toBe("connected");
		expect(manager.getConnectionStatus("lazy")).toBe("dormant");
		expect(manager.getStartupServerNames()).toEqual(["eager"]);
		expect(manager.getTools().every(tool => tool.mcpServerName === "eager")).toBe(true);
		expect(manager.getServerInstructions().has("lazy")).toBe(false);
		expect(cacheReads).toBe(0);
	});

	it("activates once for concurrent consumers and filters parent and child exposure", async () => {
		const manager = new MCPManager(process.cwd(), null, async () => ({
			configs: {
				eager: fixtureConfig(),
				lazy: fixtureConfig("on-demand"),
			},
			sources: {},
			exaApiKeys: [],
		}));
		managers.push(manager);
		await manager.discoverAndConnect();

		await Promise.all([manager.activateServers(["lazy"]), manager.activateServers(["lazy"])]);

		expect(manager.getConnectionStatus("lazy")).toBe("connected");
		const parentServers = new Set(["eager"]);
		const childServers = new Set(["lazy"]);
		expect(manager.getToolsForServers(parentServers).every(tool => tool.mcpServerName === "eager")).toBe(true);
		expect(manager.getToolsForServers(childServers).every(tool => tool.mcpServerName === "lazy")).toBe(true);
		expect(createMCPProxyTools(manager, parentServers).every(tool => tool.name.includes("eager"))).toBe(true);
		expect(createMCPProxyTools(manager, childServers).every(tool => tool.name.includes("lazy"))).toBe(true);
		expect([...manager.getServerInstructions(parentServers).keys()]).toEqual(["eager"]);
		expect([...manager.getServerInstructions(childServers).keys()]).toEqual(["lazy"]);
		expect(manager.getTools().filter(tool => tool.mcpServerName === "lazy")).toHaveLength(1);
	});

	it("fails closed before connecting when any requested server is unavailable", async () => {
		const manager = new MCPManager(process.cwd(), null, async () => ({
			configs: { available: fixtureConfig("on-demand") },
			sources: {},
			exaApiKeys: [],
		}));
		managers.push(manager);
		await manager.discoverAndConnect();

		await expect(manager.activateServers(["available", "disabled", "filtered", "unknown"])).rejects.toThrow(
			"disabled, filtered, unknown",
		);
		expect(manager.getConnectionStatus("available")).toBe("dormant");
		expect(manager.getTools()).toEqual([]);
	});

	it("activates declared servers before a root skill read returns", async () => {
		const manager = new MCPManager(process.cwd(), null, async () => ({
			configs: { lazy: fixtureConfig("on-demand") },
			sources: {},
			exaApiKeys: [],
		}));
		managers.push(manager);
		await manager.discoverAndConnect();

		const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lazy-mcp-skill-"));
		tempDirs.push(skillsDir);
		const skillDir = path.join(skillsDir, "lazy-skill");
		await fs.mkdir(skillDir, { recursive: true });
		await Bun.write(
			path.join(skillDir, "SKILL.md"),
			"---\nname: lazy-skill\ndescription: Activates lazy MCP.\nmcpServers:\n  - lazy\n---\n\n# Lazy skill\n",
		);
		const { skills } = await loadSkills({ ...DEFAULT_SKILL_SOURCES_DISABLED, customDirectories: [skillsDir] });
		expect(skills.find(skill => skill.name === "lazy-skill")?.mcpServers).toEqual(["lazy"]);

		await expect(
			new SkillProtocolHandler().resolve(parseInternalUrl("skill://lazy-skill"), { skills }),
		).rejects.toThrow("cannot activate MCP servers");
		expect(manager.getConnectionStatus("lazy")).toBe("dormant");

		const resource = await new SkillProtocolHandler().resolve(parseInternalUrl("skill://lazy-skill"), {
			skills,
			activateMCPServers: names => manager.activateServers(names).then(() => undefined),
		});

		expect(resource.content).toContain("# Lazy skill");
		expect(manager.getConnectionStatus("lazy")).toBe("connected");
		expect(manager.getToolsForServers(new Set(["lazy"]))).toHaveLength(1);
	});
});
