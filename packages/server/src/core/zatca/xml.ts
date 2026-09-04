/**
 * UBL 2.1 invoice document.
 *
 * The XML is emitted already in canonical form rather than built loosely and
 * canonicalised afterwards: attributes in a fixed order, empty elements written
 * as a start/end pair, no comments, no XML declaration in the hashed string.
 * We control the writer on both sides, so producing C14N output directly is
 * both simpler and safer than round-tripping through a general canonicaliser —
 * and the hash must match byte for byte or ZATCA rejects the invoice.
 *
 * What is hashed is the document WITHOUT its signature block, which is what
 * makes the chain verifiable: the signature covers the invoice, and the
 * invoice's hash becomes the next invoice's PIH.
 */

export interface InvoiceLineInput {
  index: number;
  nameAr: string;
  quantity: number;
  /** halalas, unit price excluding VAT */
  unitPrice: number;
  /** halalas, line total excluding VAT after its share of discount */
  lineTotal: number;
  /** halalas */
  vatAmount: number;
  discount: number;
}

export interface InvoiceInput {
  invoiceNumber: string;
  uuid: string;
  /** UTC instant of issue */
  issuedAt: Date;
  documentType: 'invoice' | 'credit_note' | 'debit_note';
  /** required on a credit or debit note: what it corrects */
  reversedInvoiceNumber?: string;
  reversalReason?: string;
  icv: number;
  pih: string;
  vatPercent: number;
  seller: {
    nameAr: string;
    vatNumber: string;
    address?: string | null;
    branchName?: string | null;
  };
  buyer?: { name: string; vatNumber?: string | null } | null;
  /** halalas */
  subtotal: number;
  discountTotal: number;
  vatAmount: number;
  grandTotal: number;
  paymentMeansCode: string;
  lines: InvoiceLineInput[];
}

/** 388 invoice, 381 credit note, 383 debit note — UN/EDIFACT 1001. */
const TYPE_CODE = { invoice: '388', credit_note: '381', debit_note: '383' } as const;

/**
 * Seven digits of transaction flags. Position 1 = simplified (B2C), which is
 * what a restaurant issues; the rest are third-party / nominal / export /
 * summary / self-billed, all zero here.
 */
const SIMPLIFIED_INVOICE = '0200000';

const money = (halalas: number): string => {
  const sign = halalas < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(halalas));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

const qty = (n: number): string => (Number.isInteger(n) ? n.toFixed(2) : String(n));

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const el = (name: string, value: string | number, attrs = ''): string =>
  `<${name}${attrs}>${escapeXml(String(value))}</${name}>`;

/** ISO date and time, split as UBL wants them, always UTC. */
function issueParts(at: Date): { date: string; time: string; stamp: string } {
  const iso = at.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) + 'Z', stamp: iso.replace(/\.\d{3}/, '') };
}

function party(nameAr: string, vatNumber: string, address?: string | null): string {
  return [
    '<cac:Party>',
    '<cac:PartyIdentification>',
    el('cbc:ID', vatNumber, ' schemeID="CRN"'),
    '</cac:PartyIdentification>',
    '<cac:PostalAddress>',
    el('cbc:StreetName', address ?? 'N/A'),
    el('cbc:CityName', 'Riyadh'),
    el('cbc:CountrySubentity', 'Riyadh'),
    '<cac:Country>',
    el('cbc:IdentificationCode', 'SA'),
    '</cac:Country>',
    '</cac:PostalAddress>',
    '<cac:PartyTaxScheme>',
    el('cbc:CompanyID', vatNumber),
    '<cac:TaxScheme>',
    el('cbc:ID', 'VAT'),
    '</cac:TaxScheme>',
    '</cac:PartyTaxScheme>',
    '<cac:PartyLegalEntity>',
    el('cbc:RegistrationName', nameAr),
    '</cac:PartyLegalEntity>',
    '</cac:Party>',
  ].join('');
}

function invoiceLine(line: InvoiceLineInput, vatPercent: number): string {
  return [
    '<cac:InvoiceLine>',
    el('cbc:ID', line.index),
    el('cbc:InvoicedQuantity', qty(line.quantity), ' unitCode="PCE"'),
    el('cbc:LineExtensionAmount', money(line.lineTotal), ' currencyID="SAR"'),
    '<cac:TaxTotal>',
    el('cbc:TaxAmount', money(line.vatAmount), ' currencyID="SAR"'),
    el('cbc:RoundingAmount', money(line.lineTotal + line.vatAmount), ' currencyID="SAR"'),
    '</cac:TaxTotal>',
    '<cac:Item>',
    el('cbc:Name', line.nameAr),
    '<cac:ClassifiedTaxCategory>',
    el('cbc:ID', 'S'),
    el('cbc:Percent', vatPercent.toFixed(2)),
    '<cac:TaxScheme>',
    el('cbc:ID', 'VAT'),
    '</cac:TaxScheme>',
    '</cac:ClassifiedTaxCategory>',
    '</cac:Item>',
    '<cac:Price>',
    el('cbc:PriceAmount', money(line.unitPrice), ' currencyID="SAR"'),
    '</cac:Price>',
    '</cac:InvoiceLine>',
  ].join('');
}

/**
 * The document as it is hashed: everything except the signature extension.
 * Deterministic — the same input always produces the same bytes, which is what
 * lets a hash be recomputed years later during an audit.
 */
export function canonicalInvoiceXml(input: InvoiceInput): string {
  const { date, time } = issueParts(input.issuedAt);
  const parts: string[] = [];

  parts.push(
    '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"'
    + ' xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"'
    + ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"'
    + ' xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">',
  );

  parts.push(el('cbc:ProfileID', 'reporting:1.0'));
  parts.push(el('cbc:ID', input.invoiceNumber));
  parts.push(el('cbc:UUID', input.uuid));
  parts.push(el('cbc:IssueDate', date));
  parts.push(el('cbc:IssueTime', time));
  parts.push(el('cbc:InvoiceTypeCode', TYPE_CODE[input.documentType], ` name="${SIMPLIFIED_INVOICE}"`));
  parts.push(el('cbc:DocumentCurrencyCode', 'SAR'));
  parts.push(el('cbc:TaxCurrencyCode', 'SAR'));

  // A credit note must say what it reverses and why, or it is rejected.
  if (input.documentType !== 'invoice') {
    parts.push(
      '<cac:BillingReference>',
      '<cac:InvoiceDocumentReference>',
      el('cbc:ID', input.reversedInvoiceNumber ?? ''),
      '</cac:InvoiceDocumentReference>',
      '</cac:BillingReference>',
    );
  }

  // The chain: counter, then the previous invoice's hash.
  parts.push(
    '<cac:AdditionalDocumentReference>',
    el('cbc:ID', 'ICV'),
    el('cbc:UUID', input.icv),
    '</cac:AdditionalDocumentReference>',
    '<cac:AdditionalDocumentReference>',
    el('cbc:ID', 'PIH'),
    '<cac:Attachment>',
    el('cbc:EmbeddedDocumentBinaryObject', input.pih, ' mimeCode="text/plain"'),
    '</cac:Attachment>',
    '</cac:AdditionalDocumentReference>',
  );

  parts.push('<cac:AccountingSupplierParty>');
  parts.push(party(input.seller.nameAr, input.seller.vatNumber, input.seller.address));
  parts.push('</cac:AccountingSupplierParty>');

  // Optional for a simplified invoice — present only when the customer is known.
  if (input.buyer) {
    parts.push('<cac:AccountingCustomerParty>');
    parts.push(party(input.buyer.name, input.buyer.vatNumber ?? 'N/A'));
    parts.push('</cac:AccountingCustomerParty>');
  }

  parts.push('<cac:Delivery>', el('cbc:ActualDeliveryDate', date), '</cac:Delivery>');
  parts.push('<cac:PaymentMeans>', el('cbc:PaymentMeansCode', input.paymentMeansCode), '</cac:PaymentMeans>');

  if (input.discountTotal > 0) {
    parts.push(
      '<cac:AllowanceCharge>',
      el('cbc:ChargeIndicator', 'false'),
      el('cbc:AllowanceChargeReason', 'discount'),
      el('cbc:Amount', money(input.discountTotal), ' currencyID="SAR"'),
      '</cac:AllowanceCharge>',
    );
  }

  parts.push(
    '<cac:TaxTotal>',
    el('cbc:TaxAmount', money(input.vatAmount), ' currencyID="SAR"'),
    '</cac:TaxTotal>',
    '<cac:TaxTotal>',
    el('cbc:TaxAmount', money(input.vatAmount), ' currencyID="SAR"'),
    '<cac:TaxSubtotal>',
    el('cbc:TaxableAmount', money(input.subtotal - input.discountTotal), ' currencyID="SAR"'),
    el('cbc:TaxAmount', money(input.vatAmount), ' currencyID="SAR"'),
    '<cac:TaxCategory>',
    el('cbc:ID', 'S'),
    el('cbc:Percent', input.vatPercent.toFixed(2)),
    '<cac:TaxScheme>',
    el('cbc:ID', 'VAT'),
    '</cac:TaxScheme>',
    '</cac:TaxCategory>',
    '</cac:TaxSubtotal>',
    '</cac:TaxTotal>',
  );

  parts.push(
    '<cac:LegalMonetaryTotal>',
    el('cbc:LineExtensionAmount', money(input.subtotal), ' currencyID="SAR"'),
    el('cbc:TaxExclusiveAmount', money(input.subtotal - input.discountTotal), ' currencyID="SAR"'),
    el('cbc:TaxInclusiveAmount', money(input.grandTotal), ' currencyID="SAR"'),
    el('cbc:AllowanceTotalAmount', money(input.discountTotal), ' currencyID="SAR"'),
    el('cbc:PayableAmount', money(input.grandTotal), ' currencyID="SAR"'),
    '</cac:LegalMonetaryTotal>',
  );

  for (const line of input.lines) parts.push(invoiceLine(line, input.vatPercent));

  parts.push('</Invoice>');
  return parts.join('');
}

/**
 * The document as it is stored and transmitted: the canonical body with the
 * signature, hash and stamp inserted into the UBL extension where ZATCA looks
 * for them.
 */
export function signedInvoiceXml(
  canonical: string,
  parts: { invoiceHash: string; signature: string; publicKeyDer: string; certificate: string | null; signedAt: Date },
): string {
  const extension = [
    '<ext:UBLExtensions>',
    '<ext:UBLExtension>',
    el('ext:ExtensionURI', 'urn:oasis:names:specification:ubl:dsig:enveloped:xades'),
    '<ext:ExtensionContent>',
    '<sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2">',
    '<sac:SignatureInformation xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2">',
    el('cbc:ID', 'urn:oasis:names:specification:ubl:signature:1'),
    el('sbc:ReferencedSignatureID', 'urn:oasis:names:specification:ubl:signature:Invoice',
      ' xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2"'),
    '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">',
    '<ds:SignedInfo>',
    '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"></ds:CanonicalizationMethod>',
    '<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"></ds:SignatureMethod>',
    '<ds:Reference Id="invoiceSignedData" URI="">',
    '<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>',
    el('ds:DigestValue', parts.invoiceHash),
    '</ds:Reference>',
    '</ds:SignedInfo>',
    el('ds:SignatureValue', parts.signature),
    '<ds:KeyInfo>',
    '<ds:X509Data>',
    el('ds:X509Certificate', parts.certificate ?? parts.publicKeyDer),
    '</ds:X509Data>',
    '</ds:KeyInfo>',
    '<ds:Object>',
    `<xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="signature">`,
    '<xades:SignedProperties Id="xadesSignedProperties">',
    '<xades:SignedSignatureProperties>',
    el('xades:SigningTime', parts.signedAt.toISOString().replace(/\.\d{3}/, '')),
    '</xades:SignedSignatureProperties>',
    '</xades:SignedProperties>',
    '</xades:QualifyingProperties>',
    '</ds:Object>',
    '</ds:Signature>',
    '</sac:SignatureInformation>',
    '</sig:UBLDocumentSignatures>',
    '</ext:ExtensionContent>',
    '</ext:UBLExtension>',
    '</ext:UBLExtensions>',
  ].join('');

  // The extension goes immediately after the root start tag, which is where the
  // schema requires it and where a validator looks for it first.
  const rootEnd = canonical.indexOf('>') + 1;
  return `<?xml version="1.0" encoding="UTF-8"?>${
    canonical.slice(0, rootEnd)}${extension}${canonical.slice(rootEnd)}`;
}
