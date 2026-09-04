import DypnsPackage, {
  CheckSmsVerifyCodeRequest,
  type CheckSmsVerifyCodeResponse,
  SendSmsVerifyCodeRequest,
  type SendSmsVerifyCodeResponse,
} from '@alicloud/dypnsapi20170525';
import { Config } from '@alicloud/openapi-core/dist/utils.js';

export interface SmsSettings {
  aliyunAccessKeyId: string;
  aliyunAccessKeySecret: string;
  aliyunDypnsEndpoint: string;
  smsSignName: string;
  smsTemplateCode: string;
  smsSchemeName: string;
  smsCodeTtlSeconds: number;
  smsResendSeconds: number;
  smsAllowedPhones: string;
}

export interface SmsVerificationPort {
  isReady(): boolean;
  send(input: { phone: string; outId: string }): Promise<void>;
  verify(input: { phone: string; outId: string; code: string }): Promise<boolean>;
}

export class SmsProviderError extends Error {
  constructor(
    readonly providerCode: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

type SmsClient = {
  sendSmsVerifyCode(request: SendSmsVerifyCodeRequest): Promise<SendSmsVerifyCodeResponse>;
  checkSmsVerifyCode(request: CheckSmsVerifyCodeRequest): Promise<CheckSmsVerifyCodeResponse>;
};

type SmsClientConstructor = new (config: Config) => SmsClient;

function providerErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'ALIYUN_REQUEST_FAILED';
  const candidate = error as { code?: unknown; data?: { Code?: unknown } };
  return String(candidate.code ?? candidate.data?.Code ?? 'ALIYUN_REQUEST_FAILED').slice(0, 128);
}

function retryableProviderCode(code: string): boolean {
  return [
    'FREQUENCY_FAIL',
    'BUSINESS_LIMIT_CONTROL',
    'isv.BUSINESS_LIMIT_CONTROL',
    'Throttling',
    'isp.QPS_LIMIT',
  ].includes(code);
}

export function smsConfigured(settings: SmsSettings): boolean {
  return Boolean(
    settings.aliyunAccessKeyId
      && settings.aliyunAccessKeySecret
      && settings.smsSignName
      && settings.smsTemplateCode,
  );
}

export function normalizeMainlandPhone(value: string): string | null {
  const compact = value.trim().replace(/[\s()-]/g, '');
  const national = compact.startsWith('+86') ? compact.slice(3) : compact.startsWith('86') ? compact.slice(2) : compact;
  return /^1[3-9]\d{9}$/.test(national) ? `+86${national}` : null;
}

export function maskPhone(phone: string): string {
  const national = phone.startsWith('+86') ? phone.slice(3) : phone;
  return national.length === 11 ? `${national.slice(0, 3)}****${national.slice(-4)}` : '***********';
}

export function allowedPhones(settings: Pick<SmsSettings, 'smsAllowedPhones'>): Set<string> | null {
  const values = settings.smsAllowedPhones
    .split(',')
    .map(normalizeMainlandPhone)
    .filter((phone): phone is string => Boolean(phone));
  return values.length ? new Set(values) : null;
}

export class AliyunSmsVerification implements SmsVerificationPort {
  private readonly client: SmsClient | null;

  constructor(
    private readonly settings: SmsSettings,
    client?: SmsClient,
  ) {
    if (client) {
      this.client = client;
    } else if (smsConfigured(settings)) {
      const config = new Config({
        accessKeyId: settings.aliyunAccessKeyId,
        accessKeySecret: settings.aliyunAccessKeySecret,
        endpoint: settings.aliyunDypnsEndpoint,
      });
      const imported = DypnsPackage as unknown as SmsClientConstructor | { default: SmsClientConstructor };
      const Client = typeof imported === 'function' ? imported : imported.default;
      this.client = new Client(config);
    } else {
      this.client = null;
    }
  }

  isReady(): boolean {
    return this.client !== null && smsConfigured(this.settings);
  }

  async send(input: { phone: string; outId: string }): Promise<void> {
    if (!this.client || !this.isReady()) {
      throw new SmsProviderError('SMS_NOT_CONFIGURED', '短信验证尚未配置');
    }
    const request = new SendSmsVerifyCodeRequest({
      phoneNumber: input.phone.slice(3),
      countryCode: '86',
      signName: this.settings.smsSignName,
      templateCode: this.settings.smsTemplateCode,
      schemeName: this.settings.smsSchemeName || undefined,
      templateParam: JSON.stringify({
        code: '##code##',
        min: String(Math.ceil(this.settings.smsCodeTtlSeconds / 60)),
      }),
      outId: input.outId,
      codeLength: 6,
      codeType: 1,
      validTime: this.settings.smsCodeTtlSeconds,
      interval: this.settings.smsResendSeconds,
      duplicatePolicy: 1,
      returnVerifyCode: false,
    });
    try {
      const response = await this.client.sendSmsVerifyCode(request);
      if (response.body?.code !== 'OK' || response.body.success !== true) {
        const code = response.body?.code ?? 'ALIYUN_SEND_FAILED';
        throw new SmsProviderError(code, '验证码发送失败', retryableProviderCode(code));
      }
    } catch (error) {
      if (error instanceof SmsProviderError) throw error;
      const code = providerErrorCode(error);
      throw new SmsProviderError(code, '验证码发送失败', retryableProviderCode(code));
    }
  }

  async verify(input: { phone: string; outId: string; code: string }): Promise<boolean> {
    if (!this.client || !this.isReady()) {
      throw new SmsProviderError('SMS_NOT_CONFIGURED', '短信验证尚未配置');
    }
    const request = new CheckSmsVerifyCodeRequest({
      phoneNumber: input.phone.slice(3),
      countryCode: '86',
      schemeName: this.settings.smsSchemeName || undefined,
      outId: input.outId,
      verifyCode: input.code,
      caseAuthPolicy: 2,
    });
    try {
      const response = await this.client.checkSmsVerifyCode(request);
      if (response.body?.code !== 'OK' || response.body.success !== true) {
        const code = response.body?.code ?? 'ALIYUN_VERIFY_FAILED';
        throw new SmsProviderError(code, '验证码校验失败', retryableProviderCode(code));
      }
      return response.body.model?.verifyResult === 'PASS';
    } catch (error) {
      if (error instanceof SmsProviderError) throw error;
      const code = providerErrorCode(error);
      throw new SmsProviderError(code, '验证码校验失败', retryableProviderCode(code));
    }
  }
}
