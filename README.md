# Campus Go MVP 模拟 API

这是一个仅使用 Node.js 内置模块的可运行模拟服务，为校园服务小程序提供商品、校园卡申请、订单和售后接口。运行数据默认保存在 `data/db.json`；该目录已加入 `.gitignore` 和 `.dockerignore`，不要把真实订单、用户或资质数据提交到 Git。云托管生产环境请配置持久化磁盘或数据库，并把 `DB_FILE` 指向持久卷路径。

> 校园卡接口只模拟经学校或持牌服务商授权后的服务流程，不应直接用于未经授权的发卡、充值或身份凭证交易。支付状态也是演示值，生产环境必须由微信支付服务端回调确认。

## 环境与启动

- Node.js 18 或更高版本。
- 不需要执行 `npm install`。

```powershell
npm start
```

默认地址为 `http://localhost:3000`。可用环境变量覆盖配置：

浏览器管理端地址：

```text
http://localhost:3000/admin
```

管理端支持经营概览、商品库存、电瓶车订单、电话卡订单、话费权益、双人宽带资格、校园牌照辅助和售后处理。当前均使用本地模拟数据。

管理端账号密码来自环境变量，不再写入前端页面或代码。复制 `.env.example` 为 `.env` 后配置 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`；微信云托管请在服务“环境变量”中配置同名变量，不要把真实密码提交到 Git。

## MySQL 持久化

默认仍使用 JSON 文件存储。配置以下环境变量后自动切换为 MySQL（微信云托管请购买 MySQL 套餐并把内网地址填入服务环境变量）：

```text
MYSQL_HOST、MYSQL_PORT、MYSQL_DATABASE、MYSQL_USERNAME、MYSQL_PASSWORD
```

启动时自动建 `app_state` 表；若表为空且 `DB_FILE` 指向的 JSON 文件存在，会把 JSON 数据导入 MySQL 后继续使用。MySQL 不可用时自动降级回 JSON 文件，服务不会启动失败。

管理端还支持商品新增与编辑、业务筛选、详情侧栏、CSV 导出、操作日志和运营设置。演示账号与内存会话仅适用于本地验证；正式部署时必须替换为数据库用户、密码哈希、RBAC 权限和安全会话。

```powershell
$env:PORT=3100
$env:DB_FILE='C:\temp\campus-go-db.json'
npm start
```

运行测试：

```powershell
npm test
```

## 响应约定

成功响应使用 `data`；列表另有 `total`。错误响应示例：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "userId is required"
  },
  "requestId": "..."
}
```

金额统一使用人民币分，例如 `29900` 表示 `299.00` 元。客户端传入的价格不会被采信，订单金额由服务端商品数据计算。

## 接口

### 健康检查

`GET /health`

### 商品

- `GET /api/products`
- `GET /api/products/:id`
- 查询参数：`category`、`campusId`、`q`

示例：

```text
GET /api/products?campusId=campus_demo&category=E_BIKE_RENTAL
```

### 校园卡申请

`POST /api/campus-card-applications`

```json
{
  "userId": "user_demo",
  "schoolId": "school_demo",
  "campusId": "campus_demo",
  "serviceType": "REPLACEMENT",
  "applicantName": "张同学",
  "studentNo": "20260001",
  "consent": true
}
```

`serviceType` 支持 `NEW_CARD`、`REPLACEMENT`、`TOP_UP`。查询当前用户申请：

`GET /api/campus-card-applications?userId=user_demo`

列表结果会隐藏姓名和学号原文。

### 创建与查询订单

`POST /api/orders`

建议每次结算生成唯一的 `Idempotency-Key` 请求头，网络重试时复用该值。

```json
{
  "userId": "user_demo",
  "items": [
    { "productId": "prod_ebike_rent_001", "quantity": 1 }
  ],
  "fulfillment": { "type": "PICKUP", "storeId": "store_demo" }
}
```

创建后的订单状态是 `PENDING_PAYMENT`，同时生成模拟支付单并按 `paymentTimeoutMinutes`（管理端可配，默认 30 分钟）写入 `paymentExpiresAt`。库存在这一刻只做预占（`reservedStock`），支付成功才真正扣减 `stock`；用户取消或超时未付会自动释放预占并把订单置为 `CANCELLED` + `paymentStatus=EXPIRED`。生产环境仍需把模拟支付替换为“微信预支付 → 回调验签 → 已支付”。

商品接口会额外返回 `reservedStock` 和 `availableStock`，下单校验、低库存指标和前端“可售/售罄”文案都以 `availableStock` 为准。

- `GET /api/orders?userId=user_demo`
- `GET /api/orders/:id?userId=user_demo`

### 售后

`POST /api/after-sales`

```json
{
  "userId": "user_demo",
  "orderId": "ord_xxx",
  "type": "REFUND",
  "reason": "未能按计划到店取车"
}
```

`type` 支持 `REFUND`、`RETURN`、`REPAIR`。同一订单只允许存在一个未关闭的售后申请。

`GET /api/after-sales?userId=user_demo`

### 商家分账与账期

支付成功会为每个涉及商家的订单生成分账记录，但资金不会立刻可结算，而是走下面这条状态机：

```
支付成功            → PENDING_DELIVERY   待交付核验
用户交付码核验通过  → IN_ACCOUNT_PERIOD  账期中（availableAt = 核验时间 + settlementPeriodDays）
账期到期            → PENDING_SETTLE     可结算
商家申请提现        → PAYOUT_REQUESTED   提现待审核（写入 payoutRequestId 并锁定金额）
平台审核通过打款    → SETTLED            已结算
平台驳回提现        → 回到 PENDING_SETTLE
订单进入售后        → FROZEN             售后冻结（记录 statusBeforeFreeze / frozenReason）
售后关闭            → 恢复冻结前状态
订单退款            → REFUNDED           已冲销
```

- 账期天数由管理端 `settlementPeriodDays` 控制（0–60 天，默认 7；设为 0 表示核验后立即可结算）。
- `POST /api/admin/merchants/:id/settle` 只结算 `PENDING_SETTLE` 的记录；若资金还卡在交付核验、账期或售后冻结，接口返回 409 `SETTLEMENT_NOT_RELEASED` 并说明卡在哪一步；若该商家已有待审核提现单，返回 409 `PAYOUT_REQUEST_PENDING`，必须走审核流程而不能绕过。
- 售后关闭（非退款）会解冻并恢复原有 `availableAt`，不会因为走过售后而重新起算账期。
- 账期到期同样是惰性清扫：商家概览、管理端概览接口会在读取时把到期记录推进到 `PENDING_SETTLE`。
- 商家概览的 `settlementMetrics` 与管理端概览的 `settlementSummary` 都按上述状态分别汇总金额（含 `payoutRequestedInCents`），管理端「商家结算」页和小程序商家工作台据此展示资金分布。

### 商家提现申请与平台审核

资金不再由商家自己确认到账。商家只能提交提现申请，平台在管理端审核后才会打款，提现单状态机为 `PENDING_REVIEW → SETTLED / REJECTED / CANCELLED`。

`POST /api/merchant/payout-requests`（商家身份，可选 body `{ "remark": "本周结算" }`）

- 未配置完整收款账户（户名/开户行/账号）返回 400。
- 已存在待审核提现单返回 409 `PAYOUT_REQUEST_EXISTS`。
- 无可结算金额返回 409 `SETTLEMENT_NOT_RELEASED` 并说明资金卡在哪一步。
- 可结算金额低于起提门槛返回 409 `PAYOUT_BELOW_MINIMUM`。
- 成功返回 201，把该商家所有 `PENDING_SETTLE` 分账置为 `PAYOUT_REQUESTED` 并写入 `payoutRequestId`。

`GET /api/merchant/payout-requests` 返回该商家的提现记录。

`POST /api/admin/payout-requests/:id/review`

```json
{
  "decision": "APPROVE",
  "reference": "BANK-20260906-001",
  "reviewNote": "已通过企业网银转账"
}
```

- `decision` 为 `APPROVE` 时必须提供 `reference`（打款凭证号），否则 400；通过后分账转 `SETTLED` 并写入一条 `PAYOUT` 财务流水。
- `decision` 为 `REJECT` 时必须提供 `reviewNote`（驳回原因），否则 400；驳回后金额退回 `PENDING_SETTLE`，商家可修改信息后重新申请。
- 已处理过的提现单再次审核返回 409 `PAYOUT_REQUEST_CLOSED`。
- 起提门槛由管理端 `payoutMinimumInCents` 控制（0–1000000 分，默认 10000 分即 ¥100），管理端设置页以“元”为单位填写。
- 平台在「商家结算」页直接打款（`/api/admin/merchants/:id/settle`）也会补记一条 `initiatedBy: "PLATFORM"` 的已结算提现单，保证台账口径一致。
- 订单进入售后或退款时，关联的待审核提现单会自动置为 `CANCELLED`，未受影响的金额退回 `PENDING_SETTLE`；商家与平台都会收到通知。

## 当前边界

- `userId` 是模拟身份参数，生产环境应从微信登录后的服务端会话中取得，不能信任客户端传值。
- JSON 文件适合本机演示和产品联调，不支持多进程并发；生产环境应替换为事务数据库和 Redis。
- CORS 当前开放用于本地联调，部署时应限制来源。
- 未接入真实微信支付、实名服务、校方校园卡系统、物流或消息通知。
- 库存已实现“预占 → 支付扣减 → 取消/超时释放 → 退款回补”闭环，但仍是单进程 JSON/MySQL 快照方案，高并发场景需要数据库行级锁或独立库存服务。
- 超时关单依赖读接口触发的惰性清扫（商品、订单、概览接口），没有独立定时任务；长时间无人访问时订单会在下一次访问时统一关闭。
- 分账账期到期同样依赖读接口惰性清扫，没有独立定时任务；提现审核与打款仍是人工在管理端确认的模拟动作，未接入真实企业付款/企业转账接口，也没有银行回单附件上传与批量打款。
