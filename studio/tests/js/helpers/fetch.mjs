// fetch 拦截器：按 URL pathname 路由到 fixture，记录全部调用供 golden 断言。
const routes = new Map();

export const fetchLog = [];
export const missingRoutes = [];

export function mockRoute(path, responder) {
    routes.set(path, responder);
}

export function clearRoutes() {
    routes.clear();
}

/** 精确路由优先；`/a/b/*` 前缀路由命中时把剩余路径段作为 params.rest 交给 responder。 */
function matchRoute(pathname) {
    const exact = routes.get(pathname);
    if (exact) return { responder: exact, params: { rest: "" } };
    for (const [pattern, responder] of routes) {
        if (!pattern.endsWith("*")) continue;
        const prefix = pattern.slice(0, -1);
        if (pathname.startsWith(prefix)) return { responder, params: { rest: decodeURIComponent(pathname.slice(prefix.length)) } };
    }
    return null;
}

export function resetFetchLog() {
    fetchLog.length = 0;
    missingRoutes.length = 0;
}

export function jsonResponse(body, status = 200) {
    return { __spec: true, status, body };
}

export function sseResponse(lines) {
    return { __spec: true, status: 200, sse: Array.isArray(lines) ? lines : [lines] };
}

const encoder = new TextEncoder();

function makeReader(chunks, signal) {
    let i = 0;
    return {
        async read() {
            if (signal?.aborted) return { done: true, value: undefined };   // 真 fetch 在 abort 之后读流即断
            if (i >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(chunks[i++]) };
        },
        releaseLock() {},
    };
}

function makeResponse({ status, bodyText, sseLines, signal = null }) {
    const ok = status >= 200 && status < 300;
    const resp = {
        ok,
        status,
        async json() {
            return JSON.parse(bodyText);
        },
        async text() {
            return bodyText;
        },
        body: sseLines ? { getReader: () => makeReader(sseLines, signal) } : null,
        clone: () => resp,   // 浏览器 Response 有 clone；桩照给，离线 409 探测要读副本
    };
    return resp;
}

function normalize(spec) {
    // 原始 Response 样对象（自定义 reader，供测试断言流中状态）直通
    if (spec && typeof spec === "object" && !spec.__spec && spec.body != null && typeof spec.body.getReader === "function") {
        return { raw: spec };
    }
    const resolved = spec && typeof spec === "object" && !spec.__spec ? jsonResponse(spec) : spec;
    if (!resolved) return { status: 204, bodyText: "" };
    const status = resolved.status ?? 200;
    if (resolved.sse) {
        const chunks = resolved.sse.map((line) => (line.endsWith("\n") ? line : line + "\n"));
        return { status, bodyText: chunks.join(""), sseLines: chunks };
    }
    const body = resolved.body;
    return { status, bodyText: typeof body === "string" ? body : JSON.stringify(body ?? null) };
}

export async function handleFetch(input, init = {}) {
    const raw = typeof input === "string" ? input : String(input?.url ?? input);
    const url = new URL(raw, "http://test.local/");
    const method = String(init.method || "GET").toUpperCase();
    let body = init.body;
    if (typeof body === "string") {
        try {
            body = JSON.parse(body);
        } catch {
            /* 保留原始字符串 */
        }
    } else if (body) {
        body = "[non-json]";
    }
    const call = { path: url.pathname, query: url.searchParams, method, body, signal: init.signal ?? null };
    fetchLog.push(call);

    const match = matchRoute(url.pathname);
    if (!match) {
        missingRoutes.push(`${method} ${url.pathname}`);
        return makeResponse({ status: 501, bodyText: JSON.stringify({ error: `no mock for ${url.pathname}` }) });
    }
    const spec = typeof match.responder === "function"
        ? await match.responder(body, call, match.params)
        : match.responder;
    const norm = normalize(spec);
    if (norm.raw) return norm.raw;
    const { status, bodyText, sseLines } = norm;
    return makeResponse({ status, bodyText, sseLines, signal: init.signal });
}

export function installFetch() {
    globalThis.fetch = (input, init) => handleFetch(input, init);
}
