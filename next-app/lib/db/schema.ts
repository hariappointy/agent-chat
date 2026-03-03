import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("emailVerified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    emailUnique: uniqueIndex("user_email_unique").on(table.email),
  })
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    tokenUnique: uniqueIndex("session_token_unique").on(table.token),
    userIdIndex: index("session_user_id_idx").on(table.userId),
  })
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: timestamp("accessTokenExpiresAt", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIndex: index("account_user_id_idx").on(table.userId),
  })
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    identifierIndex: index("verification_identifier_idx").on(table.identifier),
  })
);

export const machine = pgTable(
  "machine",
  {
    id: text("id").primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    deviceId: text("deviceId").notNull(),
    hostName: text("hostName"),
    runtimes: text("runtimes").array(),
    lastSeenAt: timestamp("lastSeenAt", { withTimezone: true }),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    deviceIdUnique: uniqueIndex("machine_device_id_unique").on(table.deviceId),
    userIdIndex: index("machine_user_id_idx").on(table.userId),
  })
);

export const machineKey = pgTable(
  "machine_key",
  {
    id: text("id").primaryKey(),
    machineId: text("machineId")
      .notNull()
      .references(() => machine.id, { onDelete: "cascade" }),
    keyPrefix: text("keyPrefix").notNull(),
    keyHash: text("keyHash").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revokedAt", { withTimezone: true }),
  },
  (table) => ({
    machineIdIndex: index("machine_key_machine_id_idx").on(table.machineId),
    keyPrefixIndex: index("machine_key_prefix_idx").on(table.keyPrefix),
  })
);

export const machineSession = pgTable(
  "machine_session",
  {
    id: text("id").primaryKey(),
    machineId: text("machineId")
      .notNull()
      .references(() => machine.id, { onDelete: "cascade" }),
    issuedAt: timestamp("issuedAt", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revokedAt", { withTimezone: true }),
  },
  (table) => ({
    machineIdIndex: index("machine_session_machine_id_idx").on(table.machineId),
  })
);
