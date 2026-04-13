import { NextResponse } from 'next/server';
import { services } from '@/app/config/services';

export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Vercel Pro: 300s, Hobby: 60s

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function checkService(
    url: string,
    retryCount = 0
): Promise<{ isUp: boolean; statusCode: number; duration: number; error?: string }> {
    const start = Date.now();
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const res = await fetch(url, {
            signal: controller.signal,
            cache: 'no-store',
            headers: {
                Accept: 'application/json, text/plain, */*',
                'User-Agent': 'StatusMonitor/1.0 (Vercel Node.js Dashboard)',
            },
        });

        clearTimeout(timeoutId);

        try {
            const json = await res.json();
            if (json?.status === 'Healthy')
                return { isUp: true, statusCode: res.status, duration: Date.now() - start };
            if (json?.status === 'Unhealthy' || json?.status === 'Degraded')
                return { isUp: false, statusCode: res.status, duration: Date.now() - start };
        } catch {
            // Not JSON
        }

        if (res.ok) return { isUp: true, statusCode: res.status, duration: Date.now() - start };

        if (retryCount === 0 && (res.status >= 500 || res.status === 429)) {
            await new Promise((r) => setTimeout(r, 500));
            return checkService(url, 1);
        }

        return { isUp: false, statusCode: res.status, duration: Date.now() - start };
    } catch (err: unknown) {
        if (retryCount === 0) {
            await new Promise((r) => setTimeout(r, 300));
            return checkService(url, 1);
        }
        const duration = Date.now() - start;
        const error =
            err instanceof Error && err.name === 'AbortError'
                ? 'TIMEOUT'
                : err instanceof Error
                ? err.message.toUpperCase()
                : 'UNKNOWN';
        return { isUp: false, statusCode: 0, duration, error };
    }
}

async function runInChunks<T, R>(
    items: T[],
    chunkSize: number,
    asyncFn: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = [];
    for (let i = 0; i < items.length; i += chunkSize) {
        const chunk = items.slice(i, i + chunkSize);
        const chunkResults = await Promise.all(chunk.map(asyncFn));
        results.push(...chunkResults);
        if (i + chunkSize < items.length) {
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    return results;
}

export async function GET() {
    const checksInput = services.flatMap((s) =>
        s.environments.map((e) => ({
            serviceId: s.id,
            serviceName: s.name,
            env: e.name,
            url: e.url,
        }))
    );

    const results = await runInChunks(checksInput, 10, async (c) => ({
        ...c,
        ...(await checkService(c.url)),
    }));

    return NextResponse.json(
        { results, checkedAt: new Date().toISOString() },
        {
            headers: {
                'Cache-Control': 'no-store',
            },
        }
    );
}
