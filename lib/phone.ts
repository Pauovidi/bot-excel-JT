export function normalizePhoneDigits(value: string) {
  return value.replace(/\D+/g, "");
}

export function normalizePhoneForStorage(value: string) {
  return normalizePhoneDigits(String(value ?? "").trim());
}

export function toComparablePhone(value: string) {
  const digits = normalizePhoneDigits(value);
  if (!digits) {
    return "";
  }

  if (digits.startsWith("34") && digits.length >= 11) {
    return `+${digits}`;
  }

  if (digits.length === 9) {
    return `+${process.env.DEFAULT_COUNTRY_CODE?.replace("+", "") || "34"}${digits}`;
  }

  return `+${digits}`;
}

export function toWhatsAppAddress(value: string) {
  const phone = value.startsWith("whatsapp:") ? value.replace("whatsapp:", "") : value;
  return `whatsapp:${toComparablePhone(phone)}`;
}
