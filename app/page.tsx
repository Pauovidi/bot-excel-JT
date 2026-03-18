import { getDemoV2Config } from "@/lib/demoV2";
import { DemoDashboard } from "@/components/demo-dashboard";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const demoV2 = getDemoV2Config();

  return <DemoDashboard demoV2={demoV2} />;
}
