import { monitorEventLoopDelay } from "node:perf_hooks";

export interface ProcessMetricsSnapshot {
  pid: number;
  uptimeSeconds: number;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
  cpu: {
    userMicros: number;
    systemMicros: number;
    /** Average CPU since process start, as a percentage of one core. */
    averagePercent: number;
  };
  /** Event-loop delay since the first metrics read (null until sampled). */
  eventLoopDelayMs: {
    mean: number;
    p50: number;
    p99: number;
    max: number;
  } | null;
}

let eventLoopHistogram: ReturnType<typeof monitorEventLoopDelay> | null = null;

const nsToMs = (value: number) => Math.round((value / 1e6) * 100) / 100;

export function getProcessMetricsSnapshot(): ProcessMetricsSnapshot {
  if (!eventLoopHistogram) {
    // Started lazily so instances that never ask for metrics pay nothing.
    eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
    eventLoopHistogram.enable();
  }
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const uptimeSeconds = process.uptime();
  const histogram = eventLoopHistogram;
  return {
    pid: process.pid,
    uptimeSeconds: Math.round(uptimeSeconds),
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    },
    cpu: {
      userMicros: cpu.user,
      systemMicros: cpu.system,
      averagePercent:
        uptimeSeconds > 0
          ? Math.round(((cpu.user + cpu.system) / 1e6 / uptimeSeconds) * 1000) / 10
          : 0,
    },
    eventLoopDelayMs:
      histogram.count > 0
        ? {
            mean: nsToMs(histogram.mean),
            p50: nsToMs(histogram.percentile(50)),
            p99: nsToMs(histogram.percentile(99)),
            max: nsToMs(histogram.max),
          }
        : null,
  };
}
