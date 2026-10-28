import { beforeAll, describe, expect, it } from "vitest";
import { deriveRawKey, importKeys, open, seal, type SealKeys } from "../src/crypto";
import { reconcile, reseal, type ReconcileOptions, type SealIO, type SyncState } from "../src/sync";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** One device: its own plain folder, a sealed folder shared with others (like a git remote), its own state. */
class Device implements SealIO {
	plain = new Map<string, Uint8Array>();
	backups: string[] = [];
	state: SyncState = {};

	previousKeys: SealKeys[] = [];
	managed: ReconcileOptions["managed"];

	constructor(public sealed: Map<string, Uint8Array>, public keys: SealKeys) {}

	async listPlain() { return [...this.plain.keys()]; }
	async readPlain(p: string) { return this.plain.get(p)!; }
	async writePlain(p: string, d: Uint8Array) { if (this.plain.has(p)) this.backups.push(p); this.plain.set(p, d); }
	async removePlain(p: string) { this.backups.push(p); this.plain.delete(p); }
	async existsPlain(p: string) { return this.plain.has(p); }
	async listSealed() { return [...this.sealed.keys()]; }
	async readSealed(id: string) { return this.sealed.get(id)!; }
	async writeSealed(id: string, d: Uint8Array) { this.sealed.set(id, d); }
	async removeSealed(id: string) { this.sealed.delete(id); }

	write(p: string, text: string) { this.plain.set(p, enc(text)); }
	read(p: string) { const d = this.plain.get(p); return d && dec(d); }

	async sync() {
		const { state, report } = await reconcile(this, this.keys, this.state, {
			now: new Date(2026, 9, 28, 15, 30),
			managed: this.managed,
			previousKeys: this.previousKeys,
		});
		this.state = state;
		return report;
	}
}

let keys: SealKeys;
let otherKeys: SealKeys;

beforeAll(async () => {
	const salt = new Uint8Array(16);
	keys = await importKeys(await deriveRawKey("correct horse battery", salt, 1000));
	otherKeys = await importKeys(await deriveRawKey("wrong passphrase!!", salt, 1000));
});

function pair() {
	const remote = new Map<string, Uint8Array>();
	return { remote, pc: new Device(remote, keys), phone: new Device(remote, keys) };
}

describe("crypto", () => {
	it("round-trips path and content, including binary", async () => {
		const bytes = new Uint8Array([0, 255, 1, 2, 3]);
		const opened = await open(keys, await seal(keys, "img/a.png", bytes));
		expect(opened.path).toBe("img/a.png");
		expect([...opened.content]).toEqual([...bytes]);
	});

	it("is deterministic, so unchanged files do not churn in git", async () => {
		expect(await seal(keys, "a.md", enc("x"))).toEqual(await seal(keys, "a.md", enc("x")));
		expect(await seal(keys, "a.md", enc("x"))).not.toEqual(await seal(keys, "a.md", enc("y")));
	});

	it("does not leak content or path in plain text", async () => {
		const blob = dec(await seal(keys, "дневник.md", enc("very private text")));
		expect(blob).not.toContain("private");
		expect(blob).not.toContain("дневник");
	});

	it("rejects a wrong key and tampered data", async () => {
		const blob = await seal(keys, "a.md", enc("x"));
		await expect(open(otherKeys, blob)).rejects.toThrow(/wrong passphrase/);
		blob[blob.length - 1] ^= 1;
		await expect(open(keys, blob)).rejects.toThrow(/wrong passphrase/);
	});
});

describe("reconcile", () => {
	it("carries a new file from PC to phone", async () => {
		const { pc, phone } = pair();
		pc.write("notes/a.md", "hello");
		expect((await pc.sync()).sealed).toEqual(["notes/a.md"]);
		expect((await phone.sync()).restored).toEqual(["notes/a.md"]);
		expect(phone.read("notes/a.md")).toBe("hello");
	});

	it("does nothing on a second sync", async () => {
		const { pc, remote } = pair();
		pc.write("a.md", "hello");
		await pc.sync();
		const before = new Map(remote);
		const report = await pc.sync();
		expect(report).toEqual({ sealed: [], restored: [], removedPlain: [], removedSealed: [], conflicts: [], orphaned: 0 });
		expect(remote).toEqual(before);
	});

	it("carries edits both ways", async () => {
		const { pc, phone } = pair();
		pc.write("a.md", "v1");
		await pc.sync();
		await phone.sync();
		phone.write("a.md", "v2 from phone");
		await phone.sync();
		await pc.sync();
		expect(pc.read("a.md")).toBe("v2 from phone");
		expect(pc.backups).toEqual(["a.md"]);
	});

	it("carries deletions both ways", async () => {
		const { pc, phone, remote } = pair();
		pc.write("a.md", "x");
		pc.write("b.md", "y");
		await pc.sync();
		await phone.sync();

		pc.plain.delete("a.md");
		await pc.sync();
		expect((await phone.sync()).removedPlain).toEqual(["a.md"]);
		expect(phone.read("a.md")).toBeUndefined();

		phone.plain.delete("b.md");
		await phone.sync();
		await pc.sync();
		expect(pc.read("b.md")).toBeUndefined();
		expect(remote.size).toBe(0);
	});

	it("does not delete a file this device simply has not received yet", async () => {
		const { pc, phone } = pair();
		pc.write("a.md", "from pc");
		await pc.sync();
		phone.write("b.md", "from phone");
		await phone.sync();
		expect(phone.read("a.md")).toBe("from pc");
		await pc.sync();
		expect(pc.read("b.md")).toBe("from phone");
	});

	it("keeps both versions when both sides edited", async () => {
		const { pc, phone } = pair();
		pc.write("a.md", "base");
		await pc.sync();
		await phone.sync();

		pc.write("a.md", "pc edit");
		phone.write("a.md", "phone edit");
		await pc.sync();
		const report = await phone.sync();

		const copy = "a (conflict 2026-10-28 1530).md";
		expect(report.conflicts).toEqual([copy]);
		expect(phone.read("a.md")).toBe("phone edit");
		expect(phone.read(copy)).toBe("pc edit");

		await pc.sync();
		expect(pc.read("a.md")).toBe("phone edit");
		expect(pc.read(copy)).toBe("pc edit");
	});

	it("lets an edit win over a deletion", async () => {
		const { pc, phone } = pair();
		pc.write("a.md", "base");
		await pc.sync();
		await phone.sync();

		pc.plain.delete("a.md");
		phone.write("a.md", "edited on phone");
		await pc.sync();
		await phone.sync();
		await pc.sync();
		expect(pc.read("a.md")).toBe("edited on phone");
	});

	it("treats a device with no state safely: equal files match, different ones become conflicts", async () => {
		const { pc, phone } = pair();
		pc.write("same.md", "same");
		pc.write("diff.md", "pc");
		await pc.sync();
		phone.write("same.md", "same");
		phone.write("diff.md", "phone");
		const report = await phone.sync();
		expect(report.conflicts).toHaveLength(1);
		expect(phone.read("diff.md")).toBe("phone");
	});

	it("replaces old sealed versions instead of piling them up", async () => {
		const { pc, remote } = pair();
		pc.write("a.md", "v1");
		await pc.sync();
		pc.write("a.md", "v2");
		await pc.sync();
		expect(remote.size).toBe(1);
	});

	it("reads 0.1.0 sealed names without a version and migrates them", async () => {
		const { pc, phone, remote } = pair();
		pc.write("a.md", "x");
		await pc.sync();
		const [[name, blob]] = remote;
		remote.delete(name);
		remote.set(name.split(".")[0], blob);
		await phone.sync();
		expect(phone.read("a.md")).toBe("x");
		phone.write("a.md", "y");
		await phone.sync();
		expect([...remote.keys()]).toEqual([expect.stringMatching(/^[0-9a-f]{32}\.[0-9a-f]{16}$/)]);
	});

	it("aborts before writing anything when a sealed file cannot be opened", async () => {
		const { pc, remote } = pair();
		pc.write("a.md", "x");
		await pc.sync();
		const intruder = new Device(remote, otherKeys);
		intruder.write("b.md", "y");
		await expect(intruder.sync()).rejects.toThrow();
		expect(remote.size).toBe(1);
		expect(intruder.read("b.md")).toBe("y");
	});
});

/**
 * Git as Obsidian Git uses it: every device has its own copy of the sealed
 * folder; "commit and sync" commits, pulls (three-way merge by file) and pushes.
 * The merge throws on anything git would report as a conflict.
 */
class Remote {
	files = new Map<string, Uint8Array>();
}

class GitDevice extends Device {
	head = new Map<string, Uint8Array>();

	constructor(private remote: Remote, keys: SealKeys) {
		super(new Map(), keys);
	}

	pull() {
		const merged = new Map<string, Uint8Array>();
		const names = new Set([...this.head.keys(), ...this.sealed.keys(), ...this.remote.files.keys()]);
		for (const name of names) {
			const b = this.head.get(name);
			const o = this.sealed.get(name);
			const t = this.remote.files.get(name);
			const same = (x?: Uint8Array, y?: Uint8Array) => (x && y ? x.length === y.length && x.every((v, i) => v === y[i]) : x === y);
			if (same(o, t)) { if (o) merged.set(name, o); }
			else if (same(o, b)) { if (t) merged.set(name, t); }
			else if (same(t, b)) { if (o) merged.set(name, o); }
			else throw new Error(`git conflict in ${name}`);
		}
		this.sealed = merged;
		this.head = new Map(merged);
	}

	commitAndSync() {
		this.pull();
		this.remote.files = new Map(this.sealed);
	}
}

describe("reconcile through git merges", () => {
	function gitPair() {
		const remote = new Remote();
		return { pc: new GitDevice(remote, keys), phone: new GitDevice(remote, keys) };
	}

	it("never makes git conflict when both devices edit the same file, and keeps both edits", async () => {
		const { pc, phone } = gitPair();
		pc.write("a.md", "base");
		await pc.sync();
		pc.commitAndSync();
		phone.pull();
		await phone.sync();

		pc.write("a.md", "pc edit");
		phone.write("a.md", "phone edit");
		await pc.sync();
		pc.commitAndSync();
		await phone.sync();
		expect(() => phone.commitAndSync()).not.toThrow();

		const report = await phone.sync();
		const copy = "a (conflict 2026-10-28 1530).md";
		expect(report.conflicts).toEqual([copy]);
		expect(phone.read("a.md")).toBe("phone edit");
		expect(phone.read(copy)).toBe("pc edit");
		phone.commitAndSync();

		pc.pull();
		await pc.sync();
		expect(pc.read("a.md")).toBe("phone edit");
		expect(pc.read(copy)).toBe("pc edit");
		expect(pc.sealed.size).toBe(2);
	});

	it("takes the incoming version when this device did not touch the file", async () => {
		const { pc, phone } = gitPair();
		pc.write("a.md", "v1");
		await pc.sync();
		pc.commitAndSync();
		phone.pull();
		await phone.sync();

		pc.write("a.md", "v2");
		await pc.sync();
		pc.commitAndSync();
		phone.commitAndSync();
		const report = await phone.sync();
		expect(report.conflicts).toEqual([]);
		expect(phone.read("a.md")).toBe("v2");
	});

	it("lets an edit win over a concurrent deletion without a git conflict", async () => {
		const { pc, phone } = gitPair();
		pc.write("a.md", "v1");
		await pc.sync();
		pc.commitAndSync();
		phone.pull();
		await phone.sync();

		pc.plain.delete("a.md");
		await pc.sync();
		pc.commitAndSync();
		phone.write("a.md", "edited");
		await phone.sync();
		expect(() => phone.commitAndSync()).not.toThrow();
		await phone.sync();
		expect(phone.read("a.md")).toBe("edited");
		pc.pull();
		await pc.sync();
		expect(pc.read("a.md")).toBe("edited");
	});
});

describe("three devices", () => {
	it("takes one incoming edit and parks the other when this device did not touch the file", async () => {
		const remote = new Remote();
		const [pc, phone, laptop] = [new GitDevice(remote, keys), new GitDevice(remote, keys), new GitDevice(remote, keys)];
		pc.write("a.md", "base");
		await pc.sync();
		pc.commitAndSync();
		for (const d of [phone, laptop]) { d.pull(); await d.sync(); }

		phone.write("a.md", "phone");
		await phone.sync();
		phone.commitAndSync();
		laptop.write("a.md", "laptop");
		await laptop.sync();
		laptop.commitAndSync();

		pc.pull();
		const report = await pc.sync();
		expect(report.conflicts).toHaveLength(1);
		const texts = [...pc.plain.values()].map(dec).sort();
		expect(texts).toEqual(["laptop", "phone"]);
	});
});
