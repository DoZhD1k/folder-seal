import { concat, DEFAULT_ITERATIONS, deriveRawKey, fromBase64, randomBytes, sha256Hex, toBase64 } from "./crypto";

/**
 * Files are encrypted with a random master key, not with the passphrase
 * itself. The passphrase only locks the master key, and the locked key lives
 * in the sealed folder next to the files. So:
 * - changing the passphrase re-locks one small file and leaves every sealed
 *   file as it is; devices that remember the master key keep working;
 * - re-encrypting everything means a new master key (and a new key id).
 */

export const MASTER_KEY_BYTES = 96;
const LOCK_KEY_BYTES = 32;
const IV_LENGTH = 12;
const AAD = new TextEncoder().encode("folder-seal master key v2");

/** `folder-seal.json` in the sealed folder. Travels through git; useless without the passphrase. */
export interface SealConfig {
	version: 2;
	/** Short hash of the master key. Changes only when everything is re-encrypted. */
	keyId: string;
	kdf: "PBKDF2-SHA-256";
	iterations: number;
	salt: string;
	/** IV | AES-256-GCM(master key), with a key derived from the passphrase. */
	lockedKey: string;
}

export function newMasterKey(): Uint8Array {
	return randomBytes(MASTER_KEY_BYTES);
}

export async function keyIdOf(master: Uint8Array): Promise<string> {
	return (await sha256Hex(master)).slice(0, 16);
}

export async function lockMasterKey(master: Uint8Array, passphrase: string, iterations = DEFAULT_ITERATIONS): Promise<SealConfig> {
	const salt = randomBytes(16);
	const iv = randomBytes(IV_LENGTH);
	const lockKey = await deriveLockKey(passphrase, salt, iterations);
	const locked = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: AAD }, lockKey, master as BufferSource),
	);
	return {
		version: 2,
		keyId: await keyIdOf(master),
		kdf: "PBKDF2-SHA-256",
		iterations,
		salt: toBase64(salt),
		lockedKey: toBase64(concat(iv, locked)),
	};
}

export async function unlockMasterKey(config: SealConfig, passphrase: string): Promise<Uint8Array> {
	const lockKey = await deriveLockKey(passphrase, fromBase64(config.salt), config.iterations);
	const blob = fromBase64(config.lockedKey);
	let master: Uint8Array;
	try {
		master = new Uint8Array(
			await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: blob.slice(0, IV_LENGTH) as BufferSource, additionalData: AAD },
				lockKey,
				blob.slice(IV_LENGTH) as BufferSource,
			),
		);
	} catch {
		throw new Error("wrong passphrase");
	}
	if ((await keyIdOf(master)) !== config.keyId) throw new Error("folder-seal.json is damaged: key id does not match");
	return master;
}

export function parseConfig(text: string): SealConfig {
	const config = JSON.parse(text) as SealConfig | { version: number };
	if (config.version === 1) {
		throw new Error("this sealed folder was made by Folder Seal 0.1, which 0.2 cannot read. See the README: “Upgrading from 0.1”.");
	}
	if (config.version !== 2) throw new Error(`unsupported folder-seal.json version ${config.version}`);
	return config as SealConfig;
}

async function deriveLockKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
	const raw = await deriveRawKey(passphrase, salt, iterations, LOCK_KEY_BYTES);
	return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}
