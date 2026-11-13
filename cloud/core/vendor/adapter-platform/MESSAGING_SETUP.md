# MODUS owner test messaging — runtime 0.2.138

These are backend-only local bridge RPCs. Read the bridge credential only in the trusted local backend. Never put it or a capability token in browser responses, settings exports or logs. Analysis-only capabilities have no messaging methods.

## Explicit setup after MODUS worker is installed

1. `adapter_messaging_owner_enable {}` enables `/modus` routing for the already configured WhatsApp owner only, educational role `employee2`. Does not send anything. The existing owner-background-worker must be restarted gracefully with no active task to load the local interception. Do not replace the remote owner allowlist or copy its credentials.
2. `adapter_messaging_telegram_setup {account,chat,employeeId:"employee2"}` binds one existing verified private Bot API chat. Obtain account/chat from the existing local Telegram service. Setup rechecks bot identity, private chat, numeric destination and absence of topics/business connections. It does not send. Messages before setup are not ingested. Setup currently rejects a duplicate configuration rather than replacing an existing binding.
3. `adapter_messaging_capability {space:"modus-platform"}` returns a 4-minute token for the five methods in `messaging.cjs`. Renew on the trusted backend. A caller cannot choose a destination in reply.

The local Telegram service must be running on 127.0.0.1:4399. On this owner workstation its existing Python service can run directly as `python -X utf8 -m telegram_adapter.server` from the canonical project directory, hidden. No PowerShell execution-policy change is needed. The service retains its existing DPAPI credentials; client distribution still needs its own configured service/account.

## Events and responses

Only new incoming text beginning `/modus` enters the test channel. Prefix is removed from the event text. Use `/modus` on each subsequent reply, including confirmation. Other WhatsApp owner commands and Telegram messages remain outside MODUS.

`MessagingClient` exposes status(), poll({limit}), ack({eventId}), reply({eventId,operationId,text}), receipt({operationId}). Events: eventId, channelId, channel, employeeId, conversationId, messageId, text, receivedAt. conversationId is an opaque binding identifier, not a phone number. Poll returns unacknowledged events; durable consumer deduplication is mandatory. Ack does not mean the business task completed.

WhatsApp channelId `owner-modus`: commandPrefix `/modus`, maxRepliesPerEvent 1, maxReplyUtf16 4000. Keep replies under 3500 UTF-16 code units. Owner claims expire after 10 minutes. `accepted` means persisted for the existing worker, not provider delivery. `sent` derives from the authenticated owner return receipt; delivered/read require its corresponding provider receipt.

Telegram channelId `owner-telegram-modus`: commandPrefix `/modus`; replies max4000 Unicode code points. Send uses saved draft, exact content/hash/recipient review, then local Bot API send. Only `sent` can be established from Bot API. Never label it delivered/read. An uncertain send retains its draft reference for receipt lookup and is not retried.

Reply operationId is immutable with eventId/text. After unknown, only request receipt; never create another operationId to resend. A second WhatsApp reply to the same event is refused. Business confirmation must name the exact pending card revision in MODUS; channel binding alone does not authorize arbitrary actions.

## Verification boundary

Unit/provider fixtures are synthetic. Restoring the real Telegram bot and reading its `receiving` status proves transport connectivity, not message delivery. Live acceptance requires a new owner message through each bot and observed replies, registration and receipts. No invitation or live reply is sent by setup.

Generalized corporate onboarding, new WABA webhook deployment, audio ingestion and arbitrary employee-directory provisioning are not enabled by this owner test mode.
