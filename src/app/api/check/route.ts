import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // room for one retry after a cold-start timeout

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const url = searchParams.get('url');

    if (!url) {
        return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    return NextResponse.json(await check(url));
}

// Azure App Service instances idle out and their first request can take well over
// 8s to answer. A single slow response is not an outage, so a timeout or a 5xx is
// retried once before the endpoint is reported as down.
const ATTEMPT_TIMEOUT_MS = 12_000;

async function check(url: string, retryCount = 0): Promise<{
    isUp: boolean;
    statusCode: number;
    duration: number;
    error?: string;
}> {
    const start = Date.now();
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);

        const res = await fetch(url, {
            signal: controller.signal,
            cache: 'no-store',
            headers: {
                Accept: 'application/json, text/plain, */*',
                'User-Agent': 'StatusMonitor/1.0 (Vercel Proxy)',
            },
        });

        clearTimeout(timeoutId);

        let isUp = false;
        try {
            const json = await res.json();
            isUp = json?.status === 'Healthy' || (res.ok && json?.status !== 'Unhealthy' && json?.status !== 'Degraded');
        } catch {
            isUp = res.ok;
        }

        if (!isUp && retryCount === 0 && (res.status >= 500 || res.status === 429)) {
            return check(url, 1);
        }

        return {
            isUp,
            statusCode: res.status,
            duration: Date.now() - start,
        };
    } catch (err: unknown) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        if (retryCount === 0) {
            return check(url, 1);
        }
        return {
            isUp: false,
            statusCode: 0,
            duration: Date.now() - start,
            error: isAbort ? 'TIMEOUT' : 'FETCH_ERROR',
        };
    }
}
