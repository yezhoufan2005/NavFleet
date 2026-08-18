# 本机调试说明

## 1. 环境前提

- 本机 MongoDB 已启动
- 本机 MQTT Broker 可访问 `127.0.0.1:1883`
- 前端开发服务运行在 `127.0.0.1:5173`
- 后端开发服务运行在 `127.0.0.1:3000`

> 当前仓库的 `vite.config.js` 已经把 `/api`、`/ws`、`/health` 代理到 `127.0.0.1:3000`。

## 2. 推荐启动顺序

### 启动后端

在 `backend` 目录执行：

```powershell
npm run dev
```

默认本机调试参数：

- `MQTT_URL=mqtt://127.0.0.1:1883`
- `MONGO_URI=mongodb://127.0.0.1:27017/fleet_monitor`
- `CONFIG_ROOT_PATH=../config-runtime`

如需覆盖，参考 `backend/.env.example`。

### 启动前端

在 `frontend` 目录执行：

```powershell
npm run dev
```

### 启动 MQTT 模拟发布

在 `backend` 目录执行：

```powershell
npm run mock:mqtt
```

也可以自定义参数：

```powershell
npx tsx scripts/mock-mqtt.ts --broker mqtt://127.0.0.1:1883 --count 4 --interval 1000 --device-prefix agv
```

## 3. 模拟数据内容

脚本会循环发布这些字段：

- `stamp`
- `fusion_loc`
- `lidar_loc`
- `vehicle_info`
- `task_status`
- `platform_task_status`
- `info_code`
- `warning_code`
- `error_code`
- `speed_limit`

默认内置 4 类设备场景：

- 正常车
- 低电量车
- 预警车
- 故障后离线车

发布主题：

- `/fleet/{deviceId}/vehicle_info`
- `/fleet/{deviceId}/status`

## 4. 页面和字段对应关系

前端页面当前和后端输出的对应关系已经统一：

- 左侧设备列表
  - `deviceName`
  - `online`
  - `stamp`
  - `vehicleInfo.soc`

- 右侧车辆信息
  - `vehicleInfo.controlMode`
  - `vehicleInfo.gear`
  - `vehicleInfo.speed`
  - `vehicleInfo.omega`
  - `vehicleInfo.soc`

- 右侧任务信息
  - `taskStatus`
  - `platformTaskStatus`
  - `stamp`

- 右侧 ROS 位姿
  - `fusionLoc`
  - `lidarLoc`

- 右侧限速信息
  - `speedLimit.limit`
  - `speedLimit.slowdownTime`
  - `speedLimit.stamp`
  - `speedLimit.moduleName`

- 右侧设备报码
  - `infoCode`
  - `warningCode`
  - `errorCode`

- 告警中心
  - 由 `infoCode / warningCode / errorCode`
  - 以及服务端规则 `low-soc / offline`
    自动生成

## 5. 本机快速排查

### 看后端是否起来

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/health
```

### 看快照接口

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/api/fleet/snapshot
```

### 通过前端代理看接口

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:5173/api/fleet/snapshot
```

### 看本机 1883 是否可用

```powershell
Test-NetConnection -ComputerName 127.0.0.1 -Port 1883
```

如果 `1883` 不通，后端会正常启动并连上 Mongo，但 MQTT 会持续报 `ECONNREFUSED`，这时需要先启动本机 Broker。
