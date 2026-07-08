// Single shared PrismaClient.
// WHY: each PrismaClient owns a connection pool. Creating one per request
// leaks connections and will exhaust Supabase's limits fast. One instance,
// imported everywhere, is the standard pattern.
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
