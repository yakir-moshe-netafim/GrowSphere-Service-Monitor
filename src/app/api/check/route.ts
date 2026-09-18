import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 45; // room for three attempts

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const url = searchParams.get('url');

    if (!url) {
        return NextResponse.json({ error: 'URL is required' }, { status: 400 });
    }

    return NextResponse.json(await check(url));
}

// Two classes of false negative are retried here:
//  - Azure App Service instances idle out, so their first request can exceed the budget.
//  - Cross-border connections to the China endpoints drop mid-handshake (ECONNRESET),
//    which surfaces as a fetch failure rather than a timeout.
// Neither means the service is down, so an endpoint is only reported down after
// MAX_ATTEMPTS consecutive failures.
const ATTEMPT_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 300;

// fetch() collapses every transport failure into "fetch failed"; the real reason
// (ECONNRESET, ENOTFOUND, UND_ERR_CONNECT_TIMEOUT, …) hides in err.cause.
function describeError(err: unknown): string {
    if (err instanceof Error && err.name === 'AbortError') return 'TIMEOUT';
    const cause = err instanceof Error ? (err.cause as { code?: string } | undefined) : undefined;
    if (cause?.code) return cause.code;
    return err instanceof Error && err.message ? err.message.toUpperCase() : 'FETCH_ERROR';
}

// UP          the endpoint answered and reports itself healthy
// DOWN         the endpoint answered, but with an error status or an unhealthy body
//              — this is a real service failure worth waking somebody for
// UNREACHABLE  no answer at all (timeout, connection reset, DNS): the monitor could
//              not reach it, which is frequently a network problem on our side and
//              must not be presented as the service being down
type CheckState = 'UP' | 'DOWN' | 'UNREACHABLE';

async function check(url: string, retryCount = 0): Promise<{
    isUp: boolean;
    state: CheckState;
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

        if (!isUp && retryCount < MAX_ATTEMPTS - 1 && (res.status >= 500 || res.status === 429)) {
            await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
            return check(url, retryCount + 1);
        }

        return {
            isUp,
            state: isUp ? 'UP' : 'DOWN',
            statusCode: res.status,
            duration: Date.now() - start,
        };
    } catch (err: unknown) {
        if (retryCount < MAX_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
            return check(url, retryCount + 1);
        }
        return {
            isUp: false,
            state: 'UNREACHABLE',
            statusCode: 0,
            duration: Date.now() - start,
            error: describeError(err),
        };
    }
}
