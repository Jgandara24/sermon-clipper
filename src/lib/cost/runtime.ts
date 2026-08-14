export type RuntimeMeasurement = {
  wallTimeMs: number;
  cpuTimeMs: number;
};

export type RuntimeMeasurementStart = {
  startedAtMs: number;
  cpuUsage: NodeJS.CpuUsage;
};

export function startRuntimeMeasurement(): RuntimeMeasurementStart {
  return { startedAtMs: Date.now(), cpuUsage: process.cpuUsage() };
}

export function finishRuntimeMeasurement(start: RuntimeMeasurementStart): RuntimeMeasurement {
  const cpu = process.cpuUsage(start.cpuUsage);
  return {
    wallTimeMs: Math.max(0, Date.now() - start.startedAtMs),
    cpuTimeMs: (cpu.user + cpu.system) / 1_000,
  };
}
