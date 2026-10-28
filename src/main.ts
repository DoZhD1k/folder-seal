import { App, Modal, Notice, normalizePath, Plugin, PluginSettingTab, Setting, TFolder } from "obsidian";
import { fromBase64, importKeys, toBase64, type SealKeys } from "./crypto";
import { readIndexPaths } from "./git-index";
import { t } from "./i18n";
import { keyIdOf, lockMasterKey, newMasterKey, parseConfig, unlockMasterKey, type SealConfig } from "./keyring";
import { reconcile, reseal, type SyncReport, type SyncState } from "./sync";
import { VaultIO } from "./vault-io";

interface Settings {
	/** Vault paths of the folders to encrypt. */
	folders: string[];
	/** Where the encrypted copies of all folders live. */
	sealedFolder: string;
	hideSealedFolder: boolean;
	rememberKey: boolean;
}

const DEFAULT_SETTINGS: Settings = {
	folders: [],
	sealedFolder: "_sealed",
	hideSealedFolder: true,
	rememberKey: true,
};

const CONFIG_FILE = "folder-seal.json";
// Device-local storage (Obsidian keeps it per vault, outside the vault folder).
const KEYRING_STORAGE = "folder-seal-keyring";
const STATE_STORAGE = "folder-seal-state-v2";
const LEGACY_STORAGE = ["folder-seal-key", "folder-seal-state"];
/** How many keys from before a re-encryption a device keeps to read late files. */
const PREVIOUS_KEYS = 3;

interface Keyring {
	current: string;
	previous: string[];
}

interface StoredState {
	sealedFolder: string;
	files: SyncState;
}

export default class FolderSealPlugin extends Plugin {
	settings!: Settings;
	private master: Uint8Array | null = null;
	private previous: Uint8Array[] = [];
	private busy = false;
	private styleEl!: HTMLStyleElement;

	async onload() {
		await this.loadSettings();
		for (const key of LEGACY_STORAGE) this.app.saveLocalStorage(key, null);
		this.loadKeyring();

		this.styleEl = document.head.createEl("style");
		this.register(() => this.styleEl.remove());
		this.refreshStyles();

		this.addRibbonIcon("lock", t("ribbon"), () => this.sync());
		this.addCommand({ id: "sync", name: t("cmdSync"), callback: () => this.sync() });
		this.addCommand({ id: "change-passphrase", name: t("cmdChange"), callback: () => this.changePassphrase(false) });
		this.addCommand({ id: "reencrypt", name: t("cmdReencrypt"), callback: () => this.changePassphrase(true) });
		this.addCommand({
			id: "forget-key",
			name: t("cmdForget"),
			callback: () => this.forgetKey(),
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFolder) || file.isRoot()) return;
				if (this.folders.includes(file.path)) {
					menu.addItem((item) =>
						item.setTitle(t("menuStop")).setIcon("lock-open").onClick(() => this.removeFolder(file.path)),
					);
				} else if (!this.folderProblem(file.path)) {
					menu.addItem((item) => item.setTitle(t("menuEncrypt")).setIcon("lock").onClick(() => this.addFolder(file.path)));
				}
			}),
		);

		// A renamed or moved encrypted folder must stay encrypted and ignored,
		// or its files would go to git in plain text with the next commit.
		this.registerEvent(
			this.app.vault.on("rename", async (file, oldPath) => {
				if (!(file instanceof TFolder)) return;
				let changed = false;
				const moved = (f: string) => {
					if (f !== oldPath && !f.startsWith(oldPath + "/")) return f;
					changed = true;
					return file.path + f.slice(oldPath.length);
				};
				this.settings.folders = this.settings.folders.map((f) => moved(normalizePath(f)));
				if (this.settings.sealedFolder) this.settings.sealedFolder = moved(normalizePath(this.settings.sealedFolder));
				if (!changed) return;
				await this.saveSettings();
				await this.ensureGitignored();
				await this.ensureGitattributes();
			}),
		);

		this.addSettingTab(new FolderSealSettingTab(this.app, this));
	}

	async loadSettings() {
		const data = (await this.loadData()) ?? {};
		// 0.1 had a single plain folder.
		if (typeof data.plainFolder === "string" && !Array.isArray(data.folders)) data.folders = [data.plainFolder];
		delete data.plainFolder;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.refreshStyles();
	}

	/** data.json changed under us: another device's settings arrived with a git pull. */
	async onExternalSettingsChange() {
		await this.loadSettings();
		this.refreshStyles();
	}

	get folders(): string[] {
		return this.settings.folders.map((f) => normalizePath(f.trim())).filter((f) => f && f !== "/");
	}

	get sealedRoot(): string {
		return normalizePath(this.settings.sealedFolder.trim());
	}

	private managed = (path: string) => this.folders.some((f) => path.startsWith(f + "/"));

	// ---- sync -------------------------------------------------------------

	async sync() {
		if (this.busy) return;
		this.busy = true;
		try {
			await this.prepare();
			const keys = await this.unlock();
			if (!keys) return;
			const report = await this.runSync(keys);
			new Notice(describe(report), report.conflicts.length || report.orphaned ? 20000 : 5000);
		} catch (e) {
			fail(e);
		} finally {
			this.busy = false;
		}
	}

	/** Checks and git files that must be right before anything is decrypted. */
	private async prepare() {
		this.validate();
		await this.ensureGitignored();
		await this.ensureGitattributes();
		await this.ensureNotTracked(this.folders);
	}

	private async runSync(keys: SealKeys): Promise<SyncReport> {
		const stored = this.loadState();
		const base = stored?.sealedFolder === this.sealedRoot ? stored.files : {};
		const io = new VaultIO(this.app, this.folders, this.sealedRoot);
		const previousKeys = await Promise.all(this.previous.map(importKeys));
		const { state, report } = await reconcile(io, keys, base, { managed: this.managed, previousKeys });
		this.saveState({ sealedFolder: this.sealedRoot, files: state });
		return report;
	}

	// ---- keys -------------------------------------------------------------

	/** Keys for the current config: from memory or device storage, else asks. Creates everything on first use. */
	private async unlock(): Promise<SealKeys | null> {
		const config = await this.readConfig();
		if (!config) return this.create();
		if (this.master && (await keyIdOf(this.master)) === config.keyId) return importKeys(this.master);

		const answer = await new PassphraseModal(this.app, "unlock", this.master ? t("unlockChanged") : undefined).ask();
		if (!answer) return null;
		const master = await progress(() => unlockMasterKey(config, answer.current));
		await this.setMaster(master);
		new Notice(`Folder Seal: ${t("unlocked")}`);
		return importKeys(master);
	}

	private async create(): Promise<SealKeys | null> {
		const answer = await new PassphraseModal(this.app, "create").ask();
		if (!answer) return null;
		const master = newMasterKey();
		await this.writeConfig(await progress(() => lockMasterKey(master, answer.next)));
		await this.setMaster(master);
		return importKeys(master);
	}

	async changePassphrase(reencrypt: boolean) {
		if (this.busy) return;
		this.busy = true;
		try {
			this.validate();
			const config = await this.readConfig();
			if (!config) throw new Error(t("errNoConfig"));
			const answer = await new PassphraseModal(this.app, reencrypt ? "reencrypt" : "change").ask();
			if (!answer) return;
			const master = await progress(() => unlockMasterKey(config, answer.current));
			await this.setMaster(master);

			if (!reencrypt) {
				await this.writeConfig(await progress(() => lockMasterKey(master, answer.next, config.iterations)));
				new Notice(`Folder Seal: ${t("passphraseChanged")}`, 15000);
				return;
			}

			// Bring everything in line under the old key, then move to a new one.
			// The config goes first: if this is interrupted, the old key is kept
			// as a previous key, so the next Sync reads leftovers and re-seals them.
			await this.prepare();
			const oldKeys = await importKeys(master);
			await this.runSync(oldKeys);
			const fresh = newMasterKey();
			await this.writeConfig(await progress(() => lockMasterKey(fresh, answer.next, config.iterations)));
			await this.setMaster(fresh);
			const count = await reseal(new VaultIO(this.app, this.folders, this.sealedRoot), oldKeys, await importKeys(fresh));
			new Notice(`Folder Seal: ${t("reencrypted", count)}`, 20000);
		} catch (e) {
			fail(e);
		} finally {
			this.busy = false;
		}
	}

	forgetKey() {
		this.master = null;
		this.previous = [];
		this.app.saveLocalStorage(KEYRING_STORAGE, null);
		new Notice(`Folder Seal: ${t("forgotten")}`);
	}

	/** Makes `master` the current key; a different previous one is kept to read late files. */
	private async setMaster(master: Uint8Array) {
		if (this.master && (await keyIdOf(this.master)) !== (await keyIdOf(master))) {
			this.previous = [this.master, ...this.previous].slice(0, PREVIOUS_KEYS);
		}
		this.master = master;
		this.saveKeyring();
	}

	private loadKeyring() {
		const raw = this.app.loadLocalStorage(KEYRING_STORAGE);
		if (!raw) return;
		try {
			const ring = JSON.parse(raw) as Keyring;
			this.master = fromBase64(ring.current);
			this.previous = ring.previous.map(fromBase64);
		} catch {
			this.app.saveLocalStorage(KEYRING_STORAGE, null);
		}
	}

	saveKeyring() {
		if (!this.settings.rememberKey || !this.master) {
			this.app.saveLocalStorage(KEYRING_STORAGE, null);
			return;
		}
		const ring: Keyring = { current: toBase64(this.master), previous: this.previous.map(toBase64) };
		this.app.saveLocalStorage(KEYRING_STORAGE, JSON.stringify(ring));
	}

	// ---- folders ----------------------------------------------------------

	/** Why `path` cannot be added as an encrypted folder, or null if it can. */
	private folderProblem(path: string): string | null {
		const sealed = this.sealedRoot;
		if (path.split("/").some((part) => part.startsWith("."))) return t("errHidden", path);
		const inside = (a: string, b: string) => a === b || a.startsWith(b + "/");
		for (const other of [...this.folders.filter((f) => f !== path), sealed]) {
			if (other && (inside(path, other) || inside(other, path))) return t("errOverlap", path, other);
		}
		return null;
	}

	private validate() {
		const sealed = this.sealedRoot;
		if (!sealed || sealed === "/" || /\s/.test(sealed) || sealed.startsWith(".")) throw new Error(t("errSealedFolder"));
		if (!this.folders.length) throw new Error(t("errNoFolders"));
		for (const f of this.folders) {
			const problem = this.folderProblem(f);
			if (problem) throw new Error(problem);
		}
	}

	async addFolder(path: string) {
		try {
			const problem = this.folderProblem(path);
			if (problem) throw new Error(problem);
			await this.ensureNotTracked([path]);
			this.settings.folders = [...this.folders, path];
			await this.saveSettings();
			await this.ensureGitignored();
			await this.ensureGitattributes();
			new Notice(`Folder Seal: ${t("folderAdded", path)}`, 10000);
		} catch (e) {
			fail(e);
		}
	}

	async removeFolder(path: string) {
		this.settings.folders = this.folders.filter((f) => f !== path);
		await this.saveSettings();
		new Notice(`Folder Seal: ${t("folderRemoved", path)}`, 20000);
	}

	// ---- git safety -------------------------------------------------------

	/**
	 * The whole point is that encrypted folders never reach git. Make sure the
	 * vault .gitignore says so before anything is decrypted into them. Lines are
	 * only ever added: a folder that leaves the list stays ignored.
	 */
	async ensureGitignored() {
		const adapter = this.app.vault.adapter;
		const current = (await adapter.exists(".gitignore")) ? await adapter.read(".gitignore") : "";
		const lines = new Set(current.split(/\r?\n/).map((line) => line.trim()));
		const missing = this.folders.filter((f) => ![f, `${f}/`, `/${f}`, `/${f}/`].some((v) => lines.has(gitignoreEscape(v))));
		if (!missing.length) return;
		const prefix = current && !current.endsWith("\n") ? "\n" : "";
		const block = missing.map((f) => `/${gitignoreEscape(f)}/\n`).join("");
		await adapter.write(".gitignore", `${current}${prefix}\n# Folder Seal: decrypted files stay on this device\n${block}`);
		new Notice(`Folder Seal: ${t("gitignoreAdded", missing.join(", "))}`);
	}

	/**
	 * Small ciphertexts often contain no NUL byte, so git may take them for text
	 * and rewrite line endings (core.autocrlf), which breaks decryption on the
	 * next device. Mark the sealed folder as binary.
	 */
	async ensureGitattributes() {
		const sealed = this.sealedRoot;
		if (!sealed || /\s/.test(sealed)) return;
		const adapter = this.app.vault.adapter;
		const rule = `/${sealed}/** binary`;
		const current = (await adapter.exists(".gitattributes")) ? await adapter.read(".gitattributes") : "";
		if (current.split(/\r?\n/).some((line) => line.trim() === rule)) return;
		const prefix = current && !current.endsWith("\n") ? "\n" : "";
		await adapter.write(".gitattributes", `${current}${prefix}# Folder Seal: encrypted files, never touch line endings\n${rule}\n`);
	}

	/**
	 * .gitignore does not stop git from tracking files it already tracks. If an
	 * encrypted folder is in the git index, its files would keep going to the
	 * remote in plain text, so refuse. Skipped when there is no readable index
	 * (no git, or the vault is a subfolder of the repository).
	 */
	private async ensureNotTracked(folders: string[]) {
		const adapter = this.app.vault.adapter;
		let paths: string[] | null = null;
		try {
			if (await adapter.exists(".git/index")) paths = readIndexPaths(new Uint8Array(await adapter.readBinary(".git/index")));
		} catch {
			return;
		}
		if (!paths) return;
		for (const f of folders) {
			if (paths.some((p) => p.startsWith(f + "/"))) throw new Error(t("errTracked", f));
		}
	}

	// ---- storage ----------------------------------------------------------

	private async readConfig(): Promise<SealConfig | null> {
		const path = normalizePath(`${this.sealedRoot}/${CONFIG_FILE}`);
		if (!(await this.app.vault.adapter.exists(path))) return null;
		return parseConfig(await this.app.vault.adapter.read(path));
	}

	private async writeConfig(config: SealConfig) {
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(this.sealedRoot))) await adapter.mkdir(this.sealedRoot);
		await adapter.write(normalizePath(`${this.sealedRoot}/${CONFIG_FILE}`), JSON.stringify(config, null, "\t") + "\n");
	}

	private loadState(): StoredState | null {
		const raw = this.app.loadLocalStorage(STATE_STORAGE);
		return raw ? (JSON.parse(raw) as StoredState) : null;
	}

	private saveState(state: StoredState) {
		this.app.saveLocalStorage(STATE_STORAGE, JSON.stringify(state));
	}

	/** A lock after each encrypted folder in the file list; optionally hides the sealed folder. */
	private refreshStyles() {
		if (!this.styleEl) return;
		const q = (s: string) => JSON.stringify(s);
		const rules = this.folders.map(
			(f) => `.nav-folder-title[data-path=${q(f)}] .nav-folder-title-content::after { content: " 🔒"; font-size: 0.85em; }`,
		);
		if (this.settings.hideSealedFolder && this.sealedRoot) {
			rules.push(`.nav-folder:has(> .nav-folder-title[data-path=${q(this.sealedRoot)}]) { display: none; }`);
		}
		this.styleEl.textContent = rules.join("\n");
	}
}

/** Escapes characters that mean something in a .gitignore pattern. */
function gitignoreEscape(path: string): string {
	return path.replace(/[\\*?[\]!#]/g, "\\$&");
}

async function progress<T>(task: () => Promise<T>): Promise<T> {
	const notice = new Notice(`Folder Seal: ${t("deriving")}`, 0);
	try {
		return await task();
	} finally {
		notice.hide();
	}
}

function fail(e: unknown) {
	console.error("Folder Seal", e);
	new Notice(`Folder Seal: ${e instanceof Error ? e.message : String(e)}`, 20000);
}

function describe(report: SyncReport): string {
	const parts: string[] = [];
	if (report.restored.length) parts.push(t("decrypted", report.restored.length));
	if (report.sealed.length) parts.push(t("encrypted", report.sealed.length));
	const removed = report.removedPlain.length + report.removedSealed.length;
	if (removed) parts.push(t("removed", removed));
	let text = `Folder Seal: ${parts.length ? parts.join(", ") : t("alreadyInSync")}`;
	if (report.conflicts.length) text += `\n\n${t("conflicts")}\n${report.conflicts.join("\n")}`;
	if (report.orphaned) text += `\n\n${t("orphaned", report.orphaned)}`;
	return text;
}

type Mode = "create" | "unlock" | "change" | "reencrypt";

interface Answer {
	/** The passphrase that opens the vault now (unlock, change, reencrypt). */
	current: string;
	/** The passphrase to set (create, change, reencrypt). */
	next: string;
}

class PassphraseModal extends Modal {
	private resolve: (value: Answer | null) => void = () => {};
	private done = false;

	constructor(
		app: App,
		private readonly mode: Mode,
		private readonly message?: string,
	) {
		super(app);
	}

	ask(): Promise<Answer | null> {
		return new Promise((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}

	onOpen() {
		const { contentEl, mode } = this;
		const asksCurrent = mode !== "create";
		const asksNext = mode !== "unlock";
		this.setTitle(
			{ create: t("createTitle"), unlock: t("unlockTitle"), change: t("changeTitle"), reencrypt: t("reencryptTitle") }[mode],
		);

		if (this.message) contentEl.createEl("p").createEl("strong", { text: this.message });
		if (mode === "create") {
			contentEl.createEl("p", { text: t("createIntro") });
			// A fresh device that syncs before its first pull lands here too, and a
			// new passphrase would split the devices. Make that impossible to miss.
			contentEl.createEl("p").createEl("strong", { text: t("createOtherDevice") });
			contentEl.createEl("p", { text: t("createNoRecovery") });
		}
		if (mode === "change") contentEl.createEl("p", { text: t("changeIntro") });
		if (mode === "reencrypt") {
			contentEl.createEl("p", { text: t("reencryptIntro") });
			contentEl.createEl("p").createEl("strong", { text: t("reencryptSyncFirst") });
		}

		const values = { current: "", next: "", repeat: "" };
		const submit = () => {
			if (asksCurrent && !values.current) return;
			if (asksNext) {
				if (!values.next) return;
				if (values.next !== values.repeat) return void new Notice(t("errMismatch"));
				if (values.next.length < 12) return void new Notice(t("errShort"));
			}
			this.finish({ current: values.current, next: values.next });
		};
		const field = (name: string, key: keyof typeof values) =>
			new Setting(contentEl).setName(name).addText((text) => {
				text.inputEl.type = "password";
				text.onChange((v) => (values[key] = v));
				text.inputEl.addEventListener("keydown", (e) => e.key === "Enter" && submit());
			});

		if (asksCurrent) field(mode === "unlock" ? t("fieldPassphrase") : t("fieldCurrent"), "current");
		if (asksNext) {
			field(mode === "create" ? t("fieldPassphrase") : t("fieldNew"), "next");
			field(mode === "create" ? t("fieldRepeat") : t("fieldRepeatNew"), "repeat");
		}
		const button = { create: t("btnCreate"), unlock: t("btnUnlock"), change: t("btnChange"), reencrypt: t("btnChange") }[mode];
		new Setting(contentEl).addButton((b) => b.setButtonText(button).setCta().onClick(submit));
	}

	onClose() {
		this.contentEl.empty();
		this.finish(null);
	}

	private finish(value: Answer | null) {
		if (this.done) return;
		this.done = true;
		this.resolve(value);
		this.close();
	}
}

class FolderSealSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: FolderSealPlugin,
	) {
		super(app, plugin);
	}

	display() {
		const { containerEl, plugin } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t("setFolders"))
			.setDesc(t("setFoldersDesc"))
			.addTextArea((text) => {
				text.setPlaceholder("Здоровье/документы\nМашина/документы").setValue(plugin.settings.folders.join("\n"));
				text.inputEl.rows = 5;
				text.inputEl.addClass("folder-seal-folders");
				text.onChange(async (v) => {
					plugin.settings.folders = v.split("\n").map((line) => line.trim()).filter(Boolean);
					await plugin.saveSettings();
				});
				// Protect new folders as soon as the user is done typing, not only on the next Sync.
				text.inputEl.addEventListener("blur", () => void plugin.ensureGitignored());
			});

		new Setting(containerEl)
			.setName(t("setSealed"))
			.setDesc(t("setSealedDesc"))
			.addText((text) =>
				text.setValue(plugin.settings.sealedFolder).onChange(async (v) => {
					plugin.settings.sealedFolder = v.trim();
					await plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(t("setHide"))
			.setDesc(t("setHideDesc"))
			.addToggle((toggle) =>
				toggle.setValue(plugin.settings.hideSealedFolder).onChange(async (v) => {
					plugin.settings.hideSealedFolder = v;
					await plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(t("setRemember"))
			.setDesc(t("setRememberDesc"))
			.addToggle((toggle) =>
				toggle.setValue(plugin.settings.rememberKey).onChange(async (v) => {
					plugin.settings.rememberKey = v;
					await plugin.saveSettings();
					plugin.saveKeyring();
				}),
			);

		new Setting(containerEl).setName(t("setPassphrase")).setHeading();

		new Setting(containerEl)
			.setName(t("cmdChange"))
			.setDesc(t("changeIntro"))
			.addButton((b) => b.setButtonText(t("btnChange")).onClick(() => plugin.changePassphrase(false)));

		new Setting(containerEl)
			.setName(t("cmdReencrypt"))
			.setDesc(t("reencryptIntro"))
			.addButton((b) => b.setButtonText(t("btnChange")).setWarning().onClick(() => plugin.changePassphrase(true)));

		new Setting(containerEl)
			.setName(t("cmdForget"))
			.setDesc(t("setForgetDesc"))
			.addButton((b) => b.setButtonText(t("btnForget")).onClick(() => plugin.forgetKey()));
	}
}
