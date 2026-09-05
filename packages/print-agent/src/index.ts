#!/usr/bin/env node
/**
 * MARA local print agent.
 *
 * Runs on a small machine inside the branch LAN. It is the only thing that
 * talks to the printers: the iPads and the cloud never open a socket to a
 * printer directly.
 *
 *   cloud queue  --(HTTPS, bearer token)-->  agent  --(TCP 9100)-->  IP printer
 *
 * Design points that matter on a real floor:
 *   * Jobs are claimed with a short lease, so if this process dies mid-ticket
 *     the cloud re-queues the job instead of stranding it.
 *   * A failed print is reported back and retried with backoff; the order is
 *     never silently lost, and once retries are spent the till is alerted.
 *   * Printer reachability is probed on a heartbeat so a printer that is off
 *     or out of paper is visible in the dashboard before service notices.
 */
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { renderReceipt, renderTicket, type ReceiptPayload, type TicketPayload } from './escpos.js';

interface Config {
  apiUrl: string;
  token: string;
  pollMs: number;
  heartbeatMs: number;
  connectTimeoutMs: number;
  batchSize: number;
  dryRun: boolean;
}

function loadConfig(): Config {
  const apiUrl = (process.env.MARA_API_URL ?? '').replace(/\/$/, '');
  const token = process.env.MARA_AGENT_TOKEN ?? '';
  if (!apiUrl) throw new Error('MARA_API_URL is required');
  if (!token) throw new Error('MARA_AGENT_TOKEN is required');

  return {
    apiUrl,
    token,
    pollMs: Number(process.env.MARA_POLL_MS ?? 2000),
    heartbeatMs: Number(process.env.MARA_HEARTBEAT_MS ?? 30_000),
    connectTimeoutMs: Number(process.env.MARA_PRINTER_TIMEOUT_MS ?? 5000),
    batchSize: Number(process.env.MARA_BATCH_SIZE ?? 10),
    // Useful for commissioning a branch: exercises the whole loop without paper.
    dryRun: process.env.MARA_DRY_RUN === 'true',
  };
}

interface Job {
  id: string;
  /** The order this ticket belongs to, so a failure can name it. */
  order_id: string | null;
  kind: string;
  payload: TicketPayload | ReceiptPayload;
  copies: number;
  attempt_count: number;
  ip_address: string;
  port: number;
  protocol: string;
  codepage: string;
  chars_per_line: number;
  printer_name: string;
  printer_id: string;
}

const log = (message: string, extra?: unknown) => {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
};

class Agent {
  private printers: Array<{ id: string; ip: string; port: number; name: string }> = [];
  private running = true;

  constructor(private readonly config: Config) {}

  private async call<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(`${this.config.apiUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${path} returned ${res.status}: ${text.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Open a raw socket to the printer and write the ticket. */
  private async sendToPrinter(job: Job, data: Buffer): Promise<void> {
    if (this.config.dryRun) {
      log(`[dry-run] ${data.length} bytes -> ${job.printer_name} (${job.ip_address}:${job.port})`);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        err ? reject(err) : resolve();
      };

      socket.setTimeout(this.config.connectTimeoutMs);
      socket.once('timeout', () => finish(new Error('printer timed out')));
      socket.once('error', (err) => finish(err));
      socket.connect(job.port, job.ip_address, () => {
        socket.write(data, (err) => {
          if (err) { finish(err); return; }
          // Give the printer a moment to drain before closing, or the tail of
          // the ticket can be truncated on some models.
          setTimeout(() => finish(), 250);
        });
      });
    });
  }

  private async processJob(job: Job): Promise<void> {
    try {
      // A receipt and a station ticket are different documents on the same
      // printer: one carries money and the tax QR, the other carries none of it.
      const data = job.kind === 'receipt' || job.kind === 'credit_note'
        ? renderReceipt(job.payload as ReceiptPayload, job.chars_per_line ?? 42)
        : renderTicket(job.payload as TicketPayload, job.chars_per_line ?? 42);
      for (let copy = 0; copy < Math.max(1, job.copies); copy += 1) {
        await this.sendToPrinter(job, data);
      }
      await this.call('/api/print-agent/result', { jobId: job.id, success: true });
      log(`printed ${job.kind} -> ${job.printer_name}`);
    } catch (err) {
      const message = (err as Error).message;
      log(`FAILED ${job.kind} -> ${job.printer_name}`
        + `${job.order_id ? ` (order ${job.order_id})` : ''}: ${message}`);
      // Report the failure so the cloud can retry and, once retries are spent,
      // raise it to the cashier.
      await this.call('/api/print-agent/result', {
        jobId: job.id, success: false, error: message.slice(0, 400),
      }).catch((e) => log(`could not report failure: ${(e as Error).message}`));
    }
  }

  /** Probe each printer's port so the dashboard reflects reality. */
  private async probePrinters(): Promise<Array<{ id: string; reachable: boolean; message?: string }>> {
    return Promise.all(this.printers.map(async (printer) => {
      if (this.config.dryRun) return { id: printer.id, reachable: true };
      return new Promise<{ id: string; reachable: boolean; message?: string }>((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const settle = (reachable: boolean, message?: string) => {
          if (done) return;
          done = true;
          socket.destroy();
          resolve({ id: printer.id, reachable, message });
        };
        socket.setTimeout(2000);
        socket.once('timeout', () => settle(false, 'no response'));
        socket.once('error', (err) => settle(false, err.message));
        socket.connect(printer.port, printer.ip, () => settle(true));
      });
    }));
  }

  private async heartbeat(): Promise<void> {
    try {
      const printers = await this.probePrinters();
      const res = await this.call<{ printers: Array<any> }>('/api/print-agent/heartbeat', {
        version: '1.0.0',
        printers,
      });
      this.printers = res.printers.map((p) => ({
        id: p.id, ip: p.ip ?? p.ip_address, port: p.port, name: p.name,
      }));
      const offline = printers.filter((p) => !p.reachable);
      if (offline.length > 0) log(`heartbeat: ${offline.length} printer(s) unreachable`);
    } catch (err) {
      log(`heartbeat failed: ${(err as Error).message}`);
    }
  }

  private async pollOnce(): Promise<number> {
    const { jobs } = await this.call<{ jobs: Job[] }>('/api/print-agent/claim', {
      limit: this.config.batchSize,
    });
    // Jobs run sequentially: two tickets racing onto one thermal printer
    // interleave their bytes and produce garbage.
    for (const job of jobs) {
      if (!this.running) break;
      await this.processJob(job);
    }
    return jobs.length;
  }

  async run(): Promise<void> {
    log(`MARA print agent starting — API ${this.config.apiUrl}${this.config.dryRun ? ' (dry run)' : ''}`);
    await this.heartbeat();

    let heartbeatDue = Date.now() + this.config.heartbeatMs;
    let backoff = this.config.pollMs;

    while (this.running) {
      try {
        const count = await this.pollOnce();
        backoff = this.config.pollMs;
        // An empty queue costs one short sleep; a busy one loops straight on.
        if (count === 0) await sleep(this.config.pollMs);
      } catch (err) {
        log(`poll failed: ${(err as Error).message}`);
        // Back off when the cloud is unreachable rather than hammering it.
        backoff = Math.min(backoff * 2, 60_000);
        await sleep(backoff);
      }

      if (Date.now() >= heartbeatDue) {
        await this.heartbeat();
        heartbeatDue = Date.now() + this.config.heartbeatMs;
      }
    }
    log('print agent stopped');
  }

  stop(): void { this.running = false; }
}

const invokedDirectly = process.argv[1]?.includes('index');
if (invokedDirectly) {
  const agent = new Agent(loadConfig());
  const shutdown = (signal: string) => { log(`${signal} received`); agent.stop(); };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  agent.run().catch((err) => {
    console.error('print agent fatal error:', err);
    process.exit(1);
  });
}

export { Agent, loadConfig };
