// ========================================================
// 🚨 终极无数据库版 Bark Server (腾讯云专供)
// ========================================================

// 【必须修改】在这里填入你在官方 Bark 客户端里的那串真实 Device Key！
const MY_REAL_DEVICE_KEY = "gjmym5KKDRHZtxbsd5k3eB";

export async function onRequest(context) {
    const request = context.request;
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. 暴力拦截 544 崩溃源头 (主页和图标请求)
    if (path === '/' || path === '/favicon.ico') {
        return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    }

    // 2. 伪装健康状态 (让 Bark App 觉得这是一个正常的服务器)
    if (path === '/ping') {
        return new Response(JSON.stringify({
            code: 200,
            message: "pong",
            timestamp: Math.floor(Date.now() / 1000)
        }), { headers: { 'content-type': 'application/json' } });
    }

    // 3. 伪装注册成功 (永远返回你自己的真实 Key，不再写入数据库)
    if (path === '/register') {
        return new Response(JSON.stringify({
            code: 200,
            message: "success",
            timestamp: Math.floor(Date.now() / 1000),
            data: {
                key: MY_REAL_DEVICE_KEY,
                device_key: MY_REAL_DEVICE_KEY,
                device_token: "fake_token_for_edgeone_bypass" 
            }
        }), { headers: { 'content-type': 'application/json' } });
    }

    // 4. 核心：处理实际的推送请求并高速转发
    const pathParts = path.split('/').filter(p => p); 
    if (pathParts.length < 2 && path !== '/push') {
         return new Response(JSON.stringify({
            code: 400,
            message: "请求格式错误，应为 /key/title/body"
        }), { status: 400, headers: { 'content-type': 'application/json' } });
    }

    // 提取请求中的 Key，验证是否是你本人的请求
    const requestedKey = pathParts[0];
    if (requestedKey !== MY_REAL_DEVICE_KEY && path !== '/push') {
        return new Response(JSON.stringify({
            code: 401,
            message: "Device Key 不匹配，拒绝推送！"
        }), { status: 401, headers: { 'content-type': 'application/json' } });
    }

    // 解析请求参数 (支持 GET 和 POST)
    let title = "Bark通知";
    let body = "";
    let searchParams = url.search;

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
        // 把 POST 参数转成官方 API 需要的 Query 参数
        const params = new URLSearchParams(requestBody);
        searchParams = '?' + params.toString();
    } else {
        if (pathParts.length === 2) {
            body = decodeURIComponent(pathParts[1]); 
        } else if (pathParts.length >= 3) {
            title = decodeURIComponent(pathParts[1]); 
            body = decodeURIComponent(pathParts[2]);
        }
    }

    // 5. 终极大招：借助官方 API 通道代发 (绕过所有 APNs 加密和数据库)
    try {
        const barkOfficialUrl = `https://api.day.app/${MY_REAL_DEVICE_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(body)}${searchParams}`;
        
        const response = await fetch(barkOfficialUrl);
        const result = await response.json();
        
        return new Response(JSON.stringify(result), {
            status: response.status,
            headers: { 'content-type': 'application/json' }
        });

    } catch (error) {
        return new Response(JSON.stringify({
            code: 500,
            message: `请求官方网关转发失败: ${error.message}`
        }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
}
