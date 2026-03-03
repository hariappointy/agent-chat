import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { RemoteShell } from "@/components/remote-shell";
import { auth } from "@/lib/auth";

export default async function DashboardPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect("/sign-in");
  }

  return <RemoteShell userName={session.user.name} />;
}
