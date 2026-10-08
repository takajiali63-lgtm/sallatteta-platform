// WhatsApp Cloud API (Meta) — only for messages the platform sends BY ITSELF (the monthly report).
// Off until WHATSAPP_TOKEN + WHATSAPP_PHONE_ID are set in Render; template name: WHATSAPP_REPORT_TEMPLATE (default "monthly_report"),
// an approved template with 5 body parameters: {{1}} name · {{2}} page visits · {{3}} search appearances · {{4}} WhatsApp orders · {{5}} likes.
export const waCloudConfigured = () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);

export async function sendReportTemplate(to, lang, params, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: String(to).replace(/\D/g, ''), type: 'template',
      template: { name: process.env.WHATSAPP_REPORT_TEMPLATE || 'monthly_report', language: { code: lang || 'ar' },
        components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p) })) }] } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`whatsapp HTTP ${r.status}`);
  return true;
}
