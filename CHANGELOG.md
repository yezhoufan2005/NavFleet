# Changelog

## [1.7.0](https://github.com/yezhoufan2005/NavFleet/compare/v1.6.0...v1.7.0) (2026-09-30)


### Features

* **codebook:** 报码字典行级增删改（复用整表写端点） ([4147de0](https://github.com/yezhoufan2005/NavFleet/commit/4147de044e3af64c049a91b0fa1cd3c57a124dc3))
* **codebook:** 报码字典行级增删改（复用整表写端点） ([74b588e](https://github.com/yezhoufan2005/NavFleet/commit/74b588edd16a97613cb715d3397ed2c564b0665d))
* **console:** 场景/系统状态并入焦点自动刷新 ([356742f](https://github.com/yezhoufan2005/NavFleet/commit/356742fea0b1ba781819c359a74995cb2a320d0c))
* **console:** 场景/系统状态并入焦点自动刷新 ([48a4553](https://github.com/yezhoufan2005/NavFleet/commit/48a455381b8ef39f50d94090b43f269a8d1d6d95))
* **console:** 用户 独立为一级导航 + 二级标签条（账号/角色/用户组） ([9b3b2b4](https://github.com/yezhoufan2005/NavFleet/commit/9b3b2b429220b75f7a1b8131027e44e7361b9192))
* **console:** 用户 独立为一级导航，账号/角色与用户组并入二级标签（1.6.2 IA 第一步） ([e6533ce](https://github.com/yezhoufan2005/NavFleet/commit/e6533ceea403b5b13c00e3affe4e8b2b7174e98b))
* **console:** 用户分区打磨——角色/用户组拆两标签、标题上移、修标签条滚动条 ([eafc189](https://github.com/yezhoufan2005/NavFleet/commit/eafc1893e2c3498acb7f6f85ccb570a7995b5a98))
* **console:** 管理页焦点自动刷新，去掉手动刷新按钮 ([01990dd](https://github.com/yezhoufan2005/NavFleet/commit/01990dd2c25b0500e8f6938b2175b3a45f727136))
* **console:** 管理页焦点自动刷新，去掉手动刷新按钮 ([f2a7db3](https://github.com/yezhoufan2005/NavFleet/commit/f2a7db31de96472bd1a8cfbfba0fde7a5140fcff))
* **console:** 补齐审计动作筛选、报表导出与告警史时间窗 ([0c77a4c](https://github.com/yezhoufan2005/NavFleet/commit/0c77a4c422b7bfe8a369a30b313db53581c9c583))
* **notify:** 外发渠道编辑器（精简+静默，高级路由整文件保留） ([6925396](https://github.com/yezhoufan2005/NavFleet/commit/6925396b4c30295b7bd3684cdd27e96c10ce7ee9))
* **notify:** 外发渠道编辑器（精简+静默，高级路由整文件保留） ([2a83a81](https://github.com/yezhoufan2005/NavFleet/commit/2a83a81f09e19b0aa9bd825bec642342f7a83128))
* **notify:** 外发配置写端点（校验先行、原子写、notify:write） ([956a13e](https://github.com/yezhoufan2005/NavFleet/commit/956a13e82a9875a21e2785bad7831c9f45011921))
* **rbac:** 前端角色/用户组管理 + 按能力的门禁与 can() 接线 ([ded0faa](https://github.com/yezhoufan2005/NavFleet/commit/ded0faa52f4c95f0fcd85aa4dbed079cbbd4f300))
* **rbac:** 自定义角色 + 用户组（能力经组叠加，改组即时生效） ([ac6e988](https://github.com/yezhoufan2005/NavFleet/commit/ac6e988a4dcadeeeab700c005be98a1def3bca8e))
* **rbac:** 门禁改为细粒度能力项（等价重构，为自定义角色/用户组铺路） ([acc73f5](https://github.com/yezhoufan2005/NavFleet/commit/acc73f5160d82ed2e7cea666f29bfb90e27b5440))
* **reports:** 定时报表写 UI（调度整文件校验写盘，复用外发收件人） ([f5fbff4](https://github.com/yezhoufan2005/NavFleet/commit/f5fbff41c883063393b21480b57aa9e0df5542af))
* **reports:** 定时报表写 UI（调度整文件校验写盘，复用外发收件人） ([bc7a32b](https://github.com/yezhoufan2005/NavFleet/commit/bc7a32bb16608e334a0f15e9e052661a175b60cc))
* **rules:** 告警规则写 UI（阈值·开关·作用范围整文件校验写盘） ([516b6a5](https://github.com/yezhoufan2005/NavFleet/commit/516b6a50efe321a99b2b7ca312713548af74eaf9))
* **rules:** 告警规则写 UI（阈值·开关·作用范围整文件校验写盘） ([d8c0b50](https://github.com/yezhoufan2005/NavFleet/commit/d8c0b50b20db03d4d3cc64b4ef1bd094bc128ca3))


### Bug Fixes

* **ci:** release 的 images 作业补 id-token: write，修 v1.6.0 startup_failure ([ac029f2](https://github.com/yezhoufan2005/NavFleet/commit/ac029f206f515cd13d33002e00979b20ec4fd9b1))
* **ci:** release 的 images 作业补 id-token: write，修 v1.6.0 startup_failure ([93a2cbe](https://github.com/yezhoufan2005/NavFleet/commit/93a2cbe4be01184f00956d94bbcf170886588ae5))
* **console:** 管理页 UI 打磨 + 精简文案 ([e8d63df](https://github.com/yezhoufan2005/NavFleet/commit/e8d63dfb9b538fb749d1ce2ea8b393ae24f24c25))
* **console:** 管理页 UI 打磨 + 精简文案 ([3e52b46](https://github.com/yezhoufan2005/NavFleet/commit/3e52b46721d76014a4df72e4d24f2e200e337c9d))

## [1.6.0](https://github.com/yezhoufan2005/NavFleet/compare/v1.5.0...v1.6.0) (2026-09-29)


### Features

* **ci:** 发布多平台镜像（arm64+amd64）+ 附 SBOM/provenance ([4595289](https://github.com/yezhoufan2005/NavFleet/commit/45952892973cd2c063c130bc703418d8cece3f11))
* **ci:** 发布多平台镜像（arm64+amd64）+ 附 SBOM/provenance ([7f7b79f](https://github.com/yezhoufan2005/NavFleet/commit/7f7b79f99d9c9f03331a20b06e76034695ed34ba))
* **observability:** Mongo 写入延迟直方图（Phase 18 收尾） ([0aac463](https://github.com/yezhoufan2005/NavFleet/commit/0aac46313bebe54a7e83ff35a81c710885a3ec7b))
* **observability:** Mongo 写失败与 WS 广播背压指标（Phase 18） ([6f3df79](https://github.com/yezhoufan2005/NavFleet/commit/6f3df797d83655ad90e371257c83c8c79d435145))
* **observability:** 补 Mongo 写入延迟直方图（Phase 18 运维盲区收尾） ([392b0c5](https://github.com/yezhoufan2005/NavFleet/commit/392b0c53276a7005562e7a002f3978cb74d0b93e))
* **observability:** 补齐 Mongo 写失败与 WS 广播背压指标（Phase 18 运维盲区） ([3a30276](https://github.com/yezhoufan2005/NavFleet/commit/3a3027662c587650e0b60aaa3e873b3d32a0c4eb))
* **onboarding:** 设备接入向导前端页（Phase 18 PR-2） ([7094ccd](https://github.com/yezhoufan2005/NavFleet/commit/7094ccd64450aa97204440f11320b9184608d7e9))
* **onboarding:** 设备接入向导前端页（Phase 18 PR-2） ([ff3dbe5](https://github.com/yezhoufan2005/NavFleet/commit/ff3dbe52443b2bc6f3b6e84a83aaf64138d67009))
* **onboarding:** 车辆/编队配置校验+写入 API（Phase 18 设备接入向导后端） ([d667caf](https://github.com/yezhoufan2005/NavFleet/commit/d667cafca1ec72e78b38c75d190adda700c95bca))
* **onboarding:** 车辆/编队配置的校验 + 写入 API（Phase 18 设备接入向导后端） ([66d7c4d](https://github.com/yezhoufan2005/NavFleet/commit/66d7c4dae3431e1b7db769abeb12771d874ed46f))
* **scenes:** 场景地图上传与管理前端页（Phase 18 PR-2） ([733a269](https://github.com/yezhoufan2005/NavFleet/commit/733a26982883813736f3bb553f5d1a6b9536d409))
* **scenes:** 场景地图上传与管理前端页（Phase 18 PR-2） ([78cb2df](https://github.com/yezhoufan2005/NavFleet/commit/78cb2df3594bbcb99d2afd7386a10e249d6c1c3e))
* **scenes:** 场景地图上传与管理后端（Phase 18 PR-1） ([67d8b94](https://github.com/yezhoufan2005/NavFleet/commit/67d8b940671997c3b53ce3434dddea7bfdad9280))
* **scenes:** 场景地图上传与管理后端（Phase 18 PR-1） ([53c71b8](https://github.com/yezhoufan2005/NavFleet/commit/53c71b8ddf60430f72ed42329f103f863bd97d8e))


### Bug Fixes

* **backend:** 设备恢复上报即回在线 + notify_log TTL 协调 + flush 掉数计入 ([033191c](https://github.com/yezhoufan2005/NavFleet/commit/033191c121752aceabfa699a7c8aad9a0b65e59e))
* **backend:** 设备恢复上报即回在线 + notify_log TTL 协调 + flush 掉数计入 ([0cd0128](https://github.com/yezhoufan2005/NavFleet/commit/0cd0128e267541bac5489d06341ce8ecc0bc7851))
* **console:** 列表与提醒的四处界面细节 ([585d0ba](https://github.com/yezhoufan2005/NavFleet/commit/585d0baaeca2054fe8a75093b6ecff44155deb2e))
* **console:** 列表与提醒的四处界面细节 ([bff4852](https://github.com/yezhoufan2005/NavFleet/commit/bff48524f10f255f8cd148506d47e24a0ceda4c2))
* **console:** 批量确认失败只提示一次 + 设备列表分页越界回正 ([24977ec](https://github.com/yezhoufan2005/NavFleet/commit/24977ecc14893087e251c33c9b3b374e40b5167c))
* **console:** 批量确认失败只提示一次 + 设备列表分页越界回正 ([10cb8b6](https://github.com/yezhoufan2005/NavFleet/commit/10cb8b6d9b14672b07d49fd22736b5ab8c62dfb2))
* **console:** 设备列表各列改按比例分配，设备与编号不再拉开 ([516b4dd](https://github.com/yezhoufan2005/NavFleet/commit/516b4dd89fc200b3675aa29cf2b7655e18448d4f))
* **console:** 设备列表改固定列宽，排序不再抖动列位置 ([54792bf](https://github.com/yezhoufan2005/NavFleet/commit/54792bfb461c96ab93c374d4a42b4e431d7fe8d4))
* **console:** 设备列表改固定列宽，排序不再抖动列位置 ([598c676](https://github.com/yezhoufan2005/NavFleet/commit/598c676f95b1cf2fb6f3b85611b0b0bdc9fd04a5))
* **fleet-core,shared:** 归一化的四处边界修正 ([eadbe5c](https://github.com/yezhoufan2005/NavFleet/commit/eadbe5cfddafa628d6192977dc2adbe468a80287))
* **fleet-core,shared:** 归一化的四处边界修正 ([2620a03](https://github.com/yezhoufan2005/NavFleet/commit/2620a036834ff1007f0d440c14a84f91b37acfe8))
* **scenes:** 修 CI 的 backend lint 报错 ([53ed883](https://github.com/yezhoufan2005/NavFleet/commit/53ed883a95943e1ed8d6d9dcf8d611cc46f1e03e))

## [1.5.0](https://github.com/yezhoufan2005/NavFleet/compare/v1.4.0...v1.5.0) (2026-09-20)


### Features

* **console:** 七张表统一为一种方言，报表筛选框对齐，待处理项与编队等高 ([9f30064](https://github.com/yezhoufan2005/NavFleet/commit/9f30064a40a4c6eed695f310a7cc3cce5348f2ee))
* **console:** 七张表统一方言 + 报表筛选框对齐 + 待处理项等高 ([789e101](https://github.com/yezhoufan2005/NavFleet/commit/789e101b756c85737f2907085df210eb889a63ff))
* **console:** 主题完全照 GitHub Primer 重做（Light/Dark default） ([a83d402](https://github.com/yezhoufan2005/NavFleet/commit/a83d402c159c5f6afe61a36db674542e8f37934e))
* **console:** 告警史并入消息页作为子 tab ([eb2ec7c](https://github.com/yezhoufan2005/NavFleet/commit/eb2ec7ccf96884ff035ff647ac84ba41b2af13fb))
* **console:** 品牌去绿改克制蓝灰（黑白灰主题 + 低饱和 indigo 强调） ([9e495bf](https://github.com/yezhoufan2005/NavFleet/commit/9e495bf601edf674164c6b9b54e3930163269cce))
* **console:** 回放窗口速度表限 5 行、表头移出滚动区 ([b486811](https://github.com/yezhoufan2005/NavFleet/commit/b4868116241e0326049e808af62883c8d9b0b67e))
* **console:** 回放进入默认适应场景 ([9c2e6c1](https://github.com/yezhoufan2005/NavFleet/commit/9c2e6c12ac26e12e9061a160c683ba4df6fcba9b))
* **console:** 审计与设备列表支持每页条数选择（10/20/50，默认20） ([bcd4208](https://github.com/yezhoufan2005/NavFleet/commit/bcd4208b5fd2842880db4b997e6f55594199c7a4))
* **console:** 报表页时间控件、去「告警」化文案、图例右置、骨架屏 ([40ed774](https://github.com/yezhoufan2005/NavFleet/commit/40ed774e0bb544b875f18b19fc254d330a5dcba6))
* **console:** 深色改用 GitHub dark_dimmed（Soft dark）+ 细分交互/分隔 token ([9d88617](https://github.com/yezhoufan2005/NavFleet/commit/9d88617410edca16204172641e957d1c20f8539c))
* **console:** 焕新第1步 设计 token 基座（深色压深/圆角收紧/品牌提彩度） ([b790e52](https://github.com/yezhoufan2005/NavFleet/commit/b790e52d954187ce602478209af3c325fae71161))
* **console:** 焕新第1步——设计 token 基座（深色压深、圆角收紧、品牌微提彩度） ([58f003b](https://github.com/yezhoufan2005/NavFleet/commit/58f003b087d936e98f69aef766d2665386270b53))
* **console:** 焕新第2步 UiCard 组件 + 表格行 hover ([5a8c3d8](https://github.com/yezhoufan2005/NavFleet/commit/5a8c3d83b68f481c3c311321bc3918904806deac))
* **console:** 焕新第2步——新增 UiCard 组件，表格行加 hover 态 ([f19cf2c](https://github.com/yezhoufan2005/NavFleet/commit/f19cf2c8f94da9867d8c4551495f173f8ac2769f))
* **console:** 焕新第3步 排版规则统一（区块标题 text-md + 控件标签去 mono） ([ae26775](https://github.com/yezhoufan2005/NavFleet/commit/ae26775d913692ba546706ecfe0596140ee14e1a))
* **console:** 焕新第3步——排版规则统一（区块标题 text-md、控件标签去 mono） ([862b940](https://github.com/yezhoufan2005/NavFleet/commit/862b9404e1577f31f774d0be52e50463c0a36c90))
* **console:** 管理页收敛为已建 6 项，删两段只读说明文字 ([3bd2c64](https://github.com/yezhoufan2005/NavFleet/commit/3bd2c64c5b9627ccefc44c2e821ab28774d30916))
* **console:** 统一筛选输入框与分页器，修复待处理项底部空白 ([dd7185a](https://github.com/yezhoufan2005/NavFleet/commit/dd7185aec6c963c34b0958137eb9df686f4f6bdc))
* **console:** 统一筛选输入框与分页器为共享组件，修复待处理项底部空白 ([a161152](https://github.com/yezhoufan2005/NavFleet/commit/a1611527eec7bdad0d3158e134c0db1592005fb1))
* **console:** 设备列表细修——单条手风琴展开(滑动)、展开卡按钮化与右对齐、九项恒显 ([1876fe5](https://github.com/yezhoufan2005/NavFleet/commit/1876fe5afcf61c17ca140ff91835bfc905cae865))
* **console:** 设备离线或离场即清除其轨迹，不留残影 ([6b869de](https://github.com/yezhoufan2005/NavFleet/commit/6b869de902f8b8a0045356528d7341b9be1255ab))
* **console:** 设备页地图也默认适应场景 ([f821b20](https://github.com/yezhoufan2005/NavFleet/commit/f821b200325b661ddfc191fb07dd6ebea4df7a71))
* **console:** 选中车标改成导航风格单一定位标 + 车名气泡 ([c44e9ae](https://github.com/yezhoufan2005/NavFleet/commit/c44e9aec3aa853d1b00df5fbeebc41430280d4ca))
* **console:** 选中车标覆盖旧点 + 待处理项可滚动 + 提醒移到正上方 + 每页条数 ([1234e9d](https://github.com/yezhoufan2005/NavFleet/commit/1234e9d3ad409d06ca1be8de20740b41e4455a96))
* **demo:** 演示数据大改——23 车/5 编队/5 场景，真实轨迹与单发布器可靠性 ([4538724](https://github.com/yezhoufan2005/NavFleet/commit/4538724030bf88a918c58554dfa933d511fc7116))
* **deploy:** 安全头覆盖所有 location + Permissions-Policy（Phase 18） ([ba6ce38](https://github.com/yezhoufan2005/NavFleet/commit/ba6ce38b409a9913d3c041c8c9e3bc855a61ec1f))
* **reports:** 报表支持「按月」分桶粒度 ([900eabb](https://github.com/yezhoufan2005/NavFleet/commit/900eabb667dc90884f1ba435e87df8464676408f))


### Bug Fixes

* **backend:** 恢复设备时按当前花名册剪枝，修复设备列表 26≠23 ([b11e466](https://github.com/yezhoufan2005/NavFleet/commit/b11e4662e7bef5f5b81dc8237ae089ceafa148ed))
* **backend:** 恢复设备时按当前花名册剪枝，去掉离线旧设备 ([a64c90b](https://github.com/yezhoufan2005/NavFleet/commit/a64c90bcc78736e58ee5bfe9d4b9c46ba4193a79))
* **backend:** 打包时 bundle @navfleet/shared，修复生产镜像启动即崩 ([524d6f6](https://github.com/yezhoufan2005/NavFleet/commit/524d6f683e6aba1927268521317ef892d5479a2c))
* **console:** 「清除已确认」按钮文案改为「清除已经确认」 ([80a71cb](https://github.com/yezhoufan2005/NavFleet/commit/80a71cba8394068b1eea2e75cb53d30dab6cbefc))
* **console:** v1.5.0 收尾——滚动收敛/术语统一/报表聚合/控件底色 ([458e382](https://github.com/yezhoufan2005/NavFleet/commit/458e382ea9e5d80a255a4f344090c87f4ff39221))
* **console:** 下拉列表面板最多约 10 行、超出滚动 ([8c7bb42](https://github.com/yezhoufan2005/NavFleet/commit/8c7bb42e55634620b65f045253f097ac8e49f973))
* **console:** 全站按钮清扫，操作按钮统一到 UiButton/UiSegmented/UiInput ([d3d7b86](https://github.com/yezhoufan2005/NavFleet/commit/d3d7b86b377f556a6fd97d37c9ed88cf24fe13a5))
* **console:** 全站按钮清扫，操作控件统一到 UiButton/UiSegmented/UiInput ([920e612](https://github.com/yezhoufan2005/NavFleet/commit/920e612cef3797525fb696a949673cb78cd94947))
* **console:** 审计起止日期校验 + 重置按钮加边框 ([a99af79](https://github.com/yezhoufan2005/NavFleet/commit/a99af79fe590740129f5b611b867b94f05c3784f))
* **console:** 待处理项与编队情况底部对齐，分段控件与输入框同高 ([80fe22b](https://github.com/yezhoufan2005/NavFleet/commit/80fe22b36a4c82b8d96a2555a502eb6e871f5b86))
* **console:** 待处理项用绝对定位填充对齐(不动右栏)，分段控件抽成 UiSegmented ([c20a363](https://github.com/yezhoufan2005/NavFleet/commit/c20a3637cbfdb19c2ee0434fd67d4891b2e66efa))
* **console:** 待处理项绝对定位填充对齐(不动右栏) + 分段控件抽成 UiSegmented ([a02f32f](https://github.com/yezhoufan2005/NavFleet/commit/a02f32f79c836eab452cd018e2b4d00ae71f5b5c))
* **console:** 数据表 6 行、审计表外滚、重置按钮描边、管理文案精简 ([2534520](https://github.com/yezhoufan2005/NavFleet/commit/25345204b99299724f60f29f4d8f1593d0bbfa64))
* **console:** 良性 ResizeObserver loop 提示不再弹成「页面出现异常」 ([80e06fb](https://github.com/yezhoufan2005/NavFleet/commit/80e06fb69b1a4ffa775a3e6f8d03ec0c7c680407))
* **console:** 设备/详情/曲线/管理 五处体感问题 ([5a81872](https://github.com/yezhoufan2005/NavFleet/commit/5a81872a865150ee663123278c8dbcb8985f3350))
* **console:** 设备列表细修 + 浅色正文柔和 ([de32ec7](https://github.com/yezhoufan2005/NavFleet/commit/de32ec7c2b9eaba978a245b0b12f7e7d9b1eadc1))
* **console:** 设备表与详情用 tabular-nums 消除每秒回流的电量抖动 ([309c710](https://github.com/yezhoufan2005/NavFleet/commit/309c7108bcb73f77f72c76f57eadce32a79debdd))
* **console:** 通知 toast 关闭 × 垂直居中 ([3e01dd1](https://github.com/yezhoufan2005/NavFleet/commit/3e01dd1da235db1ab3df15f7697e3f3c1a392653))
* **demo:** 回充阈值下移至 15% 形成迟滞，消除低电告警边界抖动 ([2f71355](https://github.com/yezhoufan2005/NavFleet/commit/2f71355f6fdb0100f86c37d1ebd4e860d1db1df1))
* **map:** lanelet delete=true 只隐藏影子墓碑，恢复连贯路网 ([98be04b](https://github.com/yezhoufan2005/NavFleet/commit/98be04b248b1e645e920c030a673ded37841cb68))
* **map:** lanelet 叠加层 bounds 只按 live 车道节点计算 ([30a9a0e](https://github.com/yezhoufan2005/NavFleet/commit/30a9a0e039fd66cc654022ff42c9737d5c510ba4))
* **map:** Lanelet2 delete=true 过滤——不画墓碑 lanelet ([1d83780](https://github.com/yezhoufan2005/NavFleet/commit/1d837805db802e2fbfab4462e0b99e32af76145f))

## [1.4.0](https://github.com/yezhoufan2005/NavFleet/compare/v1.3.0...v1.4.0) (2026-09-19)


### Features

* **auth:** kiosk 账号——长效只读大屏凭据（Phase 17C-1） ([3861f5d](https://github.com/yezhoufan2005/NavFleet/commit/3861f5d697e17bfcb2fba2287754fade57484447))
* **auth:** kiosk 账号——长效只读大屏凭据（Phase 17C-1） ([a0787e0](https://github.com/yezhoufan2005/NavFleet/commit/a0787e0ed6028c73b33c8afd7c5e0b8bcd1db0c2))
* **console:** 大屏值班页——KPI 带 + 地图 + 滚动告警，强制新鲜度指示（Phase 17C-2，17C 收口） ([d83b2cd](https://github.com/yezhoufan2005/NavFleet/commit/d83b2cd5c079fb3bfad97072b76480f757e5f399))
* **reports:** 定时邮件报表，盘上 reports.json + 复用 16D 邮件渠道（Phase 17B-2） ([9e9f6bc](https://github.com/yezhoufan2005/NavFleet/commit/9e9f6bc8e5d716474cdd8f7dcd8d01ba0f6c555c))
* **reports:** 定时邮件报表，盘上 reports.json + 复用 16D 邮件渠道（Phase 17B-2） ([e94ab5c](https://github.com/yezhoufan2005/NavFleet/commit/e94ab5c5e49277f68af5f8b7901942020d295cbc))
* **reports:** 报表页 + CSV 导出，消费 17A 聚合端点（Phase 17B-1） ([62ecb7a](https://github.com/yezhoufan2005/NavFleet/commit/62ecb7a11a5fbe21b7fe200cae7a8fee6f21d513))
* **reports:** 报表页 + CSV 导出，消费 17A 聚合端点（Phase 17B-1） ([ef1e1af](https://github.com/yezhoufan2005/NavFleet/commit/ef1e1af51db8bd0bfb3d2267648ac5efb1890b5e))
* **reports:** 服务端可用率/电量时序聚合（$dateTrunc 降采样，Phase 17A-2） ([ca9a1ad](https://github.com/yezhoufan2005/NavFleet/commit/ca9a1ad14debff2787b3658c794484573c111e69))
* **reports:** 服务端可用率/电量时序聚合（$dateTrunc 降采样，Phase 17A-2） ([9f407c4](https://github.com/yezhoufan2005/NavFleet/commit/9f407c49d67a85528a4e9b6ec4930d8bd03d17bb))
* **reports:** 服务端告警统计聚合，摆脱 /alerts 的 500 条上限（Phase 17A-1） ([81a0aaa](https://github.com/yezhoufan2005/NavFleet/commit/81a0aaac85c9fbf50eae4fe6870a3a68f29f536c))
* **reports:** 服务端告警统计聚合，摆脱 /alerts 的 500 条上限（Phase 17A-1） ([568bf3d](https://github.com/yezhoufan2005/NavFleet/commit/568bf3ddee07a3fb1a88f27aa1771cf089432f6b))


### Bug Fixes

* **reports:** 空态链接持久下划线，过 axe link-in-text-block（深/浅色） ([b34cdc6](https://github.com/yezhoufan2005/NavFleet/commit/b34cdc602ab96a3d21866e69afc5bbfb1bb18a6b))

## [1.3.0](https://github.com/yezhoufan2005/NavFleet/compare/v1.2.0...v1.3.0) (2026-09-19)


### Features

* **alerts:** 告警史页——已清除告警列表与就地统计（Phase 16B） ([3d2db8c](https://github.com/yezhoufan2005/NavFleet/commit/3d2db8c49121c53f678195db387efc57f4aecb98))
* **alerts:** 告警确认落库 + operator 确认能力（Phase 16A） ([dcbf6af](https://github.com/yezhoufan2005/NavFleet/commit/dcbf6afadd31961d8598b5b858b34600f737dffd))
* **alerts:** 规则引擎收敛到 @navfleet/shared 并可配置（Phase 16C-1） ([63992eb](https://github.com/yezhoufan2005/NavFleet/commit/63992ebe29c8d18b27ee07eec97422a1f5c5d427))
* **codebook:** 报码字典可配置——部署侧覆盖内置表 + 管理页导入导出（Phase 16C-2） ([7ec9bc2](https://github.com/yezhoufan2005/NavFleet/commit/7ec9bc2d479a6046a50b8f5143f96d10e05a7544))
* **notify:** 只读外发页 + 发送指标/Grafana 面板（Phase 16D-2b） ([9bf76f9](https://github.com/yezhoufan2005/NavFleet/commit/9bf76f9b4293997a6047d3de8d0b7c9fa5cbefc1))
* **notify:** 告警外发骨架——HTTP 渠道 + 分级路由 + 发送记录（Phase 16D-1） ([777d069](https://github.com/yezhoufan2005/NavFleet/commit/777d0695c329ac5b0f04c7f66a600599a82bd915))
* **notify:** 邮件渠道 + 收件方用户组 + 汇总/静默/去重/升级策略（Phase 16D-2a） ([7b51d46](https://github.com/yezhoufan2005/NavFleet/commit/7b51d466d3c864fc30cc2908b3c0983fcf8b0dce))

## [1.2.0](https://github.com/yezhoufan2005/NavFleet/compare/v1.1.0...v1.2.0) (2026-09-18)


### Features

* **console:** 用户 / 审计 / 会话管理页 + 个人中心（Phase 15E-2，收口 1.2.0） ([bf9a9ba](https://github.com/yezhoufan2005/NavFleet/commit/bf9a9ba85eb217df182965038a7d99294e2bd553))

## [1.1.0](https://github.com/yezhoufan2005/NavFleet/compare/v1.0.3...v1.1.0) (2026-09-09)


### Features

* **console:** 接上后端一直在广播、而没人消费的那四种事件 ([3986f64](https://github.com/yezhoufan2005/NavFleet/commit/3986f64d3b45b340e75a49cbfd6f6d9dfa8207fa))
* **deploy:** 补 Alertmanager，告警从此有接收端；并整理 ROADMAP 的现状口径 ([f486658](https://github.com/yezhoufan2005/NavFleet/commit/f486658536e811377e58a6c36fcc5d9d5c66fa38))


### Bug Fixes

* **backend:** history 的 limit 上界降到实际值，不再对外承诺 500 给不出的 4500 ([d4626d0](https://github.com/yezhoufan2005/NavFleet/commit/d4626d0abf4b3563b4153d19396c7ad241ab50a7))
* **backend:** OpenAPI 文档与实际路由对齐 —— 四条路径、两种全局响应、三个字段、一处 3.1 违规 ([5ff9905](https://github.com/yezhoufan2005/NavFleet/commit/5ff9905c33054f16c67309773f581a7a7281c28f))
* **ci:** 新门禁第一次进 CI 就被自己绊倒 —— 挂载点检查要豁免刻意不入库的路径 ([2ecf6a5](https://github.com/yezhoufan2005/NavFleet/commit/2ecf6a54de77292731d2ffdc51e712c029ded932))
* **console:** 一个「未用的 prop」原来是没接上的修复；顺带删掉与只读定位相悖的 danger ([07afa83](https://github.com/yezhoufan2005/NavFleet/commit/07afa83e8beb122bd54a7f484fb2ffbf6af4693e))
* **console:** 系统状态页的「再次检查」改成「重新检查」，与场景页一致 ([a59edfa](https://github.com/yezhoufan2005/NavFleet/commit/a59edfa2014e6158b2931e6da82768a20abaa3fe))
* **frontend:** 冻结的控制台把历史页 limit 从 1000 降到 500 ([3341442](https://github.com/yezhoufan2005/NavFleet/commit/33414423712460a3fb0822af0a3af6f9ea527857))
* **scripts:** --help 的 sed 范围写错，末尾多印四行代码 ([f04b077](https://github.com/yezhoufan2005/NavFleet/commit/f04b077a3812dd0a0f2f303c0fc9d15364e84128))
* **shared:** MapProfile 的词表改成真的，并删掉一个只是第二个名字的类型 ([bba0e9d](https://github.com/yezhoufan2005/NavFleet/commit/bba0e9df011cc0e77009a50964bf34505ad8e29d))
* 全仓审计第一批 —— 五个真 bug，两个 normalize 实现的一致性 ([90d1f95](https://github.com/yezhoufan2005/NavFleet/commit/90d1f95000ea5fe17fad113f76f5976fc315eacf))

## [1.0.3](https://github.com/yezhoufan2005/NavFleet/compare/v1.0.2...v1.0.3) (2026-09-02)


### Bug Fixes

* **backend:** P0-b / P0-d —— 摄入队列封顶，设备内存加准入与淘汰 ([29da46d](https://github.com/yezhoufan2005/NavFleet/commit/29da46d5cbbec3b4e2c6bb418bc829ff964aaf6f))
* **backend:** P0-c / P0-e / 优雅关闭 —— 三处会丢数据的路径 ([980dcd5](https://github.com/yezhoufan2005/NavFleet/commit/980dcd5e167d4f2701a5195877edb37455825113))
* **backend:** 那条测试里的 NUL 是我写坏的，不是我想测的 ([482a47e](https://github.com/yezhoufan2005/NavFleet/commit/482a47e6a1aaa1849a929ef589bca6ce7eac8efc))
* **fleet-core:** 两处把「缺失」当成值的回退（parity 9.1 / 9.19） ([474e130](https://github.com/yezhoufan2005/NavFleet/commit/474e130a1f3823b4f352a22ff92531784f61a4a4))
* **fleet-core:** 删掉 dataDefaults 的两个永久空常量（parity 8.7） ([1b04514](https://github.com/yezhoufan2005/NavFleet/commit/1b0451407afaa77571af4e9e7e0472beebb4ed77))

## [1.0.2](https://github.com/yezhoufan2005/NavFleet/compare/v1.0.1...v1.0.2) (2026-08-30)


### Features

* **console:** scaffold frontend-next and retire the theme risk ([2e0a499](https://github.com/yezhoufan2005/NavFleet/commit/2e0a499c39584d045e92a5f29cd68bda006af7e9))
* **fleet-core:** extract the logic both frontends will share ([c485a3d](https://github.com/yezhoufan2005/NavFleet/commit/c485a3d063ec79c7249cd28badddb7de6e3f443e))


### Bug Fixes

* **a11y:** stop the nav pill animating into an unreadable colour pair ([69ccfc4](https://github.com/yezhoufan2005/NavFleet/commit/69ccfc48ec02f3aa5596e8a792f79666dfc58a21))


### Miscellaneous Chores

* **release:** put the version back to 1.0.1 and pin the next release to 1.0.2 ([a0b9d19](https://github.com/yezhoufan2005/NavFleet/commit/a0b9d19710b8b7e3d27b9446961f71404642d95b))

## [1.0.1](https://github.com/yezhoufan2005/NavFleet/compare/v1.0.0...v1.0.1) (2026-08-29)

### Bug Fixes

- **ws:** contain connection errors instead of taking the process down ([82bbcc6](https://github.com/yezhoufan2005/NavFleet/commit/82bbcc6729148c7656219478094192ec25c56d1a))

## 1.0.0 (2026-08-29)

首个基准版本。NavFleet 是一套面向 AGV / 巡检车 / 无人搬运车的**只读**实时监控平台：
MQTT 接入 → 字段归一化与告警派生 → 内存快照 → MongoDB 持久化 → REST + WebSocket →
Vue 3 多页工作台。

本版本的能力清单、部署编排与已知边界见 [README](README.md) 与
[ARCHITECTURE.md](ARCHITECTURE.md)。

1.0 之前的开发过程（Phase 0–10，含每个阶段修掉的具体缺陷与当时的取舍依据）记录在
[docs/roadmap-archive.md](docs/roadmap-archive.md)。那些阶段没有对外发布过可用的构建产物 —— 早期的 0.x tag 与
Release 已移除，镜像发布链路直到本版本才真正打通 —— 所以本变更日志不为它们单列条目，
本版本即第一个对外基准包。
