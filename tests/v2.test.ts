import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { importKeys, type SealKeys } from "../src/crypto";
import { readIndexPaths } from "../src/git-index";
import { keyIdOf, lockMasterKey, newMasterKey, parseConfig, unlockMasterKey } from "../src/keyring";
import { reseal, type SealIO, type SyncState } from "../src/sync";
import { reconcile } from "../src/sync";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** A device with its own sealed folder that syncs through a git-like remote (merge by file, throws on conflict). */
class Device implements SealIO {
	plain = new Map<string, Uint8Array>();
	sealed = new Map<string, Uint8Array>();
	head = new Map<string, Uint8Array>();
	state: SyncState = {};
	previousKeys: SealKeys[] = [];
	folders = ["Здоровье/документы", "Машина/документы"];

	constructor(
		private remote: { files: Map<string, Uint8Array> },
		public keys: SealKeys,
	) {}

	async listPlain() { return [...this.plain.keys()].filter((p) => this.managed(p)); }
	async readPlain(p: string) { return this.plain.get(p)!; }
	async writePlain(p: string, d: Uint8Array) { this.plain.set(p, d); }
	async removePlain(p: string) { this.plain.delete(p); }
	async existsPlain(p: string) { return this.plain.has(p); }
	async listSealed() { return [...this.sealed.keys()]; }
	async readSealed(n: string) { return this.sealed.get(n)!; }
	async writeSealed(n: string, d: Uint8Array) { this.sealed.set(n, d); }
	async removeSealed(n: string) { this.sealed.delete(n); }

	managed = (p: string) => this.folders.some((f) => p.startsWith(f + "/"));
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

	pull() {
		const merged = new Map<string, Uint8Array>();
		const same = (x?: Uint8Array, y?: Uint8Array) => (x && y ? x.length === y.length && x.every((v, i) => v === y[i]) : x === y);
		for (const name of new Set([...this.head.keys(), ...this.sealed.keys(), ...this.remote.files.keys()])) {
			const [b, o, t] = [this.head.get(name), this.sealed.get(name), this.remote.files.get(name)];
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

let master: Uint8Array;
let keys: SealKeys;

beforeAll(async () => {
	master = newMasterKey();
	keys = await importKeys(master);
});

function devices() {
	const remote = { files: new Map<string, Uint8Array>() };
	return { pc: new Device(remote, keys), phone: new Device(remote, keys) };
}

describe("several encrypted folders", () => {
	it("syncs files from every listed folder, by vault path", async () => {
		const { pc, phone } = devices();
		pc.write("Здоровье/документы/анализы.md", "гемоглобин");
		pc.write("Машина/документы/страховка.md", "полис");
		pc.write("Здоровье/открытая.md", "not encrypted");
		await pc.sync();
		pc.commitAndSync();
		phone.pull();
		const report = await phone.sync();
		expect(report.restored.sort()).toEqual(["Здоровье/документы/анализы.md", "Машина/документы/страховка.md"]);
		expect(phone.read("Здоровье/открытая.md")).toBeUndefined();
		expect(pc.sealed.size).toBe(2);
	});

	it("leaves sealed files of a folder that left the list alone", async () => {
		const { pc, phone } = devices();
		pc.write("Здоровье/документы/a.md", "a");
		pc.write("Машина/документы/b.md", "b");
		await pc.sync();
		pc.commitAndSync();
		phone.pull();
		await phone.sync();

		phone.folders = ["Здоровье/документы"];
		const report = await phone.sync();
		expect(report.orphaned).toBe(1);
		expect(report.removedPlain).toEqual([]);
		expect(report.removedSealed).toEqual([]);
		expect(phone.sealed.size).toBe(2);
		expect(phone.read("Машина/документы/b.md")).toBe("b");
	});
});

describe("line endings", () => {
	it("does not see a conflict when only CRLF vs LF differs", async () => {
		const { pc, phone } = devices();
		pc.write("Здоровье/документы/a.md", "line one\r\nline two\r\n");
		await pc.sync();
		pc.commitAndSync();
		phone.write("Здоровье/документы/a.md", "line one\nline two\n");
		phone.pull();
		const report = await phone.sync();
		expect(report.conflicts).toEqual([]);
		expect(phone.read("Здоровье/документы/a.md")).toBe("line one\nline two\n");
	});

	it("still sees a real edit in a CRLF file", async () => {
		const { pc, phone } = devices();
		pc.write("Здоровье/документы/a.md", "one\r\n");
		await pc.sync();
		pc.commitAndSync();
		phone.pull();
		await phone.sync();
		phone.write("Здоровье/документы/a.md", "one\ntwo\n");
		await phone.sync();
		phone.commitAndSync();
		pc.pull();
		await pc.sync();
		expect(pc.read("Здоровье/документы/a.md")).toBe("one\ntwo\n");
	});
});

describe("keyring", () => {
	it("locks and unlocks the master key with the passphrase", async () => {
		const config = await lockMasterKey(master, "correct horse battery", 1000);
		expect(config.keyId).toBe(await keyIdOf(master));
		expect([...(await unlockMasterKey(config, "correct horse battery"))]).toEqual([...master]);
		await expect(unlockMasterKey(config, "wrong passphrase!!")).rejects.toThrow(/wrong passphrase/);
	});

	it("changes the passphrase without changing the key", async () => {
		const before = await lockMasterKey(master, "old passphrase 123", 1000);
		const after = await lockMasterKey(await unlockMasterKey(before, "old passphrase 123"), "new passphrase 456", 1000);
		expect(after.keyId).toBe(before.keyId);
		expect(after.lockedKey).not.toBe(before.lockedKey);
		await expect(unlockMasterKey(after, "old passphrase 123")).rejects.toThrow();
		expect([...(await unlockMasterKey(after, "new passphrase 456"))]).toEqual([...master]);
	});

	it("keeps no secret in the config", async () => {
		const text = JSON.stringify(await lockMasterKey(master, "correct horse battery", 1000));
		expect(text).not.toContain("correct horse");
		expect(parseConfig(text).version).toBe(2);
	});

	it("explains a 0.1 config instead of failing obscurely", () => {
		expect(() => parseConfig('{"version":1}')).toThrow(/0\.1/);
	});
});

describe("re-encryption", () => {
	async function rotate(device: Device) {
		const fresh = await importKeys(newMasterKey());
		await reseal(device, device.keys, fresh);
		device.previousKeys = [device.keys];
		device.keys = fresh;
		return fresh;
	}

	it("re-seals everything so the old key opens nothing", async () => {
		const { pc } = devices();
		pc.write("Здоровье/документы/a.md", "a");
		await pc.sync();
		const oldNames = [...pc.sealed.keys()];
		await rotate(pc);
		expect([...pc.sealed.keys()]).not.toEqual(oldNames);
		const stranger = new Device({ files: new Map() }, keys);
		stranger.sealed = new Map(pc.sealed);
		await expect(stranger.sync()).rejects.toThrow(/cannot decrypt/);
		expect((await pc.sync()).sealed).toEqual([]);
	});

	it("can be interrupted and repeated", async () => {
		const { pc } = devices();
		pc.write("Здоровье/документы/a.md", "a");
		pc.write("Здоровье/документы/b.md", "b");
		await pc.sync();
		const fresh = await importKeys(newMasterKey());
		expect(await reseal(pc, keys, fresh)).toBe(2);
		expect(await reseal(pc, keys, fresh)).toBe(0);
		expect(pc.sealed.size).toBe(2);
	});

	it("keeps an edit another device made with the old key, without git conflicts", async () => {
		const { pc, phone } = devices();
		pc.write("Здоровье/документы/a.md", "base");
		pc.write("Здоровье/документы/b.md", "untouched");
		await pc.sync();
		pc.commitAndSync();
		phone.pull();
		await phone.sync();

		// The phone edits and seals with the old key, not pushed yet…
		phone.write("Здоровье/документы/a.md", "phone edit");
		await phone.sync();
		// …while the PC re-encrypts and pushes.
		const fresh = await rotate(pc);
		pc.commitAndSync();

		expect(() => phone.commitAndSync()).not.toThrow();
		// The phone is asked for the new passphrase and keeps its old key as a previous one.
		phone.previousKeys = [phone.keys];
		phone.keys = fresh;
		const report = await phone.sync();
		// The re-encrypted old text cannot be told from a PC edit back to it,
		// so it is parked as a conflict copy. Nothing is lost.
		const copy = "Здоровье/документы/a (conflict 2026-10-28 1530).md";
		expect(report.conflicts).toEqual([copy]);
		expect(phone.read(copy)).toBe("base");
		expect(phone.read("Здоровье/документы/a.md")).toBe("phone edit");
		expect(phone.read("Здоровье/документы/b.md")).toBe("untouched");
		expect(phone.sealed.size).toBe(3);
		phone.commitAndSync();

		pc.pull();
		await pc.sync();
		expect(pc.read("Здоровье/документы/a.md")).toBe("phone edit");
		// Nothing under the old key is left in the remote.
		const outsider = new Device({ files: new Map() }, fresh);
		outsider.sealed = new Map(pc.sealed);
		expect((await outsider.sync()).restored).toHaveLength(3);
	});
});

describe("git index", () => {
	it("reads the paths of real index files, versions 2 to 4", () => {
		const dir = mkdtempSync(join(tmpdir(), "folder-seal-index-"));
		try {
			const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
			git("init", "-q");
			const files = ["a.md", "Здоровье/документы/анализы.md", "Здоровье/документы/анализы-2.md", `long/${"x".repeat(100)}.md`];
			for (const f of files) {
				mkdirSync(join(dir, f, ".."), { recursive: true });
				writeFileSync(join(dir, f), f);
			}
			git("add", ".");
			for (const version of ["2", "3", "4"]) {
				git("update-index", "--index-version", version);
				const paths = readIndexPaths(new Uint8Array(readFileSync(join(dir, ".git", "index"))));
				expect(paths?.sort()).toEqual([...files].sort());
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects what is not an index", () => {
		expect(readIndexPaths(enc("hello world, not an index"))).toBeNull();
	});
});
