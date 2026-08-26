// ========================================================
// EdgeOne Pages 版 Bark 服务器（直连 APNs + KV，官方函数签名）
//   - 官方签名: onRequest({ request, env })
//   - 多设备: 一把 key 可注册多台 iPhone，推一次全收
//   - 双端: iOS(Bark/APNs) + 安卓(ntfy)
// ========================================================

// ========== 配置（只改这个文件，不用碰控制台）==========
const MY_DEVICE_KEY = "gjmym5KKDRHZtxbsd5k3eB";
const ALLOW_NEW_DEVICE = true;   // 允许新设备注册；稳定后改 false

// 安卓推送（ntfy）：填了 NTFY_TOPIC 后，每次推送 iOS+安卓 一起发
const NTFY_SERVER = "http://47.97.106.187:38088";          // 自建 ntfy 地址，如 "http://1.2.3.4:8099"
const NTFY_TOPIC  = "gjmym5KKDRHZtxbsd5k3eB";          // 安卓 ntfy App 订阅的主题

// ========== APNs 凭证（Bark 项目公开的凭证）==========
const APNS_TEAM_ID   = '5U8LBRXG3A';
const APNS_KEY_ID    = 'LH4T9V5U4R';
const APNS_TOPIC     = 'me.fin.bark';
const APNS_HOST_NAME = 'api.push.apple.com';

const APNS_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg4vtC3g5L5HgKGJ2+
T1eA0tOivREvEAY2g+juRXJkYL2gCgYIKoZIzj0DAQehRANCAASmOs3JkSyoGEWZ
sUGxFs/4pw1rIlSV2IC19M8u3G5kq36upOwyFWj9Gi3Ejc9d3sC7+SHRqXrEAJow
8/7tRpV+
-----END PRIVATE KEY-----`;

// ========== 短时间去重 ==========
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

function stageError(stage, error) {
    const message = String(error && error.message || error);
    if (message.startsWith('apns.')) return error;
    return new Error(`${stage}: ${message}`);
}

function buildNtfyRequest(server, topic, title, message) {
    return {
        url: `${server.replace(/\/+$/, '')}/`,
        options: {
            method: 'POST',
            body: JSON.stringify({ topic, title, message }),
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        }
    };
}

// ========== KV 解析（按腾讯云 EdgeOne 官方文档）==========
// 官方文档：https://cloud.tencent.com/document/product/1552/127420
// 官方示例中，绑定名（如 my_kv / database）直接作为函数作用域内的
// 全局标识符访问：my_kv.get(...) / my_kv.put(...)，不是 env.my_kv。
// 为兼容两种注入方式，这里统一解析：
function resolveDatabase(env) {
    // 方式一：绑定名作为全局标识符（EdgeOne 官方方式）
    if (typeof database !== 'undefined') {
        return database;
    }
    // 方式二：通过 env.database 注入
    if (env && env.database) {
        return env.database;
    }
    return null;
}

// ========== KV 数据库 ==========
class Database {
    constructor(env) {
        this.kv = resolveDatabase(env);

        if (!this.kv) {
            throw new Error(
                'EdgeOne KV database 未注入，请确认绑定变量名为 database 并重新部署'
            );
        }
    }

    sanitize(key) {
        return (key || '').replace(/[^a-zA-Z0-9]/g, '');
    }

    async get(key) {
        return this.kv.get(key);
    }

    async put(key, value) {
        await this.kv.put(key, value);
    }

    async delete(key) {
        await this.kv.delete(key);
    }

    // 一把 key 对应多台设备的 token 列表（JSON 数组）
    async tokensByKey(deviceKey) {
        const k = 'token:' + this.sanitize(deviceKey);
        const raw = await this.get(k);
        if (!raw) return [];
        try {
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch {
            return [];
        }
    }

    async addToken(deviceKey, token) {
        const k = 'token:' + this.sanitize(deviceKey);
        const list = await this.tokensByKey(deviceKey);
        if (!list.includes(token)) {
            list.push(token);
            await this.put(k, JSON.stringify(list));
        }
    }

    async removeToken(deviceKey, token) {
        const k = 'token:' + this.sanitize(deviceKey);
        const list = (await this.tokensByKey(deviceKey)).filter(t => t !== token);
        await this.put(k, JSON.stringify(list));
    }

    // APNs JWT 缓存
    async getAuth() {
        return this.get('apns:auth');
    }

    async saveAuth(value) {
        await this.put('apns:auth', value);
    }
}

// ========== APNs 直连推送 ==========
class APNs {
    constructor(db) {
        this.db = db;
    }

    async getAuthToken() {
        let cached;
        try {
            cached = await this.db.getAuth();
        } catch (e) {
            throw stageError('apns.auth_cache_read', e);
        }
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (parsed.expiresAt && parsed.expiresAt > Date.now()) return parsed.token;
            } catch (e) { /* 失效重新生成 */ }
        }
        const token = await this.generateAuthToken();
        try {
            await this.db.saveAuth(JSON.stringify({ token, expiresAt: Date.now() + 55 * 60 * 1000 }));
        } catch (e) {
            throw stageError('apns.auth_cache_write', e);
        }
        return token;
    }

    async generateAuthToken() {
        let pem = APNS_PRIVATE_KEY
            .replace('-----BEGIN PRIVATE KEY-----', '')
            .replace('-----END PRIVATE KEY-----', '')
            .replace(/\s/g, '');
        let rawKey;
        let privateKey;
        try {
            rawKey = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
        } catch (e) {
            throw stageError('apns.pem_decode', e);
        }
        try {
            privateKey = await crypto.subtle.importKey(
                'pkcs8', rawKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
            );
        } catch (e) {
            throw stageError('apns.jwt_import_key', e);
        }
        const now = Math.floor(Date.now() / 1000);
        const encode = (obj) => {
            return btoa(String.fromCharCode(...new Uint8Array(new TextEncoder().encode(JSON.stringify(obj)))))
                .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
        };
        const headerEncoded = encode({ alg: 'ES256', typ: 'JWT', kid: APNS_KEY_ID });
        const payloadEncoded = encode({ iss: APNS_TEAM_ID, iat: now });
        const signingInput = `${headerEncoded}.${payloadEncoded}`;
        let signature;
        try {
            signature = await crypto.subtle.sign(
                { name: 'ECDSA', hash: 'SHA-256' },
                privateKey,
                new TextEncoder().encode(signingInput)
            );
        } catch (e) {
            throw stageError('apns.jwt_sign', e);
        }
        let sig = btoa(String.fromCharCode(...new Uint8Array(signature)))
            .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
        return `${signingInput}.${sig}`;
    }

    async push(deviceToken, headers, aps) {
        const authToken = await this.getAuthToken();
        const apnsHeaders = {
            'authorization': `Bearer ${authToken}`,
            'apns-topic': APNS_TOPIC,
            'apns-push-type': 'alert',
            'content-type': 'application/json'
        };
        if (headers['collapse-id']) apnsHeaders['apns-collapse-id'] = headers['collapse-id'];
        if (headers['priority'])     apnsHeaders['apns-priority'] = headers['priority'];
        if (headers['expiration'])   apnsHeaders['apns-expiration'] = headers['expiration'];

        try {
            return await fetch(`https://${APNS_HOST_NAME}/3/device/${deviceToken}`, {
                method: 'POST',
                headers: apnsHeaders,
                body: JSON.stringify(aps)
            });
        } catch (e) {
            throw stageError('apns.fetch', e);
        }
    }
}

// ========== 主入口（EdgeOne 官方函数签名）==========
export async function onRequest({ request, env }) {
    const url = new URL(request.url);
    const path = url.pathname;

    let db = null;
    let dbError = null;
    try {
        db = new Database(env);
    } catch (e) {
        dbError = e.message;
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

    // 调试：真实 put/get/delete 自检（兼容两种 KV 注入方式）
    if (path === '/debug') {
        const kv = resolveDatabase(env);
        const result = {
            hasEnv: !!env,
            hasEnvDatabase: !!(env && env.database),
            hasGlobalDatabase: typeof database !== 'undefined',
            hasDatabase: !!kv,
            write: false,
            read: null,
            error: dbError ? String(dbError) : null
        };
        if (kv) {
            try {
                const testKey = `selftest:${Date.now()}`;
                await kv.put(testKey, 'hello');
                result.write = true;
                result.read = await kv.get(testKey);
                await kv.delete(testKey);
            } catch (e) {
                result.error = String(e && e.message || e);
            }
        }
        return new Response(JSON.stringify(result, null, 2), {
            headers: { 'content-type': 'application/json' }
        });
    }

    // 设备注册（一把 key 可注册多台设备，token 追加保存）
    if (path === '/register') {
        if (!db) return _err(dbError);
        const deviceToken = url.searchParams.get('devicetoken') || url.searchParams.get('device_token');
        let deviceKey = url.searchParams.get('key');
        if (!deviceToken) return _err('缺少 devicetoken 参数', 400);
        if (!deviceKey) {
            if (!ALLOW_NEW_DEVICE) return _err('未提供 key 且不允许新设备注册', 400);
            const rb = crypto.getRandomValues(new Uint8Array(8));
            const hash = await crypto.subtle.digest('SHA-256', rb);
            deviceKey = btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/[^a-zA-Z0-9]/g, '').substring(0, 22);
        }
        await db.addToken(deviceKey, deviceToken);
        return new Response(JSON.stringify({
            code: 200,
            message: 'success',
            timestamp: Math.floor(Date.now() / 1000),
            data: { key: deviceKey, device_key: deviceKey, device_token: deviceToken }
        }), { headers: { 'content-type': 'application/json' } });
    }

    // 设备信息
    if (path === '/info') {
        if (!db) return _err(dbError);
        const queryKey = url.searchParams.get('key') || MY_DEVICE_KEY;
        const tokens = await db.tokensByKey(queryKey);
        return new Response(JSON.stringify({
            code: 200,
            message: 'ok',
            data: { device_key: queryKey, device_tokens: tokens, count: tokens.length }
        }), { headers: { 'content-type': 'application/json' } });
    }

    // ===== 推送 =====
    if (!db) return _err(dbError);

    const pathParts = path.split('/').filter(p => p);
    const pathKey = pathParts[0];

    let title = 'Bark通知';
    let body = '';
    let keys = [];       // 目标 key 列表
    let extra = {};

    // 解析参数（GET / POST 都支持）
    if (request.method === 'POST') {
        const contentType = request.headers.get('content-type') || '';
        let rb = {};
        if (contentType.includes('application/json')) {
            rb = await request.json();
        } else if (contentType.includes('application/x-www-form-urlencoded')) {
            const fd = await request.formData();
            fd.forEach((v, k) => { rb[k] = v; });
        }
        title = rb.title || 'Bark通知';
        body = rb.body || '';
        if (rb.device_keys) {
            keys = Array.isArray(rb.device_keys) ? rb.device_keys : String(rb.device_keys).split(',').map(s => s.trim()).filter(Boolean);
        } else if (rb.device_key || rb.deviceKey) {
            keys = [rb.device_key || rb.deviceKey];
        } else if (pathKey) {
            keys = [pathKey];
        }
        for (const [k, v] of Object.entries(rb)) {
            if (!['title', 'body', 'device_key', 'deviceKey', 'device_keys'].includes(k)) extra[k] = v;
        }
    } else {
        title = url.searchParams.get('title') || 'Bark通知';
        body = url.searchParams.get('body') || '';
        const dk = url.searchParams.get('device_keys');
        const d = url.searchParams.get('device_key') || url.searchParams.get('deviceKey');
        if (dk) keys = dk.split(',').map(s => s.trim()).filter(Boolean);
        else if (d) keys = [d];
        // 路径参数回退 /key/title/body
        if (!body && pathParts.length >= 2) {
            if (pathParts.length === 2) body = decodeURIComponent(pathParts[1]);
            else if (pathParts.length >= 3) {
                title = decodeURIComponent(pathParts[1]);
                body = decodeURIComponent(pathParts[2]);
            }
        }
        if (!keys.length && pathKey) keys = [pathKey];
        url.searchParams.forEach((v, k) => {
            if (!['title', 'body', 'device_key', 'deviceKey', 'device_keys'].includes(k)) extra[k] = v;
        });
    }

    keys = [...new Set(keys.map(k => String(k)))];
    if (!keys.length) return _err('缺少 device_key', 400);

    // 2 秒去重
    const sig = `${keys.join('|')}|${title}|${body}|${JSON.stringify(extra)}`;
    if (isDuplicate(sig)) {
        return new Response(JSON.stringify({ code: 200, message: 'duplicate ignored' }), {
            headers: { 'content-type': 'application/json' }
        });
    }

    // 构建 APNs payload（Bark 扩展参数）
    const aps = {
        aps: {
            alert: { title, body },
            sound: extra.sound || 'default',
            badge: extra.badge ? parseInt(extra.badge) || 1 : 1,
            'mutable-content': 1,
            'thread-id': extra.group || 'default'
        }
    };
    if (extra.group) aps.aps['thread-id'] = extra.group;
    if (extra.url)   aps.url = extra.url;
    if (extra.copy)  aps.copy = extra.copy;
    if (extra.image) aps['apns-image'] = extra.image;
    if (extra.icon)  aps.icon = extra.icon;
    if (extra.call)  aps.call = extra.call;
    if (extra.ttl)   aps.aps['apns-expiration'] = Math.floor(Date.now() / 1000) + parseInt(extra.ttl);
    if (extra.volume === 'critical') {
        aps.aps.sound = { critical: 1, name: 'default', volume: parseFloat(extra.volume_level) || 1.0 };
    }

    const apnsHeaders = {};
    if (extra.group) apnsHeaders['collapse-id'] = extra.group;

    const apns = new APNs(db);
    const results = [];

    // 逐个 key → 逐个 token 投递
    for (const key of keys) {
        const tokens = await db.tokensByKey(key);
        if (!tokens.length) {
            results.push({ key, status: 400, message: 'device token not found，请先在 iPhone 上打开 Bark App 注册一次' });
            continue;
        }
        for (const token of tokens) {
            try {
                const resp = await apns.push(token, apnsHeaders, aps);
                const text = await resp.text();
                results.push({ key, status: resp.status, body: text });
                if (resp.status === 410 || (resp.status === 400 && text.includes('BadDeviceToken'))) {
                    await db.removeToken(key, token);
                    results.push({ key, note: 'token 已失效，已移除' });
                }
            } catch (e) {
                results.push({ key, status: 500, error: String(e && e.message || e) });
            }
        }
    }

    // 安卓推送（ntfy）：每次 iOS 推送后同步发出
    if (NTFY_SERVER && NTFY_TOPIC) {
        try {
            const ntfyRequest = buildNtfyRequest(NTFY_SERVER, NTFY_TOPIC, title, body);
            const nr = await fetch(ntfyRequest.url, ntfyRequest.options);
            results.push({ ntfy: nr.status });
        } catch (e) {
            results.push({ ntfy_error: String(e && e.message || e) });
        }
    }

    return new Response(JSON.stringify({ code: 200, results }), {
        headers: { 'content-type': 'application/json' }
    });
}

function _err(message, status = 500) {
    return new Response(JSON.stringify({ code: status, message }), {
        status,
        headers: { 'content-type': 'application/json' }
    });
}
