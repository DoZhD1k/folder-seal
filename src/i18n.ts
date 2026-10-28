import { getLanguage } from "obsidian";

const en = {
	ribbon: "Folder Seal: sync",
	cmdSync: "Sync (decrypt incoming, encrypt outgoing)",
	cmdChange: "Change passphrase",
	cmdReencrypt: "Change passphrase and re-encrypt everything",
	cmdForget: "Forget passphrase on this device",
	forgotten: "Passphrase forgotten on this device",
	menuEncrypt: "Encrypt this folder",
	menuStop: "Stop encrypting this folder",

	deriving: "Checking the passphrase…",
	unlocked: "Unlocked",
	alreadyInSync: "already in sync",
	decrypted: "decrypted {0}",
	encrypted: "encrypted {0}",
	removed: "removed {0}",
	conflicts: "Both devices changed these files. Your version stays, the other one is saved next to it:",
	orphaned: "{0} encrypted files belong to folders that are no longer in the list and were left as they are.",
	gitignoreAdded: "Added to .gitignore: {0}",
	folderAdded: "{0} is now encrypted. Run Sync to encrypt its files.",
	folderRemoved:
		"{0} is no longer encrypted or synced. Its files stay on this device and stay in .gitignore, so they do not go to git in plain text. Remove the line from .gitignore yourself if you want them in git.",
	passphraseChanged: "Passphrase changed. Commit and push, then other devices keep working without entering it again.",
	reencrypted:
		"Passphrase changed and {0} files re-encrypted. Commit and push. Other devices ask for the new passphrase on their next Sync.",

	errNoFolders: "no folders to encrypt yet. Right-click a folder → “Encrypt this folder”, or add one in the settings.",
	errSealedFolder: "set the sealed folder in the settings (a folder name without spaces)",
	errOverlap: "{0} and {1} overlap. Encrypted folders must not be inside each other or inside the sealed folder.",
	errHidden: "{0}: folders starting with a dot cannot be encrypted",
	errTracked:
		"{0} is already in git, so its files would keep going to the remote in plain text. Remove it from git first: on a computer run  git rm -r --cached \"{0}\"  and commit. Old versions stay in git history.",
	errNoConfig: "nothing is encrypted yet. Run Sync first.",

	createTitle: "Folder Seal: create passphrase",
	createIntro: "Nothing is encrypted in this vault yet, so this sets up encryption from scratch.",
	createOtherDevice: "Already use Folder Seal on another device? Close this, pull from git first, then run Sync again.",
	createNoRecovery: "Lost passphrase means lost files: there is no recovery. Store it in your password manager.",
	unlockTitle: "Folder Seal: enter passphrase",
	unlockChanged: "The passphrase was changed on another device with re-encryption. Enter the new one.",
	changeTitle: "Folder Seal: change passphrase",
	changeIntro: "Files stay as they are, only the passphrase changes. Other devices do not need to enter it again.",
	reencryptTitle: "Folder Seal: change passphrase and re-encrypt",
	reencryptIntro:
		"Use this if someone may know your passphrase. Every file is encrypted again with a new key, so the old passphrase opens nothing, not even old versions in git history.",
	reencryptSyncFirst: "Sync every other device and push before you do this.",
	fieldPassphrase: "Passphrase",
	fieldRepeat: "Repeat passphrase",
	fieldCurrent: "Current passphrase",
	fieldNew: "New passphrase",
	fieldRepeatNew: "Repeat new passphrase",
	btnCreate: "Create",
	btnUnlock: "Unlock",
	btnChange: "Change",
	errMismatch: "Passphrases do not match",
	errShort: "Use at least 12 characters",

	setFolders: "Encrypted folders",
	setFoldersDesc:
		"One per line, path from the vault root, e.g. Health/documents. Easier: right-click a folder → “Encrypt this folder”. These folders never go to git; their encrypted copies do.",
	setSealed: "Sealed folder",
	setSealedDesc: "Where encrypted copies of all the folders above live. This is what git commits and pushes.",
	setHide: "Hide the sealed folder in the file list",
	setHideDesc: "It only holds unreadable files anyway.",
	setRemember: "Remember passphrase on this device",
	setRememberDesc: "Keeps the key in this device's app storage, not in the vault and not in git. Turn off to enter the passphrase every session.",
	setPassphrase: "Passphrase",
	setForgetDesc: "The next Sync asks for the passphrase again. Files are not touched.",
	btnForget: "Forget",
};

const ru: typeof en = {
	ribbon: "Folder Seal: синхронизировать",
	cmdSync: "Синхронизировать (расшифровать пришедшее, зашифровать своё)",
	cmdChange: "Сменить пароль",
	cmdReencrypt: "Сменить пароль и перешифровать всё",
	cmdForget: "Забыть пароль на этом устройстве",
	forgotten: "Пароль на этом устройстве забыт",
	menuEncrypt: "Шифровать эту папку",
	menuStop: "Перестать шифровать эту папку",

	deriving: "Проверяю пароль…",
	unlocked: "Открыто",
	alreadyInSync: "всё и так синхронизировано",
	decrypted: "расшифровано {0}",
	encrypted: "зашифровано {0}",
	removed: "удалено {0}",
	conflicts: "Эти файлы изменили на двух устройствах. Твоя версия осталась, другая сохранена рядом:",
	orphaned: "{0} зашифрованных файлов относятся к папкам, которых больше нет в списке. Их не трогал.",
	gitignoreAdded: "Добавил в .gitignore: {0}",
	folderAdded: "{0} теперь шифруется. Запусти синхронизацию, чтобы зашифровать файлы.",
	folderRemoved:
		"{0} больше не шифруется и не синхронизируется. Файлы остались на этом устройстве и в .gitignore, так что в гит открытым текстом они не уйдут. Если хочешь их в гит, убери строку из .gitignore сам.",
	passphraseChanged: "Пароль сменён. Закоммить и запушь — другие устройства продолжат работать без ввода пароля.",
	reencrypted:
		"Пароль сменён, перешифровано файлов: {0}. Закоммить и запушь. Другие устройства при следующей синхронизации спросят новый пароль.",

	errNoFolders: "пока нечего шифровать. Нажми на папку правой кнопкой (на телефоне — долгим нажатием) → «Шифровать эту папку» или добавь её в настройках.",
	errSealedFolder: "укажи в настройках папку для зашифрованного (имя без пробелов)",
	errOverlap: "{0} и {1} пересекаются. Шифруемые папки не должны лежать друг в друге или в папке зашифрованного.",
	errHidden: "{0}: папки, которые начинаются с точки, шифровать нельзя",
	errTracked:
		"{0} уже есть в гите, и её файлы продолжат уходить туда открытым текстом. Сначала убери её из гита: на компьютере выполни  git rm -r --cached \"{0}\"  и закоммить. Старые версии останутся в истории гита.",
	errNoConfig: "пока ничего не зашифровано. Сначала запусти синхронизацию.",

	createTitle: "Folder Seal: придумай пароль",
	createIntro: "В этом волте ещё ничего не зашифровано, так что шифрование настраивается с нуля.",
	createOtherDevice: "Уже пользуешься Folder Seal на другом устройстве? Закрой это окно, сначала сделай pull из гита, потом снова синхронизацию.",
	createNoRecovery: "Забыл пароль — потерял файлы: восстановить нельзя. Сохрани его в менеджере паролей.",
	unlockTitle: "Folder Seal: введи пароль",
	unlockChanged: "Пароль сменили на другом устройстве с перешифровкой. Введи новый.",
	changeTitle: "Folder Seal: смена пароля",
	changeIntro: "Файлы не трогаются, меняется только пароль. На других устройствах вводить его заново не придётся.",
	reencryptTitle: "Folder Seal: смена пароля с перешифровкой",
	reencryptIntro:
		"Нужно, если пароль мог кто-то узнать. Все файлы шифруются заново новым ключом, и старый пароль не откроет ничего, даже старые версии в истории гита.",
	reencryptSyncFirst: "Перед этим синхронизируй и запушь все остальные устройства.",
	fieldPassphrase: "Пароль",
	fieldRepeat: "Повтори пароль",
	fieldCurrent: "Текущий пароль",
	fieldNew: "Новый пароль",
	fieldRepeatNew: "Повтори новый пароль",
	btnCreate: "Создать",
	btnUnlock: "Открыть",
	btnChange: "Сменить",
	errMismatch: "Пароли не совпадают",
	errShort: "Нужно хотя бы 12 символов",

	setFolders: "Шифруемые папки",
	setFoldersDesc:
		"По одной на строку, путь от корня волта, например Здоровье/документы. Проще: правой кнопкой (на телефоне — долгим нажатием) по папке → «Шифровать эту папку». Сами папки в гит не попадают, попадают их зашифрованные копии.",
	setSealed: "Папка зашифрованного",
	setSealedDesc: "Здесь лежат зашифрованные копии всех папок выше. Именно её гит коммитит и пушит.",
	setHide: "Скрыть папку зашифрованного в списке файлов",
	setHideDesc: "Там всё равно только нечитаемые файлы.",
	setRemember: "Запомнить пароль на этом устройстве",
	setRememberDesc: "Ключ хранится в памяти приложения на этом устройстве, не в волте и не в гите. Выключи, чтобы вводить пароль каждый сеанс.",
	setPassphrase: "Пароль",
	setForgetDesc: "Следующая синхронизация снова спросит пароль. Файлы не трогаются.",
	btnForget: "Забыть",
};

type Key = keyof typeof en;

const strings: typeof en = getLanguage() === "ru" ? ru : en;

/** Translated string with {0}, {1}… replaced by the arguments. */
export function t(key: Key, ...args: (string | number)[]): string {
	return strings[key].replace(/\{(\d)\}/g, (_, i) => String(args[Number(i)]));
}
