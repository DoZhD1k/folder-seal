# Folder Seal

[Русская версия](README.ru.md)

An Obsidian plugin that keeps chosen folders of your vault encrypted in git.

You sync your vault through GitHub (or any git host) with the Obsidian Git plugin, but some notes are too personal to sit there in plain text: documents, health, a journal. Folder Seal encrypts those folders before they go to git and decrypts them on your devices. The git host only ever sees ciphertext.

It works on desktop and on mobile, including iOS: plain JavaScript on top of WebCrypto, with no `git-crypt`, no terminal, no external binaries. The interface is in English and Russian, following Obsidian's language.

> **Status: 0.2, early.** The sync logic is covered by tests and has been tried on desktop and iPhone, but keep a backup of your notes.

## How it works

Any folder anywhere in the vault can be encrypted, without hiding the whole section around it:

```text
Health/
  health.md              open, in git as usual
  documents/  🔒         encrypted: not on GitHub at all
Car/
  car.md                 open
  documents/  🔒         encrypted
_sealed/                 encrypted copies of every 🔒 folder — this is what goes to git
```

On your devices the encrypted folders look like any other: notes stay where they are, show up in search, open, and links to them work. They never reach git: the plugin adds them to `.gitignore`. Git gets `_sealed/` instead, with files named like `5e4bf3cc….seal` that reveal neither names nor contents.

Run **Folder Seal: Sync** (the lock icon or the command palette) and the plugin brings everything in line:

- changed here → encrypted into `_sealed/`;
- arrived with a git pull → decrypted into place;
- deletions travel the same way;
- changed on two devices since the last sync → your version stays, the other one is saved next to it as `name (conflict YYYY-MM-DD HHmm).md`. Nothing is lost.

Before a file is overwritten or removed, its previous version is copied to `<folder>/.folder-seal-backup/<timestamp>/`. That is inside the ignored folder, so backups never reach git either.

The plugin does not touch git. Obsidian Git keeps doing the syncing; Folder Seal only encrypts and decrypts.

## Setup

1. Install the plugin: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/DoZhD1k/folder-seal/releases/latest) into `<vault>/.obsidian/plugins/folder-seal/` (or add `DoZhD1k/folder-seal` in the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin), then enable **Folder Seal** in *Settings → Community plugins*.
2. Pick a folder to encrypt: right-click it (long-press on mobile) → **Encrypt this folder**. Repeat for every such folder, or list them in the plugin settings.
3. Run **Folder Seal: Sync**. The first time, the plugin asks you to **create a passphrase**: two fields, at least 12 characters.
4. Commit and push.

**There is no passphrase recovery.** Lose it and the sealed notes are gone. Put it in your password manager.

**If a folder is already in git,** the plugin refuses to encrypt it: `.gitignore` does not stop git from tracking files it already tracks, so they would keep going to GitHub in plain text. Remove it from git first: on a computer, run `git rm -r --cached "Health/documents"` and commit. Old versions of those files stay in git history. The simplest way is to encrypt a new folder and move the files into it.

### Other devices

If you commit `.obsidian/plugins` (Obsidian Git does by default), the plugin and its settings arrive with the next pull. On iPhone, restart Obsidian after the pull so it loads the new plugin.

**Pull first, then Sync.** The plugin asks you to **enter the passphrase**: one field, the same passphrase. The device remembers it from then on.

If Sync asks you to *create* a passphrase (two fields) on a device that should already have one, the sealed folder has not arrived yet. Close the dialog and pull: a second passphrase would split your devices onto different keys.

## Daily workflow

```text
pull  →  Sync  →  work  →  Sync  →  commit & push
```

Sync after pulling to get what other devices sent, and before pushing to send yours. Running Sync more often is harmless: unchanged files produce byte-identical ciphertext, so git sees no change.

Obsidian Git's "commit and sync" button commits first and pulls after. That works too: Sync, press the button, then Sync once more to decrypt what the pull brought in. Sealed files are never edited in place — every version is a new file and the old one is deleted — so git merges two devices' work without conflicts, even when both changed the same note.

## Links to encrypted notes

They work as usual: `[Tests](documents/tests.md)` in an open note opens on every device that has run Sync. On a device that has not, the link is broken until it does.

Mind that **the link text lives in the open note**, so GitHub shows that a file called `tests.md` exists. Not its contents. If the name itself is sensitive, link to it from another encrypted note.

## Passphrase

| You want to | Do this |
| --- | --- |
| Set a passphrase | Run the first Sync in a vault where nothing is encrypted yet. |
| Change the passphrase | **Folder Seal: Change passphrase** — the old one, then the new one twice. Files are not re-encrypted; other devices do not need to enter anything. |
| Someone may know the passphrase | **Folder Seal: Change passphrase and re-encrypt everything**. Every file is encrypted again with a new key, so the old passphrase opens nothing, not even old versions in git history. Sync and push every other device first; afterwards each one asks for the new passphrase once. |
| Not keep it on a device | Turn off "Remember passphrase" to be asked every session, or run **Forget passphrase on this device**. |

If another device had an unpushed edit during a re-encryption, nothing is lost: the plugin reads it with the old key and re-encrypts it. A conflict copy with the file's previous text may appear next to it; you can delete it.

## When something goes wrong

- **App data is gone** (reinstalled Obsidian, new phone, storage cleared): clone the vault, Sync, enter the passphrase — everything is decrypted from git. If decrypted files were still on the device, identical ones match and different ones become conflict copies. Nothing is deleted.
- **"wrong passphrase"** — nothing was touched.
- **"cannot decrypt …"** — a damaged file, or one sealed with a key this device does not know (after a re-encryption, from a device that has not synced since). Run Sync on that device, push, then pull here. Until then Sync changes nothing.
- **Renamed an encrypted folder** — the plugin updates its list and `.gitignore` by itself.
- **Removed a folder from the list** ("Stop encrypting this folder") — it is no longer synced, but stays in `.gitignore`, so it does not go to git in plain text. Its encrypted copies stay in `_sealed/`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Encrypted folders | — | One per line, path from the vault root. Each is added to `.gitignore` automatically. |
| Sealed folder | `_sealed` | Encrypted copies of all the folders. Commit this one. |
| Hide the sealed folder | on | Keep it out of the file list. |
| Remember passphrase on this device | on | Keeps the key in this device's app storage (not in the vault, not in git). |

Settings live in `.obsidian/plugins/folder-seal/data.json` and sync with the vault. So **the names of encrypted folders are visible on GitHub**; their contents are not.

## Security

**Protects against:** someone who gets your git repository — a leaked GitHub account, token, or the host itself. They see the names of encrypted folders (from the settings and `.gitignore`), file count, approximate sizes, and when files changed. Not file names, not contents.

**Does not protect against:** someone with access to your unlocked device. Decrypted notes are ordinary files there. Use full-disk encryption (BitLocker, FileVault) and a phone passcode.

Details:

- **Master key:** 96 random bytes, split into three 256-bit keys: content, file names, IVs.
- **The passphrase** locks the master key: PBKDF2-SHA-256, 600,000 iterations, random 16-byte salt → an AES-256-GCM key. The locked master key sits in `_sealed/folder-seal.json` with the salt. Changing the passphrase re-locks only that.
- **Contents:** AES-256-GCM. Every file is authenticated, so tampering or a wrong key is detected and the sync stops before writing anything.
- **File names:** each sealed file is named by an HMAC-SHA-256 of its path, so names are hidden but stable across devices. The real path is inside the ciphertext.
- **Deterministic encryption:** the IV is an HMAC of the payload, so identical input gives identical output. This keeps git history clean, at the cost that identical files are recognisable as identical. `git-crypt` makes the same trade-off.

### Formats

```text
_sealed/folder-seal.json
  { version: 2, keyId, kdf, iterations, salt, lockedKey }
  lockedKey = IV (12) | AES-256-GCM(master key), key = PBKDF2(passphrase, salt)
  keyId     = hex(SHA-256(master key))[0..16]

_sealed/<id>.<version>.seal
  "FSL1" (4 bytes) | IV (12 bytes) | AES-256-GCM ciphertext + tag
  payload = u32 BE header length | JSON {"v":1,"path":"path/from/vault/root"} | raw file bytes
  IV      = HMAC-SHA-256(iv key, payload)[0..12]
  id      = hex(HMAC-SHA-256(name key, path))[0..32]
  version = hex(SHA-256(sealed bytes))[0..16]
```

## Upgrading from 0.1

0.2 cannot read a 0.1 sealed folder: the key format changed. Before upgrading, run Sync with 0.1 on every device so the decrypted files are in place. Then delete the old sealed folder, update the plugin, add the folder to the list and run Sync — it creates a new passphrase and encrypts everything again. On other devices: pull, delete the old decrypted files, Sync.

## Limitations

- Sync is manual. Automatic runs around Obsidian Git pull/push are planned.
- Renaming a file is a delete plus a new file.
- Every sync reads and hashes all encrypted folders. Fine for notes; slow for gigabytes of media.

## Development

```bash
npm install
npm test          # unit tests: crypto, keys, multi-device sync through git
npm run dev       # rebuild main.js on change
npm run build     # type-check + production build
```

To try it live, copy `main.js`, `manifest.json` and `styles.css` into a test vault's `.obsidian/plugins/folder-seal/` and reload Obsidian.

```text
src/crypto.ts     file encryption and ids — pure WebCrypto
src/keyring.ts    master key, passphrase, folder-seal.json
src/sync.ts       three-way reconcile and re-encryption over an abstract SealIO
src/vault-io.ts   SealIO on top of the Obsidian vault, backups
src/git-index.ts  reads .git/index: refuses to encrypt a folder git already tracks
src/i18n.ts       interface strings, en and ru
src/main.ts       plugin: commands, folder menu, passphrase dialogs, settings, .gitignore guard
tests/            vitest; devices and git merges simulated in memory
```

`sync.ts` and `keyring.ts` know nothing about Obsidian, so all rules are tested in Node. If you change them, add a scenario to `tests/`.

## License

MIT
