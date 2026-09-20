/**
 * 微信开放接口调用封装。
 *
 * 自 app.js 拆出，便于独立复用与测试。
 */

const https = require('node:https');
const { ApiError } = require('../http/api-error');

function isTlsInterceptionError(error) {
  const tlsCodes = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED']);
  return tlsCodes.has(error.code) || /self-signed/i.test(error.message);
}

function wechatOpenApiRequest(pathname, rejectUnauthorized) {
  return new Promise((resolve, reject) => {
    const request = https.get(`https://api.weixin.qq.com${pathname}`, { rejectUnauthorized }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          console.error('[wechat-login] unexpected status', response.statusCode, body.slice(0, 200));
          reject(new ApiError(502, 'WECHAT_LOGIN_UNAVAILABLE', '微信登录服务不可用', { reason: `HTTP ${response.statusCode}` }));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch {
          console.error('[wechat-login] non-json body', body.slice(0, 200));
          reject(new ApiError(502, 'WECHAT_LOGIN_UNAVAILABLE', '微信登录服务返回异常', { reason: 'non-json response' }));
        }
      });
    });
    request.on('error', (error) => {
      console.error('[wechat-login] request error:', error.message);
      reject(Object.assign(new Error(error.message), { code: error.code }));
    });
    request.setTimeout(8000, () => {
      request.destroy();
      console.error('[wechat-login] request timeout after 8s');
      reject(new Error('timeout after 8s'));
    });
  });
}

function wechatOpenApiPost(pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request(`https://api.weixin.qq.com${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => {
        try {
          if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`HTTP ${response.statusCode}`);
          resolve(JSON.parse(responseBody));
        } catch (error) {
          reject(Object.assign(new Error(error.message || 'response parse failed'), { code: 'WECHAT_API_UNAVAILABLE' }));
        }
      });
    });
    request.on('error', (error) => reject(Object.assign(new Error(error.message), { code: error.code || 'WECHAT_API_UNAVAILABLE' })));
    request.setTimeout(8000, () => request.destroy(new Error('timeout after 8s')));
    request.end(body);
  });
}

module.exports = { isTlsInterceptionError, wechatOpenApiRequest, wechatOpenApiPost };
