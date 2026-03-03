import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { auth } from "@/lib/auth";

export default async function Page() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (session) {
    redirect("/dashboard");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col items-center justify-center gap-6 px-4 py-10 text-center">
      <p className="text-sm font-medium uppercase tracking-[0.24em] text-muted-foreground">
        Agent Chat
      </p>
      <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
        Run your machine from anywhere
      </h1>
      <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
        Sign in to connect your machine, run commands, and stream output from the dashboard.
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <Button asChild>
          <Link href="/sign-up">Get Started</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/sign-in">Sign In</Link>
        </Button>
      </div>
    </main>
  );
}