import type { MemorySession } from "./memory.js";
import type { Entry } from "../memory-tree/types.js";

type WriterState = { sessionId?: string; owner?: SessionWriter; failure?: Error };
type WriterRegistry = { managers: WeakMap<object, WriterState>; sessions: Map<string, SessionWriter> };
// Survives extension reloads, including Pi replacing its extension runtime during Fork.
const key = Symbol.for("pi-segment-memory.session-writers.v1");
const globals = globalThis as typeof globalThis & { [key]?: WriterRegistry };
const registry = globals[key] ??= { managers: new WeakMap(), sessions: new Map() };

export function assertSessionReadable(manager: MemorySession): void {
	const state = registry.managers.get(manager);
	const failure = state?.sessionId === manager.getSessionId?.() ? state?.failure : undefined;
	if (failure) throw failure;
}

/** One Pi process / SessionManager owns a writable Session. Cross-process writing is unsupported. */
export class SessionWriter {
	private manager?: MemorySession;
	private id?: string;
	private state?: WriterState;

	claim(manager: MemorySession): void {
		const id = manager.getSessionId?.();
		if (this.manager === manager && this.id === id) {
			this.assertHealthy();
			return;
		}
		this.release();
		const prior = registry.managers.get(manager);
		const state = prior && prior.sessionId === id ? prior : { sessionId: id };
		if (state.failure) throw state.failure;
		if ((state.owner && state.owner !== this) || (id && registry.sessions.has(id))) {
			throw new Error("Session already has a Segment Memory writer; use one Pi runtime per Session");
		}
		this.manager = manager;
		this.id = id;
		this.state = state;
		state.owner = this;
		registry.managers.set(manager, state);
		if (id) registry.sessions.set(id, this);
		this.assertHealthy();
	}

	assertHealthy(): void {
		if (this.state?.failure) throw this.state.failure;
	}

	block(error: unknown): void {
		if (this.state) this.state.failure = error instanceof Error ? error : new Error(String(error));
	}

	append(append: (customType: string, data: unknown) => void, customType: string, data: unknown): void {
		this.assertHealthy();
		if (!this.manager || !this.state) throw new Error("Session writer has not been claimed");
		const before = (this.manager.getEntries() as Entry[]).length;
		try {
			append(customType, data);
			const added = (this.manager.getEntries() as Entry[]).slice(before);
			if (added.length !== 1 || added[0]?.customType !== customType || JSON.stringify(added[0]?.data) !== JSON.stringify(data)) {
				throw new Error("Pi did not confirm exactly one matching ledger entry");
			}
		} catch (error) {
			// Pi mutates its in-memory ledger before disk I/O. Never retry against that
			// ambiguous projection, even after extension reload. Reopen the saved Session.
			this.state.failure = new Error(`Memory append failed or is uncertain; reopen the saved Session before writing again: ${error instanceof Error ? error.message : String(error)}`);
			throw this.state.failure;
		}
	}

	release(): void {
		if (this.state?.owner === this) delete this.state.owner;
		if (this.id && registry.sessions.get(this.id) === this) registry.sessions.delete(this.id);
		this.manager = undefined;
		this.state = undefined;
		this.id = undefined;
	}
}
