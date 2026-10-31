import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { deviceMatchesScope, applyRuleDebounce, evaluateRuleAlerts } from "@navfleet/shared";
import type {
  AlertClearedPayload,
  AlertCreatedPayload,
  ReportBucketUnit,
  Severity,
} from "@navfleet/shared";
import {
  ConfigRegistry,
  type ConfigFileKey,
  type ConfigStatus,
  type SceneAssetKind,
} from "./configRegistry";
import {
  carryAlertOnsets,
  buildFleetSnapshot,
  buildOfflineAlert,
  hasGps,
  mergeDevice,
  normalizeDevice,
  normalizePayload,
  offlineAlertId,
} from "./normalize";
import type { NormalizePayloadOptions, RuleMembership } from "./normalize";
import { Persistence } from "./persistence";
import { moduleLogger } from "./logger";
import { isIngestableDeviceId } from "./validation";
import {
  AlertRulesConfig,
  DeviceAlert,
  DeviceConfig,
  DeviceSnapshot,
  FleetSnapshot,
  FormationConfig,
  FormationSnapshot,
  LaneletOverlay,
  NotifyConfig,
  ReportCodeEntry,
  ReportsConfig,
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
 * Spellings that mean "offline" in a status frame, whichever shape it arrives in.
 *
 * One set, because the plain-string form and the `{ status: … }` form used to
 * interpret the same word differently: the former rejected `offline`/`0`/`false`
 * after trimming, the latter compared only against `offline` and did not trim.
 * `parseOnline` reads both through `isOfflineStatusToken`, so a publisher cannot
 * get a different answer by wrapping the same word in an object.
 */
const OFFLINE_STATUS_TOKENS = new Set(["offline", "0", "false"]);

const isOfflineStatusToken = (value: string): boolean =>
  OFFLINE_STATUS_TOKENS.has(value.trim().toLowerCase());

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
   * Whether the ingest queue may drop this frame when it is full.
   *
   * Off by default — only the MQTT firehose opts in, and it may because its frames
   * are *level-triggered*: each one carries the device's complete current state, so
   * the newest is a strict superset of the value of any older one still waiting.
   * Status frames, config reloads, the seed and the debug endpoint are all
   * edge-triggered or operator-driven and are never shed.
   */
  sheddable?: boolean;

  /**
   * Whether the frame's own `stamp` is checked against its arrival time, and a frame older
   * than the last one accepted for the device is dropped. Only the MQTT firehose opts in:
   * the seed and the debug ingest endpoint replay history, whose stamps are old on purpose.
   */
  checkDeviceClock?: boolean;
}

export class DashboardStore extends EventEmitter {
  private rawDevices = new Map<string, DeviceSnapshot>();
  private devices = new Map<string, DeviceSnapshot>();
  /**
   * The snapshot map a telemetry frame is building, while it is being built. A frame's change
   * events go out inside its loop, before `devices` is swapped at the end, so a listener that
   * looks the device up again (the notify dispatcher, for scope and display name) would otherwise
   * get the previous frame's view, or nothing for a vehicle's first frame.
   */
  private ingestingDevices: Map<string, DeviceSnapshot> | null = null;
  private fleetName = config.fleetName;
  private topicPattern = config.topicPattern;
  private updatedAt: string;
  // Serializes every mutating operation. The callers are un-awaited/concurrent
  // (MQTT `message` handler, offline-monitor interval, config watcher, REST),
  // and the mutators await persistence + event emission mid-way — without this
  // serialization, interleaved runs clobber each other's device maps (lost updates).
  //
  // This used to be a promise chain (`tail = tail.then(task)`), which is
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
   * vehicle's.
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
  /**
   * The stamp of the last live frame accepted per device, for dropping a frame that arrives
   * after a newer one. Frames are level-triggered — each carries the whole current state —
   * so an older one landing late would roll the vehicle back to where it was. Kept apart
   * from `DeviceSnapshot.stamp`, which a status frame also sets (to server time).
   */
  private lastFrameStamp = new Map<string, number>();
  private untrustedStamps = 0;
  private outOfOrderFrames = 0;

  /**
   * Since when the telemetry source (the MQTT broker connection) has been up, or null while it is
   * down. Defaults to "up since forever" so a store with no source wired (tests, a deployment that
   * only ingests over HTTP) judges silence exactly as before.
   */
  private sourceUpSince: number | null = 0;
  /** When the offline sweep last ran, to notice that this process was suspended in between. */
  private lastSweepAt: number | null = null;

  constructor(
    private readonly persistence: Persistence,
    private readonly configRegistry: ConfigRegistry,
    /**
     * The store's clock: arrival time, debounce, the offline sweep, eviction, alert clears. The
     * process clock in production. The demo simulator's history backfill passes the simulated
     * time, so a month of frames goes through exactly this code and every time it records —
     * when an alert cleared, when a vehicle went silent — is the time it happened in the
     * simulation, not the minute the backfill ran.
     */
    private readonly now: () => number = () => Date.now(),
  ) {
    super();
    this.updatedAt = this.nowIso();
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * Tell the store whether the telemetry source is connected. While it is down, a vehicle's
   * silence says nothing about the vehicle — every one goes quiet at once — so the offline sweep
   * holds off; after it comes back, the sweep waits one full offline window so vehicles get the
   * chance to report again before their pre-outage stamps are judged.
   */
  setSourceConnected(connected: boolean): void {
    if (connected) {
      this.sourceUpSince ??= this.now();
    } else {
      this.sourceUpSince = null;
    }
  }

  /** Log at most one line per `WARN_THROTTLE_MS` per `key`. */
  private warnThrottled(key: string, payload: Record<string, unknown>, message: string): void {
    const now = this.now();
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
  private enqueue(task: () => Promise<void> | void, sheddable = false): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        sheddable,
        run: async () => {
          try {
            resolve(await task());
          } catch (error) {
            // Wrapped rather than passed through: a queued task can throw anything, and a
            // caller that does `.catch((e) => e.message)` on a rejected string gets a second,
            // less informative failure. `prefer-promise-reject-errors` is what
            // asked, and the answer is the one that makes the rejection usable.
            reject(error instanceof Error ? error : new Error(String(error)));
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

  /** Device-clock counters, for `/metrics`. */
  deviceClockStats(): { untrusted: number; outOfOrder: number } {
    return { untrusted: this.untrustedStamps, outOfOrder: this.outOfOrderFrames };
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
   * Whether a frame may enter (or keep updating) the in-memory fleet.
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
  private admitDevice(
    deviceId: string,
    /**
     * The fleet the cap is measured against. Defaults to the live map, but
     * `applyPayloadInternal` passes the map it is *building*: it accumulates into
     * a new Map and only assigns it at the end, so measuring `this.rawDevices`
     * inside that loop measured a size that could not grow and admitted every
     * device in a multi-device payload regardless of `MAX_DEVICES`.
     */
    observedFleet: Map<string, DeviceSnapshot> = this.rawDevices,
  ): boolean {
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

    if (observedFleet.has(deviceId) || this.configRegistry.hasDeviceConfig(deviceId)) {
      return true;
    }

    if (observedFleet.size >= config.maxDevices) {
      this.cappedDevices += 1;
      this.warnThrottled(
        "device-capped",
        {
          deviceId: deviceId.slice(0, 64),
          deviceCount: observedFleet.size,
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
  private async evictSilentDevices(): Promise<number> {
    const retentionMs = config.deviceRetentionSeconds * 1000;
    if (retentionMs <= 0) {
      return 0;
    }

    const now = this.now();
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
      await this.closeAlertsOf(deviceId, "eviction");
      this.rawDevices.delete(deviceId);
      this.devices.delete(deviceId);
      this.lastIngestAt.delete(deviceId);
      this.lastFrameStamp.delete(deviceId);
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
   * message thrown straight away. The one caller that wants
   * a snapshot asks for it: `store.snapshot()`.
   */
  async applyPayload(
    payload: unknown,
    source = "mqtt",
    options: ApplyPayloadOptions = {},
  ): Promise<void> {
    // Arrival time is taken here, before the queue: a frame that waited behind a slow write
    // still arrived when it arrived.
    const receivedAt = this.now();
    return this.enqueue(
      () => this.applyPayloadInternal(payload, source, options, receivedAt),
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
    return this.enqueue(() => undefined);
  }

  private async initializeInternal(): Promise<void> {
    await this.configRegistry.load();
    this.refreshFleetMetadata();

    await this.persistence.connect();

    const restored = await this.persistence.restoreLatestDevices(
      this.configRegistry.listVehicleConfigs().map((vehicle) => vehicle.deviceId),
    );
    if (restored.length) {
      const now = this.now();
      // Restore only devices the current roster still configures. A restored row is a
      // historical snapshot, not a live report: resurrecting one whose id has since left
      // vehicles.json seeds an off-roster ghost into the fleet that nothing prunes until
      // DEVICE_RETENTION_SECONDS of silence (evictSilentDevices exempts configured ids and
      // only reaps the rest after that window) — the "设备列表里多出几台" report. A device
      // that is genuinely still publishing reappears on its next report and is shown like
      // any live unconfigured device; this filter drops only the stale ones a roster change
      // left behind in device_latest.
      restored
        .map((device) =>
          normalizeDevice(
            device as unknown as Record<string, unknown>,
            null,
            "",
            undefined,
            undefined,
            undefined,
            { snapshotAlerts: true },
          ),
        )
        .filter((device) => this.configRegistry.hasDeviceConfig(device.deviceId))
        .forEach((device) => {
          this.rawDevices.set(device.deviceId, device);
          // Seed the silence clock from the persisted stamp, clamped to now so a device with a
          // stamp in the future does not look fresher than it is. Declared vehicles are never
          // evicted, so a long-silent one comes back and is judged offline, not dropped.
          this.lastIngestAt.set(device.deviceId, Math.min(Date.parse(device.stamp) || now, now));
        });
      this.rebuildConfiguredDevices();
      this.updatedAt = this.nowIso();
      // Restored stamps are from before this process started, so they are as old as the restart
      // took. That says nothing about the vehicles: give them one offline window to report, as
      // after a source outage, instead of judging the whole fleet offline on the first sweep.
      if (this.sourceUpSince !== null) this.sourceUpSince = Math.max(this.sourceUpSince, now);
      return;
    }

    const seeded = await this.loadSeedPayload();
    if (seeded) {
      await this.applyPayloadInternal(seeded, "seed", { allowReplace: true });
    }
  }

  private async reloadConfigInternal(): Promise<void> {
    this.rebuildConfiguredDevices();
    await this.reevaluateRuleAlerts();
    logger.info(
      {
        fleetName: this.fleetName,
        deviceCount: this.devices.size,
        sceneCount: this.configRegistry.listScenes().length,
      },
      "Applied reloaded runtime config to in-memory fleet state",
    );
  }

  /**
   * Re-run the rules (low battery, offline) on every vehicle after `rules.json` or the roster
   * changed. A vehicle that is still reporting would correct itself on its next frame; a silent
   * one never would, so a rule turned off for maintenance left its offline alert active forever.
   */
  private async reevaluateRuleAlerts(): Promise<void> {
    const rules = this.configRegistry.getAlertRules();
    for (const device of [...this.rawDevices.values()]) {
      const configured = this.applySnapshotConfig(device);
      const evaluated = evaluateRuleAlerts(
        { ...device, tags: configured.tags, formationIds: configured.formationIds },
        rules,
      );
      // An alert that is still raised keeps the object it had (its `ts`); only the set changes.
      const previous = new Map(device.alerts.map((alert) => [alert.id, alert]));
      const ruleAlerts = applyRuleDebounce(
        device.deviceId,
        device.alerts,
        evaluated.map((alert) => previous.get(alert.id) ?? alert),
        rules,
        this.now(),
      ).filter((alert) => alert.source === "rule-engine");
      const nextAlerts = carryAlertOnsets(device.alerts, [
        ...device.alerts.filter((alert) => alert.source !== "rule-engine"),
        ...ruleAlerts,
      ]);
      const before = device.alerts
        .map((alert) => alert.id)
        .sort()
        .join("|");
      const after = nextAlerts
        .map((alert) => alert.id)
        .sort()
        .join("|");
      if (before === after) continue;

      const updatedRaw = { ...device, alerts: nextAlerts };
      const updatedConfigured = this.applySnapshotConfig(updatedRaw);
      this.rawDevices.set(device.deviceId, updatedRaw);
      this.devices.set(device.deviceId, updatedConfigured);
      this.emitChangeEvents(configured, updatedConfigured, "config-reload");
      await this.persistState(updatedRaw);
    }
  }

  /**
   * Close a departing device's active alerts — in MongoDB and for the listeners (the consoles,
   * the notify escalations). Eviction and a whole-fleet replace forget a device; without this its
   * occurrences stayed `active` in `alerts` for good.
   */
  private async closeAlertsOf(deviceId: string, source: string): Promise<void> {
    const device = this.rawDevices.get(deviceId);
    if (!device?.alerts.length) return;
    for (const alert of device.alerts) {
      const payload: AlertClearedPayload = { source, deviceId, alertId: alert.id };
      this.broadcast({ type: "alert.cleared", payload });
    }
    await this.persistence.upsertAlerts(deviceId, [], new Date(this.now()));
  }

  private refreshFleetMetadata(): void {
    const fleetConfig = this.configRegistry.getFleetConfig();
    this.fleetName = fleetConfig.fleetName;
    this.topicPattern = fleetConfig.topicPattern;
  }

  private applySnapshotConfig(device: DeviceSnapshot): DeviceSnapshot {
    return this.configRegistry.applyDeviceConfig(device);
  }

  /** The tags and formations config gives a vehicle, for rule scopes (see `RuleMembership`). */
  private readonly ruleMembership: RuleMembership = (device) => {
    const { tags, formationIds } = this.applySnapshotConfig(device);
    return { tags, formationIds };
  };

  private rebuildConfiguredDevices(): void {
    this.refreshFleetMetadata();
    const nextDevices = new Map<string, DeviceSnapshot>();
    for (const device of this.rawDevices.values()) {
      nextDevices.set(device.deviceId, this.applySnapshotConfig(device));
    }
    this.devices = nextDevices;
  }

  private async loadSeedPayload(): Promise<unknown> {
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
    receivedAt = this.now(),
  ): Promise<void> {
    const alertRules = this.configRegistry.getAlertRules();
    const checkClock = options.checkDeviceClock === true;
    // Device ids are read from topics with the pattern MQTT subscribed with, not with fleet.json's
    // `topicPattern`, which is only displayed: the two can differ, and the subscription is what
    // decided which topics arrive.
    const normalized = normalizePayload(
      payload,
      this.rawDevices,
      this.fleetName,
      config.topicPattern,
      {
        ...options,
        rules: alertRules,
        membership: this.ruleMembership,
        ...(checkClock
          ? {
              clock: {
                receivedAt,
                toleranceMs: config.deviceClockToleranceSeconds * 1000,
                onUntrusted: ({ deviceId, skewMs }) => {
                  this.untrustedStamps += 1;
                  this.warnThrottled(
                    `untrusted-stamp:${deviceId}`,
                    { deviceId, skewMs },
                    "Device clock outside tolerance; frame recorded at arrival time",
                  );
                },
              },
            }
          : {}),
      },
    );
    const nextRawMap = normalized.replace
      ? new Map<string, DeviceSnapshot>()
      : new Map(this.rawDevices);
    const nextDeviceMap = normalized.replace
      ? new Map<string, DeviceSnapshot>()
      : new Map(this.devices);

    this.ingestingDevices = nextDeviceMap;
    try {
      for (const device of normalized.devices) {
        // `nextRawMap`, not the live map: see `admitDevice`'s `observedFleet`.
        if (!this.admitDevice(device.deviceId, nextRawMap)) {
          continue;
        }
        if (checkClock) {
          // After the clock check every stamp sits within the tolerance of its arrival, so this
          // can hold a device back for at most twice the tolerance — never lock it out.
          const stampMs = Date.parse(device.stamp);
          const lastMs = this.lastFrameStamp.get(device.deviceId);
          if (lastMs !== undefined && stampMs < lastMs) {
            this.outOfOrderFrames += 1;
            this.warnThrottled(
              `out-of-order:${device.deviceId}`,
              {
                deviceId: device.deviceId,
                stamp: device.stamp,
                lastStamp: new Date(lastMs).toISOString(),
              },
              "Dropped a frame older than the device's last one",
            );
            continue;
          }
          this.lastFrameStamp.set(device.deviceId, stampMs);
        }
        const existingRaw = this.rawDevices.get(device.deviceId);
        const existingConfigured = this.devices.get(device.deviceId);
        const mergedRaw = mergeDevice(existingRaw, device);
        // Linger a debounced rule alert across the frame that would clear it.
        // `mergeDevice` takes the freshly-evaluated alerts wholesale, so without this a low
        // battery reading hovering on the threshold would flap on and off frame by frame.
        // Measured on the frame's clock, the one the alert's `ts` is stamped with.
        const frameMs = Date.parse(mergedRaw.stamp);
        mergedRaw.alerts = applyRuleDebounce(
          mergedRaw.deviceId,
          existingRaw?.alerts ?? [],
          mergedRaw.alerts,
          alertRules,
          Number.isFinite(frameMs) ? frameMs : this.now(),
        );
        const mergedConfigured = this.applySnapshotConfig(mergedRaw);

        nextRawMap.set(mergedRaw.deviceId, mergedRaw);
        nextDeviceMap.set(mergedConfigured.deviceId, mergedConfigured);
        this.lastIngestAt.set(mergedRaw.deviceId, this.now());
        // Broadcast first, persist second: the live view must not wait on the database. The write
        // still runs inside the serial queue (ordering, backpressure) and is time-bounded.
        this.emitChangeEvents(existingConfigured || null, mergedConfigured, source);
        await this.persistRawDevice(mergedRaw);
      }
    } finally {
      this.ingestingDevices = null;
    }

    // A replace payload can drop devices, and rebuilding the two snapshot maps
    // does not carry the rest of a device's footprint with it. Two things have to
    // be cascaded by hand, exactly as `evictSilentDevices` does:
    //
    //   - `lastIngestAt`, whose only sweep iterates `rawDevices.keys()` — so an
    //     entry for a device that is no longer in the fleet can never be reached
    //     again, and the map grows for the life of the process.
    //   - the per-device telemetry ring in persistence, which in the no-Mongo
    //     fallback also keeps answering `GET /alerts` for a departed device.
    //
    // Guarded on `replace` rather than run always: in the merge case `nextRawMap`
    // starts as a copy of the live map, so nothing can be missing and this would
    // be an O(fleet) walk on every telemetry frame.
    if (normalized.replace) {
      for (const deviceId of [...this.rawDevices.keys()]) {
        if (!nextRawMap.has(deviceId)) {
          await this.closeAlertsOf(deviceId, source);
          this.lastIngestAt.delete(deviceId);
          this.lastFrameStamp.delete(deviceId);
          this.persistence.forgetDevice(deviceId);
        }
      }
    }

    this.rawDevices = nextRawMap;
    this.devices = nextDeviceMap;
    this.updatedAt = this.nowIso();
    // A replace can drop devices, and deltas never remove one: an open console learns the new
    // fleet only from a snapshot, as after an eviction or a config reload.
    if (normalized.replace) {
      this.broadcast({ type: "fleet.snapshot", payload: this.snapshot() });
    }
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
        stamp: this.nowIso(),
      },
      existingRaw || null,
      "",
      this.configRegistry.getAlertRules(),
      undefined,
      this.ruleMembership,
      // A status frame says nothing about the vehicle's own alarms; read as "none", a heartbeat
      // closed a continuing alarm and the next telemetry frame opened (and sent out) a new one.
      { keepReportedAlerts: true },
    );
    const configuredDevice = this.applySnapshotConfig(normalizedRaw);

    this.rawDevices.set(deviceId, normalizedRaw);
    this.devices.set(deviceId, configuredDevice);
    this.lastIngestAt.set(deviceId, this.now());
    this.emitChangeEvents(existingConfigured || null, configuredDevice, "mqtt-status");
    await this.persistRawDevice(normalizedRaw);
    this.updatedAt = this.nowIso();
  }

  private parseOnline(statusPayload: unknown): boolean {
    // A bare boolean is one of the three shapes `mqttStatusSchema` admits, and it
    // is the least ambiguous of them. Without this branch `false` fell through to
    // the optimistic default at the bottom and marked the device **online** — the
    // payload that says "I am offline" in the plainest possible way was the one
    // that inverted. `{ online: false }` was always handled correctly, so this
    // only ever bit publishers using the bare form.
    if (typeof statusPayload === "boolean") {
      return statusPayload;
    }
    if (typeof statusPayload === "string") {
      return !isOfflineStatusToken(statusPayload);
    }
    if (typeof statusPayload === "object" && statusPayload !== null) {
      const record = statusPayload as Record<string, unknown>;
      if (typeof record.online === "boolean") {
        return record.online;
      }
      // `{ online: 0 }` and `{ online: "false" }` are common last-will payloads; they used to fall
      // through to the optimistic default and keep a vehicle that had just dropped off online.
      if (typeof record.online === "number") {
        return record.online !== 0;
      }
      if (typeof record.online === "string") {
        return !isOfflineStatusToken(record.online);
      }
      // Shares `isOfflineStatusToken` with the bare-string branch rather than
      // testing `!== "offline"` on its own: the two spellings disagreed, so
      // `"false"` meant offline as a plain payload and online inside
      // `{ status: … }`, and `" offline "` was online here but offline there.
      if (typeof record.status === "string") {
        return !isOfflineStatusToken(record.status);
      }
    }
    // Anything else: a frame arrived at all, so the device is talking to us.
    return true;
  }

  private async persistRawDevice(device: DeviceSnapshot): Promise<void> {
    await this.persistence.writeLatestSnapshot(device);
    await this.persistence.writeTelemetry(device);
    await this.persistence.upsertAlerts(device.deviceId, device.alerts, new Date(this.now()));
  }

  /**
   * Persist a change the store made itself (an offline verdict, a re-evaluated rule): the latest
   * snapshot and the alerts, but no telemetry. Such a snapshot repeats the last frame's `stamp`;
   * written as a frame it landed at the same instant as the real one, and the availability report
   * then read that instant as online or offline depending on sort order.
   */
  private async persistState(device: DeviceSnapshot): Promise<void> {
    await this.persistence.writeLatestSnapshot(device);
    await this.persistence.upsertAlerts(device.deviceId, device.alerts, new Date(this.now()));
  }

  /**
   * Broadcast what changed between two snapshots of one device.
   *
   * Synchronous, and now says so. It was `async` with no `await` in it and was awaited at
   * all three call sites, which read as「广播要等一等」—— broadcasting is `this.emit`, it
   * returns when the last listener returns. `require-await` is what surfaced
   * it; the cost of the old shape was not performance but a false claim about the model.
   */
  private emitChangeEvents(
    previous: DeviceSnapshot | null,
    current: DeviceSnapshot,
    source: string,
  ): void {
    this.broadcast({
      type: "fleet.delta",
      payload: {
        source,
        device: current,
        /**
         * Server time for this delta.
         *
         * The snapshot has always carried `updatedAt` and a delta never did, so the
         * console's freshness line — which reads it — only moved when a *snapshot*
         * arrived: on connect, on a config reload, and now on an eviction. Between those
         * it sat frozen at whatever time the socket opened, on a page that was in fact
         * being updated once a second per vehicle. A freshness indicator that does not
         * move is worse than none: it answers "is this live" with a confident no.
         */
        updatedAt: this.nowIso(),
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
        const payload: AlertCreatedPayload = { source, deviceId: current.deviceId, alert };
        this.broadcast({ type: "alert.created", payload });
      }
    });

    (previous?.alerts || []).forEach((alert) => {
      if (!currentAlertIds.has(alert.id)) {
        const payload: AlertClearedPayload = {
          source,
          deviceId: current.deviceId,
          alertId: alert.id,
        };
        this.broadcast({ type: "alert.cleared", payload });
      }
    });
  }

  private broadcast(event: SocketEvent): void {
    this.emit("event", event);
  }

  /**
   * Fan out an acknowledgement to every connected client. Unlike the
   * fleet/device/alert events above, this is not derived from a telemetry delta — it is
   * driven by the ack route after it has written to persistence — so it gets its own entry
   * point rather than going through `emitChangeEvents`. The `wsBridge` already forwards
   * anything the store emits as `"event"`.
   */
  broadcastAlertAck(payload: {
    deviceId: string;
    alertId: string;
    ackedBy: string;
    ackedAt: string;
  }): void {
    this.broadcast({ type: "alert.acked", payload });
  }

  broadcastAlertUnack(payload: { deviceId: string; alertId: string }): void {
    this.broadcast({ type: "alert.unacked", payload });
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

  /**
   * The current state of one device, or null if none is held. Used by the notification
   * dispatcher to resolve an alert's device for scope matching and the message's
   * display name, without rebuilding a whole `snapshot()`. Returns the live reference — callers
   * read it (name/tags/formationIds) and never mutate.
   */
  getDevice(deviceId: string): DeviceSnapshot | null {
    return this.ingestingDevices?.get(deviceId) ?? this.devices.get(deviceId) ?? null;
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

  // ── Scene-map upload & management: write scenes.json + upload backdrops ──
  /** Validate + persist `scenes.json` (full array), reload, and return the configured scenes. */
  writeScenes(raw: unknown, expectedVersion?: string): Promise<SceneMapDefinition[]> {
    return this.configRegistry.writeScenes(raw, expectedVersion);
  }

  /** Validate + store an uploaded backdrop for a scene, reload, and return its /scene-maps/ URL. */
  writeSceneAsset(sceneId: string, kind: SceneAssetKind, buffer: Buffer): Promise<string> {
    return this.configRegistry.writeSceneAsset(sceneId, kind, buffer);
  }

  /** The report-code dictionary in effect (built-in ⊕ deployment codebook). */
  getCodebook(): ReportCodeEntry[] {
    return this.configRegistry.getCodebook();
  }

  /** Validate + persist a deployment codebook, reload, and return the merged table. */
  /** Version (ETag) of a config file as last loaded, for optimistic-concurrency writes. */
  getConfigVersion(key: ConfigFileKey): string {
    return this.configRegistry.getConfigVersion(key);
  }

  /** Health of the configuration in effect (per-file fallback in use, last reload failure). */
  getConfigStatus(): ConfigStatus {
    return this.configRegistry.getConfigStatus();
  }

  importCodebook(rawEntries: unknown, expectedVersion?: string): Promise<ReportCodeEntry[]> {
    return this.configRegistry.importCodebook(rawEntries, expectedVersion);
  }

  // ── Device-onboarding wizard config: read + write vehicles/formations ──
  /** All configured vehicles (`vehicles.json` entries). */
  listVehicleConfigs(): DeviceConfig[] {
    return this.configRegistry.listVehicleConfigs();
  }

  /** Validate + persist `vehicles.json`, reload, and return the configured vehicles. */
  writeVehicles(raw: unknown, expectedVersion?: string): Promise<DeviceConfig[]> {
    return this.configRegistry.writeVehicles(raw, expectedVersion);
  }

  /** All configured formations (`formations.json` entries). */
  listFormationConfigs(): FormationConfig[] {
    return this.configRegistry.listFormations();
  }

  /** Validate (incl. device references) + persist `formations.json`, reload, return them. */
  writeFormations(raw: unknown, expectedVersion?: string): Promise<FormationConfig[]> {
    return this.configRegistry.writeFormations(raw, expectedVersion);
  }

  // ── Outbound-notification config (1.6.1): read + write notify.json ──
  /** The full outbound-notification config (`notify.json`), for the write editor's load side. */
  getNotifyConfig(): NotifyConfig {
    return this.configRegistry.getNotifyConfig();
  }

  /** Validate + persist `notify.json`, reload, and return the new config. */
  writeNotifyConfig(raw: unknown, expectedVersion?: string): Promise<NotifyConfig> {
    return this.configRegistry.writeNotifyConfig(raw, expectedVersion);
  }

  // ── Alert-rule config (1.6.1): read + write rules.json ──
  /** The effective alert rules (built-ins ⊕ `rules.json`), for the 告警规则 editor's load side. */
  getAlertRules(): AlertRulesConfig {
    return this.configRegistry.getAlertRules();
  }

  /** Validate + persist `rules.json`, reload, and return the new config. */
  writeAlertRules(raw: unknown, expectedVersion?: string): Promise<AlertRulesConfig> {
    return this.configRegistry.writeAlertRules(raw, expectedVersion);
  }

  // ── Scheduled-report config (1.6.1): read + write reports.json ──
  /** The scheduled-report config (`reports.json`), for the 定时报表 editor's load side. */
  getReportsConfig(): ReportsConfig {
    return this.configRegistry.getReportsConfig();
  }

  /** Validate + persist `reports.json`, reload, and return the new config. */
  writeReportsConfig(raw: unknown, expectedVersion?: string): Promise<ReportsConfig> {
    return this.configRegistry.writeReportsConfig(raw, expectedVersion);
  }

  async getHistory(
    deviceId: string,
    from?: string,
    to?: string,
    limit?: number,
  ): Promise<unknown[]> {
    return this.persistence.queryHistory({ deviceId, from, to, limit });
  }

  /** The whole window thinned to the history cap, spread evenly over time (see Persistence). */
  sampleHistory(
    deviceId: string,
    from: string,
    to: string,
  ): Promise<{ items: unknown[]; total: number; sampled: boolean }> {
    return this.persistence.sampleHistory({ deviceId, from, to });
  }

  async getAlerts(filters: {
    severity?: string;
    deviceId?: string;
    status?: string;
    from?: string;
    to?: string;
  }): Promise<unknown[]> {
    return this.persistence.queryAlerts(filters);
  }

  /** Server-side alert statistics over the retention window; honest-empty without Mongo. */
  async getAlertStats(range: { from?: string; to?: string }) {
    return this.persistence.aggregateAlertStats(range);
  }

  /** Server-side availability + battery time-series; honest-empty without Mongo. */
  async getAvailabilityReport(params: {
    deviceId?: string[];
    from?: string;
    to?: string;
    bucket: ReportBucketUnit;
  }) {
    // A frame stands for at most the offline threshold in effect (rules.json, else the env default):
    // the same silence that marks a vehicle offline live counts as offline time in the report.
    const afterSeconds =
      this.configRegistry.getAlertRules().offline.afterSeconds ?? config.offlineAfterSeconds;
    return this.persistence.aggregateAvailability({ ...params, maxGapSeconds: afterSeconds });
  }

  /**
   * Summarise closed telemetry hours for the reports, under the offline threshold in effect —
   * the same threshold `getAvailabilityReport` asks for, or the summarised hours would not be
   * the ones it trusts. Outside the ingest queue: it only reads telemetry and writes the summary.
   */
  rollupTelemetry(): Promise<number> {
    const afterSeconds =
      this.configRegistry.getAlertRules().offline.afterSeconds ?? config.offlineAfterSeconds;
    return this.persistence.rollupTelemetry(afterSeconds);
  }

  private async evaluateOfflineDevicesInternal(): Promise<void> {
    // The offline rule is configurable: a deployment can retune the silence
    // window, scope detection to some devices, or turn it off. `afterSeconds` falls back to
    // the `OFFLINE_AFTER_SECONDS` env default when `rules.json` does not set it. Eviction
    // (below) is a memory concern, not a rule, so it runs regardless.
    const offlineRule = this.configRegistry.getAlertRules().offline;
    const thresholdMs = (offlineRule.afterSeconds ?? config.offlineAfterSeconds) * 1000;
    const now = this.now();
    // A sweep that comes more than a whole offline window after the previous one means this
    // process did not run in between — the host slept, the VM was paused, the clock jumped. Every
    // vehicle's last frame then looks stale at once, and none of that is evidence about a vehicle:
    // treat it like a source outage that has just ended, and give them a window to report.
    if (
      this.lastSweepAt !== null &&
      now - this.lastSweepAt > thresholdMs &&
      this.sourceUpSince !== null
    ) {
      this.sourceUpSince = Math.max(this.sourceUpSince, now);
    }
    this.lastSweepAt = now;
    // A source outage (or the first window after it recovers) silences the whole fleet at once;
    // that is not evidence about any vehicle, so no offline verdicts until the source has been up
    // for a full window. Eviction below still runs — it is memory housekeeping, not a judgement.
    const sourceSettled = this.sourceUpSince !== null && now - this.sourceUpSince >= thresholdMs;

    for (const device of sourceSettled ? [...this.rawDevices.values()] : []) {
      // Silence is measured on arrival times, like eviction. The vehicle's own `stamp` is trusted
      // within the clock tolerance, so a clock running 55 s slow was judged silent 55 s early, and
      // with a short window flipped offline and back on every sweep.
      const lastHeard = this.lastIngestAt.get(device.deviceId) ?? Date.parse(device.stamp);
      const isStale = now - lastHeard > thresholdMs;
      if (!isStale || !device.online) {
        continue;
      }
      // Silent past the window is offline whatever the rule says: the rule's switch and scope
      // decide whether an offline *alert* is raised, not whether the vehicle is shown online. They
      // used to skip both, so a vehicle out of scope stayed "online" at a six-hour-old position
      // while the availability report counted the same hours offline.
      const raisesAlert =
        offlineRule.enabled &&
        // Scope by the configured snapshot: the raw one has no tags or formations of its own.
        deviceMatchesScope(this.applySnapshotConfig(device), offlineRule.scope);

      // Replace rather than append: a device that is already marked offline keeps its
      // alert from the previous sweep, and the id is the same either way.
      const nextAlerts: DeviceAlert[] = carryAlertOnsets(device.alerts, [
        ...device.alerts.filter((alert) => alert.id !== offlineAlertId(device.deviceId)),
        ...(raisesAlert ? [buildOfflineAlert(device.deviceId, this.nowIso())] : []),
      ]);

      const updatedRaw = {
        ...device,
        online: false,
        alerts: nextAlerts,
      };
      const previousConfigured = this.devices.get(device.deviceId) || null;
      const updatedConfigured = this.applySnapshotConfig(updatedRaw);

      this.rawDevices.set(device.deviceId, updatedRaw);
      this.devices.set(device.deviceId, updatedConfigured);
      this.emitChangeEvents(previousConfigured, updatedConfigured, "offline-monitor");
      await this.persistState(updatedRaw);
      this.updatedAt = this.nowIso();
    }

    // Same sweep, one step further along the same timeline: first mark the stale
    // ones offline, then forget the ones that have been silent long enough to have
    // no business occupying memory.
    if (await this.evictSilentDevices()) {
      this.updatedAt = this.nowIso();
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
    // Per tier, for the metric: 告警 is the critical tier only, and a total over all three read as
    // 「活跃告警 2」 in Grafana while the console showed no 告警 at all (two 提示).
    const alertsBySeverity: Record<Severity, number> = { critical: 0, warning: 0, notice: 0 };
    for (const device of devices) {
      for (const alert of device.alerts) alertsBySeverity[alert.severity] += 1;
    }
    const gpsCount = devices.filter((device) => hasGps(device.gps) && device.gpsEnabled).length;
    return {
      fleetName: this.fleetName,
      deviceCount: devices.length,
      onlineCount,
      alertCount,
      alertsBySeverity,
      gpsCount,
      updatedAt: this.updatedAt,
    };
  }
}
