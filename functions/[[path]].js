// ========================================================
// 1. EdgeOne Pages 启动入口与全自动错误捕获
// ========================================================
export async function onRequest(context) {
    try {
        return await handleRequest(context.request, context.env, context);
    } catch (error) {
        return new Response(JSON.stringify({
            code: 500,
            message: `💥 腾讯云边缘函数运行崩溃: ${error.message}`,
            stack: error.stack
        }), {
            status: 500,
            headers: { 'content-type': 'application/json;charset=UTF-8' }
        });
    }
}

// ========================================================
// 2. Bark 核心业务路由
// ========================================================
async function handleRequest(request, env, ctx) {
    const allowNewDevice = true;
    const allowQueryNums = true;
    const rootPath = '/';

    // 实例化具备超强容错的数据库类
    const db = new Database(env);
    
    const {searchParams, pathname} = new URL(request.url);
    const handler = new Handler(db, { allowNewDevice, allowQueryNums });
    const realPathname = pathname.replace((new RegExp('^' + rootPath.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'))), '/');

    switch (realPathname) {
        case '/register': return handler.register(searchParams);
        case '/ping': return handler.ping(searchParams);
        case '/healthz': return handler.healthz(searchParams);
        case '/info': return handler.info(searchParams);
        default:
            const pathParts = realPathname.split('/');
            if (pathParts[1]) {
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
// 3. 核心魔改：无视腾讯云 Bug 的超级容错数据库驱动
// ========================================================
class Database {
    constructor(env) {
        let kv = null;

        // 通道 1：尝试标准的 env 传递
        if (env && env.database) {
            kv = env.database;
        } 
        // 通道 2：尝试腾讯云 Pages 经常把变量直接丢在全局作用域的玄学情况
        else if (typeof database !== 'undefined') {
            kv = database;
        } 
        // 通道 3：如果你建的空间叫 bark_db，尝试直接寻找全局空间名
        else if (typeof bark_db !== 'undefined') {
            kv = bark_db;
        } 
        // 通道 4：终极备用方案，手工包装腾讯云的全局全局 EdgeOne.KV 接口
        else if (typeof EdgeOne !== 'undefined' && EdgeOne.KV) {
            kv = {
                get: async (key) => await EdgeOne.KV.get('bark_db', key),
                put: async (key, val) => await EdgeOne.KV.set('bark_db', key, val),
                delete: async (key) => await EdgeOne.KV.delete('bark_db', key)
            };
        }

        if (!kv) {
            throw new Error("腾讯云底层未能正常加载任何 KV 存储实例，请确保你在 Pages 的【KV存储】里绑定了名为 database 的变量。");
        }

        this.kvStorage = kv;
    }

    async deviceTokenByKey(key) {
        return await this.kvStorage.get(key);
    }

    async saveDeviceTokenByKey(key, token) {
        return await this.kvStorage.put(key, token);
    }
}

// ========================================================
// 4. Bark 辅助业务类
// ========================================================
class Handler {
    constructor(db, options) {
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
        this.info = async () => new Response(JSON.stringify({ version: 'v2.2.6', nodes: "Tencent Cloud EdgeOne" }), { status: 200 });
        
        this.push = async (parameters) => {
            const deviceToken = await db.deviceTokenByKey(parameters.device_key);
            if (!deviceToken) return new Response(JSON.stringify({ code: 400, message: 'failed to get device token' }), { status: 400 });
            
            let sound = parameters.sound || '1107';
            if (sound && !sound.endsWith('.caf')) sound += '.caf';

            const aps = {
                'aps': {
                    'alert': { 'title': parameters.title, 'subtitle': parameters.subtitle, 'body': parameters.body || 'Empty Message' },
                    'sound': sound,
                    'mutable-content': 1
                },
                'url': parameters.url || undefined,
                'group': parameters.group || undefined
            };

            // 直接转发给苹果 APNs 网关服务
            const response = await fetch(`https://api.push.apple.com/3/device/${deviceToken}`, {
                method: 'POST',
                headers: { 'apns-topic': 'me.fin.bark', 'apns-push-type': 'alert', 'content-type': 'application/json' },
                body: JSON.stringify(aps)
            });

            if (response.status === 200) {
                return new Response(JSON.stringify({ code: 200, message: 'success' }), { status: 200 });
            } else {
                return new Response(JSON.stringify({ code: response.status, message: 'apns push failed' }), { status: response.status });
            }
        };
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
