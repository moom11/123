import type { FastifyInstance } from 'fastify';
import { authRoutes } from './modules/auth/auth.routes.js';
import { menuRoutes } from './modules/menu/menu.routes.js';
import { tableRoutes } from './modules/tables/tables.routes.js';
import { orderRoutes } from './modules/orders/orders.routes.js';
import { customerRoutes } from './modules/customers/customers.routes.js';
import { publicRoutes } from './modules/customers/public.routes.js';
import { inventoryRoutes } from './modules/inventory/inventory.routes.js';
import { purchasingRoutes } from './modules/purchasing/purchasing.routes.js';
import { printingRoutes } from './modules/printing/printing.routes.js';
import { reportRoutes } from './modules/reports/reports.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { notificationRoutes } from './modules/notifications/notifications.routes.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { invoicingRoutes } from './modules/invoicing/invoicing.routes.js';
import { deviceRoutes } from './modules/devices/devices.routes.js';
import { deliveryRoutes, deliveryWebhookRoutes } from './modules/delivery/delivery.routes.js';

/**
 * Route registration.
 *
 * `/api/public` is the only surface reachable without a staff session — it
 * serves the QR menu and the customer's own ordering flow, and every one of its
 * handlers is written on the assumption that its caller is anonymous.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(menuRoutes);
    await api.register(tableRoutes);
    await api.register(orderRoutes);
    await api.register(customerRoutes);
    await api.register(inventoryRoutes);
    await api.register(purchasingRoutes);
    await api.register(printingRoutes);
    await api.register(reportRoutes);
    await api.register(adminRoutes);
    await api.register(notificationRoutes);
    await api.register(auditRoutes);
    await api.register(invoicingRoutes);
    await api.register(deviceRoutes);
    await api.register(deliveryRoutes);
  }, { prefix: '/api' });

  await app.register(publicRoutes, { prefix: '/api/public' });

  // Aggregator webhooks. Public because a platform cannot hold a session; the
  // HMAC signature is what authenticates them, checked inside the handler.
  await app.register(deliveryWebhookRoutes, { prefix: '/api/delivery/webhook' });
}
