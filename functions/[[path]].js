export async function onRequest(context) {
    try {
        // 兼容官方文档的两种写法：从 env 读取，或者直接用全局变量
        const kv = context.env.database || typeof database !== 'undefined' ? database : null;
        
        if (!kv) {
            return new Response("找不到绑定的 KV 数据库");
        }

        // 1. 读取 Key-Value 数据
        let visitCount = await kv.get('visitCount');
        let visitCountInt = Number(visitCount) || 0;
        visitCountInt += 1;

        // 2. 写入 Key-Value 数据 (这里是刚才崩溃的地方)
        await kv.put('visitCount', String(visitCountInt));
      
        // 3. 返回成功
        return new Response(JSON.stringify({
            status: "KV 数据库读写完美成功！",
            visitCount: visitCountInt,
        }), {
            headers: { 'content-type': 'application/json; charset=UTF-8' }
        });

    } catch (error) {
        // 4. 如果失败，打印官方底层的真正错误
        return new Response(JSON.stringify({
            status: "KV 数据库写入失败！",
            error_message: error.message
        }), {
            headers: { 'content-type': 'application/json; charset=UTF-8' }
        });
    }
}
