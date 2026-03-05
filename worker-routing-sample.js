/**
 * Cloudflare Worker Sample - 智能双路路由
 * 部署时，请在 Cloudflare Worker 的 Settings -> Variables 中添加以下环境变量:
 * - CN_OPTIMIZED_HOST: 填入您的亚太优化线路域名 (例如: https://your-cn-domain.com)
 * - PAGES_HOST: 填入您的原生 Cloudflare Pages 域名 (例如: https://your-app.pages.dev)
 */

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const country = request.cf ? request.cf.country : null;

        // 提取环境变量的 Host（去除末尾可能包含的斜杠以防拼接双斜杠）
        const cnHost = (env.CN_OPTIMIZED_HOST || "").replace(/\/$/, "");
        const pagesHost = (env.PAGES_HOST || "").replace(/\/$/, "");

        if (!cnHost || !pagesHost) {
            return new Response("Worker Environment Variables (CN_OPTIMIZED_HOST, PAGES_HOST) are not fully configured.", { status: 500 });
        }

        // 只对根路径 / 做国内跳转优化，其他资产路径（如 /web/viewer.html, /ping.txt）正常通行
        if (country === 'CN' && (url.pathname === '/' || url.pathname === '')) {
            return Response.redirect(`${cnHost}/`, 302);
        }

        // 其他所有请求显式透传到 Cloudflare Pages 的原生域名，避免绑在自定域名上触发内部路由循环
        const pagesUrl = new URL(url.pathname + url.search, pagesHost);
        const pagesRequest = new Request(pagesUrl.toString(), {
            method: request.method,
            headers: request.headers,
            body: request.body,
            redirect: 'follow', // 自动跟随如果 pages 返回了 30x 跳转
        });

        return fetch(pagesRequest);
    }
}
