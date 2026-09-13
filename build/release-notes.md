## RU
- Безопасность: кнопка «Проверить соединение» больше не отправляет пароль на сервер, чей ключ не проверен. Незнакомый или изменившийся ключ теперь показывает отпечаток и ждёт подтверждения — для целевого сервера и для jump host.
- Страж опасных команд перечисляет все объекты, которые удаляет составная команда, и спрашивает имя именно удаляемого объекта, а не хвоста строки. Для rm -rf / теперь нужно ввести «/» — раньше кнопка подтверждения была активна сразу.
- Историю команд можно отключить для отдельного хоста прямо в форме подключения. «Очистить» в панели истории учитывает фильтр по хосту; команды из быстрых подключений собраны под отдельным фильтром «Быстрое подключение».
- Esc закрывает ровно одно — последнее открытое окно или панель — и больше не уходит заодно на сервер. Горячие клавиши приложения (Ctrl+H, Ctrl+K и другие) работают, когда фокус в терминале, и не отправляют на сервер лишний управляющий символ.
- top, clear и Ctrl+L больше не стирают историю вывода — её можно пролистать вверх. Backspace после изменения размера окна больше не съедает приглашение командной строки.
- Исправлено: сниппеты не загружались в сессии быстрого подключения; окно импорта хостов закрывалось посреди импорта и терялся результат; сброс настроек стирал язык интерфейса и ключи, ещё не добавленные на сервер; «Проверить соединение» с пустым полем пароля делало лишнюю неудачную попытку входа.

## EN
- Security: the "Test connection" button no longer sends your password to a server whose host key hasn't been checked. An unfamiliar or changed key now shows its fingerprint and waits for confirmation — for the target server and for the jump host.
- The dangerous command guard lists every object a compound command deletes and asks for the name of what's actually being deleted, not the tail of the line. rm -rf / now requires typing "/" — previously the confirm button was active right away.
- Command history can be turned off for a single host right in the connection form. "Clear" in the History drawer respects the host filter; commands from Quick Connect sessions are grouped under their own "Quick Connect" filter.
- Esc closes exactly one thing — the most recently opened window or panel — and no longer leaks to the server at the same time. App shortcuts (Ctrl+H, Ctrl+K and others) work while the terminal has focus and no longer send a stray control character to the server.
- top, clear and Ctrl+L no longer wipe the output history — it stays reachable by scrolling up. Backspace after resizing the window no longer eats into the command prompt.
- Fixed: snippets failed to load in a Quick Connect session; the host import dialog could be closed mid-import, losing the result; resetting settings wiped the interface language and keys not yet added to the server; "Test connection" with a blank password field made an extra failed login attempt.
