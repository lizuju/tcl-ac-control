export function activePriorityLevel(raw) {
  const match = /activeLevel=e:(\d+)@control:PriorityLevel/.exec(String(raw || ""));
  return match ? Number(match[1]) : null;
}

export function isLocalPriorityOverride(raw) {
  const level = activePriorityLevel(raw);
  return level !== null && level !== 17;
}
