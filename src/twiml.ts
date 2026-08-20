function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function buildVoiceTwiml(publicBaseUrl: string, fields: Record<string, string>): string {
  const streamUrl = publicBaseUrl.replace(/^https:/, "wss:") + "/voice/media";
  const parameters = Object.entries(fields)
    .filter(([, value]) => Boolean(value))
    .map(([name, value]) => `<Parameter name="${escapeXml(name)}" value="${escapeXml(value)}" />`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${escapeXml(streamUrl)}">${parameters}</Stream></Connect></Response>`;
}
