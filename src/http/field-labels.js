/**
 * 请求体字段名 → 面向用户的中文标签。
 *
 * ## 为什么需要它
 *
 * `requireString` 的默认错误文案原先直接拼接英文 `field`：
 * `${field} is required` / `is too short` / `is too long`。而全仓 146 个
 * `requireString` 调用点里只有 1 个传了 `message`，其余全部落到这三条默认文案。
 * `miniprogram/lib/cloud-request.js` 把 `response.data.error.message` 直接塞进
 * `new Error(...)`，页面再 `wx.showToast({ title: error.message })` ——
 * **中文用户会看到 `title is required`**。
 *
 * 这不是防御性路径：`POST /api/market/items` 的 `requireString(body.title, 'title',
 * { maxLength: 60 })` 就没传 `message`，用户漏填标题时看到的就是英文。
 *
 * ## 术语从哪来
 *
 * 每个标签都先在**项目既有中文文案**里找同一概念已有的词，找不到才新拟：
 *
 * - 小程序表单标签：`merchant/apply.wxml`（经营者姓名 / 身份证号 / 开户银行 /
 *   收款人姓名 / 银行卡号 / 服务区域 / 统一社会信用代码或执照编号 …）、
 *   `plate.wxml`（学号 / 车辆品牌与型号）、`card.wxml`（姓名 / 同伴手机号）、
 *   `addresses.wxml`（姓名 / 手机号）、`aftersales.wxml`（处理结论）、
 *   `consult.wxml`（姓名 / 手机号 / 补充需求）
 * - 服务端既有中文校验文案：`app.js` 的 `店铺名称至少 2 个字符`、`商品分类不支持`、
 *   `成色描述不支持`、`论坛板块不支持`、`请填写申诉或整改说明`、`请填写整改计划`、
 *   `管理员账号仅支持…`、`管理员密码至少需要 12 位`、`不支持的管理员角色`
 * - 管理端：`admin.js` 的 `分配负责人`、`配置变更记录`
 *
 * ## 一个字段名可能对应多个概念（这是本表的固有局限）
 *
 * 服务端复用字段名的现象很普遍，例如 `name` 同时是「店铺名称」（`POST /api/merchants`）、
 * 「商品名称」（商品创建）与「线索姓名」（咨询线索）；`ownerName` 同时是
 * 「经营者姓名」与「实名认证姓名」。本表是**扁平映射**，只能给一个词。
 * 取舍原则：取覆盖面最广的那个，且必须让用户看得懂「哪个字段有问题」。
 * 详见各条目上方的注释。
 */

/** 字段名 → 中文标签。键必须与服务端 `requireString` 的第 2 个实参逐字一致。 */
const FIELD_LABELS = {
  // ---- 通用动作 / 状态类 ----
  action: '操作',
  status: '状态',
  type: '类型',
  decision: '审核决定',
  visibility: '可见性',
  note: '备注',
  reason: '原因说明',
  reasonType: '申诉原因',
  plan: '整改计划',
  reference: '打款凭证',
  billDate: '账单日期',
  deliveryCode: '交付码',
  // `code` 全仓只出现在微信登录（`wx.login` 拿到的临时凭证）。
  code: '微信登录凭证',

  // ---- 账号与权限（仅管理端使用）----
  username: '管理员账号',
  password: '管理员密码',
  role: '管理员角色',
  displayName: '姓名',

  // ---- 人名的四种写法 ----
  // `name` 覆盖「店铺名称 / 商品名称 / 线索姓名」，实体名占多数，故取「名称」。
  name: '名称',
  // `ownerName` 覆盖「经营者姓名」（商家入驻）与「实名认证姓名」。
  ownerName: '姓名',
  // `customerName` 覆盖「办理人姓名」（电话卡）与「申请人姓名」（牌照申请）。
  customerName: '姓名',
  contactName: '姓名',
  // 配送上下文里另有语义更明确的字段，见 `fulfillment.contactName`。
  ownerPhone: '机主手机号',
  companionPhone: '同伴手机号',
  phone: '手机号',
  contactPhone: '手机号',
  customerPhone: '手机号',
  contact: '联系方式',

  // ---- 内容类 ----
  title: '标题',
  description: '描述',
  content: '内容',
  // `note` 覆盖财务工单确认、SLA 告警确认、退款备注、售后备注。
  platformNotice: '平台公告',

  // ---- 市集 / 论坛 ----
  category: '商品分类',
  condition: '成色',
  board: '板块',
  productId: '商品',
  'items[].productId': '商品',
  promoId: '充值活动',
  orderId: '订单',
  merchantId: '商家',
  ownerId: '负责人',

  // ---- 地址 ----
  address: '详细地址',
  'fulfillment.address': '配送地址',
  'fulfillment.contactName': '收货人姓名',
  'fulfillment.contactPhone': '收货人手机号',
  'fulfillment.timeSlot': '配送时段',

  // ---- 商家入驻 / 资质 ----
  merchantType: '入驻主体类型',
  businessType: '业务类型',
  serviceArea: '服务区域',
  licenseNo: '统一社会信用代码或执照编号',
  licenseUrl: '资质照片',
  idNumber: '身份证号',
  identityVerificationToken: '实名认证凭证',
  settlementAccount: '银行卡号 / 对公账号',
  settlementAccountName: '收款人姓名',
  settlementBank: '开户银行',
  // `reviewNote` 是驳回时填的说明（`merchant/apply.wxml` 的「驳回原因」）。
  reviewNote: '驳回原因',
  resolutionNote: '处理结论',

  // ---- 学生认证 / 校园卡 / 宽带 / 牌照 ----
  studentNo: '学号',
  schoolId: '学校',
  schoolName: '学校名称',
  campusId: '校区',
  campusName: '校区名称',
  applicantName: '申请人姓名',
  serviceType: '服务类型',
  vehicleModel: '车辆品牌与型号',
  // `interest` 是咨询线索里的「想了解什么」（`body.interest || '未指定'`）。
  interest: '咨询意向',

  // ---- 平台配置 ----
  brandName: '品牌名称',
  servicePhone: '客服电话',
  serviceWechat: '客服微信',

  // ---- 图片上传 ----
  dataBase64: '图片数据',
  mimeType: '图片类型'
};

/**
 * `requireString(image, \`images.${index}\`, ...)` 产生的动态字段名。
 *
 * 这类字段名无法写进 `FIELD_LABELS`（它是 `images.0` / `images.1` …）。
 * 若不加处理，用户会看到「images.0过长」—— 中文是中文了，但没说出是**第几张**。
 * 所以单独识别这个形状，翻译成「第 N 张图片」（下标 0 起 → 展示 1 起）。
 */
const IMAGE_FIELD_PATTERN = /^images\.(\d+)$/;

/**
 * 取字段的中文标签。
 *
 * 三种输入三种结果：
 * - 在 `FIELD_LABELS` 里 → 对应标签；
 * - 形如 `images.<n>` → 「第 n+1 张图片」；
 * - 其它 → **原样返回字段名**（回落）。
 *
 * 回落成原始字段名而不是 `undefined`：宁可让用户看到 `brandNewField过长`
 * （至少能定位到是哪个字段），也不能看到「undefined过长」。
 * 正常路径下这个回落不会发生 —— `test/field-labels.test.js` 的完整性断言
 * 保证每个调用点的字段名都在表里。
 *
 * @param {string} field 字段名。
 * @returns {string} 中文标签；未知字段回落为原始字段名。
 */
function fieldLabel(field) {
  const name = typeof field === 'string' ? field : '';
  // 用 `hasOwnProperty` 而不是 `FIELD_LABELS[name]`：后者会命中
  // `constructor` / `toString` 这类原型上的成员，把函数当标签返回。
  if (Object.prototype.hasOwnProperty.call(FIELD_LABELS, name)) return FIELD_LABELS[name];
  const image = IMAGE_FIELD_PATTERN.exec(name);
  if (image) return `第 ${Number(image[1]) + 1} 张图片`;
  return name;
}

module.exports = { FIELD_LABELS, fieldLabel, IMAGE_FIELD_PATTERN };
