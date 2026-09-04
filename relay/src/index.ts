import { AuthorizationCenter } from './auth-center.js';
import { buildCloudApp } from './cloud-app.js';
import { loadCloudSettings } from './cloud-config.js';
import { openCloudDatabase } from './cloud-db.js';
import { RelayServer } from './relay.js';
import { SmsAuthService } from './sms-auth.js';
import { AliyunSmsVerification, allowedPhones, type SmsSettings } from './sms.js';

const PORT = parseInt(process.env.RELAY_PORT ?? process.env.PORT ?? '8790', 10);
const HOST = process.env.RELAY_HOST ?? '0.0.0.0';

function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function parseOptionalInt(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseOptionalIntFrom(names: string[], fallback: number): number {
  for (const name of names) {
    const parsed = parseOptionalInt(name);
    if (parsed !== undefined) return parsed;
  }
  return fallback;
}

async function main(): Promise<void> {
  const settings = loadCloudSettings();
  const database = openCloudDatabase(settings.databaseUrl);
  const center = new AuthorizationCenter(database, settings);

  const smsSettings: SmsSettings = {
    aliyunAccessKeyId: env('OCTRIX_ALIYUN_ACCESS_KEY_ID', 'RELAY_ALIYUN_ACCESS_KEY_ID', 'VOICECHAT_ALIYUN_ACCESS_KEY_ID') ?? '',
    aliyunAccessKeySecret: env('OCTRIX_ALIYUN_ACCESS_KEY_SECRET', 'RELAY_ALIYUN_ACCESS_KEY_SECRET', 'VOICECHAT_ALIYUN_ACCESS_KEY_SECRET') ?? '',
    aliyunDypnsEndpoint: env('OCTRIX_ALIYUN_DYPNS_ENDPOINT', 'RELAY_ALIYUN_DYPNS_ENDPOINT', 'VOICECHAT_ALIYUN_DYPNS_ENDPOINT') ?? 'dypnsapi.aliyuncs.com',
    smsSignName: process.env.OCTRIX_SMS_SIGN_NAME ?? '',
    smsTemplateCode: process.env.OCTRIX_SMS_TEMPLATE_CODE ?? '',
    smsSchemeName: process.env.OCTRIX_SMS_SCHEME_NAME ?? '',
    smsAllowedPhones: settings.smsAllowedPhones,
    smsCodeTtlSeconds: settings.smsCodeTtlSeconds,
    smsResendSeconds: settings.smsResendSeconds,
  };
  const sms = new AliyunSmsVerification(smsSettings);

  const legacyToken = settings.legacyAuthEnabled ? env('RELAY_TOKEN') : undefined;
  const legacySms = new AliyunSmsVerification({
    ...smsSettings,
    smsSignName: env('RELAY_SMS_SIGN_NAME', 'VOICECHAT_SMS_SIGN_NAME') ?? '',
    smsTemplateCode: env('RELAY_SMS_TEMPLATE_CODE', 'VOICECHAT_SMS_TEMPLATE_CODE') ?? '',
    smsSchemeName: env('RELAY_SMS_SCHEME_NAME', 'VOICECHAT_SMS_SCHEME_NAME') ?? '',
  });
  const legacySmsAuth = legacyToken ? new SmsAuthService({
    relayToken: legacyToken,
    clientTokenSecret: env('RELAY_SMS_CLIENT_TOKEN_SECRET'),
    publicUrl: settings.publicUrl,
    sms: legacySms,
    allowedPhones: allowedPhones(smsSettings),
    accessTokenTtlSeconds: parseOptionalIntFrom(['RELAY_SMS_ACCESS_TOKEN_TTL_SECONDS'], 60 * 60 * 24 * 7),
    codeTtlSeconds: settings.smsCodeTtlSeconds,
    resendSeconds: settings.smsResendSeconds,
    phoneHourlyLimit: settings.smsPhoneHourlyLimit,
    phoneDailyLimit: settings.smsPhoneDailyLimit,
    ipHourlyLimit: settings.smsIpHourlyLimit,
    maxVerifyAttempts: settings.smsMaxVerifyAttempts,
  }) : undefined;

  let relay: RelayServer | undefined;
  const cloud = await buildCloudApp({
    center,
    settings,
    sms,
    onlineDeviceIds: userId => new Set(relay?.listDevicesForOwner(userId).filter(device => device.connected).map(device => device.deviceId) ?? []),
  });

  relay = new RelayServer({
    token: legacyToken,
    authorization: center,
    cloudRequestHandler: (request, response) => cloud.routing(request, response),
    allowLegacyTokenTransports: settings.legacyAuthEnabled,
    legacyAuthUntilMs: settings.legacyAuthEnabled ? Date.parse(settings.legacyAuthUntil) : 0,
    smsAuth: legacySmsAuth,
    requestTimeoutMs: parseOptionalInt('RELAY_REQUEST_TIMEOUT_MS'),
    heartbeatIntervalMs: parseOptionalInt('RELAY_HEARTBEAT_INTERVAL_MS'),
    maxBodyBytes: parseOptionalInt('RELAY_MAX_BODY_BYTES'),
    maxPendingRequestsPerDevice: parseOptionalInt('RELAY_MAX_PENDING_REQUESTS_PER_DEVICE'),
    maxBufferedBytes: parseOptionalInt('RELAY_MAX_BUFFERED_BYTES'),
    maxClientChannelsPerDevice: parseOptionalInt('RELAY_MAX_CLIENT_CHANNELS_PER_DEVICE'),
  });

  const port = await relay.listen(PORT, HOST);
  console.log(`[octrix-cloud] 服务运行在 http://${HOST}:${port}`);
  console.log(`[octrix-cloud] 授权中心：${settings.publicUrl}；旧授权兼容：${settings.legacyAuthEnabled ? `开启至 ${settings.legacyAuthUntil}` : '关闭'}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([relay?.close(), cloud.close()]);
    center.close();
  };
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(0)));
}

main().catch(error => {
  console.error('[octrix-cloud] 启动失败:', error);
  process.exit(1);
});
