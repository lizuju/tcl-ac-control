export function statusIsOverridden(raw) {
  const bits = Number.parseInt(String(raw || "").split(";")[0] || "0", 16);
  return Number.isFinite(bits) && (bits & 0x10) !== 0;
}
