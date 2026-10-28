// All crypto goes through WebCrypto, which exists on desktop (Electron),
// iOS/Android (Capacitor webview) and Node 20+ — no native code needed.

const subtle = globalThis.crypto.subtle;

const MAGIC = new TextEncoder().encode("FSL1");
const IV_LENGTH = 12;
const KEY_BYTES = 32;

export const DEFAULT_ITERATIONS = 600_000;

export interface SealKeys {
	/** AES-256-GCM key for file contents. */
	aes: CryptoKey;
	/** HMAC key that turns a relative path into a stable, opaque file id. */
	name: CryptoKey;
	/** HMAC key that derives the IV from the payload (deterministic encryption). */
	iv: CryptoKey;
}

export interface OpenedFile {
	path: string;
	content: Uint8Array;
}

/**
 * Derives key material from a passphrase with PBKDF2-SHA-256. Every 32 bytes
 * of output cost a full run of the iterations, so ask only for what you need.
 */
export async function deriveRawKey(passphrase: string, salt: Uint8Array, iterations: number, bytes = KEY_BYTES * 3): Promise<Uint8Array> {
	const base = await subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveBits"]);
	const bits = await subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
		base,
		bytes * 8,
	);
	return new Uint8Array(bits);
}

/** Splits a 96-byte master key into the three working keys. */
export async function importKeys(raw: Uint8Array): Promise<SealKeys> {
	if (raw.length !== KEY_BYTES * 3) throw new Error("Invalid key length");
	const part = (i: number) => raw.slice(i * KEY_BYTES, (i + 1) * KEY_BYTES);
	const hmac = { name: "HMAC", hash: "SHA-256" };
	return {
		aes: await subtle.importKey("raw", part(0), "AES-GCM", false, ["encrypt", "decrypt"]),
		name: await subtle.importKey("raw", part(1), hmac, false, ["sign"]),
		iv: await subtle.importKey("raw", part(2), hmac, false, ["sign"]),
	};
}

export function randomBytes(length: number): Uint8Array {
	return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** Stable id for a path: the same path always maps to the same sealed file name. */
export async function fileId(keys: SealKeys, path: string): Promise<string> {
	const mac = await subtle.sign("HMAC", keys.name, new TextEncoder().encode(path));
	return toHex(new Uint8Array(mac)).slice(0, 32);
}

/**
 * Encrypts path + content into one blob: MAGIC | IV | AES-GCM(ciphertext+tag).
 *
 * The IV is an HMAC of the payload, so identical input gives identical output.
 * That keeps git from seeing a "change" on every sync when nothing changed —
 * the same trade-off git-crypt makes (equal files are recognisable as equal).
 */
export async function seal(keys: SealKeys, path: string, content: Uint8Array): Promise<Uint8Array> {
	const payload = encodePayload(path, content);
	const mac = await subtle.sign("HMAC", keys.iv, payload as BufferSource);
	const iv = new Uint8Array(mac).slice(0, IV_LENGTH);
	const cipher = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, keys.aes, payload as BufferSource));
	return concat(MAGIC, iv, cipher);
}

export async function open(keys: SealKeys, blob: Uint8Array): Promise<OpenedFile> {
	if (blob.length < MAGIC.length + IV_LENGTH || !equalBytes(blob.subarray(0, MAGIC.length), MAGIC)) {
		throw new Error("Not a Folder Seal file");
	}
	const iv = blob.slice(MAGIC.length, MAGIC.length + IV_LENGTH);
	const cipher = blob.slice(MAGIC.length + IV_LENGTH);
	let payload: Uint8Array;
	try {
		payload = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv }, keys.aes, cipher));
	} catch {
		throw new Error("Cannot decrypt: wrong passphrase or corrupted file");
	}
	return decodePayload(payload);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
	return toHex(new Uint8Array(await subtle.digest("SHA-256", data as BufferSource)));
}

// Payload layout: u32 BE header length | JSON header | raw content bytes.
function encodePayload(path: string, content: Uint8Array): Uint8Array {
	const header = new TextEncoder().encode(JSON.stringify({ v: 1, path }));
	const length = new Uint8Array(4);
	new DataView(length.buffer).setUint32(0, header.length);
	return concat(length, header, content);
}

function decodePayload(payload: Uint8Array): OpenedFile {
	const headerLength = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
	const header = JSON.parse(new TextDecoder().decode(payload.subarray(4, 4 + headerLength)));
	if (header.v !== 1 || typeof header.path !== "string") throw new Error("Unsupported Folder Seal file version");
	return { path: header.path, content: payload.slice(4 + headerLength) };
}

export function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function toBase64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

export function fromBase64(text: string): Uint8Array {
	return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
