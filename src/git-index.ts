/**
 * Lists the paths in a git index file (.git/index), versions 2–4.
 *
 * Used for one safety check: a folder that git already tracks keeps going to
 * the remote in plain text even after it is added to .gitignore. Reading the
 * index file directly works on mobile too, where there is no git binary.
 * Returns null for anything it does not understand; the check is then skipped.
 */
export function readIndexPaths(data: Uint8Array): string[] | null {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	if (data.length < 12 || new TextDecoder().decode(data.subarray(0, 4)) !== "DIRC") return null;
	const version = view.getUint32(4);
	if (version < 2 || version > 4) return null;
	const count = view.getUint32(8);
	const decoder = new TextDecoder();
	const paths: string[] = [];
	let previous: Uint8Array = new Uint8Array(0);
	let p = 12;
	try {
		for (let i = 0; i < count; i++) {
			const start = p;
			// ctime, mtime, dev, ino, mode, uid, gid, size, sha-1
			p += 40 + 20;
			const flags = view.getUint16(p);
			p += 2;
			if (version >= 3 && flags & 0x4000) p += 2;
			let name: Uint8Array;
			if (version === 4) {
				// Prefix compression: strip N bytes from the previous path, then a NUL-terminated suffix.
				let c = data[p++];
				let strip = c & 0x7f;
				while (c & 0x80) {
					c = data[p++];
					strip = ((strip + 1) << 7) | (c & 0x7f);
				}
				const end = data.indexOf(0, p);
				if (end < 0) return null;
				name = new Uint8Array([...previous.subarray(0, previous.length - strip), ...data.subarray(p, end)]);
				p = end + 1;
			} else {
				const end = data.indexOf(0, p);
				if (end < 0) return null;
				name = data.subarray(p, end);
				// Entries are NUL-padded to a multiple of 8 bytes (at least one NUL).
				p = start + Math.ceil((p - start + name.length + 1) / 8) * 8;
			}
			paths.push(decoder.decode(name));
			previous = name;
		}
	} catch {
		return null;
	}
	return paths;
}
