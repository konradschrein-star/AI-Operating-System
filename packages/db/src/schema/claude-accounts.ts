import { pgTable, text, integer, timestamp, boolean, uniqueIndex } from 'drizzle-orm/pg-core'

export const claudeAccounts = pgTable(
  'claude_accounts',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    apiKey: text('api_key').notNull(),
    displayName: text('display_name').notNull(),
    priority: integer('priority').notNull().default(0), // Lower = higher priority
    isActive: boolean('is_active').notNull().default(true),
    lastUsed: timestamp('last_used'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  table => [
    uniqueIndex('claude_accounts_api_key_unique').on(table.apiKey),
  ]
)

export type ClaudeAccount = typeof claudeAccounts.$inferSelect
export type InsertClaudeAccount = typeof claudeAccounts.$inferInsert
