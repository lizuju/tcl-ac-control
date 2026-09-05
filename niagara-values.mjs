export function encodeModeValue(ordinal, range, display) {
  return {
    nm: "p",
    t: "baja:DynamicEnum",
    d: display,
    v: `${ordinal}@${range}`,
  };
}

export function encodeTemperatureValue(value) {
  return {
    nm: "p",
    t: "baja:Double",
    d: value.toFixed(2),
    v: value.toFixed(1),
  };
}
