import type { UserRole } from "./index";

/**
 * 细粒度能力项（1.6.1 RBAC 基座）。**一个受控动作一项**，是门禁的最小单位。
 *
 * 读操作**不**设能力：任何登录用户都能读（fleet / 历史 / 报表 / 场景 / 告警列表 / 报码字典读），
 * 与 1.6.1 前的 viewer+ 口径一致。这里只枚举**写 / 管理 / 敏感读**这些真正需要授权的动作。
 *
 * 单一来源：后端 `requireCapability` 门禁、内置角色预设、前端 `can()` 都从这里取，改一处即同步。
 * 加一项能力就在这里加一个字面量——`admin` 预设用「全集」引用本数组，会自动纳入，不会漏授管理员。
 */
export const CAPABILITIES = [
  "alerts:ack", // 确认/取消确认告警（operator+ 的唯一区别能力）
  "vehicles:write", // 车辆配置读写（设备接入向导）
  "formations:write", // 编队配置读写
  "scenes:write", // 场景配置写 + 场景资源上传
  "codebook:write", // 报码字典导入（整表覆盖）
  "notify:read", // 外发发送记录 + 生效渠道（管理面敏感读）
  "notify:write", // 外发渠道/路由配置写入（notify.json）
  "rules:write", // 告警规则阈值/开关/作用范围写入（rules.json）
  "reports:write", // 定时报表调度写入（reports.json）
  "audit:read", // 审计日志查询
  "users:manage", // 用户增改删 / 重置 / 踢会话
  "debug:ingest", // 调试注入（默认关闭，仅 dev）
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * 内置三角色的能力预设，与 1.6.1 前的门禁**严格 1:1**：
 * - `viewer`：只读（无能力）。
 * - `operator`：仅「确认告警」。
 * - `admin`：全部（引用 `CAPABILITIES` 全集——日后新增能力自动拥有，避免加了能力却把管理员挡在门外）。
 *
 * 迁移零改动：现有用户的 `role` 字段直接命中同名预设，权限不变。自定义角色 / 用户组（后续 PR）在此
 * 基础上**叠加**能力，`role` 字段仍是这三个内置值之一。
 */
export const ROLE_CAPABILITIES: Record<UserRole, readonly Capability[]> = {
  viewer: [],
  operator: ["alerts:ack"],
  admin: CAPABILITIES,
};

/** 某内置角色的能力集合（`admin` 恒为全集）。未知角色回退为空集，永不抛。 */
export const capabilitiesForRole = (role: UserRole): readonly Capability[] =>
  ROLE_CAPABILITIES[role] ?? [];

/**
 * 自定义角色（1.6.1 RBAC）：一个具名的能力子集，由 admin 定义、被用户组引用。**不**作为用户的
 * `role` 字段值——用户的基础角色仍是内置三值之一，自定义角色只透过所属用户组叠加能力，这样
 * `UserRole` 闭合枚举（前后端两处运行时校验）无需改动。
 */
export interface RbacRole {
  id: string;
  name: string;
  capabilities: Capability[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 用户组（1.6.1 RBAC）：把一批用户绑到若干自定义角色。成员的有效能力 = 自身基础角色预设 ∪
 * 所在各组引用的各自定义角色的能力（见 `resolveEffectiveCapabilities`）。
 */
export interface RbacGroup {
  id: string;
  name: string;
  description: string;
  roleIds: string[];
  memberUsernames: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * 纯解析器：一个用户的**有效能力** = 基础角色预设 ∪（非 kiosk 时）其所属用户组引用的自定义角色的能力。
 *
 * - **kiosk 账号只读不受组提权**：长期只读墙屏凭证按构造只读，忽略一切组能力叠加——否则把它加进某组
 *   就能破掉「只读」约束。
 * - 输出按 `CAPABILITIES` 顺序去重排序，令响应与断言确定。
 *
 * 后端每请求调用（缓存喂入 roles/groups），前端也可用它预览。
 */
export const resolveEffectiveCapabilities = (
  user: { username: string; role: UserRole; kiosk?: boolean },
  roles: readonly RbacRole[],
  groups: readonly RbacGroup[],
): Capability[] => {
  const caps = new Set<Capability>(capabilitiesForRole(user.role));
  if (!user.kiosk) {
    const roleById = new Map(roles.map((role) => [role.id, role]));
    for (const group of groups) {
      if (!group.memberUsernames.includes(user.username)) continue;
      for (const roleId of group.roleIds) {
        for (const capability of roleById.get(roleId)?.capabilities ?? []) {
          caps.add(capability);
        }
      }
    }
  }
  return CAPABILITIES.filter((capability) => caps.has(capability));
};
