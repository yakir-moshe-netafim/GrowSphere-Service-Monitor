import { services } from '@/app/config/services';
import DashboardClient from '@/app/components/DashboardClient';

// No server-side health fetches here — the client calls /api/status on load.
// This means the page shell renders instantly with no risk of timeout.
export default function Dashboard() {
    return <DashboardClient services={services} />;
}
