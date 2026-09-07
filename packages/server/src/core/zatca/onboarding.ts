/**
 * Getting a real CSID out of ZATCA.
 *
 * Onboarding is three calls, in order, and each one gates the next:
 *
 *   1. POST /compliance          — hand over the CSR, receive a COMPLIANCE CSID
 *                                  plus a request id. This certificate signs
 *                                  test invoices and nothing else.
 *   2. POST /compliance/invoices — submit sample documents. ZATCA checks the
 *                                  device actually produces valid invoices
 *                                  before trusting it with live ones.
 *   3. POST /production/csids    — with the request id from step 1, receive the
 *                                  PRODUCTION CSID. Only now may the device
 *                                  issue invoices for real customers.
 *
 * A device that stops at step 1 can sign, print and queue — and every one of
 * those invoices is worthless. That is why onboarding_step is stored and why
 * preflight refuses to open on anything below 'production': the failure mode
 * is silent, and looks exactly like success.
 */

export type ZatcaEnvironment = 'sandbox' | 'simulation' | 'production';

const HOST: Record<ZatcaEnvironment, string> = {
  sandbox: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
  simulation: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',
  production: 'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',
};

export function zatcaBase(environment: ZatcaEnvironment): string {
  return HOST[environment];
}

export class ZatcaError extends Error {
  constructor(readonly status: number, readonly body: unknown, message: string) {
    super(message);
  }
}

async function call(
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: init.method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // ZATCA versions its API by header, not by path. Omitting this returns a
      // shape from an older contract that parses cleanly and means something
      // different — worse than an error.
      'Accept-Version': 'V2',
      'Accept-Language': 'en',
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }

  if (!res.ok) {
    throw new ZatcaError(res.status, body, describe(res.status, body));
  }
  return { status: res.status, body };
}

/**
 * ZATCA's errors arrive as nested arrays of category/code/message. Flattening
 * them here means the operator sees what is wrong instead of a status code.
 */
function describe(status: number, body: unknown): string {
  const b = body as {
    errors?: Array<{ message?: string; code?: string }>;
    validationResults?: { errorMessages?: Array<{ message?: string }> };
    message?: string;
  };
  const messages = [
    ...(b?.errors ?? []).map((e) => e.message ?? e.code).filter(Boolean),
    ...(b?.validationResults?.errorMessages ?? []).map((e) => e.message).filter(Boolean),
  ];
  if (messages.length > 0) return `ZATCA ${status}: ${messages.join(' | ')}`;
  if (b?.message) return `ZATCA ${status}: ${b.message}`;
  return `ZATCA ${status}: ${JSON.stringify(body).slice(0, 300)}`;
}

export interface ComplianceCsid {
  requestId: string;
  certificate: string;
  secret: string;
}

/**
 * Step 1. The OTP comes from the taxpayer's Fatoora portal and is valid for a
 * few minutes — it is the human's proof that this device is theirs to register.
 */
export async function requestComplianceCsid(
  environment: ZatcaEnvironment, csrBase64: string, otp: string,
): Promise<ComplianceCsid> {
  const { body } = await call(`${zatcaBase(environment)}/compliance`, {
    method: 'POST',
    headers: { OTP: otp },
    body: { csr: csrBase64 },
  });

  if (!body?.binarySecurityToken || !body?.secret) {
    throw new ZatcaError(200, body, 'ZATCA لم تُعِد شهادة الامتثال');
  }
  return {
    requestId: String(body.requestID ?? body.requestId ?? ''),
    // binarySecurityToken is base64 of the PEM body — store it as it arrives,
    // because that is exactly what the next calls send back.
    certificate: String(body.binarySecurityToken),
    secret: String(body.secret),
  };
}

/**
 * Step 2. ZATCA will not promote a device that has not demonstrated it can
 * produce a valid document, so a sample of each type it declared is submitted
 * here. A restaurant declares simplified invoices, so that is what it sends.
 */
export async function submitComplianceInvoice(
  environment: ZatcaEnvironment,
  credentials: { certificate: string; secret: string },
  invoice: { hash: string; uuid: string; xmlBase64: string },
): Promise<{ status: string; warnings: string[] }> {
  const auth = Buffer.from(`${credentials.certificate}:${credentials.secret}`).toString('base64');
  const { body } = await call(`${zatcaBase(environment)}/compliance/invoices`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body: {
      invoiceHash: invoice.hash,
      uuid: invoice.uuid,
      invoice: invoice.xmlBase64,
    },
  });

  const status = String(
    body?.clearanceStatus ?? body?.reportingStatus ?? body?.status ?? 'UNKNOWN',
  );
  const warnings = (body?.validationResults?.warningMessages ?? [])
    .map((w: { message?: string }) => w.message)
    .filter(Boolean) as string[];
  return { status, warnings };
}

/**
 * Step 3. The request id from step 1 is what ties this to the compliance run —
 * ZATCA will refuse a production CSID for a device whose checks did not pass.
 */
export async function requestProductionCsid(
  environment: ZatcaEnvironment,
  compliance: { certificate: string; secret: string },
  requestId: string,
): Promise<{ certificate: string; secret: string; requestId: string }> {
  const auth = Buffer.from(`${compliance.certificate}:${compliance.secret}`).toString('base64');
  const { body } = await call(`${zatcaBase(environment)}/production/csids`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` },
    body: { compliance_request_id: requestId },
  });

  if (!body?.binarySecurityToken || !body?.secret) {
    throw new ZatcaError(200, body, 'ZATCA لم تُعِد شهادة الإنتاج');
  }
  return {
    certificate: String(body.binarySecurityToken),
    secret: String(body.secret),
    requestId: String(body.requestID ?? requestId),
  };
}

/**
 * Renewal. A CSID expires, and an expired one fails every report with an
 * authentication error that reads like a configuration mistake.
 */
export async function renewProductionCsid(
  environment: ZatcaEnvironment,
  production: { certificate: string; secret: string },
  csrBase64: string, otp: string,
): Promise<{ certificate: string; secret: string }> {
  const auth = Buffer.from(`${production.certificate}:${production.secret}`).toString('base64');
  const { body } = await call(`${zatcaBase(environment)}/production/csids`, {
    method: 'PATCH',
    headers: { Authorization: `Basic ${auth}`, OTP: otp },
    body: { csr: csrBase64 },
  });
  return {
    certificate: String(body.binarySecurityToken),
    secret: String(body.secret),
  };
}

/** Expiry, read from the certificate rather than assumed. */
export function certificateExpiry(certificateBase64: string): Date | null {
  try {
    const der = Buffer.from(
      certificateBase64.replace(/-----[^-]+-----|\s/g, ''), 'base64',
    );
    // tbsCertificate → validity → notAfter. Walk rather than guess offsets.
    const notAfter = findNotAfter(der);
    return notAfter;
  } catch {
    return null;
  }
}

/**
 * Minimal DER walk to the validity period. Certificate ::= SEQUENCE {
 * tbsCertificate SEQUENCE { [0] version, serial, sigalg, issuer, validity … } }
 */
function findNotAfter(der: Buffer): Date | null {
  let i = 0;
  const len = (): number => {
    const first = der[i++]!;
    if (first < 0x80) return first;
    let n = 0;
    for (let k = 0; k < (first & 0x7f); k++) n = (n << 8) | der[i++]!;
    return n;
  };
  // Two statements, not `i += len()`: that reads i before len() advances it
  // past the length bytes, silently discarding the advance.
  const skip = (): void => { i++; const n = len(); i += n; };

  if (der[i++] !== 0x30) return null;            // Certificate
  len();
  if (der[i++] !== 0x30) return null;            // tbsCertificate
  len();
  if (der[i] === 0xa0) skip();                   // [0] version, optional
  skip();                                        // serialNumber
  skip();                                        // signature algorithm
  skip();                                        // issuer
  if (der[i++] !== 0x30) return null;            // validity
  len();
  skip();                                        // notBefore
  const tag = der[i++]!;
  const size = len();
  const value = der.subarray(i, i + size).toString('ascii');
  // UTCTime is YYMMDDHHMMSSZ; GeneralizedTime is YYYYMMDDHHMMSSZ.
  const iso = tag === 0x17
    ? `${Number(value.slice(0, 2)) < 50 ? '20' : '19'}${value.slice(0, 2)}-${value.slice(2, 4)}-${value.slice(4, 6)}T${value.slice(6, 8)}:${value.slice(8, 10)}:${value.slice(10, 12)}Z`
    : `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
