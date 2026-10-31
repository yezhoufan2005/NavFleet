/**
 * Field help — the "?" explanations, in one place.
 *
 * Kept as data, keyed by page then field, rather than inline in each template: the wording is
 * domain knowledge (units, conventions, what a value does at runtime) that must stay accurate as
 * the code changes, and one file is where a reviewer checks it. Every sentence was written against
 * the code that consumes the value, not from the label alone.
 */
export const FIELD_HELP = {
  scene: {
    resolution:
      "底图每个像素代表的实际长度（米）；与宽、高一起决定地图的实际尺寸：实际宽度 = 宽 px × 分辨率",
    mapFrame:
      "车辆位姿所在的 ROS 坐标系名（frame_id），通常是 map；目前只做记录，不参与渲染",
    width: "底图的像素宽度；地图实际宽度 = 宽 px × 分辨率（米）",
    height: "底图的像素高度；地图实际高度 = 高 px × 分辨率（米）",
    originX:
      "底图左下角在地图坐标系中的 x 坐标（米），沿用 ROS map_server 约定",
    originY:
      "底图左下角在地图坐标系中的 y 坐标（米），沿用 ROS map_server 约定",
    originYaw:
      "底图绕左下角的旋转角（弧度，逆时针为正），沿用 ROS map_server 约定；0 表示不旋转；未填写边界时，地图范围取旋转后的外接框",
    assetKind:
      "栅格：SVG / PNG / JPG 背景图；点云：.pcd 文件，浏览器内栅格化显示；OSM：Lanelet2 路网文件，用来绘制车道；点云元数据：描述点云网格与高度分层的 JSON",
    worldRange:
      "场景在地图坐标系中的覆盖范围（米）；写了 bounds 就直接用；否则由原点、宽高、分辨率与旋转角推算",
  },
  vehicle: {
    deviceId:
      "必须与车辆上报中的 deviceId 完全一致；这里只配置显示名、场景等覆盖项，车辆开始上报后才会出现在监控里",
    defaultScene:
      "车辆没有上报所在场景时使用的场景；车辆上报了运行场景则以上报为准",
    tags: "自由标签，用逗号分隔；消息规则的作用范围可以按标签匹配",
    maxLoadKg: "车辆的额定载重（kg），用于台账展示与演示数据中的负载画像",
    gps: "关闭后该车不在 GPS 地图上显示，经纬度显示为「缺失」，也不计入 GPS 覆盖数",
    rosMap: "关闭后该车不在场景地图（ROS 地图）上显示",
  },
  formation: {
    defaultScene: "编队整体的默认场景，可不填",
    color: "编队在地图和列表中的标识色，填十六进制颜色，如 #46d7c3",
  },
  rules: {
    thresholdPct:
      "电量（SOC）低于这个百分比时触发「低电量预警」；内置默认 20%；电量为 0 或缺失视为没有读数，不触发",
    debounceSeconds:
      "电量回到阈值以上后，预警再保留这么多秒才清除，避免电量在阈值附近反复触发和解除；0 表示立即清除",
    afterSeconds:
      "设备连续这么多秒没有上报即判为离线并触发「设备离线」告警；留空使用后端默认（OFFLINE_AFTER_SECONDS）；数据源（MQTT）断开期间不做离线判定",
    scope:
      "设备、编队、标签三者取并集，命中任意一项即纳入；三项都不选表示全车队",
  },
  notify: {
    urlEnv:
      "存放 Webhook 地址或 SMTP 连接串的环境变量名，密钥本身不写入配置文件；后端读不到该变量时，这个渠道不会发送",
    severities:
      "这个渠道只外发勾选的等级：告警 = critical，预警 = warning，提示 = notice",
    recipients:
      "邮件收件人：填邮箱地址，或引用平台用户（@用户名，取其账户邮箱）",
    groups: "引用外发配置中的命名收件人组，发送时按组展开成邮箱",
    silence:
      "按部署时区（REPORT_TIMEZONE，默认 Asia/Shanghai）的 HH:MM 设置，不是浏览器时区；结束时刻不晚于开始时刻表示跨零点（如 22:00→06:00）；窗口内这个渠道不发送",
  },
  reportSchedule: {
    range: "报表统计发送时刻之前多长时间的数据：24 小时、7 天或 30 天",
    time: "24 小时制 HH:MM，按部署时区（REPORT_TIMEZONE，默认 Asia/Shanghai），不是浏览器时区",
    weekday: "选「每天」则每天发送；选某个星期几则每周那一天发送一次",
    smtpEnv: "存放 SMTP 连接串的环境变量名，连接串（含凭据）不写入配置文件",
    recipients: "收件人和收件人组都为空时，这份报表到点会跳过发送（只记日志）",
  },
  codebook: {
    code: "四位报码：首位是通道（1 提示 / 2 预警 / 5 告警），第二位是子系统，后两位是具体状况",
    channel:
      "车端从哪个字段上报这个码：提示走 infoCode、预警走 warningCode、告警走 errorCode",
    impact:
      "按 VDA 5050 描述「车辆还能做什么」：无影响 → 留意 → 尽快处理 → 任务受阻 → 需人工介入",
    subsystem: "故障所属的功能域，例如导航与定位、电源与电池、安全",
    description: "这个码代表的原因或状况（对应 VDA 5050 的 errorDescription）",
    hint: "现场应如何处置（对应 VDA 5050 的 errorHint）",
  },
  role: {
    capabilities:
      "每一项授予一类写操作或敏感读取，在用户的基础角色之上叠加；「调试注入」允许伪造上报，仅限开发调试",
  },
  device: {
    fusionLoc:
      "多传感器融合后的位姿：x、y 为地图坐标（米），yaw 为朝向（弧度，从 +x 轴逆时针为正）",
    lidarLoc: "激光雷达匹配得到的位姿；与融合定位相差较大，通常说明定位漂移",
    omega: "车体绕竖直轴转动的角速度（rad/s）",
    soc: "电池荷电状态（SOC），即剩余电量百分比",
    platformTask:
      "调度平台下发侧记录的任务状态；与车端任务不一致，可能说明下发没有生效",
    speedLimit:
      "当前生效的限速（m/s）、降到限速所用的时间（s）与发出限速的车端模块",
    heading:
      "GPS 上报的航向角（度，正北为 0、顺时针）；与位姿里的 yaw（弧度）不是同一个量",
  },
  report: {
    onlineRatio:
      "统计时段内车辆在线的时长占比（按时间计算）：每帧上报代表到下一帧为止的时间，最长不超过离线判定阈值；没有上报的时段算离线",
    socMean:
      "统计时段内电量读数的平均值（按上报帧数加权），没有读数的时段不计入",
    socMin: "统计时段内的最低电量读数",
    samples: "统计时段内收到的遥测帧数；帧数越少，比例越不可靠",
    alertTotal:
      "发生时刻落在统计时段内的消息条数，每发生一次计一条，提示、预警、告警都算",
    ackRate: "已被确认的消息条数 ÷ 消息总数",
  },
} as const;
