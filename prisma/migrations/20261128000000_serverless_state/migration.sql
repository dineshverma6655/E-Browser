-- Presence, notification window and call state now live in Postgres (the backend is serverless on Vercel, so there is no
-- in-memory state any more).
ALTER TABLE "users"
  ADD COLUMN "online_at"   TIMESTAMPTZ(6),
  ADD COLUMN "offline"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "visible"     BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notified_at" TIMESTAMPTZ(6),
  ADD COLUMN "session_id"  TEXT;

ALTER TABLE "call_logs" ADD COLUMN "video" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "call_logs_caller_idx" ON "call_logs"("caller_id");
CREATE INDEX "call_logs_callee_idx" ON "call_logs"("callee_id");
