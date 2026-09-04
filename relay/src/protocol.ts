/**
 * 中继隧道协议：中继服务器与 Mac 设备端（RelayClient）之间通过一条
 * WebSocket 连接互发 JSON 帧，转发 HTTP 请求与虚拟 WebSocket 通道。
 *
 * client/web/server/relay-client.ts 持有一份镜像定义，修改时需保持同步。
 */

/** 中继 → 设备：转发一个客户端 HTTP 请求 */
export interface HttpRequestFrame {
  t: 'http';
  id: string;
  method: string;
  /** 含查询串的路径，如 /api/state?x=1 */
  path: string;
  headers: Record<string, string>;
  bodyB64?: string;
}

/** 设备 → 中继：HTTP 请求的应答 */
export interface HttpResponseFrame {
  t: 'http-res';
  id: string;
  status: number;
  headers: Record<string, string>;
  bodyB64?: string;
}

/** 中继 → 设备：客户端新建了一条虚拟 WebSocket 通道 */
export interface WsOpenFrame {
  t: 'ws-open';
  ch: string;
  /** 含查询串的本地 WS 路径，缺失时设备端应回退到 /ws */
  path?: string;
}

/** 双向：虚拟通道上的一条文本消息 */
export interface WsMessageFrame {
  t: 'ws-msg';
  ch: string;
  data: string;
}

/** 双向：关闭虚拟通道 */
export interface WsCloseFrame {
  t: 'ws-close';
  ch: string;
}

export type RelayToDeviceFrame = HttpRequestFrame | WsOpenFrame | WsMessageFrame | WsCloseFrame;
export type DeviceToRelayFrame = HttpResponseFrame | WsMessageFrame | WsCloseFrame;
