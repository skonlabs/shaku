import { createFileRoute } from '@tanstack/react-router'
import { Client } from 'pg'
import { MIGRATION_SQL } from '@/lib/_oneshot/migration-sql'

// One-shot admin migration runner. DELETE after use.
export const Route = createFileRoute('/api/public/admin-run-migration')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // One-shot — file will be deleted immediately after use.
        // Still require MIGRATION_TOKEN env to be set as a basic guard.
        if (!process.env.MIGRATION_TOKEN) {
          return new Response(JSON.stringify({ error: 'disabled' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          })
        }

        const dbUrl = process.env.DB_MIGRATION_URL
        if (!dbUrl) {
          return new Response(
            JSON.stringify({ error: 'DB_MIGRATION_URL not set' }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          )
        }

        // Read SQL from request body so we don't depend on filesystem.
        const sql = MIGRATION_SQL
        if (!sql || sql.length < 50) {
          return new Response(
            JSON.stringify({ error: 'embedded SQL missing' }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          )
        }

        const client = new Client({
          connectionString: dbUrl,
          ssl: { rejectUnauthorized: false },
          statement_timeout: 0,
          query_timeout: 0,
        })

        const log: string[] = []
        try {
          await client.connect()
          log.push('connected')
          const started = Date.now()
          await client.query(sql)
          log.push(`executed in ${Date.now() - started}ms`)

          // Verify a few key tables exist.
          const check = await client.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name IN (
                'user_knowledge_models','memories','tasks','context_logs',
                'memory_jobs','user_memory_preferences','usage_events'
              )
            ORDER BY table_name;
          `)
          log.push(
            'present_tables: ' +
              check.rows.map((r: any) => r.table_name).join(','),
          )
          return new Response(
            JSON.stringify({ ok: true, log, tables: check.rows }),
            { headers: { 'content-type': 'application/json' } },
          )
        } catch (e: any) {
          log.push('error: ' + (e?.message ?? String(e)))
          return new Response(
            JSON.stringify({ ok: false, log, error: e?.message ?? String(e) }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          )
        } finally {
          try { await client.end() } catch {}
        }
      },
    },
  },
})
