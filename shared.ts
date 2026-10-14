import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RunState = "starting" | "busy" | "idle" | "exited" | "error";

export interface RunMetadata {
	version: 1;
	handle: string;
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	childSessionId?: string;
	/** Herdr workspace the run's tab was created in. */
	herdrWorkspaceId?: string;
	/** Herdr tab hosting the run; the tab closes when the child process exits. */
	herdrTabId?: string;
	/** Herdr pane running the child pi process. */
	herdrPaneId?: string;
	runDir: string;
	sessionFile: string;
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tools, isolation) reused when the run is relaunched. */
	launchArgs?: string[];
	/** Set by the parent when it stops the child on quit or session switch; the child is relaunched on resume. */
	suspended?: boolean;
	state: RunState;
	hasStarted: boolean;
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function metadataPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

export function runDisplayName(metadata: RunMetadata): string {
	return metadata.name ? `${metadata.name} (${metadata.handle})` : metadata.handle;
}

export function readMetadata(runDir: string): RunMetadata | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(metadataPath(runDir), "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const metadata = value as Partial<RunMetadata>;
		if (
			metadata.version !== 1 ||
			typeof metadata.handle !== "string" ||
			(metadata.name !== undefined && !isValidRunName(metadata.name)) ||
			typeof metadata.sessionFile !== "string" ||
			typeof metadata.runDir !== "string"
		) {
			return undefined;
		}
		return metadata as RunMetadata;
	} catch {
		return undefined;
	}
}

export function writeMetadata(metadata: RunMetadata): void {
	mkdirSync(dirname(metadataPath(metadata.runDir)), { recursive: true, mode: 0o700 });
	const target = metadataPath(metadata.runDir);
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

export function updateMetadata(runDir: string, patch: Partial<RunMetadata>): RunMetadata | undefined {
	const current = readMetadata(runDir);
	if (!current) return undefined;
	const next: RunMetadata = {
		...current,
		...patch,
		version: 1,
		handle: current.handle,
		runDir: current.runDir,
		updatedAt: new Date().toISOString(),
	};
	writeMetadata(next);
	return next;
}

export async function waitForRunShutdown(runDir: string, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const metadata = readMetadata(runDir);
		if (!metadata || metadata.state === "exited") return;
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 50));
	}
}

export function removeRunDir(runDir: string): void {
	rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

interface HerdrPane {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
}

function herdr(args: string[]): { ok: boolean; result?: Record<string, unknown>; error: string } {
	const result = spawnSync("herdr", args, { encoding: "utf8" });
	if (result.error) return { ok: false, error: result.error.message };
	if (result.status !== 0) {
		let error = result.stderr.trim() || `herdr ${args[0]} ${args[1]} failed`;
		try {
			const parsed = JSON.parse(result.stderr) as { error?: { message?: string } };
			if (parsed.error?.message) error = parsed.error.message;
		} catch {
			// Keep raw stderr.
		}
		return { ok: false, error };
	}
	try {
		const parsed = JSON.parse(result.stdout) as { result?: Record<string, unknown> };
		return { ok: true, result: parsed.result, error: "" };
	} catch {
		return { ok: true, error: "" };
	}
}

export function requireHerdr(): string {
	const workspaceId = process.env.HERDR_WORKSPACE_ID;
	if (process.env.HERDR_ENV !== "1" || !workspaceId) throw new Error("Subagents require running inside Herdr (HERDR_ENV=1)");
	return workspaceId;
}

function herdrPane(paneId: string | undefined): HerdrPane | undefined {
	if (!paneId) return undefined;
	const response = herdr(["pane", "get", paneId]);
	return response.ok ? (response.result?.pane as HerdrPane | undefined) : undefined;
}

export function runIsAlive(metadata: RunMetadata): boolean {
	return herdrPane(metadata.herdrPaneId) !== undefined;
}

/** Close the run's pane, which terminates the child pi process and its tab. */
export function closeRun(metadata: RunMetadata): void {
	if (metadata.herdrPaneId) herdr(["pane", "close", metadata.herdrPaneId]);
}

/** Bring the run's Herdr tab into focus. */
export function focusRun(metadata: RunMetadata): void {
	const pane = herdrPane(metadata.herdrPaneId);
	if (!pane) throw new Error(`${runDisplayName(metadata)} is not running`);
	const response = herdr(["tab", "focus", pane.tab_id]);
	if (!response.ok) throw new Error(response.error);
}

export function runTabLabel(metadata: RunMetadata): string {
	return `subagent ${metadata.name ?? metadata.handle}`;
}

export function renameRunTab(metadata: RunMetadata): void {
	const pane = herdrPane(metadata.herdrPaneId);
	if (pane) herdr(["tab", "rename", pane.tab_id, runTabLabel(metadata)]);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Start the child pi process for a run in a new Herdr tab. `initialArgs` are only passed on first spawn.
 * The command lives in a launch script because Herdr rejects pane input longer than the terminal line limit.
 */
export function launchRun(metadata: RunMetadata, initialArgs: string[] = []): RunMetadata {
	const currentWorkspaceId = requireHerdr();
	let launcher = "pi";
	const testLauncher = join(metadata.cwd, "pi-test.sh");
	try {
		accessSync(testLauncher, constants.X_OK);
		launcher = testLauncher;
	} catch {
		// Use the installed pi executable.
	}

	const command = [
		launcher,
		"--session",
		metadata.sessionFile,
		"--provider",
		metadata.provider,
		"--model",
		metadata.model,
		"--thinking",
		metadata.thinking,
		...(metadata.launchArgs ?? []),
		...initialArgs,
	];
	const script = join(metadata.runDir, "launch.sh");
	writeFileSync(
		script,
		`#!/bin/sh\ncd ${shellQuote(metadata.cwd)} || exit 1\nPI_SUBAGENT_RUN_DIR=${shellQuote(metadata.runDir)}\nexport PI_SUBAGENT_RUN_DIR\nexec ${command.map(shellQuote).join(" ")}\n`,
		{ encoding: "utf8", mode: 0o700 },
	);

	const created = herdr([
		"tab",
		"create",
		"--workspace",
		currentWorkspaceId,
		"--cwd",
		metadata.cwd,
		"--label",
		runTabLabel(metadata),
		"--no-focus",
	]);
	const pane = created.result?.root_pane as HerdrPane | undefined;
	if (!created.ok || !pane) throw new Error(created.error || "Failed to create Herdr tab");

	// Record the pane before the child starts so its own metadata updates cannot race with ours.
	const updated =
		updateMetadata(metadata.runDir, {
			herdrWorkspaceId: pane.workspace_id,
			herdrTabId: pane.tab_id,
			herdrPaneId: pane.pane_id,
		}) ?? metadata;

	// `exec` replaces the pane's shell, so the tab closes once pi exits.
	const run = herdr(["pane", "run", pane.pane_id, `exec /bin/sh ${shellQuote(script)}`]);
	if (!run.ok) {
		herdr(["pane", "close", pane.pane_id]);
		throw new Error(run.error || "Failed to start subagent in Herdr pane");
	}
	return updated;
}

export function effectiveRunState(metadata: RunMetadata): RunState {
	if (
		(metadata.state === "starting" || metadata.state === "busy" || metadata.state === "idle") &&
		!runIsAlive(metadata)
	) {
		return "exited";
	}
	return metadata.state;
}

export function listRuns(parentSessionId?: string): RunMetadata[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const runs: RunMetadata[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metadata = readMetadata(join(root, entry.name));
		if (!metadata) continue;
		if (parentSessionId && metadata.parentSessionId !== parentSessionId) continue;
		runs.push(metadata);
	}
	return runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be in the process of being appended.
		}
	}
	return activeBranch(entries).findLast(isAssistantEntry)?.message;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}
