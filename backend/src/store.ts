import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { config } from "./config";
import { ConfigRegistry } from "./configRegistry";
import { buildFleetSnapshot, hasGps, mergeDevice, normalizeDevice, normalizePayload } from "./normalize";
import { Persistence } from "./persistence";
import {
  DeviceAlert,
  DeviceSnapshot,
  FleetSnapshot,
  FormationSnapshot,
  LaneletOverlay,
  SceneMapDefinition,
  SocketEvent,
} from "./types";

const logger = pino({ name: "dashboard-store" });

export class DashboardStore extends EventEmitter {
  private rawDevices = new Map<string, DeviceSnapshot>();
  private devices = new Map<string, DeviceSnapshot>();
  private fleetName = config.fleetName;
  private topicPattern = config.topicPattern;
  private updatedAt = new Date().toISOString();

  constructor(
    private readonly persistence: Persistence,
    private readonly configRegistry: ConfigRegistry
  ) {
    super();
  }

  async initialize(): Promise<void> {
    await this.configRegistry.load();
    this.refreshFleetMetadata();

    await this.persistence.connect();

    const restored = await this.persistence.restoreLatestDevices();
    if (restored.length) {
      restored
        .map((device) => normalizeDevice(device as unknown as Record<string, unknown>, null))
        .forEach((device) => {
          this.rawDevices.set(device.deviceId, device);
        });
      this.rebuildConfiguredDevices();
      this.updatedAt = new Date().toISOString();
      return;
    }

    const seeded = await this.loadSeedPayload();
    if (seeded) {
      await this.applyPayload(seeded, "seed");
    }
  }

  async reloadConfig(): Promise<void> {
    this.rebuildConfiguredDevices();
    logger.info(
      {
        fleetName: this.fleetName,
        deviceCount: this.devices.size,
        sceneCount: this.configRegistry.listScenes().length,
      },
      "Applied reloaded runtime config to in-memory fleet state"
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

  async applyPayload(payload: unknown, source = "mqtt"): Promise<FleetSnapshot> {
    const normalized = normalizePayload(payload, this.rawDevices, this.fleetName, this.topicPattern);
    const nextRawMap = normalized.replace ? new Map<string, DeviceSnapshot>() : new Map(this.rawDevices);
    const nextDeviceMap = normalized.replace ? new Map<string, DeviceSnapshot>() : new Map(this.devices);

    for (const device of normalized.devices) {
      const existingRaw = this.rawDevices.get(device.deviceId);
      const existingConfigured = this.devices.get(device.deviceId);
      const mergedRaw = mergeDevice(existingRaw, device);
      const mergedConfigured = this.applySnapshotConfig(mergedRaw);

      nextRawMap.set(mergedRaw.deviceId, mergedRaw);
      nextDeviceMap.set(mergedConfigured.deviceId, mergedConfigured);
      await this.persistRawDevice(mergedRaw);
      await this.emitChangeEvents(existingConfigured || null, mergedConfigured, source);
    }

    this.rawDevices = nextRawMap;
    this.devices = nextDeviceMap;
    this.updatedAt = new Date().toISOString();
    return this.snapshot();
  }

  async applyStatus(deviceId: string, statusPayload: unknown): Promise<void> {
    const existingRaw = this.rawDevices.get(deviceId);
    const existingConfigured = this.devices.get(deviceId);
    const normalizedRaw = normalizeDevice(
      {
        deviceId,
        online: this.parseOnline(statusPayload),
        stamp: new Date().toISOString(),
      },
      existingRaw || null
    );
    const configuredDevice = this.applySnapshotConfig(normalizedRaw);

    this.rawDevices.set(deviceId, normalizedRaw);
    this.devices.set(deviceId, configuredDevice);
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

  private async emitChangeEvents(previous: DeviceSnapshot | null, current: DeviceSnapshot, source: string): Promise<void> {
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
      this.updatedAt
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

  async getHistory(deviceId: string, from?: string, to?: string, limit?: number): Promise<unknown[]> {
    return this.persistence.queryHistory({ deviceId, from, to, limit });
  }

  async getAlerts(filters: { severity?: string; deviceId?: string; status?: string }): Promise<unknown[]> {
    return this.persistence.queryAlerts(filters);
  }

  async evaluateOfflineDevices(): Promise<void> {
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
