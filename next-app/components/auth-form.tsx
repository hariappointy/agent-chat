"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";

type AuthMode = "sign-in" | "sign-up";

type AuthFormProps = {
  mode: AuthMode;
};

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const isSignUp = mode === "sign-up";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const result = isSignUp
        ? await authClient.signUp.email({
            email,
            name,
            password,
          })
        : await authClient.signIn.email({
            email,
            password,
          });

      if (result.error) {
        setError(result.error.message ?? "Authentication failed");
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{isSignUp ? "Create your account" : "Sign in"}</CardTitle>
          <CardDescription>
            {isSignUp
              ? "Use name, email, and password to create your account."
              : "Use your email and password to continue."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
            {isSignUp ? (
              <Input
                onChange={(event) => setName(event.target.value)}
                placeholder="Name"
                required
                value={name}
              />
            ) : null}
            <Input
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Email"
              required
              type="email"
              value={email}
            />
            <Input
              minLength={8}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              required
              type="password"
              value={password}
            />
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <Button className="w-full" disabled={isLoading} type="submit">
              {isLoading
                ? isSignUp
                  ? "Creating account..."
                  : "Signing in..."
                : isSignUp
                  ? "Sign up"
                  : "Sign in"}
            </Button>
          </form>
        </CardContent>
        <CardFooter>
          {isSignUp ? (
            <p className="text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link className="text-foreground underline" href="/sign-in">
                Sign in
              </Link>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Need an account?{" "}
              <Link className="text-foreground underline" href="/sign-up">
                Sign up
              </Link>
            </p>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
