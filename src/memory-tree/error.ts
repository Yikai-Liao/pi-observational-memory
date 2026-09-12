export class MemoryTreeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryTreeError";
	}
}
