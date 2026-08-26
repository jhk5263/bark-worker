// ========================================================
// 腾讯云 EdgeOne 版 Bark 服务器 (KV 存储)
//   - 直接连接 Apple APNs，不再转发 api.day.app
//   - 支持设备注册 / 直连推送
//   - 去掉重复推送问题
//   - 可选：同时推送到安卓 (ntfy)
// ========================================================

// ========== 配置（只改这个文件，不用碰 EdgeOne 控制台）==========

// 你的 Bark 客户端 Device Key（注册时用）
const MY_DEVICE_KEY = "gjmym5KKDRHZtxbsd5k3eB";

// 是否允许新设备注册（首次部署 true，注册完改成 false 更安全）
const ALLOW_NEW_DEVICE = true;

// ===== 安卓推送（ntfy）=====
// 就是你 Worker 里顺手 POST 一条消息，安卓手机装 ntfy App 订阅同一个主题即可。
// 你不需要部署任何服务器，ntfy.sh 是官方免费公共服务器。
// NTFY_SERVER 可以一直用 https://ntfy.sh；如果哪天想自建，改成你自己的地址。
// NTFY_TOPIC  随便起一个，别人猜不到就行（建议 8 位以上随机字符）。
const NTFY_SERVER = "http://47.97.106.187:38088";
const NTFY_TOPIC  = "gjmym5KKDRHZtxbsd5k3eB";   // 留空 = 不推安卓；填写后 = 每次推送 ios+安卓一起发

// KV 命名空间绑定。在 EdgeOne 控制台绑定一个 KV 存储，变量名"database"
// 注意：EdgeOne 的 KV 绑定方式与 Cloudflare 不同，请参考你的 EdgeOne 文档
// 如果无法绑定 KV，可以用下面的内存 Map 替代（重启后丢失，仅供测试）
const USE_MEMORY_DB = false;  // true = 用内存，false = 用 EdgeOne KV

// ========== APNs 凭证（来自 Bark 项目公开的凭证）==========
// 如果你有自己 Apple 开发者账号的 APNs Key，可以替换为自己的
const APNS_TEAM_ID    = '5U8LBRXG3A';
const APNS_KEY_ID     = 'LH4T9V5U4R';
const APNS_TOPIC      = 'me.fin.bark';
const APNS_HOST_NAME  = 'api.push.apple.com';

const APNS_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg4vtC3g5L5HgKGJ2+
T1eA0tOivREvEAY2g+juRXJkYL2gCgYIKoZIzj0DAQehRANCAASmOs3JkSyoGEWZ
sUGxFs/4pw1rIlSV2IC19M8u3G5kq36upOwyFWj9Gi3Ejc9d3sC7+SHRqXrEAJow
8/7tRpV+
-----END PRIVATE KEY-----`;

// ========== 短时间去重缓存 ==========
const DEDUP_WINDOW_MS = 2000;
const _recent = new Map();

function isDuplicate(sig) {
    const now = Date.now();
    for (const [k, t] of _recent) {
        if (now - t > DEDUP_WINDOW_MS) _recent.delete(k);
    }
    if (_recent.has(sig)) return true;
    _recent.set(sig, now);
    return false;
}

// ========== 数据库层 (KV 或内存) ==========
class Database {
    constructor(ctx) {
        this.ctx = ctx;
        this.kv = ctx && ctx.env && ctx.env.database ? ctx.env.database : null;
        this.mem = new Map();
    }

    sanitize(key) {
        return (key || '').replace(/[^a-zA-Z0-9]/g, '');
    }

    async get(key) {
        const k = this.sanitize(key);
        if (!k) return null;
        if (this.kv) return this.kv.get(k, 'text');
        return this.mem.get(k) || null;
    }

    async put(key, value) {
        const k = this.sanitize(key);
        if (!k) return;
        if (this.kv) await this.kv.put(k, value);
        else this.mem.set(k, value);
    }

    async delete(key) {
        const k = this.sanitize(key);
        if (!k) return;
        if (this.kv) await this.kv.delete(k);
        else this.mem.delete(k);
    }

    async deviceTokenByKey(deviceKey) {
        return this.get(`token:${deviceKey}`);
    }

    async saveDeviceTokenByKey(deviceKey, token) {
        if (token) await this.put(`token:${deviceKey}`, token);
        else await this.delete(`token:${deviceKey}`);
    }

    async getAuthToken() {
        return this.get('apns:auth_token');
    }

    async saveAuthToken(token) {
        await this.put('apns:auth_token', token);
    }
}

// ========== APNs 直连推送 ==========
class APNs {
    constructor(db) {
        this.db = db;
        this.teamId = APNS_TEAM_ID;
        this.keyId = APNS_KEY_ID;
        this.topic = APNS_TOPIC;
        this.host = APNS_HOST_NAME;
    }

    async getAuthToken() {
        // 先从缓存拿
        const cached = await this.db.getAuthToken();
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (parsed.expiresAt && parsed.expiresAt > Date.now()) {
                    return parsed.token;
                }
            } catch (e) { /* 失效就重新生成 */ }
        }

        // 生成新的 JWT
        const token = await this.generateAuthToken();
        // 缓存到 KV（APNs token 有效期 1 小时，我们缓存 55 分钟）
        const expiresAt = Date.now() + 55 * 60 * 1000;
        await this.db.saveAuthToken(JSON.stringify({ token, expiresAt }));
        return token;
    }

    async generateAuthToken() {
        // 解析 PEM 私钥
        const pemHeader = "-----BEGIN PRIVATE KEY-----";
        const pemFooter = "-----END PRIVATE KEY-----";
        let pemContents = APNS_PRIVATE_KEY;
        pemContents = pemContents.replace(pemHeader, '').replace(pemFooter, '');
        pemContents = pemContents.replace(/\s/g, '');

        const rawKey = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

        // 导入私钥（PKCS#8 格式）
        const privateKey = await crypto.subtle.importKey(
            'pkcs8',
            rawKey,
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['sign']
        );

        const now = Math.floor(Date.now() / 1000);
        const header = {
            alg: 'ES256',
            typ: 'JWT',
            kid: this.keyId
        };
        const payload = {
            iss: this.teamId,
            iat: now
        };

        const encode = (obj) => {
            const json = JSON.stringify(obj);
            const bytes = new TextEncoder().encode(json);
            const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
            return base64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
        };

        const headerEncoded = encode(header);
        const payloadEncoded = encode(payload);
        const signingInput = `${headerEncoded}.${payloadEncoded}`;

        const signature = await crypto.subtle.sign(
            { name: 'ECDSA', hash: { name: 'SHA-256' } },
            privateKey,
            new TextEncoder().encode(signingInput)
        );

        let sigBase64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
        sigBase64 = sigBase64.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

        return `${signingInput}.${sigBase64}`;
    }

    async push(deviceToken, headers, aps) {
        const authToken = await this.getAuthToken();
        const url = `https://${this.host}/3/device/${deviceToken}`;

        const apnsHeaders = {
            'authorization': `Bearer ${authToken}`,
            'apns-topic': this.topic,
            'apns-push-type': 'alert',
            'content-type': 'application/json',
        };

        // 添加可选 APNs 头
        if (headers['collapse-id']) apnsHeaders['apns-collapse-id'] = headers['collapse-id'];
        if (headers['priority'])     apnsHeaders['apns-priority'] = headers['priority'];
        if (headers['expiration'])   apnsHeaders['apns-expiration'] = headers['expiration'];

        const body = JSON.stringify(aps);

        const response = await fetch(url, {
            method: 'POST',
            headers: apnsHeaders,
            body: body
        });

        return response;
    }
}

// ========== 主入口 ==========
export async function onRequest(context) {
    const request = context.request;
    const url = new URL(request.url);
    const path = url.pathname;

    // 数据库
    const db = new Database(context);
    // 如果 KV 不可用且 USE_MEMORY_DB=false，回退到内存模式并提示
    if (!db.kv && !USE_MEMORY_DB) {
        console.log('[BARK] KV not bound, falling back to in-memory (data lost on restart)');
    }

    // 主页 / 图标
    if (path === '/' || path === '/favicon.ico') {
        return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    // 健康检查
    if (path === '/ping' || path === '/healthz') {
        return new Response(JSON.stringify({
            code: 200,
            message: path === '/ping' ? 'pong' : 'ok',
            timestamp: Math.floor(Date.now() / 1000)
        }), { headers: { 'content-type': 'application/json' } });
    }

    // 调试：查看运行时环境 + KV 自检（排查绑定问题用，排查完可删）
    if (path === '/debug') {
        const envKeys = context.env ? Object.keys(context.env) : [];
        const hasDB = !!(context.env && context.env.database);
        let selfTest = null;
        if (hasDB) {
            try {
                const testKey = 'selftest:' + Date.now();
                await context.env.database.put(testKey, 'hello');
                const readBack = await context.env.database.get(testKey);
                await context.env.database.delete(testKey);
                selfTest = { wrote: true, readBack: readBack === null ? '(null)' : readBack };
            } catch (e) {
                selfTest = { wrote: false, error: String(e && e.message || e) };
            }
        }
        return new Response(JSON.stringify({
            envKeys,
            hasDB,
            selfTest,
            dbMode: hasDB ? 'kv' : 'memory'
        }, null, 2), { headers: { 'content-type': 'application/json' } });
    }

    // 设备注册
    if (path === '/register') {
        const deviceToken = url.searchParams.get('devicetoken') || url.searchParams.get('device_token');
        let deviceKey = url.searchParams.get('key');

        if (!deviceToken) {
            return new Response(JSON.stringify({
                code: 400,
                message: '缺少 devicetoken 参数'
            }), { status: 400, headers: { 'content-type': 'application/json' } });
        }

        // 是否允许新设备注册：请求参数 > 代码顶部常量
        const allowNew = url.searchParams.get('allow_new') || String(ALLOW_NEW_DEVICE);
        const allowNewDevice = allowNew === 'true' || allowNew === '1';

        // 如果未提供 key 且允许新设备注册，则自动生成
        if (!deviceKey) {
            if (!allowNewDevice) {
                return new Response(JSON.stringify({
                    code: 400,
                    message: '未提供 key 且不允许新设备注册'
                }), { status: 400, headers: { 'content-type': 'application/json' } });
            }
            // 生成短 key
            const randomBytes = crypto.getRandomValues(new Uint8Array(8));
            const hash = await crypto.subtle.digest('SHA-256', randomBytes);
            const hashArray = Array.from(new Uint8Array(hash));
            deviceKey = btoa(String.fromCharCode(...hashArray)).replace(/[^a-zA-Z0-9]/g, '').substring(0, 22);
        }

        // 保存 device_key → device_token 映射
        await db.saveDeviceTokenByKey(deviceKey, deviceToken);

        return new Response(JSON.stringify({
            code: 200,
            message: 'success',
            timestamp: Math.floor(Date.now() / 1000),
            data: {
                key: deviceKey,
                device_key: deviceKey,
                device_token: deviceToken
            }
        }), { headers: { 'content-type': 'application/json' } });
    }

    // 设备信息查询
    if (path === '/info') {
        const token = await db.deviceTokenByKey(MY_DEVICE_KEY);
        return new Response(JSON.stringify({
            code: 200,
            message: 'ok',
            data: {
                device_key: MY_DEVICE_KEY,
                device_token: token || '未注册',
                push_server: 'EdgeOne 直连 APNs'
            }
        }), { headers: { 'content-type': 'application/json' } });
    }

    // ========================================
    // 推送处理
    // ========================================
    const pathParts = path.split('/').filter(p => p);
    const pathKey = pathParts[0];

    let title = "Bark通知";
    let body = "";
    let extra = {};   // title/body 之外的附加参数（group, url, icon, sound, badge 等）
    let deviceKey = '';

    // 解析请求参数
    if (request.method === 'POST') {
        const contentType = request.headers.get('content-type') || '';
        let requestBody = {};
        if (contentType.includes('application/json')) {
            requestBody = await request.json();
        } else if (contentType.includes('application/x-www-form-urlencoded')) {
            const formData = await request.formData();
            formData.forEach((value, key) => { requestBody[key] = value; });
        }

        title = requestBody.title || "Bark通知";
        body = requestBody.body || "";
        deviceKey = requestBody.device_key || requestBody.deviceKey || pathKey || '';
        for (const [k, v] of Object.entries(requestBody)) {
            if (k !== 'title' && k !== 'body' && k !== 'device_key' && k !== 'deviceKey') {
                extra[k] = v;
            }
        }
    } else {
        // GET 请求
        title = url.searchParams.get('title') || "Bark通知";
        body = url.searchParams.get('body') || '';
        deviceKey = url.searchParams.get('device_key') || url.searchParams.get('deviceKey') || pathKey || '';

        // 路径参数（向后兼容 /key/title/body 格式）
        if (!body && pathParts.length >= 2) {
            if (pathParts.length === 2) body = decodeURIComponent(pathParts[1]);
            else if (pathParts.length >= 3) {
                title = decodeURIComponent(pathParts[1]);
                body = decodeURIComponent(pathParts[2]);
            }
        }

        url.searchParams.forEach((v, k) => {
            if (k !== 'title' && k !== 'body' && k !== 'device_key' && k !== 'deviceKey') {
                extra[k] = v;
            }
        });
    }

    // 如果 deviceKey 为空，尝试用推送路径的第一个参数
    if (!deviceKey && pathParts.length > 0) {
        deviceKey = pathParts[0];
    }

    if (!deviceKey) {
        return new Response(JSON.stringify({
            code: 400,
            message: '缺少 device_key'
        }), { status: 400, headers: { 'content-type': 'application/json' } });
    }

    // 可选：去重（完全相同的请求在窗口期内只放行一次）
    const sig = `${deviceKey}|${title}|${body}|${JSON.stringify(extra)}`;
    if (isDuplicate(sig)) {
        console.log(`[BARK] duplicate ignored: ${sig}`);
        return new Response(JSON.stringify({
            code: 200,
            message: "duplicate ignored"
        }), { headers: { 'content-type': 'application/json' } });
    }

    // 查找设备 token
    let deviceToken = await db.deviceTokenByKey(deviceKey);
    if (!deviceToken) {
        // 如果 deviceKey 是已知的 MY_DEVICE_KEY，但仍然没有 token，提示注册
        return new Response(JSON.stringify({
            code: 400,
            message: 'device token not found，请先在 iPhone 上打开 Bark App 注册一次'
        }), { status: 400, headers: { 'content-type': 'application/json' } });
    }

    // 构建 APNs payload
    const aps = {
        aps: {
            alert: {
                title: title,
                body: body
            },
            sound: extra.sound || 'default',
            badge: extra.badge ? parseInt(extra.badge) || 1 : 1,
            'mutable-content': 1,
            'thread-id': extra.group || 'default'
        }
    };

    // Bark 扩展参数（Bark App 会识别这些字段）
    if (extra.group)  aps.aps['thread-id'] = extra.group;
    if (extra.url)    aps.url = extra.url;
    if (extra.copy)   aps.copy = extra.copy;
    if (extra.image)  aps['apns-image'] = extra.image;
    if (extra.icon)   aps.icon = extra.icon;
    if (extra.call)   aps.call = extra.call;
    if (extra.ttl) {
        // ttl = 过期时间（秒），转为 APNs expiration
        aps.aps['apns-expiration'] = Math.floor(Date.now() / 1000) + parseInt(extra.ttl);
    }

    // 构建 APNs 头
    const apnsHeaders = {};
    if (extra.group) apnsHeaders['collapse-id'] = extra.group;
    if (extra.volume && extra.volume === 'critical') {
        aps.aps.sound = { critical: 1, name: 'default', volume: parseFloat(extra.volume_level) || 1.0 };
    }

    // 发送到 Apple APNs
    const apns = new APNs(db);
    let response;
    try {
        response = await apns.push(deviceToken, apnsHeaders, aps);
        const responseText = await response.text();

        // 处理 APNs 错误
        if (response.status === 410) {
            // device token 已失效，删除
            await db.saveDeviceTokenByKey(deviceKey, '');
            console.log(`[BARK] device token expired for key ${deviceKey}, removed`);
        } else if (response.status === 400 && responseText.includes('BadDeviceToken')) {
            await db.saveDeviceTokenByKey(deviceKey, '');
            console.log(`[BARK] bad device token for key ${deviceKey}, removed`);
        }

        // 可选：同时推送到安卓 (ntfy)
        // 直接在文件顶部 NTFY_SERVER / NTFY_TOPIC 配置，
        // 填了 NTFY_TOPIC 后，每次推送 iOS(Bark) + 安卓(ntfy) 一起发。
        if (NTFY_SERVER && NTFY_TOPIC) {
            try {
                const ntfyRes = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
                    method: 'POST',
                    body: JSON.stringify({ topic: NTFY_TOPIC, title, message: body }),
                    headers: { 'Content-Type': 'application/json' }
                });
                console.log(`[BARK] ntfy status: ${ntfyRes.status}`);
            } catch (ntfyErr) {
                console.log(`[BARK] ntfy failed: ${ntfyErr.message}`);
            }
        }

        return new Response(responseText, {
            status: response.status,
            headers: { 'content-type': 'application/json' }
        });

    } catch (error) {
        return new Response(JSON.stringify({
            code: 500,
            message: `APNs 推送失败: ${error.message}`
        }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
}
