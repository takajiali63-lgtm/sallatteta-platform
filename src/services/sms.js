// SMS for customer sign-in codes. Off until a provider key is set on Render — then codes switch on by themselves.
//   SMS_PROVIDER=twilio  + TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
// Any other provider can be added here behind the same send(phone, text) function.

export function createSms(env = process.env, { fetchImpl = globalThis.fetch, sender } = {}) {
  if (sender) return { enabled: true, send: sender };
  const provider = String(env.SMS_PROVIDER || '').toLowerCase();
  if (provider === 'twilio' && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) {
    const sid = env.TWILIO_ACCOUNT_SID;
    const auth = Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
    return {
      enabled: true,
      async send(phone, text) {
        const body = new URLSearchParams({ To: '+' + phone, From: env.TWILIO_FROM, Body: text });
        const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
          method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body,
        });
        if (!r.ok) throw new Error(`sms_failed_${r.status}`);
      },
    };
  }
  return { enabled: false, async send() { throw new Error('sms_disabled'); } };
}
