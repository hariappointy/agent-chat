import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";

import { db, schema } from "@/lib/db";

const baseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
const secret =
  process.env.BETTER_AUTH_SECRET ?? "dev-only-better-auth-secret-change-me-123456";

export const auth = betterAuth({
  baseURL: baseUrl,
  secret,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  plugins: [nextCookies()],
});
