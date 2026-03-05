import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { RemoteShell } from "@/components/remote-shell";
import { auth } from "@/lib/auth";

type MachineDashboardPageProps = {
  params: Promise<{ machineId: string }>;
};

export default async function MachineDashboardPage({ params }: MachineDashboardPageProps) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/sign-in");
  }

  const { machineId } = await params;

  return (
    <RemoteShell
      userName={session.user.name}
      userEmail={session.user.email}
      initialMachineId={machineId}
    />
  );
}
