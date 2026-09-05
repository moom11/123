/**
 * The certificate request ZATCA actually accepts.
 *
 * Onboarding is not "paste a certificate someone emailed you". The device
 * generates a key, builds a CSR describing itself, and ZATCA returns a CSID
 * bound to that exact unit. Everything identifying the device travels inside
 * the CSR, and a field in the wrong place is rejected with a message that does
 * not say which field — so each one is named and commented here.
 *
 * An EGS unit is a device that issues invoices. In MARA that is a cashier
 * terminal: waiters take orders, the till closes them. One till, one CSR, one
 * CSID, one invoice chain.
 */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { encodeSpki, fromPem, scalarFromPkcs8 } from './keys.js';
import {
  bitString, context, oid, octetString, printableString, rdn, sequence, set,
  utf8String, integer,
} from './der.js';

/**
 * The certificate template name. ZATCA rejects a CSR built for the wrong
 * environment, which is the single most common onboarding failure — the CSR
 * looks perfect and the portal simply says no.
 */
const TEMPLATE: Record<string, string> = {
  sandbox: 'TSTZATCACA-Code-Signing',
  simulation: 'PREZATCA-Code-Signing',
  production: 'ZATCA-Code-Signing',
};

const OID = {
  commonName: '2.5.4.3',
  serialNumber: '2.5.4.5',
  countryName: '2.5.4.6',
  organizationName: '2.5.4.10',
  organizationalUnit: '2.5.4.11',
  title: '2.5.4.12',
  businessCategory: '2.5.4.15',
  registeredAddress: '2.5.4.26',
  /** UID, from the RFC 1274 / X.500 pilot arc — where ZATCA puts the VAT number. */
  uid: '0.9.2342.19200300.100.1.1',
  extensionRequest: '1.2.840.113549.1.9.14',
  subjectAltName: '2.5.29.17',
  /** Microsoft's certificate-template-name extension, which ZATCA reuses. */
  templateName: '1.3.6.1.4.1.311.20.2',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
} as const;

export interface EgsUnit {
  environment: 'sandbox' | 'simulation' | 'production';
  /** Common name — the device as a human names it. */
  commonName: string;
  /** VAT registration number, 15 digits. */
  vatNumber: string;
  /** Legal name of the taxpayer. */
  organizationName: string;
  /** The branch, as the organisational unit. */
  branchName: string;
  /** Free text: city and street, as registered. */
  registeredAddress: string;
  /** Industry, e.g. 'Restaurant'. */
  businessCategory: string;
  /** The device's own serial, unique per unit. */
  serialNumber: string;
  /** Solution name and model, for the composite EGS serial. */
  solutionName?: string;
  model?: string;
  /**
   * Four flags: standard, simplified, and two reserved. A restaurant issues
   * simplified invoices only, so '0100'. Declaring standard invoices a device
   * cannot produce fails the compliance checks later, not here.
   */
  invoiceType?: string;
}

/** ZATCA's composite serial: `1-<solution>|2-<model>|3-<serial>`. */
export function egsSerial(unit: EgsUnit): string {
  return `1-${unit.solutionName ?? 'MARA'}|2-${unit.model ?? 'POS'}|3-${unit.serialNumber}`;
}

/**
 * The subjectAltName's directoryName. ZATCA reads the device's identity from
 * here rather than from the subject, which is why a CSR with a perfect subject
 * and an empty SAN is rejected.
 */
function subjectAltName(unit: EgsUnit): Buffer {
  const directory = sequence(
    rdn(OID.serialNumber, utf8String(egsSerial(unit))),
    rdn(OID.uid, utf8String(unit.vatNumber)),
    rdn(OID.title, utf8String(unit.invoiceType ?? '0100')),
    rdn(OID.registeredAddress, utf8String(unit.registeredAddress)),
    rdn(OID.businessCategory, utf8String(unit.businessCategory)),
  );
  // GeneralName ::= [4] directoryName — constructed, because a Name is.
  return sequence(oid(OID.subjectAltName), octetString(sequence(context(4, directory))));
}

function templateExtension(unit: EgsUnit): Buffer {
  const name = TEMPLATE[unit.environment];
  if (!name) throw new Error(`بيئة غير معروفة: ${unit.environment}`);
  return sequence(oid(OID.templateName), octetString(utf8String(name)));
}

/** Subject: C, OU, O, CN — in the order ZATCA's parser expects. */
function subject(unit: EgsUnit): Buffer {
  return sequence(
    rdn(OID.countryName, printableString('SA')),
    rdn(OID.organizationalUnit, utf8String(unit.branchName)),
    rdn(OID.organizationName, utf8String(unit.organizationName)),
    rdn(OID.commonName, utf8String(unit.commonName)),
  );
}

/**
 * Build and sign the request. Returns PEM, because that is what the ZATCA API
 * takes (base64 of the PEM body, in fact — see onboarding.ts).
 */
export function buildCsr(privateKeyPem: string, unit: EgsUnit): string {
  const scalar = scalarFromPkcs8(fromPem(privateKeyPem));
  const spki = encodeSpki(scalar);

  const attributes = context(0, sequence(
    oid(OID.extensionRequest),
    set(sequence(templateExtension(unit), subjectAltName(unit))),
  ));

  const info = sequence(
    integer(0),              // version v1
    subject(unit),
    spki,                    // already a complete SubjectPublicKeyInfo
    attributes,
  );

  // Sign the encoded info, not a reconstruction of it: the bytes that are
  // signed must be byte-identical to the bytes that are sent.
  const signature = Buffer.from(
    secp256k1.sign(sha256(info), scalar, { format: 'der', prehash: false }),
  );

  const csr = sequence(
    info,
    sequence(oid(OID.ecdsaWithSha256)),
    bitString(signature),
  );

  return toPem(csr, 'CERTIFICATE REQUEST');
}

export function toPem(der: Buffer, label: string): string {
  const body = der.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** The base64 body, which is what ZATCA's JSON field carries. */
export function pemBody(pem: string): string {
  return pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
}
