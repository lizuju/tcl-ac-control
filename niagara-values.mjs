export function encodeModeValue(ordinal, range) {
  return {
    nm: "p",
    t: "baja:DynamicEnum",
    v: `${ordinal}@${range}`,
  };
}

export function encodeTemperatureValue(value) {
  return {
    nm: "p",
    t: "baja:Double",
    v: String(value),
  };
}
