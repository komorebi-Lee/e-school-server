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

为了让 MVP 可直接演示，创建后的订单状态是 `PAID`，支付状态是 `MOCK_SUCCESS`。生产环境必须改为“待支付 → 微信预支付 → 回调验签 → 已支付”。

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

## 当前边界

- `userId` 是模拟身份参数，生产环境应从微信登录后的服务端会话中取得，不能信任客户端传值。
- JSON 文件适合本机演示和产品联调，不支持多进程并发；生产环境应替换为事务数据库和 Redis。
- CORS 当前开放用于本地联调，部署时应限制来源。
- 未接入真实微信支付、实名服务、校方校园卡系统、物流或消息通知。
- 商品库存创建订单时直接扣减；正式版本应使用预占、支付确认和超时释放机制。
