import { pgTable, text, integer, timestamp, boolean } from 'drizzle-orm/pg-core'

export const availableModels = pgTable('available_models', {
  id: text('id').primaryKey(), // e.g., 'claude-opus-4-1-20250805'
  displayName: text('display_name').notNull(), // e.g., 'Opus 5'
  category: text('category').notNull(), // 'latest' | 'previous' | 'legacy'
  inputTokenPrice: integer('input_token_price').notNull(), // cents per 1M tokens
  outputTokenPrice: integer('output_token_price').notNull(),
  contextWindow: integer('context_window').notNull(),
  isAvailable: boolean('is_available').notNull().default(true),
  lastFetched: timestamp('last_fetched').notNull().defaultNow(),
})

export type AvailableModel = typeof availableModels.$inferSelect
export type InsertAvailableModel = typeof availableModels.$inferInsert
