import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { ConfigRegistry } from "./configRegistry";
import {
  buildFleetSnapshot,
  hasGps,
  mergeDevice,
  normalizeDevice,
  normalizePayload,
} from "./normalize";
import type { NormalizePayloadOptions } from "./normalize";
import { Persistence } from "./persistence";
import { moduleLogger } from "./logger";
import { isIngestableDeviceId } from "./validation";
import {
  DeviceAlert,
  DeviceSnapshot,
  FleetSnapshot,
  FormationSnapshot,
  LaneletOverlay,
  SceneMapDefinition,
  SocketEvent,
} from "./types";

const logger = moduleLogger("dashboard-store");

/**
 * How often the shed/reject/cap paths may log. Each of them fires **per message**
 * while the condition holds, so an unthrottled line would spend a saturated
 * process's remaining budget on logging about being saturated. The counters
 * behind `/metrics` stay exact; only the log lines are sampled.
 */
const WARN_THROTTLE_MS = 5_000;

/**
 * One queued mutation.
 *
 * `run` never rejects — it settles the caller's promise itself — so the pump
 * needs no error handling and cannot be poisoned by a failing task.
 */
interface QueuedMutation {
  run: () => Promise<void>;
  /** Settle the caller when the queue drops this entry instead of running it. */
  shed: () => void;
  /** Whether the queue may drop this entry once it is over its limit. */
  sheddable: boolean;
}

export interface ApplyPayloadOptions extends NormalizePayloadOptions {
  /**
   * Whether the ingest queue may drop this frame when it is full (P0-b).
   *
   * Off by default — only the MQTT firehose opts in, and it may because its frames
   * are *level-triggered*: each one carries the device's complete current state, so
   * the newest is a strict superset of the value of any older one still waiting.
   * Status frames, config reloads, the seed and the debug endpoint are all
   * edge-triggered or operator-driven and are never shed.
   */
  sheddable?: boolean;
}

export class DashboardStore extends EventEmitter {
  private rawDevices = new Map<string, DeviceSnapshot>();
  private devices = new Map<string, DeviceSnapshot>();
  private fleetName = config.fleetName;
  private topicPattern = config.topicPattern;
  private updatedAt = new Date().toISOString();
  // Serializes every mutating operation. The callers are un-awaited/concurrent
  // (MQTT `message` handler, offline-monitor interval, config watcher, REST),
  // and the mutators await persistence + event emission mid-way — without this
  // serialization, interleaved runs clobber each other's device maps (lost updates).
  //
  // P0-b: this used to be a promise chain (`tail = tail.then(task)`), which is
  // serial but **unbounded** — every un-awaited caller could append another link,
  // each holding its payload alive. A half-dead MongoDB (only
  // `serverSelectionTimeoutMS` is set, so each write can hang for seconds) turned
  // one slow dependency into unbounded memory growth. An explicit array is the
  // same ordering with a length that can be read, capped and reported.
  private queue: QueuedMutation[] = [];
  private pumping = false;
  private droppedMutations = 0;
  private readonly warnThrottle = new Map<string, number>();
  /**
   * When this process last received anything for a device — **our** clock, not the
   * vehicle's (P0-d).
   *
   * Eviction cannot key off `DeviceSnapshot.stamp`: that value is device-supplied
   * (and falls back to receive time only for frames that carry no time at all), so
   * a vehicle with a badly wrong clock would be evicted while it was still
   * reporting once a second. This map answers the question eviction actually asks —
   * "have we heard from it" — and is deleted alongside the device.
   */
  private lastIngestAt = new Map<string, number>();
  private rejectedDevices = 0;
  private cappedDevices = 0;
  private evictedDevices = 0;

  constructor(
    private readonly persistence: Persistence,
    private readonly configRegistry: ConfigRegistry,
  ) {
    super();
  }

  /** Log at most one line per `WARN_THROTTLE_MS` per `key`. */
  private warnThrottled(key: string, payload: Record<string, unknown>, message: string): void {
    const now = Date.now();
    if (now - (this.warnThrottle.get(key) ?? 0) < WARN_THROTTLE_MS) {
      return;
    }
    this.warnThrottle.set(key, now);
    logger.warn(payload, message);
  }

  /**
   * Run `task` after every previously enqueued mutation has finished.
   *
   * Every mutator returns `void`, so this is deliberately non-generic: a shed
   * entry has to settle its caller's promise without having a value to settle it
   * with, and `void` makes that honest instead of a cast.
   */
  private enqueue(task: () => Promise<void>, sheddable = false): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        sheddable,
        run: async () => {
          try {
            resolve(await task());
          } catch (error) {
            reject(error);
          }
        },
        // A shed frame resolves rather than rejects. It is not an error the caller
        // can act on — the MQTT handler's only recovery would be to log, once per
        // dropped frame, on a process that is already behind. The store owns the
        // decision, so it owns the record of it: an exact counter on `/metrics`
        // plus a throttled log line.
        shed: () => resolve(),
      });
      this.shedOverflow();
      void this.pump();
    });
  }

  /** Drain the queue in FIFO order, one mutation at a time. */
  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (this.queue.length) {
        await this.queue.shift()?.run();
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Enforce `INGEST_QUEUE_LIMIT` by dropping the **oldest** sheddable entries.
   *
   * Oldest and not newest, because the queue is a backlog of live state: dropping
   * the newest frames would freeze the console at the moment overload began and
   * then let it drift, which is indistinguishable on screen from a quiet fleet.
   * Dropping the oldest keeps what is displayed current, and pays for it in
   * history resolution — where a hole is visible as a hole.
   */
  private shedOverflow(): void {
    let dropped = 0;
    while (this.queue.length > config.ingestQueueLimit) {
      const index = this.queue.findIndex((entry) => entry.sheddable);
      if (index < 0) {
        // Nothing droppable left. Config reloads, status frames, the offline sweep
        // and `drain()` are never shed; their arrival rate is bounded by their own
        // timers, so the queue cannot grow without limit on those alone.
        break;
      }
      this.queue.splice(index, 1)[0]?.shed();
      dropped += 1;
    }

    if (!dropped) {
      return;
    }
    this.droppedMutations += dropped;
    this.warnThrottled(
      "ingest-shed",
      {
        dropped,
        droppedTotal: this.droppedMutations,
        depth: this.queue.length,
        limit: config.ingestQueueLimit,
      },
      "Ingest queue full; dropped the oldest sheddable telemetry frames",
    );
  }

  /** Queue depth, cumulative drops and the configured cap, for `/metrics`. */
  ingestQueueStats(): { depth: number; dropped: number; limit: number } {
    return {
      depth: this.queue.length,
      dropped: this.droppedMutations,
      limit: config.ingestQueueLimit,
    };
  }

  /** Admission and eviction counters plus the configured device cap, for `/metrics`. */
  deviceAdmissionStats(): { rejected: number; capped: number; evicted: number; limit: number } {
    return {
      rejected: this.rejectedDevices,
      capped: this.cappedDevices,
      evicted: this.evictedDevices,
      limit: config.maxDevices,
    };
  }

  /**
   * Whether a frame may enter (or keep updating) the in-memory fleet (P0-d).
   *
   * Before this gate, anything that arrived on a subscribed topic created a device
   * that was then held forever: there was no `Map.delete()` anywhere in the backend
   * and no ceiling on how many keys the four per-device structures could hold, with
   * a 512 MiB container limit behind them. Two rules, in this order:
   *
   * 1. The id must be usable at all — bounded length, and free of the characters a
   *    single MQTT topic segment cannot carry. This runs *before* the "already
   *    known" check so that a bad id which somehow got persisted is flushed out
   *    rather than grandfathered in.
   * 2. A **new** id is refused once the fleet is at `MAX_DEVICES`. Refusing the new
   *    one (rather than evicting an incumbent) is deliberate: a flood of invented
   *    ids must not be able to push real vehicles out of the console. Devices
   *    declared in `vehicles.json` are exempt — the operator named them, and their
   *    count is bounded by the file.
   */
  private admitDevice(deviceId: string): boolean {
    if (!isIngestableDeviceId(deviceId)) {
      this.rejectedDevices += 1;
      this.warnThrottled(
        "device-rejected",
        {
          // Truncated on purpose: the id is why we are here, and an unbounded one
          // has no business being copied into the log at full length.
          deviceId: deviceId.slice(0, 64),
          length: deviceId.length,
          rejectedTotal: this.rejectedDevices,
        },
        "Refused telemetry for an unusable device id",
      );
      return false;
    }

    if (this.rawDevices.has(deviceId) || this.configRegistry.hasDeviceConfig(deviceId)) {
      return true;
    }

    if (this.rawDevices.size >= config.maxDevices) {
      this.cappedDevices += 1;
      this.warnThrottled(
        "device-capped",
        {
          deviceId: deviceId.slice(0, 64),
          deviceCount: this.rawDevices.size,
          limit: config.maxDevices,
          cappedTotal: this.cappedDevices,
        },
        "Refused a new device: the in-memory fleet is at MAX_DEVICES",
      );
      return false;
    }

    return true;
  }

  /**
   * Forget devices this process has not heard from for `DEVICE_RETENTION_SECONDS`.
   *
   * Devices declared in `vehicles.json` are never evicted — a vehicle the operator
   * listed should read as "offline", not vanish — so what this reclaims is exactly
   * the unbounded part: ids that arrived from the broker and then went silent.
   * `device_latest` keeps its row either way, so an evicted device reappears the
   * moment it reports again (and the restore path bounds what comes back at
   * startup). Returns how many were evicted.
   */
  private evictSilentDevices(): number {
    const retentionMs = config.deviceRetentionSeconds * 1000;
    if (retentionMs <= 0) {
      return 0;
    }

    const now = Date.now();
    const evictable: string[] = [];
    for (const deviceId of this.rawDevices.keys()) {
      if (this.configRegistry.hasDeviceConfig(deviceId)) {
        continue;
      }
      const lastIngest = this.lastIngestAt.get(deviceId);
      if (lastIngest === undefined) {
        // No record yet (a path that did not seed it): treat now as the first
        // sighting rather than evicting on a value we never wrote.
        this.lastIngestAt.set(deviceId, now);
        continue;
      }
      if (now - lastIngest > retentionMs) {
        evictable.push(deviceId);
      }
    }

    for (const deviceId of evictable) {
      this.rawDevices.delete(deviceId);
      this.devices.delete(deviceId);
      this.lastIngestAt.delete(deviceId);
      // Cascade, or this reclaims the small half and leaves the large one: the
      // per-device in-memory telemetry ring holds up to MAX_HISTORY_POINTS
      // documents per device, which dwarfs the two snapshots evicted above.
      this.persistence.forgetDevice(deviceId);
    }

    if (evictable.length) {
      this.evictedDevices += evictable.length;
      logger.info(
        {
          evicted: evictable.length,
          evictedTotal: this.evictedDevices,
          deviceCount: this.rawDevices.size,
          retentionSeconds: config.deviceRetentionSeconds,
        },
        "Evicted devices that have been silent past DEVICE_RETENTION_SECONDS",
      );
    }

    return evictable.length;
  }

  async initialize(): Promise<void> {
    return this.enqueue(() => this.initializeInternal());
  }

  /**
   * Ingest a payload. Returns nothing on purpose.
   *
   * It used to return a freshly built `FleetSnapshot`, and the MQTT path — which is every
   * message from every vehicle — **discarded it**. Building one copies the device map and
   * sorts the whole fleet, so at 1 Hz × N vehicles that was a full snapshot rebuild per
   * message thrown straight away (P0-b, the "pure waste" half). The one caller that wants
   * a snapshot asks for it: `store.snapshot()`.
   */
  async applyPayload(
    payload: unknown,
    source = "mqtt",
    options: ApplyPayloadOptions = {},
  ): Promise<void> {
    return this.enqueue(
      () => this.applyPayloadInternal(payload, source, options),
      options.sheddable === true,
    );
  }

  async applyStatus(deviceId: string, statusPayload: unknown): Promise<void> {
    return this.enqueue(() => this.applyStatusInternal(deviceId, statusPayload));
  }

  async reloadConfig(): Promise<void> {
    return this.enqueue(() => this.reloadConfigInternal());
  }

  async evaluateOfflineDevices(): Promise<void> {
    return this.enqueue(() => this.evaluateOfflineDevicesInternal());
  }

  /**
   * Resolves once every mutation queued before this call has finished.
   *
   * The shutdown path needs it: closing MongoDB while ingests were still in flight threw
   * away whatever they were about to persist. A no-op at the tail of the same serial queue
   * is the whole implementation — there is no separate bookkeeping to get wrong.
   */
  async drain(): Promise<void> {
    return this.enqueue(async () => undefined);
  }

  private async initializeInternal(): Promise<void> {
    await this.configRegistry.load();
    this.refreshFleetMetadata();

    await this.persistence.connect();

    const restored = await this.persistence.restoreLatestDevices();
    if (restored.length) {
      const now = Date.now();
      restored
        .map((device) => normalizeDevice(device as unknown as Record<string, unknown>, null))
        .forEach((device) => {
          this.rawDevices.set(device.deviceId, device);
          // Seed the eviction clock from the persisted stamp, clamped to now so a
          // device with a stamp in the future cannot outlive the retention window.
          // The restore itself is already bounded to that window, so nothing that
          // comes back here is immediately evictable — no restore/evict churn.
          this.lastIngestAt.set(device.deviceId, Math.min(Date.parse(device.stamp) || now, now));
        });
      this.rebuildConfiguredDevices();
      this.updatedAt = new Date().toISOString();
      return;
    }

    const seeded = await this.loadSeedPayload();
    if (seeded) {
      await this.applyPayloadInternal(seeded, "seed", { allowReplace: true });
    }
  }

  private async reloadConfigInternal(): Promise<void> {
    this.rebuildConfiguredDevices();
    logger.info(
      {
        fleetName: this.fleetName,
        deviceCount: this.devices.size,
        sceneCount: this.configRegistry.listScenes().length,
      },
      "Applied reloaded runtime config to in-memory fleet state",
    );
  }

  private refreshFleetMetadata(): void {
    const fleetConfig = this.configRegistry.getFleetConfig();
    this.fleetName = fleetConfig.fleetName;
    this.topicPattern = fleetConfig.topicPattern;
  }

  private applySnapshotConfig(device: DeviceSnapshot): DeviceSnapshot {
    return this.configRegistry.applyDeviceConfig(device);
  }

  private rebuildConfiguredDevices(): void {
    this.refreshFleetMetadata();
    const nextDevices = new Map<string, DeviceSnapshot>();
    for (const device of this.rawDevices.values()) {
      nextDevices.set(device.deviceId, this.applySnapshotConfig(device));
    }
    this.devices = nextDevices;
  }

  private async loadSeedPayload(): Promise<unknown | null> {
    if (!config.seedFile) {
      logger.info("Seed payload disabled; starting with empty fleet");
      return null;
    }

    try {
      const filePath = path.resolve(config.seedFile);
      const content = await fs.readFile(filePath, "utf8");
      return JSON.parse(content);
    } catch (error) {
      logger.warn({ err: error }, "Failed to load seed payload from file; using empty startup");
      return null;
    }
  }

  private async applyPayloadInternal(
    payload: unknown,
    source: string,
    options: ApplyPayloadOptions = {},
  ): Promise<void> {
    const normalized = normalizePayload(
      payload,
      this.rawDevices,
      this.fleetName,
      this.topicPattern,
      options,
    );
    const nextRawMap = normalized.replace
      ? new Map<string, DeviceSnapshot>()
      : new Map(this.rawDevices);
    const nextDeviceMap = normalized.replace
      ? new Map<string, DeviceSnapshot>()
      : new Map(this.devices);

    for (const device of normalized.devices) {
      if (!this.admitDevice(device.deviceId)) {
        continue;
      }
      const existingRaw = this.rawDevices.get(device.deviceId);
      const existingConfigured = this.devices.get(device.deviceId);
      const mergedRaw = mergeDevice(existingRaw, device);
      const mergedConfigured = this.applySnapshotConfig(mergedRaw);

      nextRawMap.set(mergedRaw.deviceId, mergedRaw);
      nextDeviceMap.set(mergedConfigured.deviceId, mergedConfigured);
      this.lastIngestAt.set(mergedRaw.deviceId, Date.now());
      await this.persistRawDevice(mergedRaw);
      await this.emitChangeEvents(existingConfigured || null, mergedConfigured, source);
    }

    this.rawDevices = nextRawMap;
    this.devices = nextDeviceMap;
    this.updatedAt = new Date().toISOString();
  }

  private async applyStatusInternal(deviceId: string, statusPayload: unknown): Promise<void> {
    if (!this.admitDevice(deviceId)) {
      return;
    }
    const existingRaw = this.rawDevices.get(deviceId);
    const existingConfigured = this.devices.get(deviceId);
    const normalizedRaw = normalizeDevice(
      {
        deviceId,
        online: this.parseOnline(statusPayload),
        stamp: new Date().toISOString(),
      },
      existingRaw || null,
    );
    const configuredDevice = this.applySnapshotConfig(normalizedRaw);

    this.rawDevices.set(deviceId, normalizedRaw);
    this.devices.set(deviceId, configuredDevice);
    this.lastIngestAt.set(deviceId, Date.now());
    await this.persistRawDevice(normalizedRaw);
    await this.emitChangeEvents(existingConfigured || null, configuredDevice, "mqtt-status");
    this.updatedAt = new Date().toISOString();
  }

  private parseOnline(statusPayload: unknown): boolean {
    if (typeof statusPayload === "string") {
      const lowered = statusPayload.trim().toLowerCase();
      return lowered !== "offline" && lowered !== "0" && lowered !== "false";
    }
    if (typeof statusPayload === "object" && statusPayload !== null) {
      const record = statusPayload as Record<string, unknown>;
      if (typeof record.online === "boolean") {
        return record.online;
      }
      if (typeof record.status === "string") {
        return record.status.toLowerCase() !== "offline";
      }
    }
    return true;
  }

  private async persistRawDevice(device: DeviceSnapshot): Promise<void> {
    await this.persistence.writeLatestSnapshot(device);
    await this.persistence.writeTelemetry(device);
    await this.persistence.upsertAlerts(device.deviceId, device.alerts);
  }

  private async emitChangeEvents(
    previous: DeviceSnapshot | null,
    current: DeviceSnapshot,
    source: string,
  ): Promise<void> {
    this.broadcast({
      type: "fleet.delta",
      payload: {
        source,
        device: current,
      },
    });

    if (!previous || previous.online !== current.online) {
      this.broadcast({
        type: current.online ? "device.online" : "device.offline",
        payload: {
          source,
          deviceId: current.deviceId,
          at: current.stamp,
        },
      });
    }

    const previousAlertIds = new Set((previous?.alerts || []).map((alert) => alert.id));
    const currentAlertIds = new Set(current.alerts.map((alert) => alert.id));

    current.alerts.forEach((alert) => {
      if (!previousAlertIds.has(alert.id)) {
        this.broadcast({
          type: "alert.created",
          payload: {
            source,
            deviceId: current.deviceId,
            alert,
          },
        });
      }
    });

    (previous?.alerts || []).forEach((alert) => {
      if (!currentAlertIds.has(alert.id)) {
        this.broadcast({
          type: "alert.cleared",
          payload: {
            source,
            deviceId: current.deviceId,
            alertId: alert.id,
          },
        });
      }
    });
  }

  private broadcast(event: SocketEvent): void {
    this.emit("event", event);
  }

  snapshot(): FleetSnapshot {
    const devices = [...this.devices.values()];
    return buildFleetSnapshot(
      devices,
      this.fleetName,
      this.topicPattern,
      this.getFormations(devices),
      this.updatedAt,
    );
  }

  getFormations(devices = [...this.devices.values()]): FormationSnapshot[] {
    return this.configRegistry.buildFormationSnapshots(devices);
  }

  getScenes(): SceneMapDefinition[] {
    return this.configRegistry.listScenes();
  }

  getScene(sceneId: string): SceneMapDefinition | null {
    return this.configRegistry.getScene(sceneId);
  }

  getSceneOverlay(sceneId: string): LaneletOverlay | null {
    return this.configRegistry.getSceneOverlay(sceneId);
  }

  async getHistory(
    deviceId: string,
    from?: string,
    to?: string,
    limit?: number,
  ): Promise<unknown[]> {
    return this.persistence.queryHistory({ deviceId, from, to, limit });
  }

  async getAlerts(filters: {
    severity?: string;
    deviceId?: string;
    status?: string;
  }): Promise<unknown[]> {
    return this.persistence.queryAlerts(filters);
  }

  private async evaluateOfflineDevicesInternal(): Promise<void> {
    const thresholdMs = config.offlineAfterSeconds * 1000;
    const now = Date.now();

    for (const device of this.rawDevices.values()) {
      const isStale = now - Date.parse(device.stamp) > thresholdMs;
      if (!isStale || !device.online) {
        continue;
      }

      const nextAlerts: DeviceAlert[] = [
        ...device.alerts.filter((alert) => alert.id !== `${device.deviceId}-offline`),
        {
          id: `${device.deviceId}-offline`,
          title: "设备离线",
          detail: "设备超过离线阈值未上报，系统已自动标记为离线。",
          severity: "critical",
          source: "rule-engine",
          ts: new Date().toISOString(),
          active: true,
        },
      ];

      const updatedRaw = {
        ...device,
        online: false,
        alerts: nextAlerts,
      };
      const previousConfigured = this.devices.get(device.deviceId) || null;
      const updatedConfigured = this.applySnapshotConfig(updatedRaw);

      this.rawDevices.set(device.deviceId, updatedRaw);
      this.devices.set(device.deviceId, updatedConfigured);
      await this.persistRawDevice(updatedRaw);
      await this.emitChangeEvents(previousConfigured, updatedConfigured, "offline-monitor");
      this.updatedAt = new Date().toISOString();
    }

    // Same sweep, one step further along the same timeline: first mark the stale
    // ones offline, then forget the ones that have been silent long enough to have
    // no business occupying memory.
    if (this.evictSilentDevices()) {
      this.updatedAt = new Date().toISOString();
      // An authoritative snapshot rather than a new "device removed" event: a
      // long-lived tab has no other way to learn a device is gone, and the
      // frontends already treat a fleet-shaped payload as a replacement. Only
      // emitted when something was actually evicted, which is rare.
      this.broadcast({ type: "fleet.snapshot", payload: this.snapshot() });
    }
  }

  buildSummary(): Record<string, unknown> {
    const devices = [...this.devices.values()];
    const onlineCount = devices.filter((device) => device.online).length;
    const alertCount = devices.reduce((sum, device) => sum + device.alerts.length, 0);
    const gpsCount = devices.filter((device) => hasGps(device.gps) && device.gpsEnabled).length;
    return {
      fleetName: this.fleetName,
      deviceCount: devices.length,
      onlineCount,
      alertCount,
      gpsCount,
      updatedAt: this.updatedAt,
    };
  }
}
