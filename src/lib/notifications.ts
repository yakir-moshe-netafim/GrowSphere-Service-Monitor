import { Resend } from 'resend';

interface AlertParams {
    serviceName: string;
    envName: string;
    url: string;
    statusCode: number;
}

export async function sendEmailAlert({ serviceName, envName, url, statusCode }: AlertParams) {
    if (!process.env.RESEND_API_KEY) {
        console.warn('RESEND_API_KEY is not set, skipping email alert.');
        return;
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    const to = process.env.EMAIL_TO?.split(',') ?? ['yakir.moshe@netafim.com'];

    try {
        await resend.emails.send({
            from: process.env.EMAIL_FROM ?? 'Netafim Monitor <onboarding@resend.dev>',
            to,
            subject: `🚨 CRITICAL: ${serviceName} (${envName}) is DOWN`,
            html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h1 style="color: #ef4444; margin-top: 0;">🚨 Service Alert</h1>
          <p>The following service is <strong>failing health checks</strong>:</p>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr style="background: #f8fafc;">
              <td style="padding: 8px 12px; font-weight: bold; border: 1px solid #e2e8f0;">Service</td>
              <td style="padding: 8px 12px; border: 1px solid #e2e8f0;">${serviceName}</td>
            </tr>
            <tr>
              <td style="padding: 8px 12px; font-weight: bold; border: 1px solid #e2e8f0;">Environment</td>
              <td style="padding: 8px 12px; border: 1px solid #e2e8f0;">${envName}</td>
            </tr>
            <tr style="background: #f8fafc;">
              <td style="padding: 8px 12px; font-weight: bold; border: 1px solid #e2e8f0;">URL</td>
              <td style="padding: 8px 12px; border: 1px solid #e2e8f0;"><a href="${url}">${url}</a></td>
            </tr>
            <tr>
              <td style="padding: 8px 12px; font-weight: bold; border: 1px solid #e2e8f0;">Status Code</td>
              <td style="padding: 8px 12px; border: 1px solid #e2e8f0; color: #ef4444;">${statusCode === 0 ? 'Timeout / No Response' : statusCode}</td>
            </tr>
            <tr style="background: #f8fafc;">
              <td style="padding: 8px 12px; font-weight: bold; border: 1px solid #e2e8f0;">Time</td>
              <td style="padding: 8px 12px; border: 1px solid #e2e8f0;">${new Date().toLocaleString()}</td>
            </tr>
          </table>
          <p style="color: #64748b; font-size: 14px;">This alert will not repeat for the same service &amp; environment until tomorrow.</p>
        </div>
      `,
        });
        console.log(`✅ Email alert sent for ${serviceName} (${envName})`);
    } catch (error) {
        console.error('❌ Failed to send email alert:', error);
    }
}

interface GroupedAlertParams {
    serviceName: string;
    failingEnvs: {
        envName: string;
        url: string;
        statusCode: number;
    }[];
}

// ─── Teams: Adaptive Card helper ─────────────────────────────────────────────
// Microsoft deprecated the old "MessageCard" format in early 2025.
// All webhooks must now use Adaptive Cards via the Power Automate Workflow connector.
// Docs: https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook

async function postAdaptiveCard(webhookUrl: string, payload: object): Promise<void> {
    const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    const responseText = await res.text();

    if (!res.ok) {
        throw new Error(`Teams webhook responded with HTTP ${res.status}: ${responseText}`);
    }

    // A retired Office 365 connector still answers 200, but with an empty body and a
    // proxy error header — the post is silently dropped and never reaches the channel.
    // A live connector replies "1"; a Power Automate Workflow replies 202 with a body.
    const proxyError = res.headers.get('x-proxyerrormessage');
    if (!responseText && proxyError) {
        throw new Error(
            `Teams webhook accepted the post but dropped it (HTTP ${res.status}, empty body, ` +
            `x-proxyerrormessage: "${proxyError}"). The Office 365 connector is most likely ` +
            `retired — recreate the webhook via Teams > Workflows and update TEAMS_WEBHOOK_URL.`
        );
    }

    // Old connectors return "1" on success, new Workflow connectors return HTTP 202.
    console.log(`📨 Teams webhook response: HTTP ${res.status} — body: "${responseText}"`);
}

// ─── DOWN alert ──────────────────────────────────────────────────────────────
export async function sendTeamsAlert({ serviceName, failingEnvs }: GroupedAlertParams) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) {
        console.warn('❌ TEAMS_WEBHOOK_URL is not set in process.env!');
        return;
    }
    console.log(`📡 Sending Teams DOWN alert for ${serviceName} (${failingEnvs.length} env(s))...`);

    const timestamp = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

    // Build one Adaptive Card fact-set row per failing environment
    const envFacts = failingEnvs.map(env => ({
        title: env.envName,
        value: `Status: **${env.statusCode === 0 ? 'Timeout / No Response' : env.statusCode}**`,
    }));

    const card = {
        type: 'message',
        attachments: [
            {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: {
                    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                    type: 'AdaptiveCard',
                    version: '1.4',
                    msteams: { width: 'Full' },
                    body: [
                        {
                            type: 'Container',
                            style: 'attention',
                            items: [
                                {
                                    type: 'TextBlock',
                                    text: `🚨 Service DOWN: ${serviceName}`,
                                    weight: 'Bolder',
                                    size: 'Large',
                                    color: 'Attention',
                                    wrap: true,
                                },
                                {
                                    type: 'TextBlock',
                                    text: failingEnvs.length > 1
                                        ? `Failing in **${failingEnvs.length} environments**`
                                        : `Environment: **${failingEnvs[0].envName}**`,
                                    isSubtle: true,
                                    wrap: true,
                                },
                            ],
                        },
                        {
                            type: 'FactSet',
                            facts: [
                                ...envFacts,
                                { title: '🕐 Time', value: timestamp },
                            ],
                        },
                    ],
                    actions: failingEnvs.map(env => ({
                        type: 'Action.OpenUrl',
                        title: `Check ${env.envName}`,
                        url: env.url,
                    })),
                },
            },
        ],
    };

    try {
        await postAdaptiveCard(webhookUrl, card);
        console.log(`✅ Teams DOWN alert sent for ${serviceName}`);
    } catch (error) {
        console.error('❌ Failed to send Teams DOWN alert:', error);
    }
}

// ─── RECOVERY alert ──────────────────────────────────────────────────────────
export async function sendTeamsRecoveryAlert({
    serviceName,
    recoveredEnvs,
}: {
    serviceName: string;
    recoveredEnvs: { envName: string; url: string }[];
}) {
    const webhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) return;

    const timestamp = new Date().toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });

    const envFacts = recoveredEnvs.map(env => ({
        title: env.envName,
        value: 'Status: **UP ✅**',
    }));

    const card = {
        type: 'message',
        attachments: [
            {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: {
                    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                    type: 'AdaptiveCard',
                    version: '1.4',
                    msteams: { width: 'Full' },
                    body: [
                        {
                            type: 'Container',
                            style: 'good',
                            items: [
                                {
                                    type: 'TextBlock',
                                    text: `✅ Service Recovered: ${serviceName}`,
                                    weight: 'Bolder',
                                    size: 'Large',
                                    color: 'Good',
                                    wrap: true,
                                },
                                {
                                    type: 'TextBlock',
                                    text: recoveredEnvs.length > 1
                                        ? `Recovered in **${recoveredEnvs.length} environments**`
                                        : `Environment: **${recoveredEnvs[0].envName}**`,
                                    isSubtle: true,
                                    wrap: true,
                                },
                            ],
                        },
                        {
                            type: 'FactSet',
                            facts: [
                                ...envFacts,
                                { title: '🕐 Time', value: timestamp },
                            ],
                        },
                    ],
                    actions: recoveredEnvs.map(env => ({
                        type: 'Action.OpenUrl',
                        title: `Check ${env.envName}`,
                        url: env.url,
                    })),
                },
            },
        ],
    };

    try {
        await postAdaptiveCard(webhookUrl, card);
        console.log(`✅ Teams RECOVERY alert sent for ${serviceName}`);
    } catch (error) {
        console.error('❌ Failed to send Teams recovery alert:', error);
    }
}
