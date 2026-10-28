import { normalizePath, TFile, TFolder, type App } from "obsidian";
import type { SealIO } from "./sync";

export const SEALED_EXT = ".seal";
export const BACKUP_DIR = ".folder-seal-backup";

/**
 * SealIO on top of an Obsidian vault.
 *
 * Plain files are vault paths inside the encrypted folders. They go through
 * the Vault API so the file explorer and open editors notice changes. The
 * sealed folder and backups go through the adapter: nobody needs to see them
 * in the UI.
 *
 * Before a plain file is overwritten or removed, its old version is copied to
 * <encrypted folder>/.folder-seal-backup/<timestamp>/... — inside the ignored
 * folder, so it stays out of git together with everything else there.
 * Obsidian's own trash is not used on purpose: the vault .trash folder may
 * well be committed.
 */
export class VaultIO implements SealIO {
	private readonly stamp = new Date().toISOString().replace(/[:.]/g, "-");

	constructor(
		private readonly app: App,
		private readonly folders: string[],
		private readonly sealedRoot: string,
	) {}

	async listPlain(): Promise<string[]> {
		const out: string[] = [];
		const walk = (f: TFolder) => {
			for (const child of f.children) {
				if (child instanceof TFolder) walk(child);
				else if (child instanceof TFile) out.push(child.path);
			}
		};
		for (const root of this.folders) {
			const folder = this.app.vault.getFolderByPath(root);
			if (folder) walk(folder);
		}
		return out;
	}

	async readPlain(path: string): Promise<Uint8Array> {
		return new Uint8Array(await this.app.vault.readBinary(this.plainFile(path)));
	}

	async writePlain(path: string, data: Uint8Array): Promise<void> {
		const existing = this.app.vault.getFileByPath(path);
		if (existing) {
			await this.backup(path);
			await this.app.vault.modifyBinary(existing, toArrayBuffer(data));
		} else {
			await this.ensureFolder(parentOf(path));
			await this.app.vault.createBinary(path, toArrayBuffer(data));
		}
	}

	async removePlain(path: string): Promise<void> {
		await this.backup(path);
		await this.app.vault.delete(this.plainFile(path));
	}

	async existsPlain(path: string): Promise<boolean> {
		return this.app.vault.adapter.exists(path);
	}

	async listSealed(): Promise<string[]> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.sealedRoot))) return [];
		const { files } = await adapter.list(this.sealedRoot);
		return files
			.map((f) => f.slice(f.lastIndexOf("/") + 1))
			.filter((name) => name.endsWith(SEALED_EXT))
			.map((name) => name.slice(0, -SEALED_EXT.length));
	}

	async readSealed(name: string): Promise<Uint8Array> {
		return new Uint8Array(await this.app.vault.adapter.readBinary(this.sealedPath(name)));
	}

	async writeSealed(name: string, data: Uint8Array): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.sealedRoot))) await adapter.mkdir(this.sealedRoot);
		await adapter.writeBinary(this.sealedPath(name), toArrayBuffer(data));
	}

	async removeSealed(name: string): Promise<void> {
		await this.app.vault.adapter.remove(this.sealedPath(name));
	}

	private async backup(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		const root = this.folders.find((f) => path.startsWith(f + "/"));
		if (!root) throw new Error(`${path} is not in an encrypted folder`);
		const target = normalizePath(`${root}/${BACKUP_DIR}/${this.stamp}/${path.slice(root.length + 1)}`);
		await this.ensureAdapterFolder(parentOf(target));
		await adapter.writeBinary(target, await adapter.readBinary(path));
	}

	private sealedPath(name: string): string {
		return normalizePath(`${this.sealedRoot}/${name}${SEALED_EXT}`);
	}

	private plainFile(path: string): TFile {
		const file = this.app.vault.getFileByPath(path);
		if (!file) throw new Error(`File not found: ${path}`);
		return file;
	}

	private async ensureFolder(path: string): Promise<void> {
		if (!path || this.app.vault.getFolderByPath(path)) return;
		await this.ensureFolder(parentOf(path));
		await this.app.vault.createFolder(path);
	}

	private async ensureAdapterFolder(path: string): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (!path || (await adapter.exists(path))) return;
		await this.ensureAdapterFolder(parentOf(path));
		await adapter.mkdir(path);
	}
}

function parentOf(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
