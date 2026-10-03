export const GATE_DEVICES = [
  { id: 'gate-one', name: 'Main entrance' },
  { id: 'gate-two', name: 'Balcony entrance' },
] as const;

/** Staff scopes store the same id for gate and device (seed and rehearsal). */
export function gateScanTarget(id?: string | null) {
  const found = GATE_DEVICES.find((gate) => gate.id === id);
  const gate = found ?? GATE_DEVICES[0];
  return { gateId: gate.id, deviceId: gate.id };
}
