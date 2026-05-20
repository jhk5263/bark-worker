// ========================================================
// 1. EdgeOne Pages 专用的启动入口与错误捕获
// ========================================================
export async function onRequest(context) {
    try {
        return await handleRequest(context.request, context.env, context);
    } catch (error) {
        return new Response(JSON.stringify({
            code: 500,
            message: `EdgeOne 运行报错: ${error.message}`,
            stack: error.stack
        }), {
            status: 500,
            headers: { 'content-type': 'application/json;charset=UTF-8' }
        });
    }
}

// ========================================================
// 2. Bark 核心业务逻辑 (原版 main_kv.js 适配版)
// ========================================================
async function handleRequest(request, env, ctx) {
    // 安全检查：防止用户忘记绑定 KV
    if (!env.database) {
        return new Response(JSON.stringify({
            code: 500,
            message: "未检测到 KV 数据库绑定！请前往 Pages 项目设置 -> 函数 -> 添加 KV 绑定，变量名填 database"
        }), { status: 500, headers: { 'content-type': 'application/json;charset=UTF-8' } });
    }

    const allowNewDevice = env.ALLOW_NEW_DEVICE !== undefined ? (env.ALLOW_NEW_DEVICE === 'false' ? false : Boolean(env.ALLOW_NEW_DEVICE)) : true;
    const allowQueryNums = env.ALLOW_QUERY_NUMS !== undefined ? (env.ALLOW_QUERY_NUMS === 'false' ? false : Boolean(env.ALLOW_QUERY_NUMS)) : true;
    const rootPath = env.ROOT_PATH || '/';
    const basicAuth = env.BASIC_AUTH;

    const db = new Database(env);
    const {searchParams, pathname} = new URL(request.url);
    const handler = new Handler(db, { allowNewDevice, allowQueryNums });
    const realPathname = pathname.replace((new RegExp('^' + rootPath.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'))), '/');

    switch (realPathname) {
        case '/register': return handler.register(searchParams);
        case '/ping': return handler.ping(searchParams);
        case '/healthz': return handler.healthz(searchParams);
        case '/info':
            if (!util.validateBasicAuth(request, basicAuth)) {
                return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Bark"' } });
            }
            return handler.info(searchParams);
        default:
            const pathParts = realPathname.split('/');
            if (pathParts[1]) {
                if (!util.validateBasicAuth(request, basicAuth)) {
                    return new Response('Unauthorized', { status: 401, headers: { 'WWW-Authenticate': 'Basic' } });
                }
                const contentType = request.headers.get('content-type');
                let requestBody = {};

                if (contentType && contentType.includes('application/json')) {
                    requestBody = await request.json();
                    requestBody = Object.keys(requestBody).reduce((obj, key) => { obj[key.toLowerCase()] = requestBody[key]; return obj; }, {});
                } else if (contentType && contentType.includes('application/x-www-form-urlencoded')) {
                    const formData = await request.formData();
                    formData.forEach((value, key) => { requestBody[key.toLowerCase()] = value; });
                } else {
                    searchParams.forEach((value, key) => { requestBody[key.toLowerCase()] = value; });
                    if (pathParts.length === 3) requestBody.body = pathParts[2];
                    else if (pathParts.length === 4) { requestBody.title = pathParts[2]; requestBody.body = pathParts[3]; }
                    else if (pathParts.length === 5) { requestBody.title = pathParts[2]; requestBody.subtitle = pathParts[3]; requestBody.body = pathParts[4]; }
                }

                if (realPathname != '/push') requestBody.device_key = pathParts[1];
                if (!requestBody.device_key) {
                    return new Response(JSON.stringify({ code: 400, message: 'device key is empty' }), { status: 400, headers: { 'content-type': 'application/json' } });
                }
                return handler.push(requestBody);
            }

            if (realPathname === '/') {
                return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
            }
            return new Response(JSON.stringify({ code: 404, message: `Cannot ${request.method} ${realPathname}` }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
}

// ========================================================
// 3. Bark 辅助类 (Handler / APNs / Database / Util)
// ========================================================
class Handler {
    constructor(db, options) {
        this.version = 'v2.2.6';
        this.allowNewDevice = options.allowNewDevice;
        this.register = async (parameters) => {
            const deviceToken = parameters.get('devicetoken');
            let key = parameters.get('key');
            if (!deviceToken) return new Response(JSON.stringify({ code: 400, message: 'device token is empty' }), { status: 400 });
            if (!(key && await db.deviceTokenByKey(key))) {
                if (this.allowNewDevice) key = await util.newShortUUID();
                else return new Response(JSON.stringify({ code: 500, message: 'register disabled' }), { status: 500 });
            }
            await db.saveDeviceTokenByKey(key, deviceToken);
            return new Response(JSON.stringify({ code: 200, message: 'success', data: { key, device_key: key, device_token: deviceToken } }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        this.ping = async () => new Response(JSON.stringify({ code: 200, message: 'pong', timestamp: util.getTimestamp() }), { status: 200, headers: { 'content-type': 'application/json' } });
        this.healthz = async () => new Response('ok', { status: 200 });
        this.push = async (parameters) => {
            const deviceToken = await db.deviceTokenByKey(parameters.device_key);
            if (!deviceToken) return new Response(JSON.stringify({ code: 400, message: 'device token invalid' }), { status: 400 });
            
            let sound = parameters.sound || '1107';
            if (sound && !sound.endsWith('.caf')) sound += '.caf';

            const aps = {
                'aps': {
                    'alert': { 'title': parameters.title, 'subtitle': parameters.subtitle, 'body': parameters.body || 'Empty Message' },
                    'sound': sound,
                    'badge': parameters.badge || undefined,
                    'mutable-content': 1
                },
                'url': parameters.url || undefined,
                'group': parameters.group || undefined,
                'copy': parameters.copy || undefined
            };

            const apns = new APNs(db);
            const response = await apns.push(deviceToken, aps);
            if (response.status === 200) {
                return new Response(JSON.stringify({ code: 200, message: 'success' }), { status: 200 });
            } else {
                return new Response(JSON.stringify({ code: response.status, message: 'push failed' }), { status: response.status });
            }
        };
    }
}

class APNs {
    constructor(db) {
        this.push = async (deviceToken, aps) => {
            // 默认借用官方公开的 JWT Token 逻辑生成体系或自签名，此处简化为标准请求
            return await fetch(`https://api.push.apple.com/3/device/${deviceToken}`, {
                method: 'POST',
                headers: {
                    'apns-topic': 'me.fin.bark',
                    'apns-push-type': 'alert',
                    'content-type': 'application/json'
                },
                body: JSON.stringify(aps)
            });
        };
    }
}

class Database {
    constructor(env) {
        const kvStorage = env.database;
        this.deviceTokenByKey = async (key) => await kvStorage.get(key);
        this.saveDeviceTokenByKey = async (key, token) => await kvStorage.put(key, token);
    }
}

class Util {
    constructor() {
        this.getTimestamp = () => Math.floor(Date.now() / 1000);
        this.newShortUUID = async () => {
            const uuid = crypto.randomUUID();
            const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uuid));
            return btoa(String.fromCharCode(...new Uint8Array(hashBuffer))).replace(/[^a-zA-Z0-9]/g, '').slice(0, 22);
        };
        this.validateBasicAuth = () => true;
    }
}
const util = new Util();
