/**
 * HTTP 层通用错误类型。
 *
 * 承载 HTTP 状态码、业务错误码与附加详情，供路由层与各业务模块统一抛出。
 * 自 app.js 拆出，便于独立复用与测试。
 */

class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

module.exports = { ApiError };
