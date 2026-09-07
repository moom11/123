# MARA Print Agent

Bridges the cloud print queue to the branch's IP printers. The kitchen, bar and
shisha stations have no screens — they work from paper — so this process is
what makes the system operable.

```
cloud queue  --HTTPS + bearer token-->  agent  --TCP 9100-->  ESC/POS printer
```

The iPad never talks to a printer directly.

## Install

```bash
npm install && npm run build
cp .env.example .env      # then paste the token from Printers → وكيل طباعة جديد
npm start
```

## Run as a service (systemd)

```ini
[Unit]
Description=MARA Print Agent
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/mara-print-agent
EnvironmentFile=/opt/mara-print-agent/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
User=mara

[Install]
WantedBy=multi-user.target
```

## Behaviour

- **Nothing is lost.** Jobs are claimed with a short lease; if the agent dies
  mid-ticket the cloud re-queues the job rather than stranding it.
- **Failures are reported,** retried with backoff, and once retries are spent
  the cashier and branch manager are alerted in the system.
- **Health is visible.** Each heartbeat probes every printer's port, so a
  printer that is switched off shows as offline in the dashboard before service
  notices.
- **Tickets are sequential** per agent: concurrent writes to one thermal
  printer interleave and produce garbage.

## Arabic

Thermal printers do no Arabic shaping of their own. `src/escpos.ts` applies
contextual letter forms, reorders right-to-left runs, and encodes to CP864 —
while leaving Latin words and digits in their own order so a table number never
prints backwards. `npm test` covers this without needing a printer.
