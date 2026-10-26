## RU
- Перед обновлением: сохранённый вывод команд будет стёрт. Сохранение вывода в историю теперь выключено по умолчанию, и при обновлении вывод, сохранённый прежними версиями, удаляется; сами команды в истории остаются. Чтобы сохранять вывод дальше, включите Настройки → Безопасность → «Сохранять вывод команд».
- Перед обновлением: приватные ключи на сетевых ресурсах больше не поддерживаются. Путь вида \\server\share\key не принимается — подключите ресурс как диск и укажите путь с буквой диска. Такие хосты при импорте пропускаются.
- Безопасность: введённый пароль больше не появляется на экране и в истории — после многострочной вставки, во время подключения, при вставке из каталога или истории на запросе пароля и когда программа спрашивает секрет незнакомым приглашением.
- Страж опасных команд проверяет каждую строку вставки любой длины и замечает команду, собранную клавишами редактирования строки (Ctrl+A, Ctrl+U, Backspace). Управляющие символы в предпросмотре вставки и в диалоге Стража показаны заметными значками.
- Очистка истории удаляет и её резервные копии.
- Секреты маскируются в большем числе форм: PASSWORD= и TOKEN= без префикса, значения в кавычках с пробелами, пароль в адресе вида user:пароль@host.
- Сервер, предъявивший ключ другого типа, теперь считается сменившим ключ, а не новым. Парольная фраза мастера SSH-ключа не видна в списке процессов Windows. Сохранённый пароль используется только для своего хоста и способа входа.
- Текст, выведенный на экран, больше не может подделать строку «Где я» и приглашение shell; строка «Где я» работает на Alpine и других серверах с BusyBox. Вставка из каталога, истории и строки «Где я» не может незаметно выполнить другую команду. Специально подготовленный вывод сервера или файл импорта больше не подвешивает приложение.
- История показывает, какие команды уже сохранены как сниппеты, и открывает их в каталоге. Фильтр по хостам охватывает всю историю, у удалённого хоста появился свой крестик для очистки.

## EN
- Before you update: saved command output will be erased. Saving output to history is now off by default, and on upgrade the output saved by earlier versions is deleted; the commands themselves stay in history. To keep saving output, turn on Settings → Security → "Save command output".
- Before you update: private keys on network shares are no longer supported. A path such as \\server\share\key is rejected — map the share to a drive letter and use that path. Such hosts are skipped on import.
- Security: a password you type is no longer shown on screen or kept in history — after a multi-line paste, while connecting, when inserting from the catalog or history at a password prompt, and when a program asks for a secret with an unfamiliar prompt.
- The dangerous command guard checks every line of a paste of any length and notices a command assembled with line-editing keys (Ctrl+A, Ctrl+U, Backspace). Control characters in the paste preview and the guard dialog are shown as clearly visible symbols.
- Clearing history now also deletes its backup copies.
- Secrets are masked in more forms: bare PASSWORD= and TOKEN=, quoted values with spaces, a password in an address like user:password@host.
- A server presenting a key of a different type is now treated as a changed key, not a new host. The SSH key wizard's passphrase no longer shows up in the Windows process list. A saved password is used only for its own host and login method.
- Text printed on screen can no longer fake the "Where am I" bar or the shell prompt; the bar now works on Alpine and other BusyBox servers. Inserting from the catalog, history or the "Where am I" bar can no longer silently run a different command. Crafted server output or an import file can no longer freeze the app.
- History shows which commands are already saved as snippets and opens them in the catalog. The host filter covers the whole history, and a deleted host's chip has its own × to clear it.
