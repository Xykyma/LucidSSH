## RU
- Linux x64: добавлены AppImage и .deb. Мастер SSH-ключей использует системный ssh-keygen, пароли хранятся в Secret Service. При недоступном хранилище приложение продолжает работать без сохранённого пароля, а ошибка сохранения объясняется отдельно.
- Windows portable: один exe без установки, профиль хранится рядом с ним. Для переноса закройте приложение и перенесите всю папку вместе с profile.id. Пароли остаются в Windows Credential Manager, приватные ключи не копируются, файлы профиля не шифруются.
- NSIS и AppImage поддерживают автообновление с согласием на скачивание и установку. Portable и .deb обновляются вручную через Releases; для portable замените только exe при закрытом приложении, сохранив файлы профиля.
- При одновременных подключениях запросы отпечатка сервера показываются по очереди. Закрытие подключения удаляет ожидающий запрос, не оставляя устаревший диалог.
- Ошибка сохранения пароля больше не оставляет новый хост без секрета и не меняет поля существующего хоста. Повторное сохранение после ошибки не создаёт дубликат.
- Безопасность: смена адреса, порта, логина, способа входа или файла ключа сбрасывает прежний сохранённый секрет, если новый не введён. В portable изменённый хост отсоединяется от общего секрета копий профиля, не лишая остальные копии доступа к исходному серверу.
- Сброс настроек больше не скрывает активные SSH-сессии: вкладки, вывод терминала и подключения сохраняются без перезагрузки окна.
- В форме добавления и редактирования хоста работает контекстное меню копирования и вставки. Копирование из поля пароля по-прежнему запрещено.
- Проблемы дашборда показываются отдельными уведомлениями. Закрытие одного не скрывает остальные; восстановившаяся метрика снимает своё уведомление, временно недоступная скрывает его, а переподключение очищает устаревшие находки и проверяет сервер заново.
- Окно приложения больше не остаётся скрытым, если Electron не прислал сигнал готовности, в том числе в затронутых Linux/ВМ-окружениях.
- Ограничения Linux: проверено на Ubuntu 24.04; Ubuntu 22.04, Debian 12 и фактическая установка AppImage-обновления пока не проверены.

## EN
- Linux x64: AppImage and .deb packages are available. The SSH key wizard uses the system ssh-keygen, and passwords stay in Secret Service. An unavailable store does not stop the app from working without a saved password; saving a secret reports a specific error.
- Windows portable: one exe without installation, with the profile next to it. To move it, close the app and move the whole folder, including profile.id. Passwords stay in Windows Credential Manager, private keys are not copied, and profile files are not encrypted.
- NSIS and AppImage support auto-update with consent for downloading and installing. Portable and .deb update manually through Releases; for portable, close the app and replace only the exe, keeping the profile files.
- Simultaneous connections show server fingerprint prompts one at a time. Closing a connection removes its pending prompt instead of leaving a stale dialog.
- A failed password save no longer leaves a new host without its secret or changes an existing host's fields. Retrying after the error does not create a duplicate.
- Security: changing the address, port, username, authentication method, or key file discards the saved secret unless a new one is entered. In portable, the changed host detaches from the profile copies' shared secret without taking away the other copies' access to the original server.
- Resetting settings no longer hides active SSH sessions: tabs, terminal output, and connections stay intact without reloading the window.
- The add/edit host form now has a working Copy/Paste context menu. Copying from the password field remains blocked.
- Dashboard problems appear as separate notifications. Closing one does not hide the others; a recovered metric removes its notification, a temporarily unavailable metric hides it, and reconnecting clears old findings and checks the server again.
- The app window no longer stays hidden if Electron never signals that it is ready, including in affected Linux/VM environments.
- Linux limitations: tested on Ubuntu 24.04; Ubuntu 22.04, Debian 12, and actual AppImage update installation have not yet been verified.
