import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 10; 

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const url = searchParams.get('url');

    if (!url) {
        return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    const start = Date.now();
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

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

        return NextResponse.json({
            isUp,
            statusCode: res.status,
            duration: Date.now() - start,
        });
    } catch (err: any) {
        const error = err.name === 'AbortError' ? 'TIMEOUT' : 'FETCH_ERROR';
        return NextResponse.json({
            isUp: false,
            statusCode: 0,
            duration: Date.now() - start,
            error
        });
    }
}
