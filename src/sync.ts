import { fileId, open, seal, sha256Hex, type OpenedFile, type SealKeys } from "./crypto";

/**
 * Storage the sync works against. The plugin backs it with the Obsidian vault;
 * tests back it with memory. Plain paths are vault paths of files inside the
 * encrypted folders; sealed names are file names in the sealed folder without
 * the extension.
 */
export interface SealIO {
	listPlain(): Promise<string[]>;
	readPlain(path: string): Promise<Uint8Array>;
	/** Writes a plain file. Implementations back up the previous version first. */
	writePlain(path: string, data: Uint8Array): Promise<void>;
	/** Removes a plain file. Implementations back it up first. */
	removePlain(path: string): Promise<void>;
	existsPlain(path: string): Promise<boolean>;

	listSealed(): Promise<string[]>;
	readSealed(name: string): Promise<Uint8Array>;
	writeSealed(name: string, data: Uint8Array): Promise<void>;
	removeSealed(name: string): Promise<void>;
}

/**
 * What both sides looked like after the last successful sync on this device:
 * path -> content hash. It is the "base" of the three-way merge and lives only
 * on the device, never in git. Keyed by path, not by sealed id, so it survives
 * re-encryption with a new key.
 */
export type SyncState = Record<string, string>;

export interface SyncReport {
	sealed: string[];
	restored: string[];
	removedPlain: string[];
	removedSealed: string[];
	conflicts: string[];
	/** Sealed files whose folder is no longer in the list. Left as they are. */
	orphaned: number;
}

export interface ReconcileOptions {
	now?: Date;
	/** Whether a path belongs to one of the encrypted folders. Sealed files outside them are left alone. */
	managed?: (path: string) => boolean;
	/**
	 * Keys used before the last re-encryption. Files another device sealed with
	 * them before it heard about the new key are still read, and re-sealed.
	 */
	previousKeys?: SealKeys[];
}

interface Side {
	path: string;
	hash: string;
	data: Uint8Array;
	/** Sealed side only: file name in the sealed folder. */
	name?: string;
	/** Sealed side only: sealed with a previous key, must be re-sealed. */
	stale?: boolean;
}

/**
 * Sealed file names are "<id>.<version>", where id comes from the path and
 * version from the ciphertext. A new version is a new file and the old one is
 * deleted, so git only ever sees adds and deletes in the sealed folder and
 * merges two devices' work without conflicts. Two versions of one id after a
 * merge mean both devices changed that file; reconcile turns that into a
 * conflict copy. Names without a version (0.1.0) are read as a version too.
 */
const SEALED_NAME = /^([0-9a-f]{32})(?:\.([0-9a-f]{16}))?$/;

export async function sealedName(id: string, blob: Uint8Array): Promise<string> {
	return `${id}.${(await sha256Hex(blob)).slice(0, 16)}`;
}

/**
 * Brings the plain folders and the sealed folder in line with each other.
 *
 * Everything is read and decrypted before the first write, so a wrong
 * passphrase or a corrupted file aborts the sync without touching anything.
 *
 * For every file the local copy (L), the sealed copy (R) and the state from the
 * last sync (B) are compared:
 * - L == R           nothing to do
 * - L == B           only the other device changed it -> take R
 * - R == B           only this device changed it -> seal L
 * - otherwise        both changed: keep L, put R next to it as a conflict copy
 * A missing file counts as "deleted", so deletions travel the same way.
 * Several sealed versions of one file always mean both sides changed it.
 */
export async function reconcile(
	io: SealIO,
	keys: SealKeys,
	basePaths: SyncState,
	{ now = new Date(), managed = () => true, previousKeys = [] }: ReconcileOptions = {},
): Promise<{ state: SyncState; report: SyncReport }> {
	const local = new Map<string, Side>();
	for (const path of await io.listPlain()) {
		const data = await io.readPlain(path);
		local.set(await fileId(keys, path), { path, data, hash: await contentHash(path, data) });
	}

	const report: SyncReport = { sealed: [], restored: [], removedPlain: [], removedSealed: [], conflicts: [], orphaned: 0 };
	const remote = new Map<string, Side[]>();
	const staleOrphans: Side[] = [];
	for (const name of await io.listSealed()) {
		const match = SEALED_NAME.exec(name);
		if (!match) continue;
		const { file, stale } = await openAny(name, match[1], await io.readSealed(name), keys, previousKeys);
		const side: Side = { path: file.path, data: file.content, hash: await contentHash(file.path, file.content), name, stale };
		if (!isSafePath(file.path) || !managed(file.path)) {
			report.orphaned++;
			if (stale) staleOrphans.push(side);
			continue;
		}
		const id = await fileId(keys, file.path);
		remote.set(id, [...(remote.get(id) ?? []), side]);
	}

	const base = new Map<string, string>();
	for (const [path, hash] of Object.entries(basePaths)) if (managed(path)) base.set(await fileId(keys, path), hash);

	const state: SyncState = {};

	/** Makes `side` the only sealed version of `id`. */
	const writeSealed = async (id: string, side: Side, existing: Side[] = []) => {
		const blob = await seal(keys, side.path, side.data);
		const name = await sealedName(id, blob);
		// The name carries a hash of the blob, so an existing name means identical bytes.
		if (!existing.some((v) => v.name === name)) {
			await io.writeSealed(name, blob);
			report.sealed.push(side.path);
		}
		for (const v of existing) if (v.name !== name) await io.removeSealed(v.name!);
	};

	const conflictCopy = async (side: Side) => {
		const copyPath = await freeConflictPath(io, side.path, now);
		await io.writePlain(copyPath, side.data);
		await writeSealed(await fileId(keys, copyPath), { path: copyPath, data: side.data, hash: side.hash });
		state[copyPath] = side.hash;
		report.conflicts.push(copyPath);
	};

	const ids = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
	for (const id of ids) {
		const l = local.get(id);
		const b = base.get(id);
		// Every sealed file of this id; all but the one written last get removed.
		const all = remote.get(id) ?? [];
		const versions = effectiveVersions(all, b, l?.hash);

		if (versions.length > 1) {
			// Several devices sealed a new version and git kept them all. Whoever
			// seals a version deletes the previous one, so these are all
			// concurrent edits — none of them is stale. Keep the local file if it
			// is one of them or was edited here; if it is just the old state,
			// take the first incoming version. Every other version becomes a
			// conflict copy.
			const keep = l && (l.hash !== b || versions.some((v) => v.hash === l.hash)) ? l : versions[0];
			for (const v of versions) if (v.hash !== keep.hash) await conflictCopy(v);
			if (keep !== l) {
				await io.writePlain(keep.path, keep.data);
				report.restored.push(keep.path);
			}
			await writeSealed(id, keep, all);
			state[keep.path] = keep.hash;
			continue;
		}

		const r = versions[0];
		// One clean sealed file under the current key needs no rewrite.
		const tidy = all.length === 1 && !all[0].stale;
		if (l && r && l.hash === r.hash) {
			if (!tidy) await writeSealed(id, l, all);
			state[l.path] = l.hash;
		} else if (l?.hash === b) {
			// Only the sealed side moved.
			if (r) {
				await io.writePlain(r.path, r.data);
				report.restored.push(r.path);
				if (!tidy) await writeSealed(id, r, all);
				state[r.path] = r.hash;
			} else if (l) {
				await io.removePlain(l.path);
				report.removedPlain.push(l.path);
			}
		} else if (r?.hash === b) {
			// Only the plain side moved.
			if (l) {
				await writeSealed(id, l, all);
				state[l.path] = l.hash;
			} else if (r) {
				for (const v of all) await io.removeSealed(v.name!);
				report.removedSealed.push(r.path);
			}
		} else if (!l && r) {
			// Deleted here, edited elsewhere: the edit wins.
			await io.writePlain(r.path, r.data);
			report.restored.push(r.path);
			if (!tidy) await writeSealed(id, r, all);
			state[r.path] = r.hash;
		} else if (l && !r) {
			// Deleted elsewhere, edited here: the edit wins.
			await writeSealed(id, l);
			state[l.path] = l.hash;
		} else if (l && r) {
			// Edited on both sides: keep ours, park theirs next to it.
			await conflictCopy(r);
			await writeSealed(id, l, all);
			state[l.path] = l.hash;
		}
	}

	// Files of folders that left the list are not synced, but must stay readable.
	for (const v of staleOrphans) await writeSealed(await fileId(keys, v.path), v, [v]);

	return { state, report };
}

/**
 * The sealed versions of one file that carry a decision:
 * - versions with the same content are one version (say, the same file sealed
 *   with an old and a new key);
 * - a version equal to the base is not an edit (say, a re-encryption) and is
 *   dropped while there is something else — unless it is also what this device
 *   has, because then it is this device's own latest sync and another device
 *   may have edited it concurrently.
 * The current key's copy wins over a stale one.
 */
function effectiveVersions(all: Side[], base: string | undefined, localHash: string | undefined): Side[] {
	const byHash = new Map<string, Side>();
	for (const v of all) {
		const seen = byHash.get(v.hash);
		if (!seen || (seen.stale && !v.stale)) byHash.set(v.hash, v);
	}
	const unique = [...byHash.values()];
	const edits = unique.filter((v) => v.hash !== base || v.hash === localHash);
	return edits.length ? edits : unique;
}

/**
 * Re-encrypts every sealed file from one key to another (passphrase change
 * with re-encryption). New files are written before old ones are removed, and
 * files already under `to` are skipped, so an interrupted run can be repeated.
 */
export async function reseal(io: SealIO, from: SealKeys, to: SealKeys): Promise<number> {
	const old: string[] = [];
	for (const name of await io.listSealed()) {
		if (!SEALED_NAME.test(name)) continue;
		const blob = await io.readSealed(name);
		if (await opens(to, blob)) continue;
		const file = await open(from, blob);
		const fresh = await seal(to, file.path, file.content);
		await io.writeSealed(await sealedName(await fileId(to, file.path), fresh), fresh);
		old.push(name);
	}
	for (const name of old) await io.removeSealed(name);
	return old.length;
}

async function openAny(name: string, id: string, blob: Uint8Array, keys: SealKeys, previous: SealKeys[]): Promise<{ file: OpenedFile; stale: boolean }> {
	for (const [i, k] of [keys, ...previous].entries()) {
		let file: OpenedFile;
		try {
			file = await open(k, blob);
		} catch {
			continue;
		}
		if ((await fileId(k, file.path)) !== id) throw new Error(`sealed file ${name} does not match its path`);
		return { file, stale: i > 0 };
	}
	throw new Error(
		`cannot decrypt ${name}.seal. Either the passphrase is wrong, the file is damaged, or it was sealed with an old key ` +
			"after the passphrase was changed with re-encryption: run Sync on the device that sent it, then pull again.",
	);
}

async function opens(keys: SealKeys, blob: Uint8Array): Promise<boolean> {
	try {
		await open(keys, blob);
		return true;
	} catch {
		return false;
	}
}

const TEXT_EXTENSIONS = /\.(md|txt|canvas|base|json|csv|tsv|css|js|html|svg|ya?ml)$/i;

/**
 * Hash used to compare versions of a file. For text files, CRLF counts as LF:
 * git on Windows (core.autocrlf) checks text out with CRLF while other devices
 * have LF, and a folder that git used to track would otherwise show up as
 * "changed on both sides" in every file.
 */
export async function contentHash(path: string, data: Uint8Array): Promise<string> {
	if (!TEXT_EXTENSIONS.test(path) || !data.includes(13)) return sha256Hex(data);
	const out = new Uint8Array(data.length);
	let n = 0;
	for (let i = 0; i < data.length; i++) if (!(data[i] === 13 && data[i + 1] === 10)) out[n++] = data[i];
	return sha256Hex(out.subarray(0, n));
}

/** A sealed file can only name a path inside the vault. */
function isSafePath(path: string): boolean {
	return !!path && !path.startsWith("/") && !path.split("/").some((part) => part === ".." || part === "." || part === "");
}

/** "notes/a.md" -> "notes/a (conflict 2026-10-28 1530).md", unused in the vault. */
export async function freeConflictPath(io: SealIO, path: string, now: Date): Promise<string> {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	const hasExt = dot > slash + 1;
	const stem = hasExt ? path.slice(0, dot) : path;
	const ext = hasExt ? path.slice(dot) : "";
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
	for (let i = 1; ; i++) {
		const candidate = `${stem} (conflict ${stamp}${i > 1 ? ` ${i}` : ""})${ext}`;
		if (!(await io.existsPlain(candidate))) return candidate;
	}
}
