import type { Queryable } from './db.js';
import { pool } from './db.js';
import { EVENTS, publish } from './realtime.js';

export interface NotificationInput {
  branchId: string | null;
  kind: string;
  severity?: 'info' | 'warning' | 'critical';
  title: string;
  body?: string;
  entityType?: string | null;
  entityId?: string | null;
  targetPermissions?: string[];
  targetUserId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Persist a notification and push it to anyone currently connected who is
 * entitled to see it. The stored row is the durable copy for the Notification
 * Centre; the websocket push is best-effort.
 */
export async function notify(
  input: NotificationInput,
  client?: Queryable,
): Promise<string | null> {
  const runner = client ?? pool;
  const { rows } = await runner.query<{ id: string }>(
    `INSERT INTO notifications
       (branch_id, kind, severity, title_ar, body_ar, entity_type, entity_id,
        target_permissions, target_user_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      input.branchId, input.kind, input.severity ?? 'info', input.title,
      input.body ?? '', input.entityType ?? null, input.entityId ?? null,
      input.targetPermissions ?? [], input.targetUserId ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  const id = rows[0]?.id ?? null;
  publish({
    type: EVENTS.NOTIFICATION,
    branchId: input.branchId,
    requiredPermissions: input.targetPermissions?.length
      ? input.targetPermissions
      : ['notifications.read'],
    payload: {
      id, kind: input.kind, severity: input.severity ?? 'info',
      title: input.title, body: input.body ?? '',
      entityType: input.entityType, entityId: input.entityId,
    },
  });
  return id;
}
