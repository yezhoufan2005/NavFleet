/* global module */
/**
 * Demo history generator — one deterministic per-vehicle simulation that both seeders share:
 * `scripts/verify-stack.sh` pipes this file into `mongosh` inside the compose stack, and
 * `backend/scripts/seed-reports.ts` (dev.sh --demo) requires it from Node and writes with the
 * driver. So the two produce the same history instead of two hand-tuned curves drifting apart.
 *
 * Plain JavaScript on purpose: mongosh evaluates it as a script (no imports there), Node loads it
 * through the `module.exports` guard at the bottom.
 *
 * What it models, minute by minute, per vehicle profile (`category` / `maxLoadKg` from
 * vehicles.json):
 *   - **Battery**: work drains at a rate set by the profile and the load of the current job
 *     (heavier tugs drain faster), idle drains slowly, charging fills to 95–100%. A vehicle goes to
 *     charge at a per-cycle threshold (18–32%; 电量偏低 is raised below 25%), so cycles differ in length and no two vehicles are in
 *     the same phase at "now". Shift-bound vehicles (配料) park and top up overnight.
 *   - **Reporting**: one frame a minute while reporting — denser than the offline threshold, so the
 *     time-weighted availability sees continuous coverage. Planned maintenance (every 10–16 days,
 *     2–4 h, daytime) and short communication dropouts (every ~3 days, 3–25 min) leave real gaps.
 *   - **Messages** as real fleets produce them, one document per occurrence: charging and task
 *     notices most often, warnings (low battery before a charge, speed-limit zones, localisation
 *     confidence, comm quality before a dropout, payload offset, battery temperature while charging)
 *     less, faults rare (obstacle timeout, collision-guard stop, e-stop with a manual reset,
 *     localisation lost → relocalised). Each has a realistic duration; a device never has two open
 *     occurrences of the same code; offline occurrences span the gaps beyond the threshold.
 *   - **Acknowledgement** by whoever is on shift (day 08–20 / night), mostly for faults, sometimes
 *     for warnings, rarely for notices, with a short reaction delay and occasional comments.
 *
 * Deterministic (seeded PRNG per vehicle index): a re-run reproduces the same shape, shifted to now.
 */

var DEMO_MINUTE = 60 * 1000;

/** Code → [channel, text]. Every code resolves against the built-in table or the demo codebook. */
var DEMO_CODES = {
  1102: ["info", "已完成重定位"],
  1301: ["info", "正在充电"],
  1302: ["info", "任务完成·待命"],
  1501: ["info", "任务已完成"],
  1601: ["info", "远程接管中"],
  1901: ["info", "到达人工交接位"],
  2101: ["warning", "定位置信度偏低"],
  2203: ["warning", "厂区限速区降速"],
  2302: ["warning", "电池温度偏高"],
  2501: ["warning", "电量偏低"],
  2601: ["warning", "通信质量下降"],
  2801: ["warning", "载荷偏心"],
  2902: ["warning", "载荷偏移预警"],
  5101: ["error", "定位丢失"],
  5202: ["error", "避障超时未恢复"],
  5701: ["error", "急停触发"],
  5702: ["error", "防撞保护停车"],
};

/**
 * Per-category profile. Rates are %/hour; event rates are expected occurrences per working hour.
 * `shift` = working hours [start, end) for shift-bound vehicles, else round the clock.
 */
var DEMO_PROFILES = {
  巡检: {
    work: 4.2,
    idle: 0.5,
    charge: 30,
    speed: 1.2,
    shift: null,
    taskCode: 1501,
    taskRate: 0.2,
    events: { 2101: 0.05, 2203: 0.02, 5101: 0.004, 5702: 0.004 },
  },
  搬运: {
    work: 6.5,
    idle: 0.6,
    charge: 34,
    speed: 1.0,
    shift: null,
    taskCode: 1302,
    taskRate: 0.3,
    events: {
      2203: 0.12,
      2902: 0.02,
      2101: 0.012,
      5202: 0.008,
      5702: 0.005,
      5701: 0.0025,
    },
  },
  牵引: {
    work: 8.0,
    idle: 0.7,
    charge: 28,
    speed: 1.6,
    shift: null,
    taskCode: 1501,
    taskRate: 0.2,
    events: {
      2203: 0.1,
      2801: 0.02,
      2101: 0.02,
      5202: 0.01,
      5702: 0.006,
      5701: 0.003,
    },
  },
  配料: {
    work: 5.0,
    idle: 0.4,
    charge: 36,
    speed: 0.8,
    shift: [6, 22],
    taskCode: 1901,
    taskRate: 0.45,
    events: { 2203: 0.05, 2902: 0.015, 5202: 0.006, 5701: 0.002 },
  },
};

/** Durations (minutes) as [min, max] per code; faults that need a person on site run longest. */
var DEMO_DURATIONS = {
  1102: [1, 2],
  1302: [3, 12],
  1501: [1, 4],
  1601: [3, 10],
  1901: [2, 6],
  2101: [3, 12],
  2203: [1, 4],
  2302: [6, 20],
  2601: [2, 6],
  2801: [2, 8],
  2902: [2, 8],
  5101: [5, 20],
  5202: [3, 15],
  5701: [8, 40],
  5702: [1, 5],
};

var DEMO_COMMENTS = {
  5101: ["已人工重定位", "现场确认后恢复"],
  5202: ["障碍已清除", "通道已清理"],
  5701: ["现场已复位", "已通知维修，复位后恢复"],
  5702: ["已排查，误触发", "现场已确认"],
  offline: ["网络已恢复", "已通知网络运维"],
};

/** mulberry32 — tiny seeded PRNG, so every run reproduces the same history. */
function demoRng(seed) {
  var a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    var t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Local hour of an instant in the deployment timezone (Asia/Shanghai, UTC+8, no DST). */
function demoLocalHour(ms) {
  return new Date(ms + 8 * 3600 * 1000).getUTCHours();
}

/**
 * The full history of one vehicle over [now − days, now − tailMinutes]: `telemetry` documents for
 * `telemetry_ts` and `alerts` documents (all closed occurrences), shaped exactly as the backend
 * writes them.
 */
function demoDeviceHistory(vehicle, index, options) {
  var now = options.now;
  var days = options.days;
  var offlineAfterMs = (options.offlineAfterSeconds || 90) * 1000;
  var tailMs = (options.tailMinutes || 5) * DEMO_MINUTE;
  var rand = demoRng(9173 + index * 7919);
  var between = function (lo, hi) {
    return lo + (hi - lo) * rand();
  };
  var profile = DEMO_PROFILES[vehicle.category] || DEMO_PROFILES["搬运"];
  var loadKg = Number(vehicle.maxLoadKg) || 0;
  var id = vehicle.deviceId;
  var model = vehicle.model || "generic-agv";

  var start = now - days * 24 * 60 * DEMO_MINUTE;
  var end = now - tailMs;
  var telemetry = [];
  var alerts = [];
  /** alertId → end ms of the open occurrence, so a code never overlaps itself. */
  var openUntil = {};

  var operatorAt = function (ms) {
    var h = demoLocalHour(ms);
    return h >= 8 && h < 20 ? "zhaoyun" : "qianwei";
  };

  /** Close one occurrence into an alerts document, acknowledged per severity. */
  var record = function (alertId, fields, onsetMs, clearMs) {
    if (onsetMs < start || clearMs > end || clearMs <= onsetMs) return;
    if ((openUntil[alertId] || 0) > onsetMs) return;
    openUntil[alertId] = clearMs;
    var severity = fields.severity;
    var ackChance =
      fields.ackChance != null
        ? fields.ackChance
        : severity === "critical"
          ? 0.92
          : severity === "warning"
            ? 0.45
            : 0.05;
    var ackedBy = null,
      ackedAt = null,
      comment = null;
    var ackAt = onsetMs + between(0.5, 8) * DEMO_MINUTE;
    if (rand() < ackChance && ackAt < clearMs) {
      ackedBy = fields.ackedBy || operatorAt(ackAt);
      ackedAt = new Date(ackAt).toISOString();
      var pool = fields.comments;
      if (pool && pool.length && (fields.forceComment || rand() < 0.4)) {
        comment = pool[Math.floor(rand() * pool.length)];
      }
    }
    alerts.push({
      eventKey: id + ":" + alertId,
      deviceId: id,
      alertId: alertId,
      severity: severity,
      title: fields.title,
      detail: fields.detail,
      source: fields.source,
      ts: new Date(onsetMs).toISOString(),
      active: false,
      code: fields.code,
      info: fields.info,
      firstSeenAt: new Date(onsetMs),
      lastSeenAt: new Date(clearMs),
      clearedAt: new Date(clearMs),
      ackedBy: ackedBy,
      ackedAt: ackedAt,
      comment: comment,
    });
  };

  var codeAlert = function (code, onsetMs, durationMin) {
    var spec = DEMO_CODES[code];
    var channel = spec[0];
    var severity =
      channel === "info"
        ? "notice"
        : channel === "warning"
          ? "warning"
          : "critical";
    var title =
      channel === "info"
        ? "提示报码"
        : channel === "warning"
          ? "预警报码"
          : "告警报码";
    record(
      id + "-" + channel + "-code-" + code,
      {
        severity: severity,
        title: title,
        detail: spec[1],
        info: spec[1],
        code: code,
        source: channel + "_code",
        comments: DEMO_COMMENTS[code],
      },
      onsetMs,
      onsetMs + durationMin * DEMO_MINUTE,
    );
  };

  var randomDuration = function (code) {
    var range = DEMO_DURATIONS[code] || [2, 6];
    return between(range[0], range[1]);
  };

  // Planned maintenance windows and comm dropouts: the reporting gaps.
  var gaps = [];
  var maintAt = start + between(2, 9) * 24 * 60 * DEMO_MINUTE;
  while (maintAt < end) {
    var day = Math.floor((maintAt + 8 * 3600 * 1000) / (24 * 3600 * 1000));
    var gapStart =
      day * 24 * 3600 * 1000 - 8 * 3600 * 1000 + between(9, 14) * 3600 * 1000;
    gaps.push({
      from: gapStart,
      to: gapStart + between(2, 4) * 3600 * 1000,
      planned: true,
    });
    maintAt += between(10, 16) * 24 * 60 * DEMO_MINUTE;
  }
  var dropAt = start + between(0.5, 3) * 24 * 60 * DEMO_MINUTE;
  while (dropAt < end) {
    gaps.push({
      from: dropAt,
      to: dropAt + between(3, 25) * DEMO_MINUTE,
      planned: false,
    });
    dropAt += between(1.5, 4.5) * 24 * 60 * DEMO_MINUTE;
  }
  gaps.sort(function (a, b) {
    return a.from - b.from;
  });
  gaps.forEach(function (gap) {
    if (!gap.planned)
      codeAlert(2601, gap.from - between(2, 6) * DEMO_MINUTE, between(2, 5));
    // The backend raises 设备离线 once a vehicle has been silent past the threshold.
    if (gap.to - gap.from > offlineAfterMs) {
      record(
        id + "-offline",
        {
          severity: "critical",
          title: "设备离线",
          detail: "设备超过离线阈值未上报，系统已自动标记为离线",
          info: "",
          code: null,
          source: "rule-engine",
          ackChance: gap.planned ? 1 : 0.8,
          ackedBy: gap.planned ? "admin" : null,
          comments: gap.planned ? ["计划内维护"] : DEMO_COMMENTS.offline,
          forceComment: gap.planned,
        },
        gap.from + offlineAfterMs,
        gap.to,
      );
    }
  });

  // Battery / duty simulation, one step a minute.
  var soc = between(45, 90);
  var mode = "work";
  var chargeAt = between(18, 32);
  var chargeTo = between(95, 100);
  var chargeStart = 0;
  var lowWarnStart = 0;
  var load = between(0.3, 1);
  var faultUntil = 0;
  var gapIndex = 0;
  var workRate = profile.work * (1 + (loadKg / 3000) * 0.3);

  for (var t = start; t <= end; t += DEMO_MINUTE) {
    while (gapIndex < gaps.length && gaps[gapIndex].to <= t) gapIndex += 1;
    var gap = gaps[gapIndex];
    var silent = gap && gap.from <= t && t < gap.to;
    var hour = demoLocalHour(t);
    var onShift =
      !profile.shift || (hour >= profile.shift[0] && hour < profile.shift[1]);
    var faulted = t < faultUntil;

    if (mode === "charge") {
      soc += (profile.charge * between(0.85, 1.1)) / 60;
      if (soc >= chargeTo) {
        soc = chargeTo;
        codeAlert(1301, chargeStart, (t - chargeStart) / DEMO_MINUTE);
        if (profile.events[2302] || vehicle.category === "牵引") {
          if (rand() < 0.08)
            codeAlert(
              2302,
              chargeStart + between(10, 40) * DEMO_MINUTE,
              randomDuration(2302),
            );
        }
        mode = onShift ? "work" : "idle";
        chargeAt = between(18, 32);
        load = between(0.3, 1);
      }
    } else if (!onShift && !faulted) {
      mode = "idle";
      soc -= profile.idle / 60;
      // Shift-bound vehicles top up overnight rather than run dry next morning.
      if (soc < 70) {
        mode = "charge";
        chargeStart = t;
        chargeTo = between(95, 100);
      }
    } else if (faulted || silent) {
      soc -= profile.idle / 60;
    } else {
      mode = "work";
      soc -= (workRate * (0.75 + 0.5 * load) * between(0.85, 1.15)) / 60;
      // Short pauses between jobs: a task closes, the vehicle waits, the next load differs.
      if (rand() < profile.taskRate / 60) {
        codeAlert(profile.taskCode, t, randomDuration(profile.taskCode));
        load = between(0.3, 1);
      }
      for (var key in profile.events) {
        if (rand() < profile.events[key] / 60) {
          var code = Number(key);
          var duration = randomDuration(code);
          codeAlert(code, t, duration);
          if (DEMO_CODES[code][0] === "error") {
            faultUntil = t + duration * DEMO_MINUTE;
            // Some faults are cleared by an operator taking the vehicle over remotely.
            if (rand() < 0.4)
              codeAlert(1601, t + duration * DEMO_MINUTE, randomDuration(1601));
            if (code === 5101)
              codeAlert(1102, t + duration * DEMO_MINUTE, randomDuration(1102));
          } else if (code === 2101 && rand() < 0.15) {
            var lostAt = t + duration * DEMO_MINUTE;
            var lost = randomDuration(5101);
            codeAlert(5101, lostAt, lost);
            codeAlert(1102, lostAt + lost * DEMO_MINUTE, randomDuration(1102));
            faultUntil = lostAt + lost * DEMO_MINUTE;
          }
        }
      }
      if (soc < 25 && !lowWarnStart) lowWarnStart = t;
      if (soc <= chargeAt) {
        if (lowWarnStart && t - lowWarnStart > 2 * DEMO_MINUTE) {
          codeAlert(2501, lowWarnStart, (t - lowWarnStart) / DEMO_MINUTE);
        }
        lowWarnStart = 0;
        mode = "charge";
        chargeStart = t;
        chargeTo = between(95, 100);
      }
    }
    soc = Math.max(5, Math.min(100, soc));

    if (silent) continue;
    var moving = mode === "work" && !faulted && onShift;
    telemetry.push({
      ts: new Date(t),
      meta: { deviceId: id, fleetId: "default-fleet", vehicleModel: model },
      measurements: {
        online: true,
        stamp: new Date(t).toISOString(),
        vehicleInfo: {
          soc: Math.round(soc * 10) / 10,
          speed: moving
            ? Math.round(profile.speed * between(0.6, 1.05) * 100) / 100
            : 0,
        },
      },
    });
  }

  return { telemetry: telemetry, alerts: alerts };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    demoDeviceHistory: demoDeviceHistory,
    DEMO_PROFILES: DEMO_PROFILES,
  };
}
