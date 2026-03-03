"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  async function handleSignOut() {
    setIsLoading(true);

    try {
      await authClient.signOut();
      router.push("/sign-in");
      router.refresh();
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Button disabled={isLoading} onClick={handleSignOut} type="button" variant="outline">
      {isLoading ? "Signing out..." : "Sign out"}
    </Button>
  );
}
