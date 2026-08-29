import type { WebSocket } from 'ws';

/**
 * Realtime fan-out for the floor: table status, new customer orders awaiting a
 * waiter, service requests, print failures, low stock.
 *
 * Delivery is permission-and-branch aware, so a waiter's iPad cannot subscribe
 * its way into another branch's traffic or into events it has no right to see.
 */
export interface RealtimeClient {
  socket: WebSocket;
  userId: string;
  employeeId: string | null;
  branchId: string | null;
  permissions: ReadonlySet<string>;
  channels: Set<string>;
}

export interface RealtimeEvent {
  type: string;
  branchId: string | null;
  /** Only clients holding at least one of these receive the event. */
  requiredPermissions?: readonly string[];
  /** Narrow further to one waiter (their tables, their approvals). */
  targetEmployeeId?: string | null;
  payload: unknown;
}

const clients = new Set<RealtimeClient>();

export function addClient(client: RealtimeClient): void {
  clients.add(client);
}

export function removeClient(client: RealtimeClient): void {
  clients.delete(client);
}

export function clientCount(): number {
  return clients.size;
}

export function publish(event: RealtimeEvent): void {
  const message = JSON.stringify({
    type: event.type,
    payload: event.payload,
    at: new Date().toISOString(),
  });

  for (const client of clients) {
    if (event.branchId && client.branchId && client.branchId !== event.branchId) continue;

    if (event.requiredPermissions?.length) {
      const allowed = event.requiredPermissions.some((p) => client.permissions.has(p));
      if (!allowed) continue;
    }

    // A targeted event still reaches supervisors who can see all orders, so a
    // manager watching the floor is not blind to a waiter's queue.
    if (event.targetEmployeeId) {
      const isTarget = client.employeeId === event.targetEmployeeId;
      const isSupervisor = client.permissions.has('orders.read.all');
      if (!isTarget && !isSupervisor) continue;
    }

    if (client.socket.readyState === 1) {
      try { client.socket.send(message); } catch { /* dropped below on close */ }
    }
  }
}

export const EVENTS = {
  TABLE_STATUS: 'table.status',
  ORDER_PENDING_APPROVAL: 'order.pending_approval',
  ORDER_UPDATED: 'order.updated',
  ORDER_PAID: 'order.paid',
  SERVICE_REQUEST: 'service.request',
  SERVICE_RESOLVED: 'service.resolved',
  PRINT_FAILED: 'print.failed',
  PRINT_QUEUE_STUCK: 'print.queue_stuck',
  PRINTER_STATUS: 'printer.status',
  NOTIFICATION: 'notification',
  LOW_STOCK: 'inventory.low_stock',
  PR_PENDING_APPROVAL: 'purchase_request.pending_approval',
  PR_STATUS: 'purchase_request.status',
} as const;
