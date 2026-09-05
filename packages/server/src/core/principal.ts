import type { FastifyRequest } from 'fastify';
import type { Permission } from '@mara/shared';
import { forbidden, unauthorized } from './errors.js';

/**
 * The authenticated caller. Built once per request from the access token plus
 * a database read, and consulted by every guard. There is exactly one source
 * of truth for "may this caller do this" and it lives on the server.
 */
export interface Principal {
  kind: 'admin' | 'employee';
  userId: string;
  employeeId: string | null;
  employeeCode: string | null;
  sessionId: string;
  displayName: string;
  roleCode: string;
  isAdminRole: boolean;
  /** NULL branchId means the principal spans every branch (owner/executive). */
  branchId: string | null;
  allowedBranchIds: string[];
  permissions: ReadonlySet<string>;
  mfaSatisfied: boolean;
  department: string | null;
  /**
   * The branch this one request is acting on, taken from the X-Branch-Id
   * header. A principal who spans every branch (owner, executive) has no home
   * branch to fall back on, so without this every branch-scoped endpoint would
   * refuse them. It selects, it never grants: assertBranchAccess still decides.
   */
  requestedBranchId: string | null;
}

/** A verified customer on the QR menu. Never carries staff permissions. */
export interface CustomerPrincipal {
  kind: 'customer';
  customerId: string;
  sessionId: string;
  phone: string;
}

/** One uploaded part, as both @fastify/multipart and the router shim provide it. */
export interface UploadedFile {
  filename: string;
  mimetype: string;
  toBuffer: () => Promise<Uint8Array>;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    customer?: CustomerPrincipal;
    printAgentId?: string;
    /**
     * The terminal this request came from, resolved from X-Device-Token.
     * Absent for anything not sent from a registered device — which is fine
     * for reading, and refused for closing a bill.
     */
    device?: import('../modules/devices/devices.service.js').Device;
  }
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized('يجب تسجيل الدخول');
  return req.principal;
}

export function requireCustomer(req: FastifyRequest): CustomerPrincipal {
  if (!req.customer) throw unauthorized('يجب التحقق من رقم الجوال');
  return req.customer;
}

export function has(principal: Principal, permission: Permission | string): boolean {
  return principal.permissions.has(permission);
}

export function hasAny(principal: Principal, permissions: readonly string[]): boolean {
  return permissions.some((p) => principal.permissions.has(p));
}

/** Throw unless the principal holds the permission. */
export function assertPermission(
  principal: Principal,
  permission: Permission | string,
): void {
  if (!principal.permissions.has(permission)) {
    throw forbidden(`تحتاج صلاحية: ${permission}`);
  }
}

export function assertAnyPermission(
  principal: Principal,
  permissions: readonly (Permission | string)[],
): void {
  if (!permissions.some((p) => principal.permissions.has(p))) {
    throw forbidden(`تحتاج إحدى الصلاحيات: ${permissions.join(', ')}`);
  }
}

/**
 * Multi-branch containment. Every branch-scoped query passes through here, so
 * a branch manager cannot read or write another branch's data by guessing an id.
 */
export function assertBranchAccess(principal: Principal, branchId: string): void {
  if (principal.allowedBranchIds.length === 0) return;  // spans all branches
  if (!principal.allowedBranchIds.includes(branchId)) {
    throw forbidden('لا تملك صلاحية الوصول إلى هذا الفرع');
  }
}

/**
 * Resolve the branch a request should act on: the explicit one if the caller
 * is entitled to it, otherwise the caller's home branch.
 */
export function resolveBranch(principal: Principal, requested?: string | null): string {
  const branch = requested ?? principal.requestedBranchId ?? principal.branchId;
  if (!branch) throw forbidden('يجب تحديد الفرع');
  assertBranchAccess(principal, branch);
  return branch;
}
