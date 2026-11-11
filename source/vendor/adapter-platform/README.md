# Platform client component — 0.2.128

Backend-only client.cjs: injected rpc supports only adapter_status, adapter_request_submit, adapter_request_result. Readiness output excludes chat lists, tokens and file inventory. Ledger stores IDs/digests/state, not prompt content. Persist ledger per client. Unknown submission must not be retried; reconcile with operator, do not issue new ID. Result only accepts ledger-owned ID. This client is not a server-side security boundary: existing bridge master token must never be given to browser/untrusted client. Dedicated limited capability issuance is not implemented.

Use a fresh Windows user/application profile on another PC. Never copy AppData/PACTIQO Adapter, cookies, bridge.json, owner-bot-channel.dpapi, key vault or project history. User signs into their own Codex and each service. Existing app production profile path is fixed under APPDATA; ADAPTER_TEST_DATA works only with smoke mode and is NOT a supported production multi-profile switch. Do not claim same-user profile isolation or unattended lifecycle as complete.

Install payload is the complete verified win-unpacked folder from0.2.128; manifest records anchor hashes, not a file allowlist. Current machine source: D:/PACTIQO/Builds/Adapter/0.2.128/win-unpacked. Keep user data outside payload. No personal paths required by client.cjs. Do not bundle this machine's Codex credentials. Separate Codex installation/distribution and login must be verified before customer release.

Tests: node --test integrations/platform-client/client.test.cjs. Synthetic RPC only, no provider messages and no real Codex. Caller must supply a trusted backend RPC binding for its isolated client profile. This artifact intentionally does not read the current owner's bridge config and does not claim the bot queue.

Contracts: submit requestId is UUID; text1..24000 (analysis-only; total JSON transport limit 65536 UTF-8 bytes); parentRequestId must have answered status in client ledger. Return state accepted is not completion. result status answered is an assistant answer, not an external send receipt. No mouse fallback. Production connector readiness remains false in manifest until capability/profile/lifecycle gaps are implemented.

### Проверенная production-изоляция 0.2.129
Запуск отдельного клиента: `Adapter.exe --profile-dir "D:\PACTIQO\ClientProfiles\<client>" --start-hidden` либо ADAPTER_PROFILE_DIR. Путь должен быть абсолютным и отличаться от личного default-профиля. userData/sessionData и singleton раздельные; перезапуск сохраняет параметры. Автоматическое обновление по личному локальному каталогу в таком профиле отключено: обновлением управляет клиентский установщик.
Backend читает bridge.json только своего профиля. Master RPC adapter_platform_capability({space:"client-crm"}) выдаёт token/port/expiresAt на 4 минуты. Этот token разрешает только adapter_status (без приватного списка подключений), adapter_request_submit, adapter_request_result. Parent/result ограничены своим space. Повтор requestId с другим содержимым отклоняется; неизвестный исход не переотправляется. После перезапуска capability требуется выдать заново. Не передавать master или scoped token в UI/HTML.
Штатная остановка отдельного профиля: master RPC adapter_profile_stop({expectedVersion:"0.2.129"}); при задаче/вводе вернёт deferred. Scoped token остановку не разрешает. Личный профиль этой командой не закрывается.
Доказательство: D:/PACTIQO/Builds/Adapter/0.2.129/clean-profile-evidence.json. Проверены пустые операции/файлы, executor выключен, отказ чужому result и owner RPC, скрытый запуск по параметру, ротация token и сохранение профиля после restart, штатный stop. Это не доказательство входа клиента в Codex или внешней доставки. Нельзя переносить clean-production-profile* в установщик: это тестовые профили с runtime credentials. Переносить только win-unpacked.

### Headless onboarding Codex — 0.2.130
В отдельном production-профиле CODEX_HOME по умолчанию `<profile-dir>/codex`. Унаследованный CODEX_HOME владельца игнорируется; личная owner-history не подключается. Допустим только CODEX_HOME внутри этого клиентского профиля; ссылки наружу отклоняются. Запуск app-server и login status наследуют этот отдельный путь.

Master backend RPC (не capability из браузера):
```js
await rpc('adapter_client_onboarding', {
  action: 'configure',
  executable: 'C:/.../codex.exe',
  codexHome: 'D:/ClientData/adapter/codex'
});
await rpc('adapter_client_onboarding', {action:'status'});
await rpc('adapter_client_onboarding', {action:'enable'});
await rpc('adapter_client_onboarding', {action:'disable'});
```
`configure` проверяет установленный EXE, сохраняет настройки в клиентском профиле и выключает исполнение. Не копирует авторизацию. Ответ содержит `state`: missing_executable / waiting_login / ready_disabled / ready, authenticated, executorEnabled, и login.executable/args/environment для штатного входа. Установщик запускает установленный Codex `login` с возвращённым CODEX_HOME; пользователь завершает вход у провайдера. Пароль/токен не передаётся в Адаптер. Затем backend вызывает enable; при отсутствии входа останется waiting_login и executorEnabled=false. При активных поручениях изменение настроек блокируется.

После ready backend получает adapter_platform_capability и использует PlatformClient submit/result. Новое поручение имеет отдельную сохранённую сессию Codex; продолжение parentRequestId возвращается в свою сессию. Ответ схемы можно передавать строкой в text и обязательно валидировать reply на backend. Параметр JSON-schema непосредственно в публичном submit ещё не предусмотрен.

На настоящем установленном Codex с пустым CODEX_HOME проверены waiting_login и отказ enable до входа; это не успешная генерация моделью под новым аккаунтом. Собственный вход клиента — необходимый внешний шаг. Синтетическое восстановление ответа проверяется отдельно и не называется настоящей авторизацией.

### Режим анализатора корпоративного текста — 0.2.132
Поручения через platform capability получают внутренний analysis-only на стороне сервера. Клиент не может передать/поменять этот профиль через submit. Поле сохраняется и наследуется продолжением. Для него не создаётся MCP capability исполнителя; настроенный Adapter MCP не добавляется в app-server, shell_tool=false и web_search=disabled. Session runner отключает унаследованные MCP и apps. Общая история владельца не используется. Обычный owner worker сохраняет прежнюю конфигурацию. Модельный JSON проверяйте по своей схеме до записи в CRM: текст ответа сам по себе не является разрешением бизнес-действия.
