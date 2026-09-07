const crypto = require('node:crypto');
const fs = require('node:fs');

const TRADE_STATE_MAP = {
  SUCCESS: 'PAID',
  REFUND: 'PAID',
  NOTPAY: 'PENDING',
  USERPAYING: 'PENDING',
  CLOSED: 'CLOSED',
  REVOKED: 'CLOSED',
  PAYERROR: 'FAILED'
};

const REFUND_STATE_MAP = {
  SUCCESS: 'REFUNDED',
  CLOSED: 'FAILED',
  PROCESSING: 'PENDING',
  ABNORMAL: 'FAILED'
};

function callbackError(code, message) {
  return Object.assign(new Error(message), { code });
}

function splitCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value);
  return values.map((item) => item.trim());
}

function yuanToCents(value) {
  const amount = Number(String(value || '').replace(/[¥,\s]/g, ''));
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100);
}

class WeChatPayTransport {
  constructor(options) {
    this.appid = options.appid;
    this.mchid = options.mchid;
    this.serialNo = options.serialNo;
    this.apiV3Key = Buffer.from(String(options.apiV3Key || ''), 'utf8');
    this.notifyUrl = options.notifyUrl;
    this.platformCertificateSerial = options.platformCertificateSerial;
    this.baseUrl = options.baseUrl || 'https://api.mch.weixin.qq.com';
    this.fetch = options.httpClient?.fetch || globalThis.fetch;
    this.now = options.now || Date.now;
    this.privateKey = crypto.createPrivateKey(fs.readFileSync(options.privateKeyPath));
    this.platformPublicKey = crypto.createPublicKey(fs.readFileSync(options.platformPublicKeyPath));

    if (this.apiV3Key.length !== 32) {
      throw new Error('WECHAT_PAY_APIV3_KEY_INVALID: must be 32 characters');
    }
    if (!this.fetch) {
      throw new Error('WECHAT_PAYMENT_TRANSPORT_MISSING');
    }
  }

  authorizationHeader(method, pathname, body, timestamp, nonce) {
    const message = Buffer.from(`${method}\n${pathname}\n${timestamp}\n${nonce}\n${body}\n`);
    const signature = crypto.sign('sha256', message, this.privateKey).toString('base64');
    return `WECHATPAY2-SHA256-RSA2048 mchid="${this.mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${this.serialNo}"`;
  }

  async request(method, pathname, payload) {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const timestamp = String(Math.floor(this.now() / 1000));
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers = {
      Authorization: this.authorizationHeader(method, pathname, body, timestamp, nonce),
      Accept: 'application/json',
      'User-Agent': 'campus-go-server'
    };
    if (body) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers,
        body: body || undefined
      });
    } catch (error) {
      throw Object.assign(new Error(error.message), { code: 'WECHAT_PAY_NETWORK_ERROR' });
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw Object.assign(new Error('WeChat Pay returned non-JSON response'), {
          code: 'WECHAT_PAY_RESPONSE_INVALID',
          status: response.status
        });
      }
    }
    if (!response.ok) {
      throw Object.assign(new Error(data?.message || `WeChat Pay API returned ${response.status}`), {
        code: data?.code || 'WECHAT_PAY_API_ERROR',
        status: response.status
      });
    }
    return data || {};
  }

  async createIntent(payment) {
    if (!payment.openid) {
      throw Object.assign(new Error('WECHAT_PAY_OPENID_MISSING'), { code: 'WECHAT_PAY_OPENID_MISSING' });
    }
    const result = await this.request('POST', '/v3/pay/transactions/jsapi', {
      appid: this.appid,
      mchid: this.mchid,
      description: payment.description || '狮山智生活订单',
      out_trade_no: payment.paymentNo,
      notify_url: this.notifyUrl,
      amount: {
        total: Number(payment.amountInCents),
        currency: payment.currency || 'CNY'
      },
      payer: { openid: payment.openid }
    });
    if (!result.prepay_id) {
      throw Object.assign(new Error('WeChat Pay response is missing prepay_id'), {
        code: 'WECHAT_PAY_RESPONSE_INVALID'
      });
    }

    const timeStamp = String(Math.floor(this.now() / 1000));
    const nonceStr = crypto.randomBytes(16).toString('hex');
    const packageValue = `prepay_id=${result.prepay_id}`;
    const paySign = crypto
      .sign('sha256', Buffer.from(`${this.appid}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`), this.privateKey)
      .toString('base64');
    return {
      providerTradeNo: payment.paymentNo,
      payload: {
        timeStamp,
        nonceStr,
        package: packageValue,
        signType: 'RSA',
        paySign
      }
    };
  }

  async confirm(payment) {
    const pathname = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(payment.paymentNo)}?mchid=${encodeURIComponent(this.mchid)}`;
    const result = await this.request('GET', pathname);
    return {
      status: TRADE_STATE_MAP[result.trade_state] || 'UNKNOWN',
      providerTradeNo: result.transaction_id || payment.providerTradeNo || payment.paymentNo,
      paidAt: result.success_time || '',
      payload: result
    };
  }

  async close(payment) {
    const pathname = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(payment.paymentNo)}/close`;
    await this.request('POST', pathname, { mchid: this.mchid });
    return {
      status: 'CLOSED',
      providerTradeNo: payment.providerTradeNo || payment.paymentNo,
      payload: null
    };
  }

  async fetchBills(billDate) {
    const date = String(billDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw Object.assign(new Error('bill date must be YYYY-MM-DD'), { code: 'WECHAT_PAY_BILL_DATE_INVALID' });
    }
    const tradeBill = await this.downloadBill(
      `/v3/bill/tradebill?bill_date=${date}&account_type=BASIC&tar_type=ALL`,
      'trade'
    );
    const fundBill = await this.downloadBill(
      `/v3/bill/fundbill?bill_date=${date}&account_type=BASIC`,
      'fund'
    );
    return { billDate: date, tradeBill, fundBill };
  }

  async downloadBill(pathname, billType) {
    const result = await this.request('GET', pathname);
    if (!result.download_url) {
      throw Object.assign(new Error('WeChat Pay bill response is missing download_url'), {
        code: 'WECHAT_PAY_RESPONSE_INVALID'
      });
    }

    let response;
    try {
      response = await this.fetch(result.download_url, {
        headers: {
          Accept: 'text/csv',
          'User-Agent': 'campus-go-server'
        }
      });
    } catch (error) {
      throw Object.assign(new Error(error.message), { code: 'WECHAT_PAY_NETWORK_ERROR' });
    }
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`WeChat Pay bill download returned ${response.status}`), {
        code: 'WECHAT_PAY_API_ERROR',
        status: response.status
      });
    }
    return this.parseBill(text, billType);
  }

  parseBill(text, billType) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
    const headerIndex = lines.findIndex((line) => (
      billType === 'trade' ? line.includes('商户订单号') : line.includes('商户退款单号')
    ));
    if (headerIndex < 0) {
      throw Object.assign(new Error(`WeChat Pay ${billType} bill has no header row`), {
        code: 'WECHAT_PAY_RESPONSE_INVALID'
      });
    }
    const headers = splitCsvLine(lines[headerIndex]);
    const rows = lines.slice(headerIndex + 1)
      .filter((line) => !line.startsWith('总') && !line.startsWith('合计'))
      .map((line) => {
        const values = splitCsvLine(line);
        return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
      });

    if (billType === 'trade') {
      return rows.map((row) => ({
        paymentNo: row['商户订单号'] || '',
        providerTradeNo: row['微信订单号'] || '',
        status: row['交易状态'] || '',
        amountInCents: yuanToCents(row['现金支付金额(元)'] || row['应结订单金额(元)']),
        paidAt: row['交易时间'] || ''
      }));
    }

    return rows.map((row) => ({
      paymentNo: row['商户订单号'] || row['商户支付单号'] || '',
      providerTradeNo: row['微信支付单号'] || '',
      refundNo: row['商户退款单号'] || '',
      providerRefundNo: row['微信退款单号'] || '',
      status: row['商户退款单号'] ? 'REFUND' : 'PAYMENT',
      amountInCents: yuanToCents(row['支出金额(元)'] || row['收入金额(元)']),
      refundedAt: row['记账时间'] || ''
    }));
  }

  async refund(payment) {
    const result = await this.request('POST', '/v3/refund/domestic/refunds', {
      out_trade_no: payment.paymentNo,
      out_refund_no: payment.refundNo || `RF_${payment.paymentNo}`,
      amount: {
        refund: Number(payment.refundAmountInCents || payment.amountInCents),
        total: Number(payment.amountInCents),
        currency: payment.currency || 'CNY'
      }
    });
    return {
      status: REFUND_STATE_MAP[result.status] || 'UNKNOWN',
      providerTradeNo: payment.providerTradeNo || payment.paymentNo,
      payload: result
    };
  }

  async queryRefund(payment) {
    const refundNo = payment.refund?.refundNo || payment.refundNo || `RF_${payment.paymentNo}`;
    const pathname = `/v3/refund/domestic/refunds/${encodeURIComponent(refundNo)}?mchid=${encodeURIComponent(this.mchid)}`;
    const result = await this.request('GET', pathname);
    return {
      status: REFUND_STATE_MAP[result.status] || 'UNKNOWN',
      refundNo: result.out_refund_no || refundNo,
      providerTradeNo: result.out_trade_no || payment.providerTradeNo || payment.paymentNo,
      payload: result
    };
  }

  verifyCallback(request, body) {
    const timestamp = Number(request.headers['wechatpay-timestamp']);
    const nonce = String(request.headers['wechatpay-nonce'] || '');
    const signature = String(request.headers['wechatpay-signature'] || '');
    const serial = String(request.headers['wechatpay-serial'] || '');
    if (!Number.isFinite(timestamp) || Math.abs(Math.floor(this.now() / 1000) - timestamp) > 300) {
      throw callbackError('CALLBACK_TIMESTAMP_EXPIRED', 'WeChat Pay callback timestamp is outside the allowed window');
    }
    if (serial !== this.platformCertificateSerial) {
      throw callbackError('CALLBACK_SERIAL_UNTRUSTED', 'WeChat Pay callback serial is not trusted');
    }

    const rawBody = request.rawBody || JSON.stringify(body);
    const message = Buffer.from(`${timestamp}\n${nonce}\n${rawBody}\n`);
    if (!crypto.verify('sha256', message, this.platformPublicKey, Buffer.from(signature, 'base64'))) {
      throw callbackError('CALLBACK_SIGNATURE_INVALID', 'WeChat Pay callback signature is invalid');
    }

    const resource = this.decryptCallbackResource(body?.resource);
    if (body?.event_type === 'REFUND.SUCCESS') {
      return {
        type: 'REFUND',
        status: REFUND_STATE_MAP[resource.refund_status] || 'UNKNOWN',
        refundNo: resource.out_refund_no || '',
        providerTradeNo: resource.out_trade_no || '',
        payload: resource
      };
    }

    return {
      type: 'PAYMENT',
      status: TRADE_STATE_MAP[resource.trade_state] || 'UNKNOWN',
      providerTradeNo: resource.out_trade_no || '',
      paidAt: resource.success_time || '',
      payload: resource
    };
  }

  decryptCallbackResource(resource) {
    if (!resource?.ciphertext || !resource.nonce) {
      throw callbackError('CALLBACK_RESOURCE_INVALID', 'WeChat Pay callback resource is incomplete');
    }
    const ciphertext = Buffer.from(resource.ciphertext, 'base64');
    if (ciphertext.length <= 16) {
      throw callbackError('CALLBACK_RESOURCE_INVALID', 'WeChat Pay callback ciphertext is invalid');
    }
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.apiV3Key, Buffer.from(resource.nonce, 'base64'));
      decipher.setAAD(Buffer.from(String(resource.associated_data || ''), 'utf8'));
      decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
      const plaintext = Buffer.concat([
        decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
        decipher.final()
      ]).toString('utf8');
      return JSON.parse(plaintext);
    } catch {
      throw callbackError('CALLBACK_RESOURCE_INVALID', 'WeChat Pay callback resource cannot be decrypted');
    }
  }
}

module.exports = { WeChatPayTransport };
