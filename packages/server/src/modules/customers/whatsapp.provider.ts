import { config } from '../../core/config.js';

/**
 * WhatsApp delivery for one-time codes.
 *
 * The interface exists so an SMS fallback can be added later without touching
 * any caller: `sendOtp` is the only thing the OTP service knows about.
 */
export interface MessageProvider {
  readonly name: string;
  sendOtp(phone: string, code: string, purposeLabel: string): Promise<DeliveryResult>;
}

export interface DeliveryResult {
  ok: boolean;
  reference?: string;
  error?: string;
}

/**
 * Meta WhatsApp Business Platform (Cloud API). OTPs are sent through an
 * approved authentication template — Meta does not permit free-form messages
 * for this purpose outside a customer service window.
 */
class MetaCloudProvider implements MessageProvider {
  readonly name = 'meta_cloud';

  async sendOtp(phone: string, code: string): Promise<DeliveryResult> {
    const { phoneNumberId, accessToken, apiVersion, otpTemplate, templateLanguage } =
      config.whatsapp;

    if (!phoneNumberId || !accessToken) {
      return { ok: false, error: 'WhatsApp credentials are not configured' };
    }

    const url = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      to: phone.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: otpTemplate,
        language: { code: templateLanguage },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          {
            type: 'button', sub_type: 'url', index: '0',
            parameters: [{ type: 'text', text: code }],
          },
        ],
      },
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        return {
          ok: false,
          error: (json as { error?: { message?: string } })?.error?.message
            ?? `WhatsApp API returned ${res.status}`,
        };
      }
      return {
        ok: true,
        reference: (json as { messages?: { id: string }[] })?.messages?.[0]?.id,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

/**
 * Development provider: writes the code to the server log instead of sending
 * it. Refuses to run in production so a misconfigured deploy fails loudly
 * rather than silently printing customers' codes into a log file.
 */
class LogProvider implements MessageProvider {
  readonly name = 'log';

  async sendOtp(phone: string, code: string, purposeLabel: string): Promise<DeliveryResult> {
    if (config.isProd) {
      return { ok: false, error: 'The log OTP provider must not be used in production' };
    }
    // eslint-disable-next-line no-console
    console.log(`[otp] ${purposeLabel} → ${phone}: ${code}`);
    return { ok: true, reference: `log-${Date.now()}` };
  }
}

let provider: MessageProvider | null = null;

export function getMessageProvider(): MessageProvider {
  if (!provider) {
    provider = config.whatsapp.provider === 'meta_cloud'
      ? new MetaCloudProvider()
      : new LogProvider();
  }
  return provider;
}

/** Test seam — lets the integration suite capture codes without a network. */
export function setMessageProvider(p: MessageProvider | null): void {
  provider = p;
}

/**
 * Normalise a Saudi phone number to E.164. Accepts 05xxxxxxxx, 5xxxxxxxx,
 * 9665xxxxxxxx and +9665xxxxxxxx so a guest can type it however they like,
 * while the database stores exactly one canonical form per person.
 */
export function normalisePhone(input: string, defaultCountry = '966'): string {
  let digits = input.replace(/[\s()-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  digits = digits.replace(/\D/g, '');

  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = defaultCountry + digits.slice(1);
  else if (digits.startsWith('5') && digits.length === 9) digits = defaultCountry + digits;

  if (digits.length < 10 || digits.length > 15) {
    throw new Error('رقم جوال غير صالح');
  }
  return `+${digits}`;
}
