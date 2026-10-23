## RU
- Безопасность: введённый пароль больше не появляется на экране и в истории — после многострочной вставки, во время подключения, при вставке из каталога или истории на запросе пароля и когда программа спрашивает секрет незнакомым приглашением.
- Страж опасных команд проверяет каждую строку вставки любой длины и замечает команду, собранную клавишами редактирования строки (Ctrl+A, Ctrl+U, Backspace). Управляющие символы в предпросмотре вставки и в диалоге Стража показаны заметными значками.
- Вывод команд больше не сохраняется в историю по умолчанию — это включается в Настройки → Безопасность. При обновлении сохранённый раньше вывод стирается, а очистка истории удаляет и её резервные копии.
- Секреты маскируются в большем числе форм: PASSWORD= и TOKEN= без префикса, значения в кавычках с пробелами, пароль в адресе вида user:пароль@host.
- Сервер, предъявивший ключ другого типа, теперь считается сменившим ключ, а не новым. Путь к ключу на сетевом ресурсе больше не принимается — подключите ресурс как диск. Парольная фраза мастера SSH-ключа не видна в списке процессов Windows. Сохранённый пароль используется только для своего хоста и способа входа.
- Текст, выведенный на экран, больше не может подделать строку «Где я» и приглашение shell; строка «Где я» работает на Alpine и других серверах с BusyBox. Вставка из каталога, истории и строки «Где я» не может незаметно выполнить другую команду. Специально подготовленный вывод сервера или файл импорта больше не подвешивает приложение.
- История показывает, какие команды уже сохранены как сниппеты, и открывает их в каталоге. Фильтр по хостам охватывает всю историю, у удалённого хоста появился свой крестик для очистки.

## EN
- Security: a password you type is no longer shown on screen or kept in history — after a multi-line paste, while connecting, when inserting from the catalog or history at a password prompt, and when a program asks for a secret with an unfamiliar prompt.
- The dangerous command guard checks every line of a paste of any length and notices a command assembled with line-editing keys (Ctrl+A, Ctrl+U, Backspace). Control characters in the paste preview and the guard dialog are shown as clearly visible symbols.
- Command output is no longer saved to history by default — turn it on in Settings → Security. On upgrade, output saved earlier is erased, and clearing history now also deletes its backup copies.
- Secrets are masked in more forms: bare PASSWORD= and TOKEN=, quoted values with spaces, a password in an address like user:password@host.
- A server presenting a key of a different type is now treated as a changed key, not a new host. A key path on a network share is no longer accepted — map the share to a drive letter. The SSH key wizard's passphrase no longer shows up in the Windows process list. A saved password is used only for its own host and login method.
- Text printed on screen can no longer fake the "Where am I" bar or the shell prompt; the bar now works on Alpine and other BusyBox servers. Inserting from the catalog, history or the "Where am I" bar can no longer silently run a different command. Crafted server output or an import file can no longer freeze the app.
- History shows which commands are already saved as snippets and opens them in the catalog. The host filter covers the whole history, and a deleted host's chip has its own × to clear it.
